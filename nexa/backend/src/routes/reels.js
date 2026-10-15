import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { processMentionsAndHashtags } from '../content.js';
import { reelUpload, MAX_REEL_UPLOAD_BYTES, MAX_REEL_VIDEO_BYTES, mediaMiddleware, removeLocalUpload, editsToJson, parseEdits } from '../uploads.js';

const router = Router();

function reelDTO(row, viewerId) {
  const likeCount = db.prepare('SELECT COUNT(*) c FROM reel_likes WHERE reel_id = ?').get(row.id).c;
  const commentCount = db.prepare('SELECT COUNT(*) c FROM reel_comments WHERE reel_id = ? AND deleted_at IS NULL').get(row.id).c;
  const likedByMe = viewerId ? !!db.prepare('SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?').get(row.id, viewerId) : false;
  const savedByMe = viewerId ? !!db.prepare('SELECT 1 FROM saved_reels WHERE reel_id = ? AND user_id = ?').get(row.id, viewerId) : false;
  const author = db.prepare(`SELECT id, username, display_name, avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM users WHERE id = ?`).get(row.user_id);
  return {
    id: row.id, videoUrl: row.video_url, caption: row.caption, edits: parseEdits(row.edits), createdAt: row.created_at, editedAt: row.edited_at,
    likeCount, commentCount, likedByMe, savedByMe,
    author: toPublicUser(author),
  };
}

export const REEL_URL_RE = /^https?:\/\/.+\.(mp4|webm|mov)(\?.*)?$/i;

router.post('/', requireAuth, (req, res) => {
  const { videoUrl, caption } = req.body || {};
  if (typeof videoUrl !== 'string' || !REEL_URL_RE.test(videoUrl.trim())) {
    return res.status(400).json({
      error: { code: 'INVALID_VIDEO_URL', message: 'Provide a direct link to an already-hosted .mp4/.webm/.mov file — this slice has no upload/transcode pipeline.' },
    });
  }
  const id = uuid();
  db.prepare('INSERT INTO reels (id, user_id, video_url, caption) VALUES (?, ?, ?, ?)')
    .run(id, req.userId, videoUrl.trim().slice(0, 2000), typeof caption === 'string' ? caption.slice(0, 2200) : '');
  processMentionsAndHashtags({ text: caption, sourceType: 'reel', sourceId: id, actorId: req.userId, io: req.app.get('io') });
  const row = db.prepare('SELECT * FROM reels WHERE id = ?').get(id);
  res.status(201).json({ reel: reelDTO(row, req.userId) });
});

