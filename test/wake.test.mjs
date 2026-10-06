import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Arena} from '../lib/arena.mjs';
import {Store} from '../lib/store.mjs';
import {WakeService} from '../lib/wake.mjs';
import {WAKE_PROVIDERS, providerName, markerFor, retryable} from '../lib/wake/common.mjs';
import {serve} from '../server.mjs';
import {temporaryDirectory, removeTemporaryDirectory} from '../lib/temp.mjs';

const workspace = path.resolve('.'), cli = promisify(execFile);
const invitationToken = invitation => invitation.text.match(/--invitation ([a-f0-9]+)/)[1];

function host() {
 const messages = new Map(), calls = [], states = new Map();
 return {messages, calls, states,
  async read(binding) { return {session: binding.session, workspace, status: states.get(binding.session) || 'idle', messages: messages.get(binding.session) || [], model: 'fixture/model'}; },
  async send(binding, prompt, marker) {
   calls.push({binding, prompt, marker});
   const history = messages.get(binding.session) || [];
   history.push({role: 'user', text: prompt}); messages.set(binding.session, history);
   return {delivered: true};
  }
 };
}

function fixture(t, options = {}) {
 const root = temporaryDirectory('arena-wake-'), store = new Store(root), clock = {now: Date.now()}, arena = new Arena(store, {now: () => clock.now}), adapter = host();
 const wake = new WakeService(arena, {adapters: Object.fromEntries(WAKE_PROVIDERS.map(p => [p, adapter])), readTimeoutMs: 100, sendTimeoutMs: 100, ...options});
 t.after(() => { wake.stop(); store.close(); removeTemporaryDirectory(root); });
 return {root, store, clock, arena, adapter, wake,
  async connect(id, seat, provider = 'opencode', session = `session-${seat}`) {
   const invite = arena.invite(id, seat, 'http://127.0.0.1:4318');
   const input = {match: id, seat, invitation: invitationToken(invite), provider, session, credentialPath: path.join(root, `${seat}.credential.json`), turnId: 'fixture-turn'};
   const connection = await wake.connect(input);
   return {connection, identity: arena.identity(connection.token), input};
  },
  async all(id, provider = 'opencode') {
   const identities = {};
   for (const seat of arena.seats(arena.get(id))) identities[seat] = (await this.connect(id, seat, provider)).identity;
   return identities;
  },
  async tick() { clock.now += 3100; await Promise.all(wake.tick()); }
 };
}

test('Every wake provider verifies before consuming invitations, then parks; aliases and auto are explicit', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'werewolf'}).id;
 for (let i = 0; i < WAKE_PROVIDERS.length; i++) {
  const {connection} = await f.connect(id, `p${i + 1}`, WAKE_PROVIDERS[i]);
  assert.equal(connection.continuationMode, 'wake');
  assert.equal(connection.parked, true);
 }
 assert.equal(providerName('qodercn'), 'qoder');
 assert.equal(providerName('codeartsdoer'), 'codearts');
 assert.equal(providerName('OpenCode'), 'opencode');
 assert.throws(() => providerName('AUTO'), /confirm/);
 assert.throws(() => providerName(undefined), /confirm/);
 await f.tick(); assert.equal(f.adapter.calls.length, 0, 'no notifications before the administrator starts');
});

test('Wrong session/workspace, missing model, duplicate host role and expiry do not consume an invitation', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi'}).id;
 const invite = f.arena.invite(id, 'red', 'http://127.0.0.1:4318');
 const input = {match: id, seat: 'red', invitation: invitationToken(invite), provider: 'opencode', session: 'session-red', credentialPath: path.join(f.root, 'red.credential.json')};
 const read = f.adapter.read;
 f.adapter.read = async () => ({session: 'different', workspace, status: 'idle'});
 await assert.rejects(f.wake.connect(input), /different session/);
 f.adapter.read = async () => ({session: input.session, workspace: path.join(workspace, 'wrong'), status: 'idle'});
 await assert.rejects(f.wake.connect(input), /workspace/);
 f.adapter.read = async binding => ({...await read(binding), model: undefined});
 await assert.rejects(f.wake.connect({...input, provider: 'mimo'}), /confirmed model/);
 assert.ok(f.arena.get(id).invites.red);
 f.adapter.read = read;
 await f.wake.connect(input);
 const second = f.arena.invite(id, 'black', 'http://127.0.0.1:4318');
 await assert.rejects(f.wake.connect({...input, seat: 'black', invitation: invitationToken(second)}), /already bound/);
 assert.ok(f.arena.get(id).invites.black);
 f.clock.now += 1800001;
 await assert.rejects(f.wake.connect({...input, seat: 'black', session: 'session-black', invitation: invitationToken(second)}), /expired/);
});

