import db from './db.js';
import { roomDTO } from './routes/games.js';
import { recordTournamentResultIfApplicable } from './routes/tournaments.js';
import { chessInit, chessApplyMove } from './gameEngines/chess.js';

// ---- Tic-Tac-Toe ----
const TTT_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
function tttCheckWinner(board) {
  for (const [a, b, c] of TTT_LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  if (board.every(cell => cell !== null)) return 'draw';
  return null;
}
function tttInit(players) {
  return { board: Array(9).fill(null), turn: players[0].user_id, marks: Object.fromEntries(players.map((p, i) => [p.user_id, i === 0 ? 'X' : 'O'])), winner: null };
}
function tttApplyMove(state, userId, move) {
  const cell = move?.cell;
  if (typeof cell !== 'number' || cell < 0 || cell > 8 || state.board[cell] !== null) return { error: 'Invalid move.' };
  state.board[cell] = state.marks[userId];
  const result = tttCheckWinner(state.board);
  if (result === 'draw') return { winner: 'draw' };
  if (result) return { winner: userId }; // result is this player's own mark since they just moved
  return { winner: null };
}

// ---- Connect Four (7 cols x 6 rows, index = row*7 + col, row 0 = top) ----
const C4_COLS = 7, C4_ROWS = 6;
function c4Init(players) {
  return { board: Array(C4_COLS * C4_ROWS).fill(null), turn: players[0].user_id, marks: Object.fromEntries(players.map((p, i) => [p.user_id, i === 0 ? 'R' : 'Y'])), winner: null };
}
function c4LowestEmptyRow(board, col) {
  for (let row = C4_ROWS - 1; row >= 0; row--) {
    if (board[row * C4_COLS + col] === null) return row;
  }
  return -1;
}
function c4CheckWinner(board) {
  const get = (r, c) => (r < 0 || r >= C4_ROWS || c < 0 || c >= C4_COLS) ? null : board[r * C4_COLS + c];
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c < C4_COLS; c++) {
      const mark = get(r, c);
      if (!mark) continue;
      for (const [dr, dc] of dirs) {
        if ([1, 2, 3].every(i => get(r + dr * i, c + dc * i) === mark)) return mark;
      }
    }
  }
  if (board.every(cell => cell !== null)) return 'draw';
  return null;
}
function c4ApplyMove(state, userId, move) {
  const col = move?.cell;
  if (typeof col !== 'number' || col < 0 || col >= C4_COLS) return { error: 'Invalid column.' };
  const row = c4LowestEmptyRow(state.board, col);
  if (row === -1) return { error: 'That column is full.' };
  state.board[row * C4_COLS + col] = state.marks[userId];
  const result = c4CheckWinner(state.board);
  return { winner: result === state.marks[userId] ? userId : result === null ? null : result };
}

// ---- Checkers (8x8, standard dark-square layout, single-step captures — see README note) ----
const CK_SIZE = 8;
function ckIdx(row, col) { return row * CK_SIZE + col; }
function ckInit(players) {
  const board = Array(64).fill(null);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < CK_SIZE; col++) {
      if ((row + col) % 2 === 1) board[ckIdx(row, col)] = 'a';
    }
  }
  for (let row = 5; row < 8; row++) {
    for (let col = 0; col < CK_SIZE; col++) {
      if ((row + col) % 2 === 1) board[ckIdx(row, col)] = 'b';
    }
  }
  return { board, turn: players[0].user_id, marks: Object.fromEntries(players.map((p, i) => [p.user_id, i === 0 ? 'a' : 'b'])), winner: null };
}
function ckOwnsPiece(piece, mark) {
  return piece && piece.toLowerCase() === mark;
}
function ckApplyMove(state, userId, move) {
  const { from, to } = move || {};
  if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || from > 63 || to < 0 || to > 63) {
    return { error: 'Invalid move.' };
  }
  const mark = state.marks[userId];
  const piece = state.board[from];
  if (!ckOwnsPiece(piece, mark)) return { error: 'That piece is not yours.' };
  if (state.board[to] !== null) return { error: 'That square is occupied.' };

  const fromRow = Math.floor(from / CK_SIZE), fromCol = from % CK_SIZE;
  const toRow = Math.floor(to / CK_SIZE), toCol = to % CK_SIZE;
  const rowDiff = toRow - fromRow, colDiff = toCol - fromCol;
  const isKing = piece === piece.toUpperCase() && piece !== piece.toLowerCase(); // 'A' or 'B'
  const forwardDir = mark === 'a' ? 1 : -1;

  const isSimpleMove = Math.abs(rowDiff) === 1 && Math.abs(colDiff) === 1;
  const isJump = Math.abs(rowDiff) === 2 && Math.abs(colDiff) === 2;
  if (!isSimpleMove && !isJump) return { error: 'Pieces move diagonally, one step (or a capturing jump).' };
  if (!isKing && Math.sign(rowDiff) !== forwardDir) return { error: 'Only kings can move backward.' };

  if (isJump) {
    const midRow = (fromRow + toRow) / 2, midCol = (fromCol + toCol) / 2;
    const midPiece = state.board[ckIdx(midRow, midCol)];
    if (!midPiece || midPiece.toLowerCase() === mark) return { error: 'No opponent piece to capture there.' };
    state.board[ckIdx(midRow, midCol)] = null;
  }

  state.board[to] = piece;
  state.board[from] = null;
  const backRow = mark === 'a' ? CK_SIZE - 1 : 0;
  if (toRow === backRow) state.board[to] = mark.toUpperCase(); // promote to king

  const opponentMark = mark === 'a' ? 'b' : 'a';
  const opponentPiecesLeft = state.board.some(p => p && p.toLowerCase() === opponentMark);
  if (!opponentPiecesLeft) return { winner: userId };
  return { winner: null };
}

