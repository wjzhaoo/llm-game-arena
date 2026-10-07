import test from 'node:test';
import assert from 'node:assert/strict';
import { initialXiangqi, legalXiangqi, applyXiangqi, xiangqiView } from '../lib/xiangqi.mjs';
import { initialWerewolf, pendingWerewolf, applyWerewolf, timeoutWerewolf, werewolfView } from '../lib/werewolf.mjs';

const roles = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];
const wolf = options => initialWerewolf({ roles, ...options });
const move = (from, to) => ({ from, to });
const hasMove = (state, from, to) => legalXiangqi(state).some(m => JSON.stringify(m) === JSON.stringify(move(from, to)));
const fixture = pieces => {
  const state = initialXiangqi();
  state.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const [x, y, piece] of pieces) state.board[y][x] = piece;
  state.repetitions = {};
  return state;
};
const kings = [[3, 0, 'bK'], [5, 9, 'rK']];
const passDiscussion = state => {
  while (state.phase === 'discuss') timeoutWerewolf(state, pendingWerewolf(state)[0]);
};
const passVote = state => {
  while (state.phase === 'vote') timeoutWerewolf(state, pendingWerewolf(state)[0]);
};
const night = (state, { targets = ['p5', 'p5'], inspect = null, save = false, poison = null } = {}) => {
  for (const [i, id] of pendingWerewolf(state).entries()) applyWerewolf(state, id, { type: 'kill', target: targets[i] ?? null });
  if (state.phase === 'seer') applyWerewolf(state, pendingWerewolf(state)[0], { type: 'inspect', target: inspect });
  if (state.phase === 'witch') applyWerewolf(state, pendingWerewolf(state)[0], { type: 'witch', save, poison });
};

test('Xiangqi starts with 32 pieces and all 44 standard opening moves', () => {
  const state = initialXiangqi();
  assert.equal(state.board.flat().filter(Boolean).length, 32);
  assert.equal(legalXiangqi(state).length, 44);
  assert.equal(state.turn, 'red');
  assert.equal(xiangqiView(state).check, false);
  assert.deepEqual(state.board[0], ['bR', 'bH', 'bE', 'bA', 'bK', 'bA', 'bE', 'bH', 'bR']);
});

test('Xiangqi rejects wrong actor, malformed/out-of-range and illegal actions atomically', () => {
  const state = initialXiangqi(), before = JSON.stringify(state);
  for (const action of [null, {}, { from: [0, 6], to: [0, 5], extra: 1 }, move([0.1, 6], [0, 5]), move([-1, 6], [0, 5]), move([0, 6], [0, 7]), move([0, 6], [0, 6])]) {
    assert.throws(() => applyXiangqi(state, 'red', action));
    assert.equal(JSON.stringify(state), before);
  }
  assert.throws(() => applyXiangqi(state, 'black', move([0, 3], [0, 4])));
  applyXiangqi(state, 'red', move([0, 6], [0, 5]));
  assert.equal(state.turn, 'black'); assert.equal(state.ply, 1);
  assert.equal(state.board[5][0], 'rP'); assert.equal(state.board[6][0], null);
});

test('Xiangqi horse legs, elephant eyes and river restrictions', () => {
  const state = fixture([...kings, [4, 7, 'rH'], [5, 7, 'rP'], [2, 7, 'rE'], [1, 6, 'rP']]);
  assert.equal(hasMove(state, [4, 7], [6, 6]), false);
  assert.equal(hasMove(state, [4, 7], [5, 5]), true);
  assert.equal(hasMove(state, [2, 7], [0, 5]), false);
  assert.equal(hasMove(state, [2, 7], [4, 5]), true);
  state.board[7][2] = null; state.board[5][2] = 'rE';
  assert.equal(hasMove(state, [2, 5], [4, 3]), false);
  assert.equal(hasMove(state, [2, 5], [4, 7]), false); // occupied by friendly horse
});

