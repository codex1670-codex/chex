import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { isBlocked } from './users.js';

const router = Router();

function directKey(a, b) {
  return [a, b].sort().join(':');
}

function findDirectConversation(a, b) {
  return db.prepare('SELECT * FROM conversations WHERE direct_key = ?').get(directKey(a, b));
}

function userBrief(id) {
  const u = db.prepare(`SELECT id, username, display_name, avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM users WHERE id = ?`).get(id);
  return toPublicUser(u);
}

function conversationDTO(row, viewerId, io) {
  const participants = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id WHERE cp.conversation_id = ?
  `).all(row.id).map(toPublicUser);
  const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get(row.id);
  return {
    id: row.id,
    type: row.type,
    participants,
    lastMessage: last ? { id: last.id, senderId: last.sender_id, content: last.content, createdAt: last.created_at, status: last.status } : null,
    createdAt: row.created_at,
  };
}

// ---- Message requests ----

router.get('/requests', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT mr.*, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM message_requests mr
    JOIN users u ON u.id = mr.sender_id
    WHERE mr.receiver_id = ? AND mr.status = 'pending' ORDER BY mr.created_at DESC
  `).all(req.userId);
  res.json({
    requests: rows.map(r => ({
      id: r.id, firstText: r.first_text, createdAt: r.created_at,
      sender: toPublicUser({ ...r, id: r.sender_id }),
    })),
  });
});

router.post('/requests/:id/accept', requireAuth, (req, res) => {
  const reqRow = db.prepare('SELECT * FROM message_requests WHERE id = ?').get(req.params.id);
  if (!reqRow || reqRow.receiver_id !== req.userId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: { code: 'ALREADY_RESOLVED', message: 'This request was already handled.' } });

  const tx = db.transaction(() => {
    let convo = findDirectConversation(reqRow.sender_id, reqRow.receiver_id);
    if (!convo) {
      const convoId = uuid();
      db.prepare('INSERT INTO conversations (id, type, direct_key) VALUES (?, ?, ?)')
        .run(convoId, 'direct', directKey(reqRow.sender_id, reqRow.receiver_id));
      db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(convoId, reqRow.sender_id);
      db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(convoId, reqRow.receiver_id);
      convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convoId);
    }
    db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content) VALUES (?, ?, ?, ?)')
      .run(uuid(), convo.id, reqRow.sender_id, reqRow.first_text);
    db.prepare("UPDATE message_requests SET status = 'accepted', conversation_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(convo.id, reqRow.id);
    return convo;
  });
  const convo = tx();
  const dto = conversationDTO(convo, req.userId);
  req.app.get('io')?.to(`user:${reqRow.sender_id}`).emit('message_request:accepted', { conversation: dto });
  res.json({ conversation: dto });
});

