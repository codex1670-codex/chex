import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { processMentionsAndHashtags } from '../content.js';
import { mediaMiddleware, removeLocalUpload, editsToJson, parseEdits, playedSeconds, checkVideoDurationSeconds, MAX_STORY_VIDEO_SECONDS } from '../uploads.js';
import fs from 'fs';

const router = Router();
const STORY_TTL_HOURS = 24;

function isCloseFriend(ownerId, viewerId) {
  return !!db.prepare('SELECT 1 FROM close_friends WHERE owner_id = ? AND friend_id = ?').get(ownerId, viewerId);
}

function storyDTO(row, viewerId) {
  const viewCount = db.prepare('SELECT COUNT(*) c FROM story_views WHERE story_id = ?').get(row.id).c;
  const viewedByMe = viewerId ? !!db.prepare('SELECT 1 FROM story_views WHERE story_id = ? AND viewer_id = ?').get(row.id, viewerId) : false;
  return {
    id: row.id, mediaType: row.media_type, content: row.content, caption: row.caption || '',
    edits: parseEdits(row.edits), background: row.background,
    audience: row.audience, createdAt: row.created_at, expiresAt: row.expires_at,
    viewCount, viewedByMe,
  };
}

router.post('/', requireAuth, (req, res) => {
  const { mediaType, content, background, audience } = req.body || {};
  const type = mediaType === 'image' ? 'image' : 'text';
  const cleanContent = typeof content === 'string' ? content.trim().slice(0, type === 'text' ? 200 : 2000) : '';
  if (!cleanContent) {
    return res.status(400).json({ error: { code: 'EMPTY_STORY', message: type === 'image' ? 'Provide an image URL.' : 'Write something for your story.' } });
  }
  const validAudience = ['everyone', 'followers', 'close_friends'].includes(audience) ? audience : 'everyone';
  const id = uuid();
  const expiresAt = new Date(Date.now() + STORY_TTL_HOURS * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO stories (id, user_id, media_type, content, background, audience, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, type, cleanContent, typeof background === 'string' ? background.slice(0, 20) : '#7C5CFF', validAudience, expiresAt);

  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
  if (type === 'text') processMentionsAndHashtags({ text: cleanContent, sourceType: 'story', sourceId: id, actorId: req.userId, io: req.app.get('io') });
  res.status(201).json({ story: storyDTO(row, req.userId) });
});

// A story video can be at most MAX_STORY_VIDEO_SECONDS of *playback* (null = no cap): the trim window
// divided by playback speed. The client enforces this in the editor; this is the server
// check. If the edits don't pin an end point we fall back to ffprobe (when installed).
async function storyVideoTooLong(filePath, editsJson) {
  if (!MAX_STORY_VIDEO_SECONDS) return false; // no cap on story length
  const edits = parseEdits(editsJson);
  const probed = await checkVideoDurationSeconds(filePath); // null if ffprobe missing
  const secs = playedSeconds(edits, probed);
  return secs !== null && secs > MAX_STORY_VIDEO_SECONDS + 0.5;
}

// Express 4 doesn't forward rejected promises from async handlers to the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const storyAudience = (a) => (['everyone', 'followers', 'close_friends'].includes(a) ? a : 'everyone');

// Story from a photo or video picked on the device (gallery, camera, downloaded file).
router.post('/upload', requireAuth, mediaMiddleware('stories', ['image', 'video']), wrap(async (req, res) => {
  const editsJson = req.media.kind === 'video' ? editsToJson(req.body.edits) : null;
  if (req.media.kind === 'video' && await storyVideoTooLong(req.media.filePath, editsJson)) {
    fs.unlink(req.media.filePath, () => {});
    return res.status(400).json({ error: { code: 'VIDEO_TOO_LONG', message: `Story videos can be up to ${MAX_STORY_VIDEO_SECONDS} seconds — trim it in the editor.` } });
  }
  const id = uuid();
  const expiresAt = new Date(Date.now() + STORY_TTL_HOURS * 3600 * 1000).toISOString();
  const caption = typeof req.body.caption === 'string' ? req.body.caption.trim().slice(0, 200) : '';
  db.prepare(`
    INSERT INTO stories (id, user_id, media_type, content, caption, edits, background, audience, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, '#000000', ?, ?)
  `).run(id, req.userId, req.media.kind, req.media.url, caption || null, editsJson, storyAudience(req.body.audience), expiresAt);
  if (caption) processMentionsAndHashtags({ text: caption, sourceType: 'story', sourceId: id, actorId: req.userId, io: req.app.get('io') });
  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
  res.status(201).json({ story: storyDTO(row, req.userId) });
}));

// Edit a story after posting: caption, audience and (for videos) the edit settings.
router.patch('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM stories WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found or expired.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own stories.' } });
  const { caption, audience, edits } = req.body || {};
  const newEdits = edits !== undefined && row.media_type === 'video' ? editsToJson(edits) : row.edits;
  if (row.media_type === 'video' && edits !== undefined) {
    const secs = playedSeconds(parseEdits(newEdits), null);
    if (MAX_STORY_VIDEO_SECONDS && secs !== null && secs > MAX_STORY_VIDEO_SECONDS + 0.5) {
      return res.status(400).json({ error: { code: 'VIDEO_TOO_LONG', message: `Story videos can be up to ${MAX_STORY_VIDEO_SECONDS} seconds.` } });
    }
  }
  // Text stories keep their text in `content`; media stories use the separate caption.
  let content = row.content, newCaption = row.caption;
  if (typeof caption === 'string') {
    if (row.media_type === 'text') {
      if (!caption.trim()) return res.status(400).json({ error: { code: 'EMPTY_STORY', message: 'Write something for your story.' } });
      content = caption.trim().slice(0, 200);
    } else {
      newCaption = caption.trim().slice(0, 200) || null;
    }
  }
  db.prepare('UPDATE stories SET content = ?, caption = ?, edits = ?, audience = ? WHERE id = ?')
    .run(content, newCaption, newEdits, audience === undefined ? row.audience : storyAudience(audience), row.id);
  const updated = db.prepare('SELECT * FROM stories WHERE id = ?').get(row.id);
  res.json({ story: storyDTO(updated, req.userId) });
});