test('Xiangqi cannon must jump exactly one screen when capturing', () => {
  const state = fixture([...kings, [0, 7, 'rC'], [0, 5, 'rP'], [0, 2, 'bR'], [1, 7, 'bP']]);
  assert.equal(hasMove(state, [0, 7], [0, 6]), true);
  assert.equal(hasMove(state, [0, 7], [0, 4]), false);
  assert.equal(hasMove(state, [0, 7], [0, 2]), true);
  assert.equal(hasMove(state, [0, 7], [1, 7]), false);
  state.board[4][0] = 'bP';
  assert.equal(hasMove(state, [0, 7], [0, 2]), false);
  assert.equal(hasMove(state, [0, 7], [0, 4]), true);
});

test('Xiangqi pawns cross the river but never move backwards; palace pieces stay inside', () => {
  const state = fixture([...kings, [0, 5, 'rP'], [2, 4, 'rP'], [3, 9, 'rA']]);
  assert.equal(hasMove(state, [0, 5], [1, 5]), false);
  assert.equal(hasMove(state, [2, 4], [3, 4]), true);
  assert.equal(hasMove(state, [2, 4], [2, 5]), false);
  assert.equal(hasMove(state, [3, 9], [4, 8]), true);
  assert.equal(hasMove(state, [3, 9], [2, 8]), false);
  assert.equal(hasMove(state, [5, 9], [6, 9]), false);
});

test('Xiangqi prevents facing generals and other self-checks', () => {
  const state = fixture([[4, 0, 'bK'], [4, 9, 'rK'], [4, 5, 'rR']]);
  assert.equal(hasMove(state, [4, 5], [3, 5]), false);
  assert.equal(hasMove(state, [4, 5], [4, 4]), true);
  const checked = fixture([[3, 0, 'bK'], [4, 9, 'rK'], [4, 1, 'bR'], [0, 7, 'rR']]);
  assert.equal(xiangqiView(checked).check, true);
  assert.equal(hasMove(checked, [0, 7], [0, 6]), false);
  assert.equal(hasMove(checked, [0, 7], [4, 7]), true);
});

test('Xiangqi checkmate and stalemate both award the last mover victory', () => {
  const mate = fixture([[4, 0, 'bK'], [4, 9, 'rK'], [3, 1, 'rR'], [5, 1, 'rR'], [4, 2, 'rR'], [4, 5, 'rP']]);
  applyXiangqi(mate, 'red', move([4, 2], [4, 1]));
  assert.equal(mate.status, 'finished'); assert.equal(mate.reason, 'checkmate'); assert.equal(mate.winner, 'red');
  const stale = fixture([[4, 0, 'bK'], [4, 9, 'rK'], [3, 2, 'rR'], [5, 2, 'rR'], [0, 1, 'rR'], [4, 5, 'rP']]);
  applyXiangqi(stale, 'red', move([0, 1], [1, 1]));
  assert.equal(stale.status, 'finished'); assert.equal(stale.reason, 'stalemate'); assert.equal(stale.winner, 'red');
});

test('Xiangqi threefold repetition includes side to move, and terminal states reject actions', () => {
  const state = initialXiangqi();
  const cycle = [['red', [1, 9], [2, 7]], ['black', [1, 0], [2, 2]], ['red', [2, 7], [1, 9]], ['black', [2, 2], [1, 0]]];
  for (let i = 0; i < 2; i++) for (const [actor, from, to] of cycle) applyXiangqi(state, actor, move(from, to));
  assert.equal(state.status, 'finished'); assert.equal(state.winner, null); assert.equal(state.reason, 'threefold-repetition');
  assert.deepEqual(legalXiangqi(state), []);
  assert.throws(() => applyXiangqi(state, 'red', move([0, 6], [0, 5])));
});

test('Xiangqi ply cap, JSON resume, and isolated view copies', () => {
  const state = JSON.parse(JSON.stringify(initialXiangqi({ maxPly: 1 })));
  applyXiangqi(state, 'red', move([0, 6], [0, 5]));
  assert.equal(state.reason, 'ply-cap'); assert.equal(state.winner, null);
  const view = xiangqiView(state); view.board[0][0] = null; view.history[0].from[0] = 8;
  assert.equal(state.board[0][0], 'bR'); assert.equal(state.history[0].from[0], 0);
});

