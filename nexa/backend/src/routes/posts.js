import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { isRestricted } from './users.js';
import { processMentionsAndHashtags } from '../content.js';
import { mediaMiddleware, removeLocalUpload, editsToJson, parseEdits } from '../uploads.js';

const router = Router();

function postDTO(row, viewerId) {
  const likeCount = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(row.id).c;
  const commentCount = db.prepare("SELECT COUNT(*) c FROM comments WHERE post_id = ? AND deleted_at IS NULL AND status = 'visible'").get(row.id).c;
  const likedByMe = viewerId ? !!db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(row.id, viewerId) : false;
  const savedByMe = viewerId ? !!db.prepare('SELECT 1 FROM saved_posts WHERE post_id = ? AND user_id = ?').get(row.id, viewerId) : false;
  const author = db.prepare(`SELECT id, username, display_name, avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM users WHERE id = ?`).get(row.user_id);
  return {
    id: row.id,
    caption: row.caption,
    imageUrl: row.image_url,
    // mediaUrl/mediaType supersede imageUrl (kept for older clients). Rows created before
    // video posts existed have no media_type, so any image_url there is an image.
    mediaUrl: row.image_url,
    mediaType: row.image_url ? (row.media_type || 'image') : null,
    edits: parseEdits(row.edits),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    likeCount, commentCount, likedByMe, savedByMe,
    author: toPublicUser(author),
  };
}

function commentDTO(r) {
  return {
    id: r.id, text: r.text, createdAt: r.created_at, editedAt: r.edited_at,
    parentCommentId: r.parent_comment_id, hidden: r.status === 'hidden',
    author: toPublicUser({ ...r, id: r.user_id }),
  };
}

router.post('/', requireAuth, (req, res) => {
  const { caption, imageUrl } = req.body || {};
  const cap = typeof caption === 'string' ? caption.slice(0, 2200) : '';
  if (!cap.trim() && !imageUrl) {
    return res.status(400).json({ error: { code: 'EMPTY_POST', message: 'Add a caption or an image to post.' } });
  }
  const id = uuid();
  db.prepare('INSERT INTO posts (id, user_id, caption, image_url) VALUES (?, ?, ?, ?)')
    .run(id, req.userId, cap, typeof imageUrl === 'string' ? imageUrl.slice(0, 2000) : null);
  processMentionsAndHashtags({ text: cap, sourceType: 'post', sourceId: id, actorId: req.userId, io: req.app.get('io') });
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.status(201).json({ post: postDTO(row, req.userId) });
});

// Post with a photo or video picked from the device (gallery, camera, downloaded file).
// `edits` (optional JSON) holds non-destructive video edit settings — see uploads.js.
router.post('/upload', requireAuth, mediaMiddleware('posts', ['image', 'video']), (req, res) => {
  const cap = typeof req.body.caption === 'string' ? req.body.caption.slice(0, 2200) : '';
  const id = uuid();
  db.prepare('INSERT INTO posts (id, user_id, caption, image_url, media_type, edits) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, cap, req.media.url, req.media.kind, req.media.kind === 'video' ? editsToJson(req.body.edits) : null);
  processMentionsAndHashtags({ text: cap, sourceType: 'post', sourceId: id, actorId: req.userId, io: req.app.get('io') });
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.status(201).json({ post: postDTO(row, req.userId) });
});

router.get('/:id', optionalAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  res.json({ post: postDTO(row, req.userId) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only delete your own posts.' } });
  db.prepare("UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

router.patch('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own posts.' } });
  const { caption, edits } = req.body || {};
  const newCaption = caption === undefined ? row.caption : caption;
  if (typeof newCaption !== 'string' || (!newCaption.trim() && !row.image_url)) {
    return res.status(400).json({ error: { code: 'EMPTY_POST', message: 'A post needs a caption or media.' } });
  }
  const cap = newCaption.slice(0, 2200);
  // Edit settings only apply to video posts (photo edits are baked into the file itself).
  const newEdits = edits !== undefined && row.media_type === 'video' ? editsToJson(edits) : row.edits;
  db.prepare("UPDATE posts SET caption = ?, edits = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(cap, newEdits, row.id);
  processMentionsAndHashtags({ text: cap, sourceType: 'post', sourceId: row.id, actorId: req.userId, io: req.app.get('io') });
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id);
  res.json({ post: postDTO(updated, req.userId) });
});

// Replace a post's photo/video with a new file (e.g. the re-edited photo from the editor).
// Ownership is checked BEFORE the upload middleware touches disk, via the pre-check below.
const ownPostOr4xx = (req, res, next) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  if (row.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own posts.' } });
  req.postRow = row;
  next();
};
router.post('/:id/media', requireAuth, ownPostOr4xx, mediaMiddleware('posts', ['image', 'video']), (req, res) => {
  const row = req.postRow;
  db.prepare("UPDATE posts SET image_url = ?, media_type = ?, edits = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(req.media.url, req.media.kind, req.media.kind === 'video' ? editsToJson(req.body.edits) : null, row.id);
  removeLocalUpload(row.image_url);
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id);
  res.json({ post: postDTO(updated, req.userId) });
});

router.post('/:id/like', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(req.userId, row.id);
  if (row.user_id !== req.userId) {
    db.prepare('INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), row.user_id, req.userId, 'like', row.id);
    req.app.get('io')?.to(`user:${row.user_id}`).emit('notification:new', { type: 'like' });
  }
  res.json({ post: postDTO(row, req.userId) });
});

router.delete('/:id/like', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.userId, row.id);
  res.json({ post: postDTO(row, req.userId) });
});

