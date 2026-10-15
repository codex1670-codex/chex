import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { isBlocked } from './users.js';
import { sendDirectMessage } from './messages.js';
import { processMentionsAndHashtags } from '../content.js';
import { SONGS, findSong } from '../songs.js';

const router = Router();
const NOTE_TTL_HOURS = 24;
const MOODS = ['none', 'happy', 'chilling', 'busy', 'celebrating', 'thinking'];

function isCloseFriend(ownerId, viewerId) {
  return !!db.prepare('SELECT 1 FROM close_friends WHERE owner_id = ? AND friend_id = ?').get(ownerId, viewerId);
}

function noteDTO(row) {
  const likeCount = db.prepare('SELECT COUNT(*) c FROM note_likes WHERE note_id = ?').get(row.id).c;
  const author = db.prepare(`SELECT id, username, display_name, avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM users WHERE id = ?`).get(row.user_id);
  return {
    id: row.id, text: row.text, emoji: row.emoji, mood: row.mood, audience: row.audience,
    createdAt: row.created_at, editedAt: row.edited_at, expiresAt: row.expires_at, likeCount,
    author: toPublicUser(author),
    song: row.song_id ? { id: row.song_id, title: row.song_title, artist: row.song_artist, previewUrl: row.song_url, language: findSong(row.song_id)?.language } : null,
  };
}

router.get('/moods', (_req, res) => res.json({ moods: MOODS }));

// The "Spotify" picker for note music — a fixed catalog of 20 tracks (see songs.js).
// No search/OAuth: the client renders this whole list and lets the person pick one.
router.get('/songs', (_req, res) => res.json({ songs: SONGS }));