router.post('/requests/:id/delete', requireAuth, (req, res) => {
  const reqRow = db.prepare('SELECT * FROM message_requests WHERE id = ?').get(req.params.id);
  if (!reqRow || reqRow.receiver_id !== req.userId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  db.prepare("UPDATE message_requests SET status = 'deleted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reqRow.id);
  res.json({ ok: true });
});

router.post('/requests/:id/block', requireAuth, (req, res) => {
  const reqRow = db.prepare('SELECT * FROM message_requests WHERE id = ?').get(req.params.id);
  if (!reqRow || reqRow.receiver_id !== req.userId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  const tx = db.transaction(() => {
    db.prepare("UPDATE message_requests SET status = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reqRow.id);
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.userId, reqRow.sender_id);
  });
  tx();
  res.json({ ok: true });
});

router.post('/requests/:id/report', requireAuth, (req, res) => {
  const reqRow = db.prepare('SELECT * FROM message_requests WHERE id = ?').get(req.params.id);
  if (!reqRow || reqRow.receiver_id !== req.userId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  db.prepare("UPDATE message_requests SET status = 'reported', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reqRow.id);
  res.json({ ok: true });
});

// ---- Conversations & messages ----

router.get('/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.* FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE cp.user_id = ?
    ORDER BY (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) DESC
  `).all(req.userId);
  res.json({ conversations: rows.map(r => conversationDTO(r, req.userId)) });
});

router.get('/conversations/:id/messages', requireAuth, (req, res) => {
  const participant = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!participant) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You don't have access to this conversation." } });
  const cursor = req.query.cursor || '9999-12-31T23:59:59.999Z';
  const rows = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND created_at < ?
    ORDER BY created_at DESC LIMIT 30
  `).all(req.params.id, cursor);
  db.prepare("UPDATE conversation_participants SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ?")
    .run(req.params.id, req.userId);
  res.json({
    messages: rows.reverse().map(m => ({ id: m.id, senderId: m.sender_id, content: m.content, status: m.status, createdAt: m.created_at })),
    nextCursor: rows.length === 30 ? rows[0].created_at : null,
  });
});

// Core send logic, reused by POST /send and by other features (e.g. Note replies) that
// need to deliver a direct message through the exact same permission sequence.
// Returns { status: 'sent'|'message_request', ...} — never throws for expected outcomes,
// only for programmer errors (missing args). Callers must still catch for DB errors.
export function sendDirectMessage({ fromUserId, toUsername, conversationId, text, io }) {
  const cleanText = String(text || '').trim().slice(0, 4000);
  if (!cleanText) return { httpStatus: 400, body: { error: { code: 'EMPTY_MESSAGE', message: "There's nothing to send." } } };

  let convo = null;
  if (conversationId) {
    convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!convo) return { httpStatus: 404, body: { error: { code: 'NOT_FOUND', message: 'Conversation not found.' } } };
    const participant = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(convo.id, fromUserId);
    if (!participant) return { httpStatus: 403, body: { error: { code: 'FORBIDDEN', message: "You don't have access to this conversation." } } };
  } else if (toUsername) {
    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(toUsername);
    if (!target) return { httpStatus: 404, body: { error: { code: 'NOT_FOUND', message: 'User not found.' } } };
    if (target.id === fromUserId) return { httpStatus: 400, body: { error: { code: 'INVALID_ACTION', message: "You can't message yourself." } } };
    if (isBlocked(fromUserId, target.id)) {
      return { httpStatus: 403, body: { error: { code: 'BLOCKED', message: "You can't message this user." } } };
    }
    convo = findDirectConversation(fromUserId, target.id);

    if (!convo) {
      const existingReq = db.prepare('SELECT * FROM message_requests WHERE sender_id = ? AND receiver_id = ?').get(fromUserId, target.id);
      if (existingReq && existingReq.status === 'pending') {
        db.prepare("UPDATE message_requests SET first_text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .run(cleanText, existingReq.id);
        return { httpStatus: 202, body: { status: 'message_request', requestId: existingReq.id, message: 'Message request updated. It will be sent once they accept.' } };
      }
      if (existingReq && existingReq.status === 'blocked') {
        return { httpStatus: 403, body: { error: { code: 'BLOCKED', message: "You can't message this user." } } };
      }
      const reqId = uuid();
      db.prepare('INSERT INTO message_requests (id, sender_id, receiver_id, first_text) VALUES (?, ?, ?, ?)')
        .run(reqId, fromUserId, target.id, cleanText);
      db.prepare('INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), target.id, fromUserId, 'message_request', reqId);
      io?.to(`user:${target.id}`).emit('message_request:new', { requestId: reqId });
      io?.to(`user:${target.id}`).emit('notification:new', { type: 'message_request' });
      return { httpStatus: 202, body: { status: 'message_request', requestId: reqId, message: "They haven't accepted messages from you yet, so this was sent as a message request." } };
    }
  } else {
    return { httpStatus: 400, body: { error: { code: 'INVALID_INPUT', message: 'Provide a conversationId or toUsername.' } } };
  }

  const msgId = uuid();
  db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content, status) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, convo.id, fromUserId, cleanText, 'sent');
  const saved = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  const dto = { id: saved.id, senderId: saved.sender_id, content: saved.content, status: saved.status, createdAt: saved.created_at, conversationId: convo.id };

  const otherParticipants = db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?').all(convo.id, fromUserId);
  otherParticipants.forEach(p => {
    io?.to(`user:${p.user_id}`).emit('message:new', dto);
    io?.to(`user:${p.user_id}`).emit('notification:new', { type: 'message' });
    db.prepare('INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), p.user_id, fromUserId, 'message', msgId);
  });

  return { httpStatus: 201, body: { status: 'sent', message: dto } };
}

// The mandatory permission sequence: auth -> conversation lookup -> permission check -> send.
// If no accepted conversation exists between the two users, this creates/updates a message request
// instead of a message, and never silently delivers a message the recipient hasn't allowed.
router.post('/send', requireAuth, (req, res) => {
  const { toUsername, conversationId, text } = req.body || {};
  const result = sendDirectMessage({ fromUserId: req.userId, toUsername, conversationId, text, io: req.app.get('io') });
  res.status(result.httpStatus).json(result.body);
});

// ---- Group chat ----

router.post('/conversations/group', requireAuth, (req, res) => {
  const { name, usernames } = req.body || {};
  const list = Array.isArray(usernames) ? [...new Set(usernames)] : [];
  if (list.length < 2) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'A group needs at least 2 other members.' } });
  }
  const members = [];
  for (const u of list) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(u);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: `User @${u} not found.` } });
    if (isBlocked(req.userId, user.id)) return res.status(403).json({ error: { code: 'BLOCKED', message: `Can't add @${u} to this group.` } });
    members.push(user);
  }

  const convoId = uuid();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO conversations (id, type) VALUES (?, ?)').run(convoId, 'group');
    db.prepare('INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convoId, req.userId, 'admin');
    for (const m of members) {
      db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(convoId, m.id);
    }
    if (typeof name === 'string' && name.trim()) {
      db.prepare('INSERT INTO conversation_meta (conversation_id, name) VALUES (?, ?)').run(convoId, name.trim().slice(0, 60));
    }
  });
  tx();

  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convoId);
  const dto = conversationDTO(convo, req.userId);
  const io = req.app.get('io');
  members.forEach(m => io?.to(`user:${m.id}`).emit('message_request:accepted', { conversation: dto })); // reuse existing client event to refresh convo list
  res.status(201).json({ conversation: dto });
});

