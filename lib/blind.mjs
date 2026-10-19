/**
 * Blind Xiangqi (覆棋 / 暗棋). Board[y][x], x=0..8, y=0..9; red at the bottom.
 * Kings start face-up on their palace squares; the other 30 pieces are drawn
 * from a fully shuffled red+black pool and placed face-down on the standard
 * starting squares. A covered piece moves with the identity of the square it
 * sits on and flips over after its first move; if it turns out to be the
 * other colour it changes allegiance. Captured covered pieces are revealed
 * publicly. Capture-the-king wins: no check obligation, generals may face
 * each other along an open file for the flying capture. No legal move loses.
 * Threefold repetition or 120 plies without a capture or reveal is a draw.
 * State is server-owned; the public view never leaks hidden identities.
 */

import { randomInt } from 'node:crypto';

const SIDES = ['red', 'black'];
const KINDS = ['K', 'R', 'H', 'E', 'A', 'C', 'P'];
const opposite = side => side === 'red' ? 'black' : 'red';
const inside = (x, y) => x >= 0 && x < 9 && y >= 0 && y < 10;
const NAMES = {
  red: { K: '帅', R: '车', H: '马', E: '相', A: '仕', C: '炮', P: '兵' },
  black: { K: '将', R: '车', H: '马', E: '象', A: '士', C: '砲', P: '卒' },
};
export const BLIND_RULE_SUMMARY =
  '将帅明置，其余 30 子红黑完全混洗为暗棋；暗棋按所站位置的棋子走法走一步后揭开，' +
  '揭开后按真实颜色归属，翻出对方颜色即由对方控制；吃掉的暗棋公开身份。' +
  '吃将制：吃掉将/帅即胜，不强制应将、不禁止送将；将帅仍限九宫，支持照面飞将。' +
  '揭开后士/仕可出九宫、象/相可过河；仍有蹩马腿、塞象眼。' +
  '无合法走法判负；相同局面第三次出现，或连续 120 手未吃子且未揭子，自动和棋。';

const piece = (side, kind, hidden = false, coverSide = null, coverKind = null) => ({ s: side, k: kind, h: hidden, cs: coverSide, ck: coverKind });
const owner = p => p.h ? p.cs : p.s;
const movesAs = p => p.h ? p.ck : p.k;
const reveal = p => { p.h = false; p.cs = null; p.ck = null; };
const publicPiece = p => p.h ? { hidden: true, side: p.cs, kind: p.ck } : { hidden: false, side: p.s, kind: p.k };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function initialBlind({ seed } = {}) {
  const rand = seed === undefined ? () => randomInt(0, 4294967296) / 4294967296 : mulberry32(seed);
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  const pool = [];
  for (const side of SIDES) for (const kind of ['R', 'R', 'H', 'H', 'E', 'E', 'A', 'A', 'C', 'C', 'P', 'P', 'P', 'P', 'P']) pool.push([side, kind]);
  const deck = shuffled(pool, rand);
  const back = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  for (const [side, home, cannonY, pawnY] of [['black', 0, 2, 3], ['red', 9, 7, 6]]) {
    for (let x = 0; x < 9; x++) {
      const kind = back[x];
      if (kind === 'K') board[home][x] = piece(side, 'K');
      else { const [s, k] = deck.pop(); board[home][x] = piece(s, k, true, side, kind); }
    }
    for (const x of [1, 7]) { const [s, k] = deck.pop(); board[cannonY][x] = piece(s, k, true, side, 'C'); }
    for (const x of [0, 2, 4, 6, 8]) { const [s, k] = deck.pop(); board[pawnY][x] = piece(s, k, true, side, 'P'); }
  }
  const state = {
    game: 'blind', board, turn: 'red', status: 'playing', winner: null, reason: null,
    ply: 0, quietPlies: 0, lastMove: null, history: [], captured: { red: [], black: [] },
  };
  state.repetitions = { [blindKey(state)]: 1 };
  return state;
}

function blindKey(state) {
  return `${state.turn}:${state.board.map(row => row.map(p => p ? `${p.s}${p.k}${p.h ? 'h' + p.cs + p.ck : 'o'}` : '..').join('')).join('/')}`;
}

function lineCount(board, [x, y], [tx, ty]) {
  const dx = Math.sign(tx - x), dy = Math.sign(ty - y);
  let count = 0;
  for (let cx = x + dx, cy = y + dy; cx !== tx || cy !== ty; cx += dx, cy += dy) if (board[cy][cx]) count++;
  return count;
}