test('Xiangqi red/black movement symmetry and deterministic legal playout survives JSON resume', () => {
  let state = initialXiangqi({ maxPly: 100 }), seed = 123456;
  for (let ply = 0; ply < 80 && state.status === 'playing'; ply++) {
    const before = JSON.stringify(state), legal = legalXiangqi(state);
    assert.equal(JSON.stringify(state), before, 'legal move generation must not mutate state');
    const mirrored = JSON.parse(before);
    mirrored.board = state.board.slice().reverse().map(row => row.slice().reverse().map(p => p ? `${p[0] === 'r' ? 'b' : 'r'}${p[1]}` : null));
    mirrored.turn = state.turn === 'red' ? 'black' : 'red';
    const transformed = legal.map(m => JSON.stringify(move([8 - m.from[0], 9 - m.from[1]], [8 - m.to[0], 9 - m.to[1]]))).sort();
    assert.deepEqual(legalXiangqi(mirrored).map(m => JSON.stringify(m)).sort(), transformed);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const chosen = legal[seed % legal.length], actor = state.turn;
    const resumed = JSON.parse(before);
    applyXiangqi(state, actor, chosen); applyXiangqi(resumed, actor, chosen);
    assert.deepEqual(state, resumed);
    const priorMoverView = structuredClone(state); priorMoverView.turn = actor;
    assert.equal(xiangqiView(priorMoverView).check, false, 'a legal move never leaves its own general checked');
    state = resumed;
  }
});

test('Werewolf fixtures validate role counts; default produces all six correct roles', () => {
  for (let i = 0; i < 20; i++) assert.deepEqual(initialWerewolf().players.map(p => p.role).sort(), [...roles].sort());
  assert.throws(() => initialWerewolf({ roles: Array(6).fill('wolf') }));
  assert.throws(() => initialWerewolf({ maxRounds: 21 }));
  assert.deepEqual(pendingWerewolf(wolf()), ['p1', 'p2']);
});

test('Werewolf strictly validates phase, seat, shape, and living targets without changing state', () => {
  const state = wolf(), before = JSON.stringify(state);
  for (const [seat, action] of [
    ['p3', { type: 'kill', target: 'p5' }], ['p7', { type: 'kill', target: 'p5' }],
    ['p1', { type: 'kill', target: 'p2' }], ['p1', { type: 'kill', target: 'p1' }],
    ['p1', { type: 'kill', target: 'p7' }], ['p1', { type: 'kill', target: 'p5', role: 'seer' }],
    ['p1', { type: 'vote', target: 'p5' }], ['p1', { type: 'kill' }],
  ]) { assert.throws(() => applyWerewolf(state, seat, action)); assert.equal(JSON.stringify(state), before); }
  applyWerewolf(state, 'p1', { type: 'kill', target: 'p5' });
  assert.throws(() => applyWerewolf(state, 'p1', { type: 'kill', target: 'p6' }));
});

test('Werewolf public and other-seat views never expose night choices or private results', () => {
  const state = wolf();
  applyWerewolf(state, 'p1', { type: 'kill', target: 'p5' });
  const publicDuringVote = werewolfView(state);
  assert.equal(publicDuringVote.players.some(p => 'role' in p), false);
  assert.equal('self' in publicDuringVote, false); assert.equal('night' in publicDuringVote, false);
  assert.equal('revealed' in publicDuringVote, false);
  assert.equal(werewolfView(state, 'p2').self.killVote, null);
  assert.deepEqual(werewolfView(state, 'p1').self.teammates, ['p2']);
  applyWerewolf(state, 'p2', { type: 'kill', target: 'p5' });
  applyWerewolf(state, 'p3', { type: 'inspect', target: 'p1' });
  assert.deepEqual(werewolfView(state, 'p3').self.findings, [{ round: 1, target: 'p1', wolf: true }]);
  assert.equal(werewolfView(state, 'p4').self.nightVictim, 'p5');
  for (const seat of [null, 'p1', 'p2', 'p5', 'p6']) {
    const view = werewolfView(state, seat);
    assert.equal('findings' in (view.self || {}), false);
    assert.equal('nightVictim' in (view.self || {}), false);
    assert.equal('potions' in view, false);
    assert.deepEqual(view.log, [{ type: 'night', round: 1 }]);
  }
  applyWerewolf(state, 'p4', { type: 'witch', save: false, poison: null });
  assert.deepEqual(werewolfView(state).log.at(-1), { type: 'dawn', round: 1, deaths: ['p5'] });
  assert.equal(werewolfView(state).players.find(p => p.id === 'p5').role, undefined);
  assert.equal(werewolfView(state, 'p5').self.canAct, false);
  assert.throws(() => applyWerewolf(state, 'p5', { type: 'speak', text: 'dead' }));
});

