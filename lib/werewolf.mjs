import { randomInt } from 'node:crypto';

/**
 * Six-player arena Werewolf: 2 wolves, seer, witch, 2 villagers.
 * initialWerewolf({roles}) accepts an explicit role array for reproducible tests;
 * omit it in production for a crypto.randomInt Fisher–Yates shuffle.
 * State contains secrets. NEVER serialize it to clients; use werewolfView.
 * pendingWerewolf is SERVER-ONLY: night actor IDs would reveal their roles.
 * Actions, exclusively in the actor's corresponding phase:
 * wolf:    {type:'kill', target:'p1'|...|'p6'|null} (null = abstain)
 * seer:    {type:'inspect', target:seat|null}
 * witch:   {type:'witch', save:boolean, poison:seat|null}
 * discuss: {type:'speak', text:string} (0–600 chars, one turn each)
 * vote:    {type:'vote', target:seat|null}
 * Wolves vote simultaneously; tied plurality = no kill. Day voting follows
 * the same rule. Abstentions do not count as votes; self-votes are allowed.
 * Witch may save herself; save and poison cannot both be used that night.
 * Each potion can be used once per game. Death roles/cause remain hidden
 * until game end. Seer sees only wolf/not-wolf. No dead-player actions.
 * Night deaths resolve simultaneously. No surviving players is a draw;
 * otherwise no wolves = good win, wolves >= good = wolf win.
 * After 20 full rounds, the game draws. Missing turns time out as abstention.
 */

const ROLES = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];
const SEATS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const clone = value => structuredClone(value);
const live = state => state.players.filter(p => p.alive);
const player = (state, seat) => state.players.find(p => p.id === seat);

