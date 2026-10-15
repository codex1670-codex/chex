import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { createSeededRoom } from './games.js';

const router = Router();

function tournamentDTO(t) {
  const participants = db.prepare(`
    SELECT tp.*, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM tournament_participants tp
    JOIN users u ON u.id = tp.user_id WHERE tp.tournament_id = ? ORDER BY tp.wins DESC, tp.losses ASC
  `).all(t.id);
  const matches = db.prepare(`
    SELECT tm.*, r.status AS room_status, r.invite_code FROM tournament_matches tm
    JOIN game_rooms r ON r.id = tm.room_id WHERE tm.tournament_id = ?
  `).all(t.id);
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(t.game_id);
  return {
    id: t.id, name: t.name, status: t.status, hostId: t.host_id,
    game: { id: game.id, name: game.name },
    participants: participants.map(p => ({
      user: toPublicUser({ ...p, id: p.user_id }),
      wins: p.wins, losses: p.losses,
    })),
    matches: matches.map(m => ({
      id: m.id, roomId: m.room_id, inviteCode: m.invite_code, roomStatus: m.room_status,
      playerAId: m.player_a_id, playerBId: m.player_b_id, winnerId: m.winner_id,
    })),
    createdAt: t.created_at, startedAt: t.started_at, endedAt: t.ended_at,
  };
}

router.post('/', requireAuth, (req, res) => {
  const { gameId, name } = req.body || {};
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'active'").get(gameId);
  if (!game) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That game is not available.' } });
  const id = uuid();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO tournaments (id, game_id, host_id, name) VALUES (?, ?, ?, ?)')
      .run(id, gameId, req.userId, (name || `${game.name} Tournament`).slice(0, 60));
    db.prepare('INSERT INTO tournament_participants (tournament_id, user_id) VALUES (?, ?)').run(id, req.userId);
  });
  tx();
  res.status(201).json({ tournament: tournamentDTO(db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id)) });
});

// Privacy-respecting discovery: only tournaments hosted by people you follow, still open.
router.get('/open', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.* FROM tournaments t
    JOIN follows f ON f.followed_id = t.host_id AND f.follower_id = ?
    WHERE t.status = 'open' ORDER BY t.created_at DESC LIMIT 30
  `).all(req.userId);
  res.json({ tournaments: rows.map(tournamentDTO) });
});

router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.* FROM tournaments t JOIN tournament_participants tp ON tp.tournament_id = t.id
    WHERE tp.user_id = ? ORDER BY t.created_at DESC
  `).all(req.userId);
  res.json({ tournaments: rows.map(tournamentDTO) });
});

router.get('/:id', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tournament not found.' } });
  res.json({ tournament: tournamentDTO(t) });
});

router.post('/:id/join', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tournament not found.' } });
  if (t.status !== 'open') return res.status(409).json({ error: { code: 'CLOSED', message: 'This tournament already started.' } });
  db.prepare('INSERT OR IGNORE INTO tournament_participants (tournament_id, user_id) VALUES (?, ?)').run(t.id, req.userId);
  res.json({ tournament: tournamentDTO(t) });
});

// Host starts the tournament: generates every pairwise match (round robin) as a real,
// pre-seeded, playable game room. Requires at least 2 participants.
router.post('/:id/start', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tournament not found.' } });
  if (t.host_id !== req.userId) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the host can start the tournament.' } });
  if (t.status !== 'open') return res.status(409).json({ error: { code: 'ALREADY_STARTED', message: 'This tournament already started.' } });

  const participants = db.prepare('SELECT user_id FROM tournament_participants WHERE tournament_id = ?').all(t.id).map(r => r.user_id);
  if (participants.length < 2) {
    return res.status(400).json({ error: { code: 'NOT_ENOUGH_PLAYERS', message: 'Need at least 2 participants to start.' } });
  }

  const tx = db.transaction(() => {
    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        const { room, error } = createSeededRoom(t.game_id, [participants[i], participants[j]]);
        if (error) throw new Error(error);
        db.prepare('INSERT INTO tournament_matches (id, tournament_id, room_id, player_a_id, player_b_id) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), t.id, room.id, participants[i], participants[j]);
      }
    }
    db.prepare("UPDATE tournaments SET status = 'active', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(t.id);
  });
  try { tx(); } catch (err) {
    return res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Could not generate matches.' } });
  }

  res.json({ tournament: tournamentDTO(db.prepare('SELECT * FROM tournaments WHERE id = ?').get(t.id)) });
});

// Called internally by gameEngine.js whenever a game_room finishes, so tournament standings
// and completion state stay accurate without the client ever reporting a result itself.
export function recordTournamentResultIfApplicable(roomId, winnerId) {
  const match = db.prepare('SELECT * FROM tournament_matches WHERE room_id = ?').get(roomId);
  if (!match || match.winner_id) return;

  const tx = db.transaction(() => {
    db.prepare('UPDATE tournament_matches SET winner_id = ? WHERE id = ?').run(winnerId === 'draw' ? null : winnerId, match.id);
    if (winnerId && winnerId !== 'draw') {
      const loserId = winnerId === match.player_a_id ? match.player_b_id : match.player_a_id;
      db.prepare('UPDATE tournament_participants SET wins = wins + 1 WHERE tournament_id = ? AND user_id = ?').run(match.tournament_id, winnerId);
      db.prepare('UPDATE tournament_participants SET losses = losses + 1 WHERE tournament_id = ? AND user_id = ?').run(match.tournament_id, loserId);
    }
    const remaining = db.prepare('SELECT COUNT(*) c FROM tournament_matches WHERE tournament_id = ? AND winner_id IS NULL').get(match.tournament_id).c;
    if (remaining === 0) {
      db.prepare("UPDATE tournaments SET status = 'finished', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(match.tournament_id);
    }
  });
  tx();
}

export default router;