router.post('/', requireAuth, (req, res) => {
  const { text, emoji, mood, audience, songId } = req.body || {};
  const cleanText = typeof text === 'string' ? text.trim().slice(0, 60) : '';
  const song = songId ? findSong(songId) : null;
  if (songId && !song) {
    return res.status(400).json({ error: { code: 'INVALID_SONG', message: 'Pick a song from the list.' } });
  }
  if (!cleanText && !emoji && !song) {
    return res.status(400).json({ error: { code: 'EMPTY_NOTE', message: 'Add some text, an emoji, or a song for your note.' } });
  }
  const validAudience = ['everyone', 'followers', 'close_friends', 'no_one'].includes(audience) ? audience : 'followers';
  const id = uuid();
  const expiresAt = new Date(Date.now() + NOTE_TTL_HOURS * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO notes (id, user_id, text, emoji, mood, audience, song_id, song_title, song_artist, song_url, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      id = excluded.id, text = excluded.text, emoji = excluded.emoji, mood = excluded.mood,
      audience = excluded.audience, song_id = excluded.song_id, song_title = excluded.song_title,
      song_artist = excluded.song_artist, song_url = excluded.song_url,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), expires_at = excluded.expires_at
  `).run(id, req.userId, cleanText, emoji || null, MOODS.includes(mood) ? mood : null, validAudience,
    song?.id || null, song?.title || null, song?.artist || null, song?.previewUrl || null, expiresAt);

  const row = db.prepare('SELECT * FROM notes WHERE user_id = ?').get(req.userId);
  processMentionsAndHashtags({ text: cleanText, sourceType: 'note', sourceId: row.id, actorId: req.userId, io: req.app.get('io') });
  res.status(201).json({ note: noteDTO(row) });
});

router.delete('/mine', requireAuth, (req, res) => {
  db.prepare('DELETE FROM notes WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

// True edit: updates content but preserves the original created_at/expires_at, unlike
// POST / (which is an upsert that resets the 24h timer — intended for posting anew).
router.patch('/mine', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM notes WHERE user_id = ?').get(req.userId);
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "You don't have an active note to edit." } });
  const { text, emoji, mood, audience, songId } = req.body || {};
  const cleanText = typeof text === 'string' ? text.trim().slice(0, 60) : existing.text;
  // songId: undefined leaves the existing song untouched, null/'' clears it, a valid id swaps it.
  let song, songTouched = songId !== undefined;
  if (songTouched) {
    song = songId ? findSong(songId) : null;
    if (songId && !song) return res.status(400).json({ error: { code: 'INVALID_SONG', message: 'Pick a song from the list.' } });
  }
  const hasSong = songTouched ? !!song : !!existing.song_id;
  if (!cleanText && !(emoji || existing.emoji) && !hasSong) {
    return res.status(400).json({ error: { code: 'EMPTY_NOTE', message: 'A note needs some text, an emoji, or a song.' } });
  }
  const validAudience = ['everyone', 'followers', 'close_friends', 'no_one'].includes(audience) ? audience : existing.audience;
  db.prepare(`
    UPDATE notes SET text = ?, emoji = ?, mood = ?, audience = ?, song_id = ?, song_title = ?, song_artist = ?, song_url = ?,
      edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_id = ?
  `).run(
    cleanText, emoji !== undefined ? (emoji || null) : existing.emoji, MOODS.includes(mood) ? mood : existing.mood, validAudience,
    songTouched ? (song?.id || null) : existing.song_id,
    songTouched ? (song?.title || null) : existing.song_title,
    songTouched ? (song?.artist || null) : existing.song_artist,
    songTouched ? (song?.previewUrl || null) : existing.song_url,
    req.userId,
  );
  const row = db.prepare('SELECT * FROM notes WHERE user_id = ?').get(req.userId);
  res.json({ note: noteDTO(row) });
});

// Notes from people I follow (plus my own), respecting audience + block/mute + expiry.
// Mutes are content-silencing (see schema comment) so a muted author's notes are hidden
// from this bar exactly like their posts are hidden from the feed — muting isn't
// blocking, so the author is untouched otherwise (still followable, messageable, etc.).
router.get('/feed', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT n.* FROM notes n
    WHERE n.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (
        n.user_id = ?
        OR n.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)
      )
      AND n.user_id NOT IN (
        SELECT blocked_id FROM blocks WHERE blocker_id = ?
        UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?
        UNION SELECT muted_id FROM mutes WHERE muter_id = ?
      )
    ORDER BY n.created_at DESC
  `).all(req.userId, req.userId, req.userId, req.userId, req.userId);

  const visible = rows.filter(r => {
    if (r.user_id === req.userId) return true;
    if (r.audience === 'no_one') return false;
    if (r.audience === 'close_friends') return isCloseFriend(r.user_id, req.userId);
    return true; // 'everyone' or 'followers' — viewer already passed the follow-graph filter above
  });

  res.json({ notes: visible.map(noteDTO) });
});

router.post('/:id/like', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found.' } });
  db.prepare('INSERT OR IGNORE INTO note_likes (note_id, user_id) VALUES (?, ?)').run(row.id, req.userId);
  res.json({ note: noteDTO(row) });
});

router.delete('/:id/like', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found.' } });
  db.prepare('DELETE FROM note_likes WHERE note_id = ? AND user_id = ?').run(row.id, req.userId);
  res.json({ note: noteDTO(row) });
});

// Replying to a note sends a real direct message to the note's author,
// going through the exact same message-request gate as any other message.
router.post('/:id/reply', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Note not found.' } });
  const author = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
  if (isBlocked(req.userId, row.user_id)) {
    return res.status(403).json({ error: { code: 'BLOCKED', message: "You can't reply to this note." } });
  }
  const { text } = req.body || {};
  const result = sendDirectMessage({ fromUserId: req.userId, toUsername: author.username, text, io: req.app.get('io') });
  if (result.httpStatus < 400) {
    db.prepare("INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, 'note_reply', ?)")
      .run(uuid(), row.user_id, req.userId, row.id);
    req.app.get('io')?.to(`user:${row.user_id}`).emit('notification:new', { type: 'note_reply' });
  }
  res.status(result.httpStatus).json(result.body);
});

export default router;
