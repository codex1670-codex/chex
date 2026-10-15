import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db, { toPublicUser, USER_MEDIA_COLUMNS_SQL } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendDirectMessage } from './messages.js';

const router = Router();

function genInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function roomDTO(room) {
  const players = db.prepare(`
    SELECT gp.*, u.username, u.display_name, u.avatar_color, ${USER_MEDIA_COLUMNS_SQL} FROM game_players gp
    JOIN users u ON u.id = gp.user_id
    WHERE gp.room_id = ? AND gp.left_at IS NULL ORDER BY gp.slot ASC
  `).all(room.id);
  return {
    id: room.id,
    gameId: room.game_id,
    hostId: room.host_id,
    inviteCode: room.invite_code,
    capacity: room.capacity,
    status: room.status,
    state: JSON.parse(room.state || '{}'),
    players: players.map(p => ({
      slot: p.slot, ready: !!p.ready,
      user: toPublicUser({ ...p, id: p.user_id }),
    })),
    createdAt: room.created_at, startedAt: room.started_at, endedAt: room.ended_at,
  };
}

router.get('/', (_req, res) => {
  const games = db.prepare("SELECT * FROM games WHERE status = 'active'").all();
  res.json({
    games: games.map(g => {
      const openRooms = db.prepare("SELECT COUNT(*) c FROM game_rooms WHERE game_id = ? AND status = 'waiting'").get(g.id).c;
      return { id: g.id, name: g.name, category: g.category, minPlayers: g.min_players, maxPlayers: g.max_players, openRooms };
    }),
  });
});

// Real, privacy-respecting "Friends" discovery: only rooms hosted by people you follow,
// still waiting for a second player. Never exposes rooms from users you don't follow —
// there's no public/global room browsing, since that would leak who's online to strangers.
router.get('/rooms/friends', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.* FROM game_rooms r
    JOIN follows f ON f.followed_id = r.host_id AND f.follower_id = ?
    WHERE r.status = 'waiting'
    ORDER BY r.created_at DESC LIMIT 30
  `).all(req.userId);
  res.json({ rooms: rows.map(roomDTO) });
});


router.get('/rooms/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.* FROM game_rooms r JOIN game_players gp ON gp.room_id = r.id
    WHERE gp.user_id = ? AND gp.left_at IS NULL AND r.status != 'finished'
    ORDER BY r.created_at DESC
  `).all(req.userId);
  res.json({ rooms: rows.map(roomDTO) });
});

export function createRoom(gameId, hostUserId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND status = ?').get(gameId, 'active');
  if (!game) return { error: 'That game is not available.' };
  const roomId = uuid();
  let code = genInviteCode();
  while (db.prepare('SELECT 1 FROM game_rooms WHERE invite_code = ?').get(code)) code = genInviteCode();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO game_rooms (id, game_id, host_id, invite_code, capacity, state) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, game.id, hostUserId, code, game.max_players, JSON.stringify({}));
    db.prepare('INSERT INTO game_players (room_id, user_id, slot) VALUES (?, ?, 0)').run(roomId, hostUserId);
  });
  tx();
  return { room: db.prepare('SELECT * FROM game_rooms WHERE id = ?').get(roomId), game };
}

router.post('/rooms', requireAuth, (req, res) => {
  const { gameId } = req.body || {};
  const result = createRoom(gameId, req.userId);
  if (result.error) return res.status(404).json({ error: { code: 'NOT_FOUND', message: result.error } });
  res.status(201).json({ room: roomDTO(result.room) });
});

// Used by the tournament bracket generator: creates a room with both players pre-seated,
// already 'ready', so matches start as soon as both players open the room.
export function createSeededRoom(gameId, playerIds) {
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND status = ?').get(gameId, 'active');
  if (!game) return { error: 'That game is not available.' };
  const roomId = uuid();
  let code = genInviteCode();
  while (db.prepare('SELECT 1 FROM game_rooms WHERE invite_code = ?').get(code)) code = genInviteCode();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO game_rooms (id, game_id, host_id, invite_code, capacity, state) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, game.id, playerIds[0], code, playerIds.length, JSON.stringify({}));
    playerIds.forEach((uid, slot) => {
      db.prepare('INSERT INTO game_players (room_id, user_id, slot) VALUES (?, ?, ?)').run(roomId, uid, slot);
    });
  });
  tx();
  return { room: db.prepare('SELECT * FROM game_rooms WHERE id = ?').get(roomId), game };
}

export function joinRoomByCode(inviteCode, userId) {
  const room = db.prepare('SELECT * FROM game_rooms WHERE invite_code = ?').get(String(inviteCode || '').toUpperCase().trim());
  if (!room) return { error: 'No room with that code.' };
  if (room.status !== 'waiting') return { error: 'This room already started or ended.' };
  const existing = db.prepare('SELECT * FROM game_players WHERE room_id = ? AND user_id = ?').get(room.id, userId);
  if (existing) return { room };
  const activeCount = db.prepare('SELECT COUNT(*) c FROM game_players WHERE room_id = ? AND left_at IS NULL').get(room.id).c;
  if (activeCount >= room.capacity) return { error: 'This room is full.' };
  const usedSlots = db.prepare('SELECT slot FROM game_players WHERE room_id = ? AND left_at IS NULL').all(room.id).map(r => r.slot);
  let slot = 0;
  while (usedSlots.includes(slot)) slot++;
  db.prepare('INSERT INTO game_players (room_id, user_id, slot) VALUES (?, ?, ?)').run(room.id, userId, slot);
  return { room: db.prepare('SELECT * FROM game_rooms WHERE id = ?').get(room.id) };
}

router.post('/rooms/join', requireAuth, (req, res) => {
  const { inviteCode } = req.body || {};
  const result = joinRoomByCode(inviteCode, req.userId);
  if (result.error) {
    const status = result.error === 'This room is full.' || result.error === 'This room already started or ended.' ? 409 : 404;
    return res.status(status).json({ error: { code: status === 409 ? 'ROOM_UNAVAILABLE' : 'NOT_FOUND', message: result.error } });
  }
  const dto = roomDTO(result.room);
  req.app.get('io')?.to(`game:${result.room.id}`).emit('game:state', dto);
  res.json({ room: dto });
});

router.get('/rooms/:id', requireAuth, (req, res) => {
  const room = db.prepare('SELECT * FROM game_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Room not found.' } });
  const isPlayer = db.prepare('SELECT 1 FROM game_players WHERE room_id = ? AND user_id = ?').get(room.id, req.userId);
  if (!isPlayer) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You're not in this game room." } });
  res.json({ room: roomDTO(room) });
});

// SEND_GAME_INVITE: shares a real, joinable invite code through the real messaging system
// (same message-request gate as any other DM — an invite is just a message).
router.post('/rooms/:id/invite', requireAuth, (req, res) => {
  const room = db.prepare('SELECT * FROM game_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Room not found.' } });
  const isPlayer = db.prepare('SELECT 1 FROM game_players WHERE room_id = ? AND user_id = ?').get(room.id, req.userId);
  if (!isPlayer) return res.status(403).json({ error: { code: 'FORBIDDEN', message: "You're not in this game room." } });
  if (room.status !== 'waiting') return res.status(409).json({ error: { code: 'ROOM_UNAVAILABLE', message: 'This room already started or ended.' } });

  const { toUsername } = req.body || {};
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(room.game_id);
  const text = `Join my ${game.name} game on NEXA — invite code: ${room.invite_code}`;
  const result = sendDirectMessage({ fromUserId: req.userId, toUsername, text, io: req.app.get('io') });
  res.status(result.httpStatus).json(result.body);
});

export default router;
