import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { postDTO } from './posts.js';

const router = Router();
const PAGE_SIZE = 10;

function blockedIds(userId) {
  const rows = db.prepare(`
    SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?
    UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?
    UNION SELECT muted_id AS id FROM mutes WHERE muter_id = ?
  `).all(userId, userId, userId);
  return rows.map(r => r.id);
}

router.get('/following', requireAuth, (req, res) => {
  const cursor = req.query.cursor || '9999-12-31T23:59:59.999Z';
  const blocked = blockedIds(req.userId);
  const placeholders = blocked.length ? blocked.map(() => '?').join(',') : null;

  const sql = `
    SELECT p.* FROM posts p
    WHERE p.deleted_at IS NULL
      AND p.created_at < ?
      AND (p.user_id IN (SELECT followed_id FROM follows WHERE follower_id = ?) OR p.user_id = ?)
      ${placeholders ? `AND p.user_id NOT IN (${placeholders})` : ''}
    ORDER BY p.created_at DESC
    LIMIT ?
  `;
  const params = [cursor, req.userId, req.userId, ...(blocked.length ? blocked : []), PAGE_SIZE + 1];
  const rows = db.prepare(sql).all(...params);

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  res.json({
    posts: page.map(r => postDTO(r, req.userId)),
    nextCursor: hasMore ? page[page.length - 1].created_at : null,
  });
});

router.get('/foryou', requireAuth, (req, res) => {
  const cursor = req.query.cursor || '9999-12-31T23:59:59.999Z';
  const blocked = blockedIds(req.userId);
  const placeholders = blocked.length ? blocked.map(() => '?').join(',') : null;

  // Simple "for you" ranking for the vertical slice: recency + engagement (likes+comments),
  // excluding blocked users. A full recommendation system is out of scope for this slice.
  const sql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
    FROM posts p
    WHERE p.deleted_at IS NULL
      AND p.created_at < ?
      ${placeholders ? `AND p.user_id NOT IN (${placeholders})` : ''}
    ORDER BY (like_count * 2 + comment_count * 3) DESC, p.created_at DESC
    LIMIT ?
  `;
  const params = [cursor, ...(blocked.length ? blocked : []), PAGE_SIZE + 1];
  const rows = db.prepare(sql).all(...params);

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  res.json({
    posts: page.map(r => postDTO(r, req.userId)),
    nextCursor: hasMore ? page[page.length - 1].created_at : null,
  });
});

export default router;
