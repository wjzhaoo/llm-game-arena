/**
 * Chinese Xiangqi. Board[y][x], x=0..8, y=0..9; red begins at the bottom.
 * Pieces: side r/b + K general, A advisor, E elephant, H horse, R rook,
 * C cannon, P pawn. Action: {from:[x,y], to:[x,y]}.
 * No legal move is a loss, including stalemate. Threefold repetition and
 * the configurable ply cap are explicit arena draw rules, not tournament
 * adjudication of perpetual checking/chasing. State is server-owned.
 */

const opposite = side => side === 'red' ? 'black' : 'red';
const prefix = side => side === 'red' ? 'r' : 'b';
const inside = (x, y) => x >= 0 && x < 9 && y >= 0 && y < 10;
const palace = (p, x, y) => x >= 3 && x <= 5 && (p === 'r' ? y >= 7 && y <= 9 : y >= 0 && y <= 2);
const cloneBoard = board => board.map(row => row.slice());
const positionKey = state => `${state.turn}:${state.board.map(row => row.map(p => p || '..').join('')).join('/')}`;

export function initialXiangqi({ maxPly = 300 } = {}) {
  if (!Number.isInteger(maxPly) || maxPly < 1 || maxPly > 10000) throw new Error('maxPly must be an integer from 1 to 10000');
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  const back = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  board[0] = back.map(piece => `b${piece}`);
  board[9] = back.map(piece => `r${piece}`);
  for (const x of [1, 7]) { board[2][x] = 'bC'; board[7][x] = 'rC'; }
  for (const x of [0, 2, 4, 6, 8]) { board[3][x] = 'bP'; board[6][x] = 'rP'; }
  const state = { game: 'xiangqi', board, turn: 'red', status: 'playing', winner: null, reason: null, ply: 0, maxPly, lastMove: null, history: [] };
  state.repetitions = { [positionKey(state)]: 1 };
  return state;
}

function pseudoTargets(board, x, y) {
  const piece = board[y][x];
  if (!piece) return [];
  const [p, type] = piece;
  const result = [];
  const add = (tx, ty) => {
    if (inside(tx, ty) && board[ty][tx]?.[0] !== p) result.push([tx, ty]);
  };
  if (type === 'R' || type === 'C') {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let screened = false;
      for (let tx = x + dx, ty = y + dy; inside(tx, ty); tx += dx, ty += dy) {
        const target = board[ty][tx];
        if (type === 'R') {
          if (!target) result.push([tx, ty]);
          else { if (target[0] !== p) result.push([tx, ty]); break; }
        } else if (!screened) {
          if (!target) result.push([tx, ty]);
          else screened = true;
        } else if (target) {
          if (target[0] !== p) result.push([tx, ty]);
          break;
        }
      }
    }
  } else if (type === 'H') {
    for (const [dx, dy] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]]) {
      const lx = x + (Math.abs(dx) === 2 ? Math.sign(dx) : 0);
      const ly = y + (Math.abs(dy) === 2 ? Math.sign(dy) : 0);
      if (inside(lx, ly) && !board[ly][lx]) add(x + dx, y + dy);
    }
  } else if (type === 'E') {
    for (const [dx, dy] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
      const tx = x + dx, ty = y + dy;
      if (inside(tx, ty) && (p === 'r' ? ty >= 5 : ty <= 4) && !board[y + dy / 2][x + dx / 2]) add(tx, ty);
    }
  } else if (type === 'A') {
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (palace(p, x + dx, y + dy)) add(x + dx, y + dy);
  } else if (type === 'K') {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (palace(p, x + dx, y + dy)) add(x + dx, y + dy);
    // A general attacks the opposing general along a clear file.
    for (const dy of [-1, 1]) {
      for (let ty = y + dy; inside(x, ty); ty += dy) {
        if (board[ty][x]) {
          if (board[ty][x] === `${p === 'r' ? 'b' : 'r'}K`) result.push([x, ty]);
          break;
        }
      }
    }
  } else if (type === 'P') {
    add(x, y + (p === 'r' ? -1 : 1));
    if (p === 'r' ? y <= 4 : y >= 5) { add(x - 1, y); add(x + 1, y); }
  }
  return result;
}

function inCheck(board, side) {
  const own = prefix(side), enemy = prefix(opposite(side));
  let general;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) if (board[y][x] === `${own}K`) general = [x, y];
  if (!general) return true;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
    if (board[y][x]?.[0] === enemy && pseudoTargets(board, x, y).some(([tx, ty]) => tx === general[0] && ty === general[1])) return true;
  }
  return false;
}

export function legalXiangqi(state) {
  if (state.status !== 'playing') return [];
  const legal = [], own = prefix(state.turn);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
    if (state.board[y][x]?.[0] !== own) continue;
    for (const [tx, ty] of pseudoTargets(state.board, x, y)) {
      const board = cloneBoard(state.board);
      board[ty][tx] = board[y][x]; board[y][x] = null;
      if (!inCheck(board, state.turn)) legal.push({ from: [x, y], to: [tx, ty] });
    }
  }
  return legal;
}

function validSquare(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) && inside(...value);
}

export function applyXiangqi(state, actor, action) {
  if (state.status !== 'playing') throw new Error('Game is finished');
  if (!['red', 'black'].includes(actor) || actor !== state.turn) throw new Error('It is not this actor’s turn');
  if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).sort().join(',') !== 'from,to' || !validSquare(action.from) || !validSquare(action.to)) throw new Error('Use {from:[x,y],to:[x,y]} with valid board coordinates');
  const [x, y] = action.from, [tx, ty] = action.to;
  if (!legalXiangqi(state).some(move => move.from[0] === x && move.from[1] === y && move.to[0] === tx && move.to[1] === ty)) throw new Error('Illegal Xiangqi move');
  const captured = state.board[ty][tx];
  const piece = state.board[y][x];
  state.board[ty][tx] = piece; state.board[y][x] = null;
  state.ply++;
  state.lastMove = { actor, from: [x, y], to: [tx, ty], piece, captured };
  state.history.push({ ...state.lastMove, from: [x, y], to: [tx, ty], ply: state.ply });
  state.turn = opposite(actor);
  const finish = (winner, reason) => { state.status = 'finished'; state.winner = winner; state.reason = reason; };
  if (captured === `${prefix(state.turn)}K`) finish(actor, 'general-captured');
  else if (!legalXiangqi(state).length) finish(actor, inCheck(state.board, state.turn) ? 'checkmate' : 'stalemate');
  const key = positionKey(state);
  state.repetitions[key] = (state.repetitions[key] || 0) + 1;
  if (state.status === 'playing' && state.repetitions[key] >= 3) finish(null, 'threefold-repetition');
  if (state.status === 'playing' && state.ply >= state.maxPly) finish(null, 'ply-cap');
  return state;
}

export function xiangqiView(state) {
  return {
    game: 'xiangqi', board: cloneBoard(state.board), turn: state.turn,
    status: state.status, winner: state.winner, reason: state.reason,
    ply: state.ply, maxPly: state.maxPly, check: inCheck(state.board, state.turn),
    lastMove: state.lastMove ? structuredClone(state.lastMove) : null,
    history: structuredClone(state.history), legalMoves: legalXiangqi(state),
    rules: { stalemate: 'loss', repetition: 'threefold-draw', plyCap: state.maxPly },
  };
}
