import { Router } from 'express';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function notificationDTO(r) {
  return {
    id: r.id,
    type: r.type,
    targetId: r.target_id,
    read: !!r.read,
    createdAt: r.created_at,
    actor: toPublicUser({ ...r, id: r.actor_id }),
  };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM notifications n
    JOIN users u ON u.id = n.actor_id
    WHERE n.recipient_id = ? ORDER BY n.created_at DESC LIMIT 50
  `).all(req.userId);
  const unreadCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE recipient_id = ? AND read = 0').get(req.userId).c;
  res.json({ notifications: rows.map(notificationDTO), unreadCount });
});

router.post('/:id/read', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!row || row.recipient_id !== req.userId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

router.post('/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE recipient_id = ? AND read = 0').run(req.userId);
  res.json({ ok: true });
});

export default router;