// ---- Chat themes ----

router.get('/theme', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM chat_themes WHERE user_id = ?').get(req.userId);
  res.json({ theme: row?.theme || 'default' });
});

router.post('/theme', requireAuth, (req, res) => {
  const { theme } = req.body || {};
  const BUILT_IN = ['default', 'cosmic-purple', 'neon-cyber', 'midnight-glass', 'aurora-dream', 'ocean-dimension', 'solar-flare'];
  if (!BUILT_IN.includes(theme)) {
    return res.status(400).json({ error: { code: 'INVALID_THEME', message: `theme must be one of: ${BUILT_IN.join(', ')}` } });
  }
  db.prepare(`
    INSERT INTO chat_themes (user_id, theme) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(req.userId, theme);
  res.json({ ok: true, theme });
});

// ---- Message actions: react, edit, delete, pin, forward ----

router.post('/:id/react', requireAuth, (req, res) => {
  const { emoji } = req.body || {};
  if (typeof emoji !== 'string' || !emoji.trim()) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide an emoji to react with.' } });
  }
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!msg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found.' } });
  const participant = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(msg.conversation_id, req.userId);
  if (!participant) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You don't have access to this conversation." } });

  db.prepare(`
    INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
    ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(msg.id, req.userId, emoji.trim().slice(0, 8));
  const reactions = db.prepare('SELECT user_id, emoji FROM message_reactions WHERE message_id = ?').all(msg.id);
  const io = req.app.get('io');
  const others = db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?').all(msg.conversation_id, req.userId);
  others.forEach(p => io?.to(`user:${p.user_id}`).emit('message:reaction', { messageId: msg.id, reactions }));
  res.json({ reactions });
});

router.delete('/:id/react', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found.' } });
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(msg.id, req.userId);
  const reactions = db.prepare('SELECT user_id, emoji FROM message_reactions WHERE message_id = ?').all(msg.id);
  res.json({ reactions });
});

router.patch('/:id', requireAuth, (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: { code: 'EMPTY_MESSAGE', message: "There's nothing to save." } });
  }
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!msg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found.' } });
  if (msg.sender_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own messages.' } });

  db.prepare("UPDATE messages SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(content.trim().slice(0, 4000), msg.id);
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
  const io = req.app.get('io');
  const others = db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?').all(msg.conversation_id, req.userId);
  others.forEach(p => io?.to(`user:${p.user_id}`).emit('message:edited', { id: updated.id, content: updated.content, editedAt: updated.edited_at }));
  res.json({ message: { id: updated.id, content: updated.content, editedAt: updated.edited_at } });
});

router.delete('/:id', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found.' } });
  if (msg.sender_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only delete your own messages.' } });
  db.prepare("UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(msg.id);
  const io = req.app.get('io');
  const others = db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?').all(msg.conversation_id, req.userId);
  others.forEach(p => io?.to(`user:${p.user_id}`).emit('message:deleted', { id: msg.id }));
  res.json({ ok: true });
});

router.post('/:id/pin', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!msg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found.' } });
  const participant = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(msg.conversation_id, req.userId);
  if (!participant) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You don't have access to this conversation." } });
  db.prepare('UPDATE messages SET pinned = 1 WHERE id = ?').run(msg.id);
  res.json({ ok: true, pinned: true });
});

router.delete('/:id/pin', requireAuth, (req, res) => {
  db.prepare('UPDATE messages SET pinned = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true, pinned: false });
});

router.get('/conversations/:id/pinned', requireAuth, (req, res) => {
  const participant = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!participant) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You don't have access to this conversation." } });
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND pinned = 1 AND deleted_at IS NULL ORDER BY created_at DESC').all(req.params.id);
  res.json({ messages: rows.map(m => ({ id: m.id, senderId: m.sender_id, content: m.content, createdAt: m.created_at })) });
});

router.post('/:id/forward', requireAuth, (req, res) => {
  const original = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!original) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found.' } });
  const senderIsParticipant = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?').get(original.conversation_id, req.userId);
  if (!senderIsParticipant) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You don't have access to this message." } });

  const { toUsername, conversationId } = req.body || {};
  const result = sendDirectMessage({ fromUserId: req.userId, toUsername, conversationId, text: original.content, io: req.app.get('io') });
  if (result.httpStatus < 400 && result.body.message) {
    db.prepare('UPDATE messages SET forwarded_from_id = ? WHERE id = ?').run(original.id, result.body.message.id);
  }
  res.status(result.httpStatus).json(result.body);
});

export default router;
