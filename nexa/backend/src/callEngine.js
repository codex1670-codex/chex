import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from './db.js';

function conversationParticipants(conversationId) {
  return db.prepare('SELECT user_id FROM conversation_participants WHERE conversation_id = ?').all(conversationId).map(r => r.user_id);
}

function isBlockedPair(a, b) {
  return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a);
}

export function registerCallHandlers(io, socket) {
  const userId = socket.userId;

  // Caller starts a call inside a conversation they're already a participant of.
  // Calling is only possible within an existing (accepted) conversation — this is what
  // ties call permission to the same relationship/message-permission rules as messaging.
  socket.on('call:invite', ({ conversationId, type }) => {
    const participants = conversationParticipants(conversationId);
    if (!participants.includes(userId)) {
      return socket.emit('call:error', { message: "You're not part of this conversation." });
    }
    const others = participants.filter(p => p !== userId);
    for (const other of others) {
      if (isBlockedPair(userId, other)) {
        return socket.emit('call:error', { message: "You can't call this conversation." });
      }
    }
    const callType = type === 'video' ? 'video' : 'voice';
    const callId = uuid();
    db.prepare('INSERT INTO calls (id, conversation_id, caller_id, type) VALUES (?, ?, ?, ?)').run(callId, conversationId, userId, callType);
    db.prepare('INSERT INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, ?)').run(callId, userId, new Date().toISOString());

    const caller = db.prepare(`SELECT id, username, display_name, avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM users WHERE id = ?`).get(userId);
    socket.join(`call:${callId}`);
    others.forEach(otherId => {
      io.to(`user:${otherId}`).emit('call:incoming', {
        callId, conversationId, type: callType,
        caller: toPublicUser(caller),
      });
    });
    socket.emit('call:ringing', { callId });

    // Auto-mark missed if nobody answers within 45s and it's still ringing.
    setTimeout(() => {
      const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
      if (call && call.status === 'ringing') {
        db.prepare("UPDATE calls SET status = 'missed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(callId);
        io.to(`call:${callId}`).emit('call:missed', { callId });
        others.forEach(otherId => {
          db.prepare("INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, 'missed_call', ?)")
            .run(uuid(), otherId, userId, callId);
          io.to(`user:${otherId}`).emit('notification:new', { type: 'missed_call' });
        });
      }
    }, 45000);
  });

  socket.on('call:accept', ({ callId }) => {
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    if (!call) return socket.emit('call:error', { message: 'Call not found.' });
    if (call.status !== 'ringing') return socket.emit('call:error', { message: 'This call is no longer available.' });
    const participants = conversationParticipants(call.conversation_id);
    if (!participants.includes(userId)) return socket.emit('call:error', { message: "You're not part of this call." });

    db.prepare("UPDATE calls SET status = 'active', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(callId);
    db.prepare('INSERT OR IGNORE INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, ?)').run(callId, userId, new Date().toISOString());
    socket.join(`call:${callId}`);
    io.to(`call:${callId}`).emit('call:accepted', { callId, acceptedBy: userId });
  });

  socket.on('call:decline', ({ callId }) => {
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    if (!call) return;
    db.prepare("UPDATE calls SET status = 'declined', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(callId);
    io.to(`call:${callId}`).emit('call:declined', { callId, declinedBy: userId });
  });

  socket.on('call:end', ({ callId }) => {
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    if (!call) return;
    if (call.status === 'ringing' || call.status === 'active') {
      db.prepare("UPDATE calls SET status = 'ended', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(callId);
    }
    db.prepare("UPDATE call_participants SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE call_id = ? AND user_id = ?").run(callId, userId);
    io.to(`call:${callId}`).emit('call:ended', { callId, endedBy: userId });
  });

  // Pure relay for WebRTC SDP offers/answers and ICE candidates — the server never
  // inspects or stores the media/SDP content, it just forwards it between the two peers.
  socket.on('call:signal', ({ callId, data }) => {
    socket.to(`call:${callId}`).emit('call:signal', { callId, from: userId, data });
  });
}