// Replace a story's photo/video (e.g. the re-edited photo). The 24h clock is NOT reset.
const ownStoryOr4xx = (req, res, next) => {
  const row = db.prepare('SELECT * FROM stories WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found or expired.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own stories.' } });
  if (row.media_type === 'text') return res.status(400).json({ error: { code: 'NOT_MEDIA_STORY', message: 'Text stories have no media to replace.' } });
  req.storyRow = row;
  next();
};
router.post('/:id/media', requireAuth, ownStoryOr4xx, mediaMiddleware('stories', ['image', 'video']), wrap(async (req, res) => {
  const row = req.storyRow;
  const editsJson = req.media.kind === 'video' ? editsToJson(req.body.edits) : null;
  if (req.media.kind === 'video' && await storyVideoTooLong(req.media.filePath, editsJson)) {
    fs.unlink(req.media.filePath, () => {});
    return res.status(400).json({ error: { code: 'VIDEO_TOO_LONG', message: `Story videos can be up to ${MAX_STORY_VIDEO_SECONDS} seconds — trim it in the editor.` } });
  }
  db.prepare('UPDATE stories SET content = ?, media_type = ?, edits = ? WHERE id = ?').run(req.media.url, req.media.kind, editsJson, row.id);
  removeLocalUpload(row.content);
  const updated = db.prepare('SELECT * FROM stories WHERE id = ?').get(row.id);
  res.json({ story: storyDTO(updated, req.userId) });
}));

// Active stories from people I follow (plus mine), grouped by author, respecting audience + block.
router.get('/feed', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM stories s
    JOIN users u ON u.id = s.user_id
    WHERE s.deleted_at IS NULL
      AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (
        s.user_id = ?
        OR s.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)
      )
      AND s.user_id NOT IN (
        SELECT blocked_id FROM blocks WHERE blocker_id = ?
        UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?
      )
    ORDER BY s.created_at ASC
  `).all(req.userId, req.userId, req.userId, req.userId);

  const visible = rows.filter(r => {
    if (r.user_id === req.userId) return true;
    if (r.audience === 'close_friends') return isCloseFriend(r.user_id, req.userId);
    return true;
  });

  const byAuthor = new Map();
  for (const r of visible) {
    if (!byAuthor.has(r.user_id)) {
      byAuthor.set(r.user_id, {
        author: toPublicUser({ ...r, id: r.user_id }),
        stories: [],
      });
    }
    byAuthor.get(r.user_id).stories.push(storyDTO(r, req.userId));
  }
  // put my own group first
  const groups = [...byAuthor.values()];
  groups.sort((a, b) => (a.author.id === req.userId ? -1 : b.author.id === req.userId ? 1 : 0));

  res.json({ groups });
});

router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM stories WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found or expired.' } });
  if (row.user_id !== req.userId) {
    db.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id) VALUES (?, ?)').run(row.id, req.userId);
  }
  res.json({ story: storyDTO(row, req.userId) });
});

router.get('/:id/viewers', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the author can see viewers.' } });
  const viewers = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_color, sv.viewed_at FROM story_views sv
    JOIN users u ON u.id = sv.viewer_id WHERE sv.story_id = ? ORDER BY sv.viewed_at DESC
  `).all(row.id);
  res.json({ viewers: viewers.map(v => ({ id: v.id, username: v.username, displayName: v.display_name, avatarColor: v.avatar_color, viewedAt: v.viewed_at })) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Story not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only delete your own stories.' } });
  db.prepare("UPDATE stories SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

export default router;
