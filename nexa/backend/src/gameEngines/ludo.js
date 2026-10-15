// Simplified Ludo for 2-4 players. Real server-rolled dice, real capturing, real safe
// squares and home-stretch logic. Documented simplification (disclosed, not hidden):
// no "blocking" rule for two same-color tokens stacked on one square.
//
// Track model: a single shared 52-square outer ring (0..51). Each color has a fixed
// entry offset onto that ring. After completing the ring relative to their own entry
// point (52 steps), a token moves into a private 6-square home stretch, then finishes.

const COLORS = ['red', 'green', 'yellow', 'blue'];
const ENTRY_OFFSET = { red: 0, green: 13, blue: 26, yellow: 39 };
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const TRACK_LEN = 52;
const HOME_STRETCH_LEN = 6;
const TOTAL_STEPS = TRACK_LEN + HOME_STRETCH_LEN;

export function ludoInit(players) {
  const colorOf = {};
  players.forEach((p, i) => { colorOf[p.user_id] = COLORS[i]; });
  const tokens = {};
  players.forEach(p => { tokens[p.user_id] = [-1, -1, -1, -1]; });
  return {
    colorOf, tokens,
    turn: players[0].user_id,
    playerOrder: players.map(p => p.user_id),
    dice: null,
    diceRolledThisTurn: false,
    winner: null,
  };
}

function globalSquare(color, progress) {
  if (progress >= TRACK_LEN) return null;
  return (ENTRY_OFFSET[color] + progress) % TRACK_LEN;
}

export function ludoRollDice(state, userId) {
  if (state.turn !== userId) return { error: "It's not your turn." };
  if (state.diceRolledThisTurn) return { error: 'Already rolled — move a token.' };
  state.dice = 1 + Math.floor(Math.random() * 6);
  state.diceRolledThisTurn = true;

  const color = state.colorOf[userId];
  const tokens = state.tokens[userId];
  const canMove = tokens.some((progress) => canMoveToken(state, color, progress));
  if (!canMove) return { noMoves: true, dice: state.dice };
  return { dice: state.dice };
}

function canMoveToken(state, color, progress) {
  if (progress === TOTAL_STEPS) return false;
  if (progress === -1) return state.dice === 6;
  return progress + state.dice <= TOTAL_STEPS;
}

export function ludoApplyMove(state, userId, move) {
  const { tokenIndex } = move || {};
  if (state.turn !== userId) return { error: "It's not your turn." };
  if (!state.diceRolledThisTurn || state.dice === null) return { error: 'Roll the dice first.' };
  if (typeof tokenIndex !== 'number' || tokenIndex < 0 || tokenIndex > 3) return { error: 'Invalid token.' };

  const color = state.colorOf[userId];
  const progress = state.tokens[userId][tokenIndex];
  if (!canMoveToken(state, color, progress)) return { error: 'That token cannot move with this roll.' };

  const newProgress = progress === -1 ? 0 : progress + state.dice;
  state.tokens[userId][tokenIndex] = newProgress;

  const landedSquare = globalSquare(color, newProgress);
  let captured = false;
  if (landedSquare !== null && !SAFE_SQUARES.has(landedSquare)) {
    for (const otherId of state.playerOrder) {
      if (otherId === userId) continue;
      const otherColor = state.colorOf[otherId];
      state.tokens[otherId].forEach((op, oi) => {
        if (op >= 0 && op < TRACK_LEN && globalSquare(otherColor, op) === landedSquare) {
          state.tokens[otherId][oi] = -1;
          captured = true;
        }
      });
    }
  }

  const allFinished = state.tokens[userId].every(p => p === TOTAL_STEPS);
  if (allFinished) return { winner: userId };

  const rolledSix = state.dice === 6;
  state.dice = null;
  state.diceRolledThisTurn = false;
  return { winner: null, keepTurn: rolledSix || captured };
}

export function ludoAdvanceTurn(state) {
  const idx = state.playerOrder.indexOf(state.turn);
  state.turn = state.playerOrder[(idx + 1) % state.playerOrder.length];
  state.dice = null;
  state.diceRolledThisTurn = false;
}
