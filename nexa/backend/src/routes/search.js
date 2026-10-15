import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { profileFor } from './users.js';
import { postDTO } from './posts.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], hashtags: [] });

  const users = db.prepare(`
    SELECT * FROM users WHERE account_status = 'active' AND (username LIKE ? OR display_name LIKE ?)
    AND id != ? LIMIT 8
  `).all(`%${q}%`, `%${q}%`, req.userId);

  const normalizedTag = q.replace(/^#/, '').toLowerCase();
  const hashtags = db.prepare(`
    SELECT h.*, (SELECT COUNT(*) FROM post_hashtags ph WHERE ph.hashtag_id = h.id) +
                (SELECT COUNT(*) FROM reel_hashtags rh WHERE rh.hashtag_id = h.id) AS post_count
    FROM hashtags h WHERE h.tag LIKE ? ORDER BY post_count DESC LIMIT 8
  `).all(`%${normalizedTag}%`);

  res.json({
    users: users.map(u => profileFor(u, req.userId)),
    hashtags: hashtags.map(h => ({ tag: h.tag, postCount: h.post_count })),
  });
});

router.get('/hashtags/:tag', requireAuth, (req, res) => {
  const tag = req.params.tag.replace(/^#/, '').toLowerCase();
  const hashtag = db.prepare('SELECT * FROM hashtags WHERE tag = ?').get(tag);
  if (!hashtag) return res.json({ tag, posts: [] });

  const postRows = db.prepare(`
    SELECT p.* FROM post_hashtags ph JOIN posts p ON p.id = ph.post_id
    WHERE ph.hashtag_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 30
  `).all(hashtag.id);

  res.json({ tag, posts: postRows.map(p => postDTO(p, req.userId)) });
});

export default router;