test('Werewolf wolf ties mean no kill and votes are private until all cast', () => {
  const state = wolf(); night(state, { targets: ['p5', 'p6'] });
  assert.equal(state.phase, 'discuss'); assert.equal(state.players.filter(p => p.alive).length, 6);
  passDiscussion(state);
  applyWerewolf(state, 'p1', { type: 'vote', target: 'p3' });
  assert.equal('votes' in werewolfView(state), false);
  assert.equal(werewolfView(state, 'p2').self.vote, null);
  assert.equal(werewolfView(state).log.some(entry => entry.type === 'exile'), false);
  for (const [seat, target] of [['p2', 'p4'], ['p3', 'p4'], ['p4', 'p3'], ['p5', null], ['p6', null]]) applyWerewolf(state, seat, { type: 'vote', target });
  const exile = state.log.find(entry => entry.type === 'exile');
  assert.equal(exile.seat, null); assert.equal(exile.votes.p1, 'p3');
  assert.equal(state.round, 2); assert.equal(state.players.filter(p => p.alive).length, 6);
});

test('Werewolf witch cannot combine potions and can save herself only once', () => {
  const state = wolf();
  applyWerewolf(state, 'p1', { type: 'kill', target: 'p4' });
  applyWerewolf(state, 'p2', { type: 'kill', target: 'p4' });
  timeoutWerewolf(state, 'p3');
  const before = JSON.stringify(state);
  assert.throws(() => applyWerewolf(state, 'p4', { type: 'witch', save: true, poison: 'p1' }));
  assert.equal(JSON.stringify(state), before);
  applyWerewolf(state, 'p4', { type: 'witch', save: true, poison: null });
  assert.equal(state.players[3].alive, true); assert.equal(state.potions.save, false);
  passDiscussion(state); passVote(state);
  applyWerewolf(state, 'p1', { type: 'kill', target: 'p5' });
  applyWerewolf(state, 'p2', { type: 'kill', target: 'p5' });
  timeoutWerewolf(state, 'p3');
  assert.equal('nightVictim' in werewolfView(state, 'p4').self, false);
  assert.throws(() => applyWerewolf(state, 'p4', { type: 'witch', save: true, poison: null }));
  applyWerewolf(state, 'p4', { type: 'witch', save: false, poison: 'p1' });
  assert.equal(state.potions.poison, false); assert.equal(state.players[0].alive, false);
  assert.equal(state.players[4].alive, false); assert.equal(state.status, 'playing');
});

test('Werewolf simultaneous night outcomes, wolf parity, terminal reveal and rejected late actions', () => {
  const state = wolf(); night(state, { targets: ['p5', 'p5'], poison: 'p6' });
  assert.equal(state.status, 'finished'); assert.equal(state.winner, 'wolves'); assert.equal(state.reason, 'wolf-parity');
  assert.deepEqual(state.log.find(x => x.type === 'dawn').deaths, ['p5', 'p6']);
  assert.equal(werewolfView(state).players.every(p => typeof p.role === 'string'), true);
  assert.deepEqual(pendingWerewolf(state), []);
  assert.throws(() => timeoutWerewolf(state, 'p1'));
  assert.throws(() => applyWerewolf(state, 'p1', { type: 'kill', target: 'p3' }));
});