export function initialWerewolf({ roles, maxRounds = 20 } = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) throw new Error('maxRounds must be an integer from 1 to 20');
  if (roles !== undefined && (!Array.isArray(roles) || roles.length !== 6 || roles.some(r => typeof r !== 'string') || [...roles].sort().join(',') !== [...ROLES].sort().join(','))) throw new Error('Use exactly two wolves, a seer, a witch, and two villagers');
  const shuffled = roles ? roles.slice() : ROLES.slice();
  if (!roles) for (let i = shuffled.length - 1; i > 0; i--) { const j = randomInt(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  return {
    game: 'werewolf', status: 'playing', winner: null, reason: null,
    phase: 'wolf', round: 1, maxRounds,
    players: SEATS.map((id, i) => ({ id, role: shuffled[i], alive: true })),
    potions: { save: true, poison: true }, findings: {},
    night: { wolfVotes: {}, target: null, save: false, poison: null, seerDone: false, witchDone: false },
    speeches: {}, votes: {},
    log: [{ type: 'night', round: 1 }],
  };
}

export function pendingWerewolf(state) {
  if (state.status !== 'playing') return [];
  const alive = live(state);
  if (state.phase === 'wolf') return alive.filter(p => p.role === 'wolf' && !Object.hasOwn(state.night.wolfVotes, p.id)).map(p => p.id);
  if (state.phase === 'seer') return state.night.seerDone ? [] : alive.filter(p => p.role === 'seer').map(p => p.id);
  if (state.phase === 'witch') return state.night.witchDone ? [] : alive.filter(p => p.role === 'witch').map(p => p.id);
  if (state.phase === 'discuss') return alive.filter(p => !Object.hasOwn(state.speeches, p.id)).map(p => p.id);
  if (state.phase === 'vote') return alive.filter(p => !Object.hasOwn(state.votes, p.id)).map(p => p.id);
  return [];
}

function plurality(ballots) {
  const counts = new Map();
  for (const target of Object.values(ballots)) if (target !== null) counts.set(target, (counts.get(target) || 0) + 1);
  let best = 0, winners = [];
  for (const [target, count] of counts) {
    if (count > best) { best = count; winners = [target]; }
    else if (count === best) winners.push(target);
  }
  return winners.length === 1 ? winners[0] : null;
}

function finish(state, winner, reason) {
  state.status = 'finished'; state.winner = winner; state.reason = reason;
  state.phase = 'finished';
  state.log.push({ type: 'finished', round: state.round, winner, reason });
}

function checkWinner(state) {
  const alive = live(state), wolves = alive.filter(p => p.role === 'wolf').length, good = alive.length - wolves;
  if (!alive.length) finish(state, null, 'no-survivors');
  else if (wolves === 0) finish(state, 'good', 'all-wolves-eliminated');
  else if (wolves >= good) finish(state, 'wolves', 'wolf-parity');
  return state.status === 'finished';
}

function advance(state) {
  // Empty-role phases are skipped on the server, without creating a public
  // event identifying whether a role is alive. All private results stay here.
  while (state.status === 'playing' && pendingWerewolf(state).length === 0) {
    if (state.phase === 'wolf') {
      state.night.target = plurality(state.night.wolfVotes);
      state.phase = 'seer';
    } else if (state.phase === 'seer') {
      state.phase = 'witch';
    } else if (state.phase === 'witch') {
      const deaths = new Set();
      if (state.night.target && !state.night.save) deaths.add(state.night.target);
      if (state.night.poison) deaths.add(state.night.poison);
      const killed = SEATS.filter(id => deaths.has(id));
      for (const id of killed) player(state, id).alive = false;
      state.log.push({ type: 'dawn', round: state.round, deaths: killed });
      if (checkWinner(state)) break;
      state.phase = 'discuss'; state.speeches = {}; state.votes = {};
    } else if (state.phase === 'discuss') {
      state.phase = 'vote';
      state.log.push({ type: 'voting', round: state.round });
    } else if (state.phase === 'vote') {
      const exiled = plurality(state.votes);
      if (exiled) player(state, exiled).alive = false;
      // Day ballots become public only after all living players have voted.
      state.log.push({ type: 'exile', round: state.round, seat: exiled, votes: clone(state.votes) });
      if (checkWinner(state)) break;
      if (state.round >= state.maxRounds) { finish(state, null, 'round-cap'); break; }
      state.round++; state.phase = 'wolf'; state.speeches = {}; state.votes = {};
      state.night = { wolfVotes: {}, target: null, save: false, poison: null, seerDone: false, witchDone: false };
      state.log.push({ type: 'night', round: state.round });
    } else throw new Error('Unknown game phase');
  }
}

function shape(action, type, keys) {
  return action && typeof action === 'object' && !Array.isArray(action) && action.type === type && Object.keys(action).sort().join(',') === ['type', ...keys].sort().join(',');
}

function validateTarget(state, target, { actor, forbidSelf = false, forbidWolves = false } = {}) {
  if (target === null) return;
  if (typeof target !== 'string' || !SEATS.includes(target) || !player(state, target).alive || (forbidSelf && target === actor) || (forbidWolves && player(state, target).role === 'wolf')) throw new Error('Invalid living target');
}

export function applyWerewolf(state, seat, action) {
  if (state.status !== 'playing') throw new Error('Game is finished');
  if (!SEATS.includes(seat) || !pendingWerewolf(state).includes(seat)) throw new Error('Actor cannot act now');
  if (state.phase === 'wolf') {
    if (!shape(action, 'kill', ['target'])) throw new Error('Use {type:"kill",target:seat|null}');
    validateTarget(state, action.target, { forbidWolves: true });
    state.night.wolfVotes[seat] = action.target;
  } else if (state.phase === 'seer') {
    if (!shape(action, 'inspect', ['target'])) throw new Error('Use {type:"inspect",target:seat|null}');
    validateTarget(state, action.target, { actor: seat, forbidSelf: true });
    if (action.target) {
      state.findings[seat] ??= [];
      state.findings[seat].push({ round: state.round, target: action.target, wolf: player(state, action.target).role === 'wolf' });
    }
    state.night.seerDone = true;
  } else if (state.phase === 'witch') {
    if (!shape(action, 'witch', ['save', 'poison']) || typeof action.save !== 'boolean') throw new Error('Use {type:"witch",save:boolean,poison:seat|null}');
    validateTarget(state, action.poison);
    if (action.save && action.poison !== null) throw new Error('Only one potion can be used in a night');
    if (action.save && (!state.potions.save || !state.night.target)) throw new Error('Save potion or victim unavailable');
    if (action.poison !== null && !state.potions.poison) throw new Error('Poison potion unavailable');
    state.night.save = action.save; state.night.poison = action.poison;
    if (action.save) state.potions.save = false;
    if (action.poison !== null) state.potions.poison = false;
    state.night.witchDone = true;
  } else if (state.phase === 'discuss') {
    if (!shape(action, 'speak', ['text']) || typeof action.text !== 'string' || action.text.length > 600) throw new Error('Use {type:"speak",text:string} up to 600 characters');
    const text = action.text.trim();
    state.speeches[seat] = text;
    state.log.push({ type: 'speech', round: state.round, seat, text });
  } else if (state.phase === 'vote') {
    if (!shape(action, 'vote', ['target'])) throw new Error('Use {type:"vote",target:seat|null}');
    validateTarget(state, action.target);
    state.votes[seat] = action.target;
  }
  advance(state);
  return state;
}

export function timeoutWerewolf(state, seat) {
  if (state.status !== 'playing' || !pendingWerewolf(state).includes(seat)) throw new Error('Actor cannot act now');
  const actions = {
    wolf: { type: 'kill', target: null },
    seer: { type: 'inspect', target: null },
    witch: { type: 'witch', save: false, poison: null },
    discuss: { type: 'speak', text: '' },
    vote: { type: 'vote', target: null },
  };
  return applyWerewolf(state, seat, actions[state.phase]);
}

export function werewolfView(state, seat = null, reveal = false) {
  if (seat !== null && !SEATS.includes(seat)) throw new Error('Unknown seat');
  const self = seat === null ? null : player(state, seat);
  const revealAll = reveal === true || state.status === 'finished';
  const view = {
    game: 'werewolf', status: state.status, winner: state.winner, reason: state.reason,
    phase: ['wolf', 'seer', 'witch'].includes(state.phase) && !revealAll && !(self && pendingWerewolf(state).includes(seat)) ? 'night' : state.phase, round: state.round, maxRounds: state.maxRounds,
    players: state.players.map(p => ({ id: p.id, alive: p.alive, ...(revealAll ? { role: p.role } : {}) })),
    log: clone(state.log),
    rules: {
      roles: { wolf: 2, seer: 1, witch: 1, villager: 2 },
      wolfTie: 'no-kill', voteTie: 'no-exile', deathRoles: 'hidden-until-game-end',
      potionsPerNight: 1, witchMaySaveSelf: true, seerResult: 'wolf-or-not-wolf', roundCap: state.maxRounds,
    },
  };
  if (self) {
    view.self = { id: seat, role: self.role, alive: self.alive, canAct: pendingWerewolf(state).includes(seat) };
    if (self.role === 'wolf') {
      view.self.teammates = state.players.filter(p => p.role === 'wolf' && p.id !== seat).map(p => p.id);
      view.self.killVote = Object.hasOwn(state.night.wolfVotes, seat) ? state.night.wolfVotes[seat] : null;
    }
    if (self.role === 'seer') view.self.findings = clone(state.findings[seat] || []);
    if (self.role === 'witch') {
      view.self.potions = clone(state.potions);
      // Victim information is supplied only to the living witch on her turn,
      // and only while the save potion remains available.
      if (self.alive && state.phase === 'witch' && state.potions.save) view.self.nightVictim = state.night.target;
    }
    if (state.phase === 'vote') view.self.vote = Object.hasOwn(state.votes, seat) ? state.votes[seat] : null;
  }
  if (revealAll) view.revealed = { findings: clone(state.findings), night: clone(state.night), potions: clone(state.potions) };
  return view;
}