router.get('/:id/comments', optionalAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!post) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  const rows = db.prepare(`
    SELECT c.*, u.username, u.display_name, u.avatar_color, u.avatar_photo_url, u.profile_video_url, u.profile_video_cover_url, u.profile_video_muted, u.profile_display_mode FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at ASC LIMIT 200
  `).all(post.id);
  // A commenter restricted by the post's author is only visible to themselves and the author.
  // A comment the author has hidden is only visible to the author and the commenter.
  const visible = rows.filter(r => {
    if (isRestricted(post.user_id, r.user_id) && req.userId !== post.user_id && req.userId !== r.user_id) return false;
    if (r.status === 'hidden' && req.userId !== post.user_id && req.userId !== r.user_id) return false;
    return true;
  });
  res.json({ comments: visible.map(commentDTO) });
});

router.post('/:id/comments', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!post) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  const { text, parentCommentId } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: { code: 'EMPTY_COMMENT', message: 'Write something to comment.' } });
  }
  let parent = null;
  if (parentCommentId) {
    parent = db.prepare('SELECT * FROM comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL').get(parentCommentId, post.id);
    if (!parent) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The comment you\'re replying to no longer exists.' } });
  }
  const id = uuid();
  db.prepare('INSERT INTO comments (id, post_id, user_id, parent_comment_id, text) VALUES (?, ?, ?, ?, ?)')
    .run(id, post.id, req.userId, parent?.id || null, text.trim().slice(0, 1000));
  processMentionsAndHashtags({ text: text.trim(), sourceType: 'comment', sourceId: id, actorId: req.userId, io: req.app.get('io') });
  const notifyTarget = parent ? parent.user_id : post.user_id;
  if (notifyTarget !== req.userId) {
    db.prepare('INSERT INTO notifications (id, recipient_id, actor_id, type, target_id) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), notifyTarget, req.userId, 'comment', post.id);
    req.app.get('io')?.to(`user:${notifyTarget}`).emit('notification:new', { type: 'comment' });
  }
  const row = db.prepare(`
    SELECT c.*, u.username, u.display_name, u.avatar_color, u.avatar_photo_url, u.profile_video_url, u.profile_video_cover_url, u.profile_video_muted, u.profile_display_mode FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(id);
  res.status(201).json({ comment: commentDTO(row) });
});

router.patch('/:postId/comments/:commentId', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL').get(req.params.commentId, req.params.postId);
  if (!comment) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Comment not found.' } });
  if (comment.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only edit your own comments.' } });
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: { code: 'EMPTY_COMMENT', message: 'A comment needs some text.' } });
  }
  db.prepare("UPDATE comments SET text = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(text.trim().slice(0, 1000), comment.id);
  const row = db.prepare(`
    SELECT c.*, u.username, u.display_name, u.avatar_color, u.avatar_photo_url, u.profile_video_url, u.profile_video_cover_url, u.profile_video_muted, u.profile_display_mode FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(comment.id);
  res.json({ comment: commentDTO(row) });
});

router.delete('/:postId/comments/:commentId', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND post_id = ?').get(req.params.commentId, req.params.postId);
  if (!comment) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Comment not found.' } });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  // Either the commenter, or the post's author (moderating their own post), may delete it.
  if (comment.user_id !== req.userId && post.user_id !== req.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You can't delete this comment." } });
  }
  db.prepare("UPDATE comments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(comment.id);
  res.json({ ok: true });
});

// Hide: the post's author can hide a comment on their own post without deleting it —
// it stays visible to the author and the commenter, hidden from everyone else.
router.post('/:postId/comments/:commentId/hide', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  if (post.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the post author can hide comments.' } });
  db.prepare("UPDATE comments SET status = 'hidden' WHERE id = ? AND post_id = ?").run(req.params.commentId, req.params.postId);
  res.json({ ok: true, hidden: true });
});

router.delete('/:postId/comments/:commentId/hide', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  if (post.user_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the post author can unhide comments.' } });
  db.prepare("UPDATE comments SET status = 'visible' WHERE id = ? AND post_id = ?").run(req.params.commentId, req.params.postId);
  res.json({ ok: true, hidden: false });
});

router.post('/:id/save', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found.' } });
  db.prepare('INSERT OR IGNORE INTO saved_posts (user_id, post_id) VALUES (?, ?)').run(req.userId, row.id);
  res.json({ ok: true, saved: true });
});

router.delete('/:id/save', requireAuth, (req, res) => {
  db.prepare('DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?').run(req.userId, req.params.id);
  res.json({ ok: true, saved: false });
});

router.get('/saved/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.* FROM saved_posts sp JOIN posts p ON p.id = sp.post_id
    WHERE sp.user_id = ? AND p.deleted_at IS NULL ORDER BY sp.created_at DESC
  `).all(req.userId);
  res.json({ posts: rows.map(r => postDTO(r, req.userId)) });
});

export { postDTO, processMentionsAndHashtags };
export default router;