test('Wake is sent once to the pending participant; delivery is separate from claim/submit', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi', timeoutSeconds: 180}).id, ids = await f.all(id);
 f.arena.start(id); await f.tick(); await f.tick();
 assert.equal(f.adapter.calls.length, 1);
 const notice = f.arena.get(id).jobs[0].wakeNotice;
 assert.equal(notice.status, 'sent');
 assert.equal(f.arena.get(id).jobs[0].clientId, null);
 assert.ok(!f.adapter.calls[0].prompt.includes(f.arena.get(id).bindings.red.tokenHash));
 const {job} = await f.wake.resume(ids.red);
 assert.equal(job.seat, 'red');
 assert.equal(f.arena.get(id).bindings.red.armed, false);
 f.arena.submit(ids.red, {...job, result: {from: [0, 6], to: [0, 5]}});
 assert.equal((await f.wake.resume(ids.red)).parked, true);
 await f.tick();
 assert.equal(f.adapter.calls.length, 2);
 assert.equal(f.adapter.calls[1].binding.session, 'session-black');
 const {job: blackJob} = await f.wake.resume(ids.black);
 assert.throws(() => f.arena.submit(ids.red, {...blackJob, result: {from: [0, 3], to: [0, 4]}}), /foreign session/);
});

test('Busy/unknown hosts stay pending and retry only when idle; a definite busy rejection is safe to retry', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi'}).id; await f.all(id); f.arena.start(id);
 f.adapter.states.set('session-red', 'active'); await f.tick();
 f.adapter.states.set('session-red', 'unknown'); await f.tick();
 assert.equal(f.adapter.calls.length, 0);
 f.adapter.states.set('session-red', 'idle');
 const send = f.adapter.send; let tries = 0;
 f.adapter.send = async (...args) => { if (!tries++) throw retryable('busy'); return send(...args); };
 await f.tick(); assert.equal(f.arena.get(id).jobs[0].wakeNotice.status, 'pending');
 await f.tick(); assert.equal(f.arena.get(id).jobs[0].wakeNotice.status, 'sent');
 assert.equal(tries, 2);
});

test('Uncertain delivery and a persisted sending record never resend; only a matching user marker reconciles', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi'}).id; const ids = await f.all(id); f.arena.start(id);
 let sends = 0; f.adapter.send = async () => { sends++; throw Error('lost ack'); };
 await f.tick(); await f.tick();
 assert.equal(sends, 1); assert.equal(f.arena.get(id).jobs[0].wakeNotice.status, 'uncertain');
 const marker = markerFor(f.arena.get(id).jobs[0].attemptId);
 f.adapter.messages.set('session-red', [{role: 'assistant', text: `[${marker}]`}]);
 await f.tick(); assert.equal(f.arena.get(id).jobs[0].wakeNotice.status, 'uncertain');
 f.store.change(s => { s.matches[id].jobs[0].wakeNotice.status = 'sending'; });
 f.wake.stop();
 f.store.close();
 const restartedStore = new Store(f.root), restartedArena = new Arena(restartedStore, {now: () => f.clock.now});
 const restored = new WakeService(restartedArena, {adapters: {opencode: f.adapter}, readTimeoutMs: 100});
 try {
 await Promise.all(restored.tick({force: true})); assert.equal(sends, 1);
 f.adapter.messages.set('session-red', [{role: 'user', text: `[${marker}]`}]);
 await Promise.all(restored.tick({force: true}));
 assert.equal(restartedArena.get(id).jobs[0].wakeNotice.status, 'sent');
 assert.equal(sends, 1);
 assert.equal((await restored.resume(ids.red)).job.seat, 'red');
 } finally { restored.stop(); restartedStore.close(); }
});

test('Revocation during a host read cancels delivery and keeps the old deadline', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi'}).id; const ids = await f.all(id); f.arena.start(id);
 const deadline = f.arena.get(id).jobs[0].deadline, read = f.adapter.read;
 let release, entered;
 const ready = new Promise(resolve => { entered = resolve; });
 f.adapter.read = binding => new Promise(resolve => { release = () => resolve(read(binding)); entered(); });
 const work = f.wake.tick();
 await ready;
 f.arena.revoke(id, 'red'); release(); await Promise.all(work);
 assert.equal(f.adapter.calls.length, 0);
 assert.equal(f.arena.get(id).jobs[0].deadline, deadline);
 assert.throws(() => f.arena.claim(ids.red), /revoked/);
 f.adapter.read = read;
 const {connection} = await f.connect(id, 'red', 'opencode', 'new-session-red');
 assert.ok(connection.job);
 assert.equal(connection.job.deadline, deadline);
});

