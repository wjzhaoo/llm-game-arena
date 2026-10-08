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

test('Timeout needs no judge and sends one completion notice to each parked participant', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi', timeoutSeconds: 10}).id, ids = await f.all(id); f.arena.start(id);
 f.clock.now += 11000; f.arena.tick(); await f.tick(); await f.tick();
 const ended = f.adapter.calls.filter(c => c.prompt.includes('本场比赛已结束'));
 assert.equal(ended.length, 2);
 assert.equal(f.adapter.calls.filter(c => c.binding.session === 'session-judge').length, 0);
 assert.equal((await f.wake.resume(ids.black)).completed, true);
 assert.equal(f.arena.get(id).bindings.black.armed, false);
});

test('Local invitation uses the installed absolute client from another model workspace and retains host verification',async t=>{
 const root=temporaryDirectory('arena-local-client-'),modelWorkspace=path.join(root,'原会话 工作区'),wrongWorkspace=path.join(root,'其他 工作区');
 fs.mkdirSync(modelWorkspace);fs.mkdirSync(wrongWorkspace);
 const adapter=host();adapter.read=async binding=>({session:binding.session,workspace:modelWorkspace,status:'idle',messages:adapter.messages.get(binding.session)||[]});
 const app=await serve({port:0,root:path.join(root,'server'),autoTick:false,wakeOptions:{adapters:{opencode:adapter}}});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const id=app.arena.create({kind:'xiangqi'}).id,invitation=app.arena.invite(id,'red',app.origin);
 const script=invitation.text.match(/node "([^"]+client\.mjs)" connect/)[1],credential=path.join(modelWorkspace,'tmp','red.credential.json');
 assert.equal(path.resolve(script),path.resolve('client.mjs'));
 assert.ok(path.isAbsolute(script));assert.ok(fs.existsSync(script));assert.ok(!fs.existsSync(path.join(modelWorkspace,'client.mjs')));
 assert.ok(invitation.text.includes(`node "${script}" resume`));assert.ok(invitation.text.includes(`node "${script}" submit`));
 const args=[script,'connect','--url',app.origin,'--match',id,'--seat','red','--invitation',invitationToken(invitation),'--provider','opencode','--session','ses_other-workspace','--workspace','.','--out','tmp/red.credential.json'];
 await assert.rejects(cli(process.execPath,args,{cwd:wrongWorkspace}),/workspace/);
 assert.ok(app.arena.get(id).invites.red);assert.equal(fs.existsSync(path.join(wrongWorkspace,'tmp','red.credential.json')),false);
 const connected=JSON.parse((await cli(process.execPath,args,{cwd:modelWorkspace})).stdout);
 assert.equal(connected.parked,true);
 assert.equal(app.arena.get(id).bindings.red.wake.workspace,modelWorkspace);
 assert.equal(JSON.parse(fs.readFileSync(credential,'utf8')).workspace,modelWorkspace);
 // Later commands must retain the original workspace even when launched elsewhere.
 await cli(process.execPath,[script,'wake-bind','--credential',credential],{cwd:root});
 assert.equal(app.arena.get(id).bindings.red.wake.workspace,modelWorkspace);
 assert.equal(JSON.parse((await cli(process.execPath,[script,'resume','--credential',credential],{cwd:root})).stdout).parked,true);
 const black=app.arena.invite(id,'black',app.origin);
 app.arena.connect({match:id,seat:'black',provider:'simulated',session:'fixture-black',invitation:invitationToken(black)});
 app.arena.start(id);await Promise.all(app.wake.tick());
 assert.equal(adapter.calls.length,1);assert.equal(adapter.calls[0].binding.workspace,modelWorkspace);
 assert.ok(adapter.calls[0].prompt.includes(`node "${script}" resume`));assert.ok(adapter.calls[0].prompt.includes(`node "${script}" submit`));
 assert.ok(!adapter.calls[0].prompt.includes(path.join(modelWorkspace,'client.mjs')));
 const {job}=JSON.parse((await cli(process.execPath,[script,'resume','--credential',credential],{cwd:root})).stdout);
 const response=path.join(modelWorkspace,'tmp','response.json');fs.writeFileSync(response,JSON.stringify({from:[0,6],to:[0,5]}),'utf8');
 const submitted=JSON.parse((await cli(process.execPath,[script,'submit','--credential',credential,'--task',job.taskId,'--attempt',job.attemptId,'--file',response],{cwd:root})).stdout);
 assert.equal(submitted.ok,true);assert.equal(app.arena.get(id).game.ply,1);
});