function canMove(board, side, src, dst) {
  if (src[0] === dst[0] && src[1] === dst[1]) return false;
  const [x, y] = src, [tx, ty] = dst;
  const p = board[y][x], target = board[ty][tx];
  if (!p || owner(p) !== side || (target && owner(target) === side)) return false;
  const kind = movesAs(p), dx = tx - x, dy = ty - y, ax = Math.abs(dx), ay = Math.abs(dy);
  if (kind === 'R') return (dx === 0 || dy === 0) && lineCount(board, src, dst) === 0;
  if (kind === 'C') return (dx === 0 || dy === 0) && lineCount(board, src, dst) === (target ? 1 : 0);
  if (kind === 'H') {
    if (!((ax === 1 && ay === 2) || (ax === 2 && ay === 1))) return false;
    const leg = ax === 2 ? [x + dx / 2, y] : [x, y + dy / 2];
    return !board[leg[1]][leg[0]];
  }
  if (kind === 'E') {
    if (ax !== 2 || ay !== 2 || board[y + dy / 2][x + dx / 2]) return false;
    // Covered elephants keep the river rule; revealed ones may cross (house rule).
    return !p.h || (side === 'red' ? ty >= 5 : ty <= 4);
  }
  if (kind === 'A') {
    if (ax !== 1 || ay !== 1) return false;
    // Covered advisors stay in the palace; revealed ones may leave it (house rule).
    return !p.h || (tx >= 3 && tx <= 5 && (side === 'red' ? ty >= 7 : ty <= 2));
  }
  if (kind === 'K') {
    if (target && !target.h && target.k === 'K' && dx === 0 && lineCount(board, src, dst) === 0) return true;
    return ax + ay === 1 && tx >= 3 && tx <= 5 && (side === 'red' ? ty >= 7 && ty <= 9 : ty >= 0 && ty <= 2);
  }
  if (kind === 'P') {
    const forward = side === 'red' ? -1 : 1, crossed = side === 'red' ? y <= 4 : y >= 5;
    return (dx === 0 && dy === forward) || (crossed && ax === 1 && dy === 0);
  }
  return false;
}

export function legalBlind(state) {
  if (state.status !== 'playing') return [];
  const legal = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
    if (state.board[y][x] && owner(state.board[y][x]) === state.turn) {
      for (let ty = 0; ty < 10; ty++) for (let tx = 0; tx < 9; tx++) {
        if (canMove(state.board, state.turn, [x, y], [tx, ty])) legal.push({ from: [x, y], to: [tx, ty] });
      }
    }
  }
  return legal;
}

const validSquare = value => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) && inside(...value);

export function applyBlind(state, actor, action) {
  if (state.status !== 'playing') throw new Error('Game is finished');
  if (!SIDES.includes(actor) || actor !== state.turn) throw new Error('It is not this actor’s turn');
  if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).sort().join(',') !== 'from,to' || !validSquare(action.from) || !validSquare(action.to)) throw new Error('Use {from:[x,y],to:[x,y]} with valid board coordinates');
  const [x, y] = action.from, [tx, ty] = action.to;
  if (!legalBlind(state).some(m => m.from[0] === x && m.from[1] === y && m.to[0] === tx && m.to[1] === ty)) throw new Error('Illegal blind Xiangqi move');
  const p = state.board[y][x], target = state.board[ty][tx];
  const wasHidden = p.h, captureWasHidden = !!(target && target.h);
  const label = actor === 'red' ? '红方' : '黑方';
  const preName = wasHidden ? '暗棋' : NAMES[p.s][p.k];
  state.board[y][x] = null; state.board[ty][tx] = p;
  reveal(p);
  let text = `${label}${preName} ${x + 1},${10 - y} → ${tx + 1},${10 - ty}`;
  if (wasHidden) {
    text += `，揭开为${p.s === 'red' ? '红' : '黑'}${NAMES[p.s][p.k]}`;
    if (p.s !== actor) text += `（移交${p.s === 'red' ? '红方' : '黑方'}）`;
  }
  if (target) {
    reveal(target);
    state.captured[actor].push(target);
    text += `，吃掉${target.s === 'red' ? '红' : '黑'}${NAMES[target.s][target.k]}`;
    if (captureWasHidden) text += '（原暗棋，现已公开）';
  }
  state.ply++;
  state.quietPlies = (target || wasHidden) ? 0 : state.quietPlies + 1;
  // Identities become public only through this accepted move.
  state.lastMove = {
    actor, from: [x, y], to: [tx, ty], piece: publicPiece(p), wasHidden,
    capture: target ? publicPiece(target) : null, captureWasHidden, text, ply: state.ply,
  };
  state.history.push({ ...state.lastMove, from: [x, y], to: [tx, ty] });
  state.turn = opposite(actor);
  const finish = (winner, reason) => { state.status = 'finished'; state.winner = winner; state.reason = reason; };
  if (target && target.k === 'K') finish(actor, 'general-captured');
  else if (!legalBlind(state).length) finish(actor, 'no-legal-move');
  else {
    const key = blindKey(state);
    state.repetitions[key] = (state.repetitions[key] || 0) + 1;
    if (state.repetitions[key] >= 3) finish(null, 'threefold-repetition');
    else if (state.quietPlies >= 120) finish(null, 'quiet-120');
  }
  return state;
}

export function blindView(state,reveal=false) {
  return {
    game: 'blind',
    board: state.board.map(row => row.map(p => p ? {...publicPiece(p),...(reveal&&p.h?{truth:{side:p.s,kind:p.k}}:{})} : null)),
    turn: state.turn, status: state.status, winner: state.winner, reason: state.reason,
    ply: state.ply, quietPlies: state.quietPlies, check: false,
    captured: { red: state.captured.red.map(publicPiece), black: state.captured.black.map(publicPiece) },
    lastMove: state.lastMove ? structuredClone(state.lastMove) : null,
    history: structuredClone(state.history),
    legalMoves: legalBlind(state),
    rules: { mode: 'capture-general', reveal: 'on-first-move', advisor: 'free-after-reveal', elephant: 'free-after-reveal', quietPlies: 120, repetition: 'threefold-draw', summary: BLIND_RULE_SUMMARY },
  };
}

export { NAMES as BLIND_NAMES };