test('Werewolf good wins when all wolves die and dead special-role phases auto-skip', () => {
  const state = wolf(); night(state, { targets: [null, null], poison: 'p1' });
  passDiscussion(state);
  for (const id of pendingWerewolf(state)) applyWerewolf(state, id, { type: 'vote', target: 'p2' });
  assert.equal(state.winner, 'good'); assert.equal(state.reason, 'all-wolves-eliminated');
  const deadSeer = wolf(); night(deadSeer, { targets: ['p3', 'p3'] });
  passDiscussion(deadSeer); passVote(deadSeer);
  applyWerewolf(deadSeer, 'p1', { type: 'kill', target: null });
  applyWerewolf(deadSeer, 'p2', { type: 'kill', target: null });
  assert.equal(deadSeer.phase, 'witch'); assert.deepEqual(pendingWerewolf(deadSeer), ['p4']);
});

test('Werewolf timeouts deterministically draw after 20 rounds, including JSON persistence', () => {
  let state = wolf(), actions = 0;
  while (state.status === 'playing') {
    timeoutWerewolf(state, pendingWerewolf(state)[0]);
    state = JSON.parse(JSON.stringify(state));
    actions++; assert.ok(actions <= 320);
  }
  assert.equal(actions, 320); assert.equal(state.round, 20);
  assert.equal(state.winner, null); assert.equal(state.reason, 'round-cap');
  assert.equal(state.players.every(p => p.alive), true);
});

test('Werewolf invalid speech, unavailable poison and view mutations are isolated', () => {
  const state = wolf(); night(state, { targets: [null, null], poison: 'p1' });
  assert.throws(() => applyWerewolf(state, 'p3', { type: 'speak', text: 'x'.repeat(601) }));
  const view = werewolfView(state, 'p4'); view.self.potions.poison = true; view.log[0].round = 99; view.players[0].alive = true;
  assert.equal(state.potions.poison, false); assert.equal(state.log[0].round, 1); assert.equal(state.players[0].alive, false);
  passDiscussion(state); passVote(state);
  timeoutWerewolf(state, 'p2'); timeoutWerewolf(state, 'p3');
  assert.throws(() => applyWerewolf(state, 'p4', { type: 'witch', save: false, poison: 'p2' }));
  assert.throws(() => applyWerewolf(state, 'p4', { type: 'witch', save: false, poison: 'p1' }));
  assert.throws(() => werewolfView(state, 'judge'));
});

test('Werewolf ballots resolve identically regardless of submission order', () => {
  const a = wolf(), b = wolf();
  applyWerewolf(a, 'p1', { type: 'kill', target: 'p5' });
  applyWerewolf(a, 'p2', { type: 'kill', target: 'p6' });
  applyWerewolf(b, 'p2', { type: 'kill', target: 'p6' });
  applyWerewolf(b, 'p1', { type: 'kill', target: 'p5' });
  for (const state of [a, b]) { timeoutWerewolf(state, 'p3'); timeoutWerewolf(state, 'p4'); passDiscussion(state); }
  const votes = { p1: 'p3', p2: 'p4', p3: 'p4', p4: 'p3', p5: 'p4', p6: null };
  for (const seat of Object.keys(votes)) applyWerewolf(a, seat, { type: 'vote', target: votes[seat] });
  for (const seat of Object.keys(votes).reverse()) applyWerewolf(b, seat, { type: 'vote', target: votes[seat] });
  assert.equal(a.players[3].alive, false); assert.equal(b.players[3].alive, false);
  assert.deepEqual(a, b);
});

test('Werewolf dead witch auto-skips, an absent victim cannot be saved, and seer sees only wolf status', () => {
  const state = wolf();
  applyWerewolf(state, 'p1', { type: 'kill', target: null });
  applyWerewolf(state, 'p2', { type: 'kill', target: null });
  assert.throws(() => applyWerewolf(state, 'p3', { type: 'inspect', target: 'p3' }));
  applyWerewolf(state, 'p3', { type: 'inspect', target: 'p4' });
  assert.deepEqual(werewolfView(state, 'p3').self.findings, [{ round: 1, target: 'p4', wolf: false }]);
  assert.throws(() => applyWerewolf(state, 'p4', { type: 'witch', save: true, poison: null }));
  timeoutWerewolf(state, 'p4'); passDiscussion(state);
  for (const seat of pendingWerewolf(state)) applyWerewolf(state, seat, { type: 'vote', target: 'p4' });
  applyWerewolf(state, 'p1', { type: 'kill', target: null });
  applyWerewolf(state, 'p2', { type: 'kill', target: null });
  timeoutWerewolf(state, 'p3');
  assert.equal(state.phase, 'discuss'); assert.equal(state.players[3].alive, false);
});