test('HTTP and actual CLI wake flow return parked promptly and protect management diagnostics', async t => {
 const root = temporaryDirectory('arena-wake-http-'), adapter = host(), app = await serve({port: 0, root, adminToken: 'fixture-admin', wakeOptions: {adapters: {opencode: adapter}}});
 t.after(async () => { await app.close(); removeTemporaryDirectory(root); });
 const id = app.arena.create({kind: 'xiangqi'}).id;
 const files = {};
 for (const seat of ['red', 'black']) {
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

test('CodeArts connect without a session resolves the host session, dedupes on it and keeps invitations on failure', async t => {
 const f = fixture(t), id = f.arena.create({kind: 'xiangqi'}).id;
 const codearts = host();
 codearts.resolveSession = async binding => { assert.ok(path.isAbsolute(binding.workspace)); return 'resolved-codearts-session'; };
 const others = () => Object.fromEntries(WAKE_PROVIDERS.filter(p => p !== 'codearts').map(p => [p, host()]));
 const wake = new WakeService(f.arena, {adapters: {...others(), codearts}, readTimeoutMs: 100, sendTimeoutMs: 100});
 t.after(() => wake.stop());
 const invite = f.arena.invite(id, 'red', 'http://127.0.0.1:4318');
 const input = {match: id, seat: 'red', invitation: invitationToken(invite), provider: 'codearts', credentialPath: path.join(f.root, 'red.credential.json')};
 const out = await wake.connect(input);
 assert.equal(out.continuationMode, 'wake');
 assert.equal(f.arena.get(id).bindings.red.session, 'resolved-codearts-session');
 assert.equal(f.arena.get(id).bindings.red.wake.session, 'resolved-codearts-session');
 const other = f.arena.create({kind: 'xiangqi'}).id;
 await assert.rejects(wake.connect({...input, match: other, invitation: invitationToken(f.arena.invite(other, 'red', 'http://127.0.0.1:4318'))}), /already bound/);
 assert.ok(f.arena.get(other).invites.red, 'a failed duplicate must not consume the invitation');
 const failing = host();
 failing.resolveSession = async () => { throw Error('当前工作区有 2 个 CodeArts 会话，请显式传 --session 指定其一'); };
 const wake2 = new WakeService(f.arena, {adapters: {...others(), codearts: failing}, readTimeoutMs: 100, sendTimeoutMs: 100});
 t.after(() => wake2.stop());
 const third = f.arena.create({kind: 'xiangqi'}).id, invite3 = f.arena.invite(third, 'red', 'http://127.0.0.1:4318');
 await assert.rejects(wake2.connect({...input, match: third, invitation: invitationToken(invite3)}), /显式传 --session/);
 assert.ok(f.arena.get(third).invites.red);
 await assert.rejects(wake2.connect({...input, provider: 'mimo', match: third, invitation: invitationToken(invite3)}), /confirm real provider and session/);
 assert.ok(f.arena.get(third).invites.red);
});

test('Manual wake uses verified capability, stale-binding protection and one in-flight send', async t => {
 const f=fixture(t),id=f.arena.create({kind:'xiangqi'}).id;await f.all(id);
 let d=f.wake.diagnostics(id).find(x=>x.seat==='red');assert.equal(d.canWake,false);assert.match(d.blockedReason,/尚未开始/);
 f.arena.start(id);d=f.wake.diagnostics(id).find(x=>x.seat==='red');assert.equal(d.canWake,true);
 const request={match:id,seat:'red',bindingId:d.bindingId,attemptId:d.attemptId};
 assert.throws(()=>f.wake.requestManual({...request,bindingId:'stale'}),/变化/);
 assert.throws(()=>f.wake.requestManual({...request,attemptId:'stale'}),/变化/);
 assert.equal(f.wake.requestManual(request).scheduled,true);assert.equal(f.wake.requestManual(request).duplicate,true);
 await Promise.all(f.wake.inFlight.values());assert.equal(f.adapter.calls.length,1);
 assert.equal(f.wake.requestManual(request).duplicate,true);assert.equal(f.adapter.calls.length,1);
 d=f.wake.diagnostics(id).find(x=>x.seat==='red');assert.equal(d.status,'sent');assert.equal(d.canWake,false);
 f.arena.revoke(id,'red');assert.throws(()=>f.wake.requestManual(request),/变化/);
});

test('Manual uncertain delivery only verifies and never resends; wait bindings cannot wake',async t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi'}).id;await f.all(id);f.arena.start(id);
 f.adapter.send=async()=>{f.adapter.calls.push('uncertain');throw Error('no confirmed receipt')};
 const d=f.wake.diagnostics(id).find(x=>x.seat==='red'),request={match:id,seat:'red',bindingId:d.bindingId,attemptId:d.attemptId};
 f.wake.requestManual(request);await Promise.all(f.wake.inFlight.values());assert.equal(f.wake.diagnostics(id).find(x=>x.seat==='red').status,'uncertain');
 f.wake.requestManual(request);await Promise.all(f.wake.inFlight.values());assert.equal(f.adapter.calls.length,1);
 const other=f.arena.create({kind:'xiangqi'}).id;for(const seat of f.arena.seats(f.arena.get(other)))await f.connect(other,seat,'simulated',`wait-${seat}`);f.arena.start(other);
 const wait=f.wake.diagnostics(other).find(x=>x.seat==='red');assert.equal(wait.mode,'wait');assert.equal(wait.canWake,false);assert.throws(()=>f.wake.requestManual({match:other,seat:'red',bindingId:wait.bindingId,attemptId:wait.attemptId}),/轮询/);
});

test('HTTP manual wake validates administrator, binding snapshot, local static assets and no arbitrary target',async t=>{
 const root=temporaryDirectory('arena-manual-http-'),adapter=host();
 const app=await serve({port:0,root,adminToken:'manual-ui-test-only',autoTick:false,wakeOptions:{workspace,adapters:{opencode:adapter}}});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const id=app.arena.create({kind:'xiangqi'}).id;
 for(const seat of app.arena.seats(app.arena.get(id))){const invitation=app.arena.invite(id,seat,app.origin);await app.wake.connect({match:id,seat,provider:'opencode',session:'manual-'+seat,credentialPath:path.join(root,seat+'.credential.json'),invitation:invitationToken(invitation)})}
 app.arena.start(id);const d=app.wake.diagnostics(id).find(x=>x.seat==='red');const body={match:id,seat:'red',bindingId:d.bindingId,attemptId:d.attemptId};
 const post=(value,token='manual-ui-test-only')=>fetch(app.origin+'/api/wake-check',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(value)});
 assert.equal((await post(body,'wrong')).status,401);assert.equal((await post({...body,bindingId:'stale'})).status,400);
 let response=await post(body);assert.equal(response.status,200);assert.equal((await response.json()).scheduled,true);await Promise.all(app.wake.inFlight.values());assert.equal(adapter.calls.length,1);
 response=await post(body);assert.equal((await response.json()).duplicate,true);assert.equal(adapter.calls.length,1);
 for(const route of ['/theme.js','/ui.js','/assets/avatars/manifest.json','/assets/avatars/qoder.svg']){response=await fetch(app.origin+route);assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff')}
 response=await fetch(app.origin+'/assets/avatars/missing.svg');assert.equal(response.status,404);
 response=await fetch(app.origin+'/assets/avatars/%2e%2e%2f%2e%2e%2fserver.mjs');assert.equal(response.status,404);
});
