import { Router } from 'express';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function callDTO(row, viewerId) {
  const participants = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM call_participants cp
    JOIN users u ON u.id = cp.user_id WHERE cp.call_id = ?
  `).all(row.id);
  return {
    id: row.id, conversationId: row.conversation_id, type: row.type, status: row.status,
    callerId: row.caller_id, startedAt: row.started_at, answeredAt: row.answered_at, endedAt: row.ended_at,
    participants: participants.map(toPublicUser),
    wasMissed: row.status === 'missed' && row.caller_id !== viewerId,
  };
}

router.get('/history', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.* FROM calls c
    JOIN call_participants cp ON cp.call_id = c.id
    WHERE cp.user_id = ? ORDER BY c.started_at DESC LIMIT 50
  `).all(req.userId);
  res.json({ calls: rows.map(r => callDTO(r, req.userId)) });
});

router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Call not found.' } });
  const isParticipant = db.prepare('SELECT 1 FROM call_participants WHERE call_id = ? AND user_id = ?').get(row.id, req.userId);
  if (!isParticipant) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You weren't part of this call." } });
  res.json({ call: callDTO(row, req.userId) });
});

export default router;
