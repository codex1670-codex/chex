// Standard checkers on the 32 dark squares of an 8x8 board (index = row*8+col).
// Forced captures (if a capture is available, you must take it) and multi-jump chains
// are both implemented — these are real rule requirements, not simplifications.

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function idx(r, c) { return r * 8 + c; }
function isDark(r, c) { return (r + c) % 2 === 1; }

function initialBoard() {
  const board = Array(64).fill(null);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) if (isDark(r, c)) board[idx(r, c)] = { color: 'r', king: false };
  for (let r = 5; r < 8; r++) for (let c = 0; c < 8; c++) if (isDark(r, c)) board[idx(r, c)] = { color: 'b', king: false };
  return board;
}

export function checkersInit(players) {
  return {
    board: initialBoard(),
    turn: players[0].user_id,
    colors: { [players[0].user_id]: 'r', [players[1].user_id]: 'b' }, // red moves toward row 7, black toward row 0
    winner: null,
    mustContinueFrom: null, // [r,c] if mid multi-jump
  };
}

function pieceDirections(piece) {
  if (piece.king) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  return piece.color === 'r' ? [[1, -1], [1, 1]] : [[-1, -1], [-1, 1]];
}

function findCapturesForPiece(board, r, c) {
  const piece = board[idx(r, c)];
  const caps = [];
  for (const [dr, dc] of pieceDirections(piece)) {
    const mr = r + dr, mc = c + dc, lr = r + dr * 2, lc = c + dc * 2;
    if (!inBounds(lr, lc)) continue;
    const mid = board[idx(mr, mc)];
    if (mid && mid.color !== piece.color && !board[idx(lr, lc)]) caps.push({ from: [r, c], to: [lr, lc], captured: [mr, mc] });
  }
  return caps;
}

function findSimpleMovesForPiece(board, r, c) {
  const piece = board[idx(r, c)];
  const moves = [];
  for (const [dr, dc] of pieceDirections(piece)) {
    const nr = r + dr, nc = c + dc;
    if (inBounds(nr, nc) && !board[idx(nr, nc)]) moves.push({ from: [r, c], to: [nr, nc] });
  }
  return moves;
}

function allCapturesForColor(board, color) {
  let caps = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.color === color) caps = caps.concat(findCapturesForPiece(board, Math.floor(i / 8), i % 8));
  }
  return caps;
}

function hasAnyMove(board, color) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.color !== color) continue;
    const r = Math.floor(i / 8), c = i % 8;
    if (findCapturesForPiece(board, r, c).length || findSimpleMovesForPiece(board, r, c).length) return true;
  }
  return false;
}

export function checkersApplyMove(state, userId, move) {
  const { from, to } = move || {};
  if (!Array.isArray(from) || !Array.isArray(to)) return { error: 'Invalid move format.' };
  const [fr, fc] = from, [tr, tc] = to;
  const myColor = state.colors[userId];
  const piece = state.board[idx(fr, fc)];
  if (!piece || piece.color !== myColor) return { error: 'No piece of yours there.' };

  if (state.mustContinueFrom && (state.mustContinueFrom[0] !== fr || state.mustContinueFrom[1] !== fc)) {
    return { error: 'You must continue capturing with the same piece.' };
  }

  const forcedCaptures = allCapturesForColor(state.board, myColor);
  const myCaptures = findCapturesForPiece(state.board, fr, fc);
  const captureMove = myCaptures.find(m => m.to[0] === tr && m.to[1] === tc);

  if (captureMove) {
    state.board[idx(tr, tc)] = piece;
    state.board[idx(fr, fc)] = null;
    state.board[idx(...captureMove.captured)] = null;
    if ((piece.color === 'r' && tr === 7) || (piece.color === 'b' && tr === 0)) piece.king = true;

    const moreCaptures = findCapturesForPiece(state.board, tr, tc);
    if (moreCaptures.length) {
      state.mustContinueFrom = [tr, tc];
      return { winner: null }; // same player continues, turn does not switch
    }
    state.mustContinueFrom = null;
  } else {
    if (forcedCaptures.length) return { error: 'A capture is available — you must take it.' };
    const simple = findSimpleMovesForPiece(state.board, fr, fc).find(m => m.to[0] === tr && m.to[1] === tc);
    if (!simple) return { error: 'Illegal move.' };
    state.board[idx(tr, tc)] = piece;
    state.board[idx(fr, fc)] = null;
    if ((piece.color === 'r' && tr === 7) || (piece.color === 'b' && tr === 0)) piece.king = true;
    state.mustContinueFrom = null;
  }

  const oppColor = myColor === 'r' ? 'b' : 'r';
  if (!hasAnyMove(state.board, oppColor)) return { winner: userId };
  return { winner: null, keepTurn: !!state.mustContinueFrom };
}