test('A hung host does not block another role; notification text and public views exclude night secrets', async t => {
 const f = fixture(t, {readTimeoutMs: 20}), id = f.arena.create({kind: 'werewolf'}).id; await f.all(id); f.arena.start(id);
 const wolves = f.arena.get(id).game.players.filter(p => p.role === 'wolf').map(p => p.id), read = f.adapter.read;
 f.adapter.read = binding => binding.session === `session-${wolves[0]}` ? new Promise(() => {}) : read(binding);
 await f.tick();
 assert.equal(f.adapter.calls.length, 1);
 assert.equal(f.adapter.calls[0].binding.session, `session-${wolves[1]}`);
 for (const call of f.adapter.calls) assert.ok(!/"role"|"phase"|"wolf"|"seer"/.test(call.prompt));
 const publicView = JSON.stringify(f.arena.public(f.arena.get(id)));
 assert.ok(!publicView.includes('wakeNotice'));
 assert.ok(!publicView.includes('credentialPath'));
 assert.ok(!publicView.includes('"phase":"wolf"'));
});

test('Timeout wakes the judge and sends one completion notice to parked participants', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi', timeoutSeconds: 10}).id, ids = await f.all(id); f.arena.start(id);
 f.clock.now += 11000; f.arena.tick(); await f.tick(); await f.tick();
 const ended = f.adapter.calls.filter(c => c.prompt.includes('本场比赛已结束'));
 assert.equal(ended.length, 2);
 assert.equal(f.adapter.calls.filter(c => c.binding.session === 'session-judge').length, 1);
 assert.equal((await f.wake.resume(ids.black)).completed, true);
 assert.equal(f.arena.get(id).bindings.black.armed, false);
});

test('HTTP and actual CLI wake flow return parked promptly and protect management diagnostics', async t => {
 const root = temporaryDirectory('arena-wake-http-'), adapter = host(), app = await serve({port: 0, root, adminToken: 'fixture-admin', wakeOptions: {adapters: {opencode: adapter}}});
 t.after(async () => { await app.close(); removeTemporaryDirectory(root); });
 const id = app.arena.create({kind: 'xiangqi'}).id;
 const files = {};
 for (const seat of ['red', 'black', 'judge']) {
  const invite = app.arena.invite(id, seat, app.origin), credential = files[seat] = path.join(root, `${seat}.credential.json`);
  const result = await cli(process.execPath, ['client.mjs', 'connect', '--url', app.origin, '--match', id, '--seat', seat, '--invitation', invitationToken(invite), '--provider', 'opencode', '--session', `ses_http-${seat}`, '--out', credential]);
  const out = JSON.parse(result.stdout);
  assert.equal(out.parked, true);
  assert.equal(out.continuationMode, 'wake');
  assert.ok(!result.stdout.includes('"token"'));
 }
 let response = await fetch(`${app.origin}/api/matches/${id}/connections`);
 assert.equal(response.status, 401);
 response = await fetch(`${app.origin}/api/matches/${id}/connections`, {headers: {Authorization: 'Bearer fixture-admin'}});
 assert.equal((await response.json())[0].status, 'parked');
 response = await fetch(`${app.origin}/api/wake-check`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({match: id, seat: 'red'})});
 assert.equal(response.status, 401);
 const start = Date.now(), parked = await cli(process.execPath, ['client.mjs', 'resume', '--credential', files.red]);
 assert.equal(JSON.parse(parked.stdout).parked, true);
 assert.ok(Date.now() - start < 3000, 'wake resume must not enter the 60-second wait loop');
 app.arena.start(id); await Promise.all(app.wake.tick());
 const {job} = JSON.parse((await cli(process.execPath, ['client.mjs', 'resume', '--credential', files.red])).stdout);
 fs.writeFileSync(path.join(root, 'response.json'), JSON.stringify({from: [0, 6], to: [0, 5]}), 'utf8');
 const submitted = await cli(process.execPath, ['client.mjs', 'submit', '--credential', files.red, '--task', job.taskId, '--attempt', job.attemptId, '--file', path.join(root, 'response.json')]);
 assert.equal(JSON.parse(submitted.stdout).receiptPersisted, true);
 assert.equal(JSON.parse((await cli(process.execPath, ['client.mjs', 'resume', '--credential', files.red])).stdout).parked, true);
 await Promise.all(app.wake.tick());
 assert.equal(adapter.calls.at(-1).binding.session, 'ses_http-black');
});