// Real upload from the user's own device — gallery, camera roll, or a downloaded file —
// as opposed to POST / above, which only accepts a link to an already-hosted video.
// requireAuth runs first (on headers, unaffected by the multipart body) so an
// unauthenticated request is rejected before anything touches disk. Optional `edits`
// (JSON) holds the non-destructive edit settings — trim, speed, filter, mute, text overlays.
router.post('/upload', requireAuth, mediaMiddleware('reels', ['video'], { maxVideoBytes: MAX_REEL_VIDEO_BYTES }), (req, res) => {
  const { caption } = req.body || {};
  const id = uuid();
  db.prepare('INSERT INTO reels (id, user_id, video_url, caption, edits) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.userId, req.media.url, typeof caption === 'string' ? caption.slice(0, 2200) : '', editsToJson(req.body.edits));
  processMentionsAndHashtags({ text: caption, sourceType: 'reel', sourceId: id, actorId: req.userId, io: req.app.get('io') });
  const row = db.prepare('SELECT * FROM reels WHERE id = ?').get(id);
  res.status(201).json({ reel: reelDTO(row, req.userId) });
});

router.get('/feed', optionalAuth, (req, res) => {
  const cursor = req.query.cursor || '9999-12-31T23:59:59.999Z';
  const blocked = req.userId
    ? db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?').all(req.userId, req.userId).map(r => r.id)
    : [];
  const placeholders = blocked.length ? blocked.map(() => '?').join(',') : null;
  const rows = db.prepare(`
    SELECT * FROM reels WHERE deleted_at IS NULL AND created_at < ?
    ${placeholders ? `AND user_id NOT IN (${placeholders})` : ''}
    ORDER BY created_at DESC LIMIT 11
  `).all(cursor, ...(blocked.length ? blocked : []));
  const hasMore = rows.length > 10;
  const page = rows.slice(0, 10);
  res.json({ reels: page.map(r => reelDTO(r, req.userId)), nextCursor: hasMore ? page[page.length - 1].created_at : null });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reels WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only delete your own reels.' } });
  db.prepare("UPDATE reels SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

router.patch('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own reels.' } });
  const { caption, edits } = req.body || {};
  if (caption !== undefined && typeof caption !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide a caption.' } });
  }
  const cap = (caption === undefined ? row.caption : caption).slice(0, 2200);
  const newEdits = edits === undefined ? row.edits : editsToJson(edits);
  db.prepare("UPDATE reels SET caption = ?, edits = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(cap, newEdits, row.id);
  processMentionsAndHashtags({ text: cap, sourceType: 'reel', sourceId: row.id, actorId: req.userId, io: req.app.get('io') });
  const updated = db.prepare('SELECT * FROM reels WHERE id = ?').get(row.id);
  res.json({ reel: reelDTO(updated, req.userId) });
});

// Swap in a different video file for an existing reel (likes/comments are kept).
const ownReelOr4xx = (req, res, next) => {
  const row = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own reels.' } });
  req.reelRow = row;
  next();
};
router.post('/:id/media', requireAuth, ownReelOr4xx, mediaMiddleware('reels', ['video'], { maxVideoBytes: MAX_REEL_VIDEO_BYTES }), (req, res) => {
  const row = req.reelRow;
  db.prepare("UPDATE reels SET video_url = ?, edits = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(req.media.url, editsToJson(req.body.edits), row.id);
  removeLocalUpload(row.video_url);
  const updated = db.prepare('SELECT * FROM reels WHERE id = ?').get(row.id);
  res.json({ reel: reelDTO(updated, req.userId) });
});

router.post('/:id/like', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  db.prepare('INSERT OR IGNORE INTO reel_likes (user_id, reel_id) VALUES (?, ?)').run(req.userId, row.id);
  if (row.user_id !== req.userId) {
    db.prepare("INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, 'reel_like', ?)").run(uuid(), row.user_id, req.userId, row.id);
    req.app.get('io')?.to(`user:${row.user_id}`).emit('notification:new', { type: 'reel_like' });
  }
  res.json({ reel: reelDTO(row, req.userId) });
});

router.delete('/:id/like', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  db.prepare('DELETE FROM reel_likes WHERE user_id = ? AND reel_id = ?').run(req.userId, row.id);
  res.json({ reel: reelDTO(row, req.userId) });
});

router.get('/:id/comments', optionalAuth, (req, res) => {
  const reel = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!reel) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  const rows = db.prepare(`
    SELECT c.*, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM reel_comments c
    JOIN users u ON u.id = c.user_id WHERE c.reel_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at ASC LIMIT 200
  `).all(reel.id);
  res.json({ comments: rows.map(r => ({ id: r.id, text: r.text, createdAt: r.created_at, author: toPublicUser({ ...r, id: r.user_id }) })) });
});

router.post('/:id/comments', requireAuth, (req, res) => {
  const reel = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!reel) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: { code: 'EMPTY_COMMENT', message: 'Write something to comment.' } });
  }
  const id = uuid();
  db.prepare('INSERT INTO reel_comments (id, reel_id, user_id, text) VALUES (?, ?, ?, ?)').run(id, reel.id, req.userId, text.trim().slice(0, 1000));
  if (reel.user_id !== req.userId) {
    db.prepare("INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, 'reel_comment', ?)").run(uuid(), reel.user_id, req.userId, reel.id);
    req.app.get('io')?.to(`user:${reel.user_id}`).emit('notification:new', { type: 'reel_comment' });
  }
  const author = db.prepare(`SELECT username, display_name, avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM users WHERE id = ?`).get(req.userId);
  res.status(201).json({ comment: { id, text: text.trim().slice(0, 1000), createdAt: new Date().toISOString(), author: toPublicUser({ ...author, id: req.userId }) } });
});