test('Werewolf public and inactive-seat views conceal exact night phase', () => {
 const s=initialWerewolf({roles});
 assert.equal(werewolfView(s).phase,'night');
 assert.equal(werewolfView(s,'p5').phase,'night');
 assert.equal(werewolfView(s,'p1').phase,'wolf');
 applyWerewolf(s,'p1',{type:'kill',target:null});applyWerewolf(s,'p2',{type:'kill',target:null});
 assert.equal(werewolfView(s).phase,'night');
 assert.equal(werewolfView(s,'p1').phase,'night');
 assert.equal(werewolfView(s,'p3').phase,'seer');
});

import { initialBlind, legalBlind, applyBlind, blindView } from '../lib/blind.mjs';
const bmove = (from, to) => ({ from, to });
const hasBlindMove = (state, from, to) => legalBlind(state).some(m => JSON.stringify(m) === JSON.stringify(bmove(from, to)));

test('Blind Xiangqi deals 32 pieces: two open kings, 30 shuffled covered pieces, 44 opening moves', () => {
  const state = initialBlind({ seed: 42 });
  const all = state.board.flat().filter(Boolean);
  assert.equal(all.length, 32);
  assert.equal(all.filter(p => p.h).length, 30);
  assert.deepEqual([state.board[0][4].s, state.board[0][4].k, state.board[0][4].h], ['black', 'K', false]);
  assert.deepEqual([state.board[9][4].s, state.board[9][4].k, state.board[9][4].h], ['red', 'K', false]);
  const pool = all.filter(p => p.h).map(p => p.s[0] + p.k).sort();
  const expected = [];
  for (const s of ['r', 'b']) for (const k of ['R', 'R', 'H', 'H', 'E', 'E', 'A', 'A', 'C', 'C', 'P', 'P', 'P', 'P', 'P']) expected.push(s + k);
  assert.deepEqual(pool, expected.sort());
  assert.equal(legalBlind(state).length, 44);
  assert.equal(state.turn, 'red');
  const a = initialBlind({ seed: 7 }), b = initialBlind({ seed: 7 });
  assert.equal(JSON.stringify(a.board), JSON.stringify(b.board));
  const view = blindView(state);
  assert.equal(view.board[0][0].hidden, true);
  assert.deepEqual(view.board[0][4], { hidden: false, side: 'black', kind: 'K' });
});

test('Blind covered pieces move as their cover, reveal on the first move and may change allegiance', () => {
  const state = initialBlind({ seed: 42 });
  const before = JSON.stringify(state);
  for (const action of [null, {}, bmove([0.1, 6], [0, 5]), bmove([-1, 6], [0, 5]), bmove([0, 6], [0, 6]), bmove([0, 6], [1, 6]), bmove([0, 6], [0, 4])]) {
    assert.throws(() => applyBlind(state, 'red', action));
    assert.equal(JSON.stringify(state), before);
  }
  assert.throws(() => applyBlind(state, 'black', bmove([0, 3], [0, 4])));
  applyBlind(state, 'red', bmove([0, 6], [0, 5]));
  const p = state.board[5][0];
  assert.equal(p.h, false);
  assert.equal(state.lastMove.wasHidden, true);
  assert.equal(state.quietPlies, 0);
  assert.match(state.lastMove.text, /暗棋 1,4 → 1,5，揭开为/);
  assert.equal(state.board[5][0].s === 'red', !state.lastMove.text.includes('移交'));
  // A covered piece still on its square moves as the square's kind: back-rank elephant stays on its own half.
  const s2 = initialBlind({ seed: 11 });
  assert.equal(hasBlindMove(s2, [2, 9], [4, 7]), true);
  assert.equal(hasBlindMove(s2, [2, 9], [0, 7]), true);
  // Covered elephants keep the river rule; the same piece may cross once revealed (house rule).
  const s3 = initialBlind({ seed: 42 });
  s3.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  s3.board[9][4] = { s: 'red', k: 'K', h: false, cs: null, ck: null };
  s3.board[0][4] = { s: 'black', k: 'K', h: false, cs: null, ck: null };
  s3.board[5][4] = { s: 'red', k: 'E', h: true, cs: 'red', ck: 'E' };
  s3.repetitions = {};
  assert.equal(hasBlindMove(s3, [4, 5], [2, 3]), false);
  assert.equal(hasBlindMove(s3, [4, 5], [2, 7]), true);
  s3.board[5][4].h = false;
  assert.equal(hasBlindMove(s3, [4, 5], [2, 3]), true);
});