const ENGINES = {
  'tic-tac-toe': { init: tttInit, applyMove: tttApplyMove },
  'connect-four': { init: c4Init, applyMove: c4ApplyMove },
  'checkers': { init: ckInit, applyMove: ckApplyMove },
  'chess': { init: chessInit, applyMove: chessApplyMove },
};

function getRoom(roomId) {
  return db.prepare('SELECT * FROM game_rooms WHERE id = ?').get(roomId);
}
function getPlayers(roomId) {
  return db.prepare('SELECT * FROM game_players WHERE room_id = ? AND left_at IS NULL ORDER BY slot ASC').all(roomId);
}
function saveState(roomId, state) {
  db.prepare('UPDATE game_rooms SET state = ? WHERE id = ?').run(JSON.stringify(state), roomId);
}

export function registerGameHandlers(io, socket) {
  const userId = socket.userId;

  const requirePlayer = (roomId) => {
    const room = getRoom(roomId);
    if (!room) return { error: 'Room not found.' };
    const player = db.prepare('SELECT * FROM game_players WHERE room_id = ? AND user_id = ? AND left_at IS NULL').get(roomId, userId);
    if (!player) return { error: "You're not in this game room." };
    return { room, player };
  };

  const broadcast = (roomId) => {
    const room = getRoom(roomId);
    io.to(`game:${roomId}`).emit('game:state', roomDTO(room));
  };

  socket.on('game:join', ({ roomId }) => {
    const { error } = requirePlayer(roomId);
    if (error) return socket.emit('game:error', { message: error });
    socket.join(`game:${roomId}`);
    broadcast(roomId);
  });

  socket.on('game:ready', ({ roomId }) => {
    const { room, error } = requirePlayer(roomId);
    if (error) return socket.emit('game:error', { message: error });
    if (room.status !== 'waiting') return socket.emit('game:error', { message: 'Game already started.' });

    db.prepare('UPDATE game_players SET ready = 1 WHERE room_id = ? AND user_id = ?').run(roomId, userId);

    const players = getPlayers(roomId);
    const allReady = players.length === room.capacity && players.every(p => p.ready);
    if (allReady) {
      const engine = ENGINES[room.game_id];
      const state = engine.init(players);
      db.prepare("UPDATE game_rooms SET status = 'active', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), state = ? WHERE id = ?")
        .run(JSON.stringify(state), roomId);
    }
    broadcast(roomId);
  });

  socket.on('game:move', ({ roomId, cell, move }) => {
    const { room, error } = requirePlayer(roomId);
    if (error) return socket.emit('game:error', { message: error });
    if (room.status !== 'active') return socket.emit('game:error', { message: 'Game is not active.' });

    const engine = ENGINES[room.game_id];
    const state = JSON.parse(room.state || '{}');
    if (state.winner) return socket.emit('game:error', { message: 'Game already finished.' });
    if (state.turn !== userId) return socket.emit('game:error', { message: "It's not your turn." });

    const result = engine.applyMove(state, userId, move !== undefined ? move : { cell });
    if (result.error) return socket.emit('game:error', { message: result.error });

    if (result.winner) {
      state.winner = result.winner;
      db.prepare("UPDATE game_rooms SET status = 'finished', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), state = ? WHERE id = ?")
        .run(JSON.stringify(state), roomId);
      recordTournamentResultIfApplicable(roomId, result.winner);
    } else {
      const players = getPlayers(roomId);
      const next = players.find(p => p.user_id !== userId);
      state.turn = next.user_id;
      saveState(roomId, state);
    }
    broadcast(roomId);
  });

  socket.on('game:leave', ({ roomId }) => {
    const { room, error } = requirePlayer(roomId);
    if (error) return;
    db.prepare("UPDATE game_players SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE room_id = ? AND user_id = ?").run(roomId, userId);
    if (room.status === 'active') {
      const state = JSON.parse(room.state || '{}');
      const remaining = getPlayers(roomId);
      if (!state.winner && remaining.length === 1) {
        state.winner = remaining[0].user_id; // forfeit
        db.prepare("UPDATE game_rooms SET status = 'finished', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), state = ? WHERE id = ?")
          .run(JSON.stringify(state), roomId);
        recordTournamentResultIfApplicable(roomId, state.winner);
      }
    }
    socket.leave(`game:${roomId}`);
    broadcast(roomId);
  });
}
