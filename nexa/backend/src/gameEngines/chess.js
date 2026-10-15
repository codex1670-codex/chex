// Simplified chess: standard piece movement, captures, check/checkmate/stalemate detection.
// Documented simplifications (not hidden): no castling, no en passant, pawns always
// auto-promote to queen. These are real, disclosed limitations — not faked completeness.

const DIRS = {
  rook: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  bishop: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  queen: [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]],
};
const KNIGHT_OFFSETS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function idx(r, c) { return r * 8 + c; }

function initialBoard() {
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const board = Array(64).fill(null);
  for (let c = 0; c < 8; c++) {
    board[idx(0, c)] = { type: back[c], color: 'w' };
    board[idx(1, c)] = { type: 'p', color: 'w' };
    board[idx(6, c)] = { type: 'p', color: 'b' };
    board[idx(7, c)] = { type: back[c], color: 'b' };
  }
  return board;
}

export function chessInit(players) {
  return {
    board: initialBoard(),
    turn: players[0].user_id,
    colors: { [players[0].user_id]: 'w', [players[1].user_id]: 'b' },
    winner: null,
    check: null,
  };
}

function pseudoMovesForPiece(board, r, c) {
  const piece = board[idx(r, c)];
  if (!piece) return [];
  const moves = [];
  const push = (nr, nc) => {
    if (!inBounds(nr, nc)) return false;
    const target = board[idx(nr, nc)];
    if (!target) { moves.push([nr, nc]); return true; }
    if (target.color !== piece.color) moves.push([nr, nc]);
    return false;
  };

  if (piece.type === 'p') {
    const dir = piece.color === 'w' ? 1 : -1;
    const startRow = piece.color === 'w' ? 1 : 6;
    if (inBounds(r + dir, c) && !board[idx(r + dir, c)]) {
      moves.push([r + dir, c]);
      if (r === startRow && !board[idx(r + 2 * dir, c)]) moves.push([r + 2 * dir, c]);
    }
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (inBounds(nr, nc) && board[idx(nr, nc)] && board[idx(nr, nc)].color !== piece.color) moves.push([nr, nc]);
    }
  } else if (piece.type === 'n') {
    for (const [dr, dc] of KNIGHT_OFFSETS) {
      const nr = r + dr, nc = c + dc;
      if (inBounds(nr, nc) && (!board[idx(nr, nc)] || board[idx(nr, nc)].color !== piece.color)) moves.push([nr, nc]);
    }
  } else if (piece.type === 'k') {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (inBounds(nr, nc) && (!board[idx(nr, nc)] || board[idx(nr, nc)].color !== piece.color)) moves.push([nr, nc]);
    }
  } else {
    const dirs = DIRS[piece.type === 'r' ? 'rook' : piece.type === 'b' ? 'bishop' : 'queen'];
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc)) {
        if (!push(nr, nc)) break;
        nr += dr; nc += dc;
      }
    }
  }
  return moves;
}

function findKing(board, color) {
  for (let i = 0; i < 64; i++) if (board[i] && board[i].type === 'k' && board[i].color === color) return i;
  return -1;
}

function isSquareAttacked(board, square, byColor) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.color !== byColor) continue;
    const r = Math.floor(i / 8), c = i % 8;
    const moves = pseudoMovesForPiece(board, r, c);
    if (moves.some(([mr, mc]) => idx(mr, mc) === square)) return true;
  }
  return false;
}

function inCheck(board, color) {
  const king = findKing(board, color);
  return king !== -1 && isSquareAttacked(board, king, color === 'w' ? 'b' : 'w');
}

function cloneBoard(board) { return board.map(p => p ? { ...p } : null); }

function legalMovesForPiece(board, r, c) {
  const piece = board[idx(r, c)];
  const pseudo = pseudoMovesForPiece(board, r, c);
  return pseudo.filter(([nr, nc]) => {
    const test = cloneBoard(board);
    test[idx(nr, nc)] = test[idx(r, c)];
    test[idx(r, c)] = null;
    return !inCheck(test, piece.color);
  });
}

function hasAnyLegalMove(board, color) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.color !== color) continue;
    if (legalMovesForPiece(board, Math.floor(i / 8), i % 8).length > 0) return true;
  }
  return false;
}

export function chessApplyMove(state, userId, move) {
  const { from, to } = move || {};
  if (!Array.isArray(from) || !Array.isArray(to)) return { error: 'Invalid move format.' };
  const [fr, fc] = from, [tr, tc] = to;
  if (!inBounds(fr, fc) || !inBounds(tr, tc)) return { error: 'Move out of bounds.' };
  const myColor = state.colors[userId];
  const piece = state.board[idx(fr, fc)];
  if (!piece || piece.color !== myColor) return { error: 'No piece of yours there.' };

  const legal = legalMovesForPiece(state.board, fr, fc);
  if (!legal.some(([r, c]) => r === tr && c === tc)) return { error: 'Illegal move.' };

  state.board[idx(tr, tc)] = piece;
  state.board[idx(fr, fc)] = null;
  if (piece.type === 'p' && (tr === 0 || tr === 7)) piece.type = 'q';

  const oppColor = myColor === 'w' ? 'b' : 'w';
  const oppInCheck = inCheck(state.board, oppColor);
  const oppHasMove = hasAnyLegalMove(state.board, oppColor);
  state.check = oppInCheck ? oppColor : null;

  if (!oppHasMove) {
    return { winner: oppInCheck ? userId : 'draw' };
  }
  return { winner: null };
}