router.post('/:id/save', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  db.prepare('INSERT OR IGNORE INTO saved_reels (user_id, reel_id) VALUES (?, ?)').run(req.userId, row.id);
  res.json({ ok: true, saved: true });
});

router.delete('/:id/save', requireAuth, (req, res) => {
  db.prepare('DELETE FROM saved_reels WHERE user_id = ? AND reel_id = ?').run(req.userId, req.params.id);
  res.json({ ok: true, saved: false });
});

router.get('/saved/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.* FROM saved_reels sr JOIN reels r ON r.id = sr.reel_id
    WHERE sr.user_id = ? AND r.deleted_at IS NULL ORDER BY sr.created_at DESC
  `).all(req.userId);
  res.json({ reels: rows.map(r => reelDTO(r, req.userId)) });
});

// Section 130 — Profile Reels History: Recently Watched / Liked / Saved / Created.
// "Shared" and "Drafts" aren't included — this build has no share-tracking table and no
// draft concept for reels, so those tabs would just always be empty rather than real.
// Watch history is capped per viewer: once it holds more than MAX_WATCH_HISTORY reels, the
// oldest-watched entries are deleted automatically, one for each new reel watched (a rolling
// window of the 200 most recent). Re-watching a reel only refreshes its timestamp, so it
// never counts twice.
export const MAX_WATCH_HISTORY = 200;
const trimWatchHistory = (userId) => {
  const count = db.prepare('SELECT COUNT(*) c FROM reel_views WHERE user_id = ?').get(userId).c;
  if (count <= MAX_WATCH_HISTORY) return;
  db.prepare(`
    DELETE FROM reel_views WHERE user_id = ? AND reel_id IN (
      SELECT reel_id FROM reel_views WHERE user_id = ? ORDER BY viewed_at ASC LIMIT ?
    )
  `).run(userId, userId, count - MAX_WATCH_HISTORY);
};

router.post('/:id/view', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reel not found.' } });
  db.prepare(`
    INSERT INTO reel_views (user_id, reel_id, viewed_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(user_id, reel_id) DO UPDATE SET viewed_at = excluded.viewed_at
  `).run(req.userId, row.id);
  trimWatchHistory(req.userId);
  res.json({ ok: true });
});

// Always scoped to req.userId from the auth token — there is no username/viewer param,
// so this is never reachable for anyone else's history. That's the entire privacy
// mechanism the spec asks for here: the data simply isn't queryable except as yourself.
router.get('/history/mine', requireAuth, (req, res) => {
  trimWatchHistory(req.userId); // also clears any overflow left from before the cap existed
  const withStamp = (rows, field) => rows.map(r => ({ ...reelDTO(r, req.userId), interactionAt: r[field] }));
  const watched = db.prepare(`
    SELECT r.*, v.viewed_at FROM reel_views v JOIN reels r ON r.id = v.reel_id
    WHERE v.user_id = ? AND r.deleted_at IS NULL ORDER BY v.viewed_at DESC LIMIT ${MAX_WATCH_HISTORY}
  `).all(req.userId);
  const liked = db.prepare(`
    SELECT r.*, l.created_at AS liked_at FROM reel_likes l JOIN reels r ON r.id = l.reel_id
    WHERE l.user_id = ? AND r.deleted_at IS NULL ORDER BY l.created_at DESC LIMIT 100
  `).all(req.userId);
  const saved = db.prepare(`
    SELECT r.*, s.created_at AS saved_at FROM saved_reels s JOIN reels r ON r.id = s.reel_id
    WHERE s.user_id = ? AND r.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 100
  `).all(req.userId);
  const created = db.prepare('SELECT * FROM reels WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100').all(req.userId);
  res.json({
    watched: withStamp(watched, 'viewed_at'),
    liked: withStamp(liked, 'liked_at'),
    saved: withStamp(saved, 'saved_at'),
    created: withStamp(created, 'created_at'),
  });
});

export default router;