test('Blind capture-the-general wins immediately; hidden captures are revealed publicly', () => {
  const state = initialBlind({ seed: 42 });
  state.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  state.board[9][4] = { s: 'red', k: 'K', h: false, cs: null, ck: null };
  state.board[0][4] = { s: 'black', k: 'K', h: false, cs: null, ck: null };
  state.board[5][4] = { s: 'red', k: 'R', h: true, cs: 'red', ck: 'R' };
  state.repetitions = {};
  applyBlind(state, 'red', bmove([4, 5], [4, 0]));
  assert.equal(state.status, 'finished');
  assert.equal(state.winner, 'red');
  assert.equal(state.reason, 'general-captured');
  const view = blindView(state);
  assert.equal(view.captured.red.length, 1);
  assert.deepEqual(view.captured.red[0], { hidden: false, side: 'black', kind: 'K' });
});

test('Blind flying-general capture works along an open file; no check obligation exists', () => {
  const state = initialBlind({ seed: 42 });
  state.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  state.board[9][4] = { s: 'red', k: 'K', h: false, cs: null, ck: null };
  state.board[0][4] = { s: 'black', k: 'K', h: false, cs: null, ck: null };
  state.board[5][3] = { s: 'black', k: 'R', h: false, cs: null, ck: null };
  state.repetitions = {};
  // Red king may capture the exposed black general down the open file.
  assert.equal(hasBlindMove(state, [4, 9], [4, 0]), true);
  // Red may also make an unrelated waiting move even though black rook attacks the palace: no forced check response.
  state.board[9][0] = { s: 'red', k: 'R', h: false, cs: null, ck: null };
  applyBlind(state, 'red', bmove([0, 9], [0, 8]));
  assert.equal(state.status, 'playing');
  assert.equal(state.turn, 'black');
});

test('Blind no-legal-move loses and quiet plies / repetition draw', () => {
  const state = initialBlind({ seed: 42 });
  state.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  state.board[9][4] = { s: 'red', k: 'K', h: false, cs: null, ck: null };
  state.board[7][9] = { s: 'black', k: 'K', h: false, cs: null, ck: null };
  state.board[8][9] = { s: 'black', k: 'P', h: false, cs: null, ck: null };
  state.repetitions = {};
  // Capture-the-king rules have no check concept: pieces are lost only when every
  // own move is physically impossible. The black king sits outside its palace and
  // the last black pawn is boxed in at the back rank corner, so black has no move.
  applyBlind(state, 'red', bmove([4, 9], [3, 9]));
  assert.equal(state.status, 'finished');
  assert.equal(state.winner, 'red');
  assert.equal(state.reason, 'no-legal-move');
  // Quiet-ply accounting: revealed pieces shuffling without capture accumulates toward the 120-ply draw.
  const s2 = initialBlind({ seed: 42 });
  s2.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  s2.board[9][4] = { s: 'red', k: 'K', h: false, cs: null, ck: null };
  s2.board[0][4] = { s: 'black', k: 'K', h: false, cs: null, ck: null };
  s2.repetitions = {};
  s2.quietPlies = 119;
  applyBlind(s2, 'red', bmove([4, 9], [3, 9]));
  assert.equal(s2.quietPlies, 120);
  assert.equal(s2.status, 'finished');
  assert.equal(s2.winner, null);
  assert.equal(s2.reason, 'quiet-120');
});
