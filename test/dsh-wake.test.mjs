import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DshWake} from '../lib/wake/dsh.mjs';
import {createWakeAdapters} from '../lib/wake/index.mjs';
import {providerName, supportsWake, markerFor, hasMarker} from '../lib/wake/common.mjs';
import {prepareHost} from '../lib/wake/host.mjs';
import {serve, clientFiles} from '../server.mjs';
import {relayInvitation} from '../lib/invitation.mjs';
import {temporaryDirectory, removeTemporaryDirectory} from '../lib/temp.mjs';

const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tokenOf = invitation => invitation.text.match(/--invitation ([a-f0-9]+)/)[1];
const rpc = value => Response.json({result: {ok: true, value}});
function fixture(t) {
 const root = temporaryDirectory('arena-dsh-'), secret = randomBytes(32), calls = [];
 const resources = [];
 t.after(async () => {
  for (const close of resources.reverse()) await close();
  removeTemporaryDirectory(root);
 });
 fs.writeFileSync(path.join(root, '.credentials.yaml'), 'records:\n  client-connection/browser-session:\n    payload:\n      secret: ' + secret.toString('base64url') + '\n');
 const session = {sessionId: 'dsh-session-fixture', cwd: root, running: false, agentAvailable: true, projections: {values: {turnOutline: [{prompt: '用户消息', response: '助手回复'}]}}};
 const state = {url: 'http://127.0.0.1:51001', sessions: [session], result: {accepted: true}, persist: true};
 function authenticate(url, options) {
  const origin = new URL(url), authority = origin.protocol === 'https:' ? 'https://' + origin.host : origin.host;
  const cookieName = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
  const [name, cookie] = options.headers.Cookie.split('=');
  assert.equal(name, cookieName);
  const [version, body, signature] = cookie.split('.');
  assert.equal(version, 'v1');
  assert.equal(signature, createHmac('sha256', secret).update(body).digest('base64url'));
  const payload = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(payload.version, 1);
  assert.equal(payload.authority, authority);
  assert.equal(payload.expiresAt - payload.issuedAt, 300000);
  assert.ok(payload.expiresAt > Date.now());
 }
 const fetchImpl = async (url, options) => {
  const request = JSON.parse(options.body);
  calls.push({url: String(url), options, request});
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(request.type, 'client-request');
  assert.match(request.rpcId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(request.payload), ['args']);
  assert.equal(new URL(url).pathname, '/api/' + request.method);
  authenticate(url, options);
  if (request.method === 'session/list') return state.page ? state.page(request.payload.args) : rpc({items: state.sessions});
  assert.equal(request.method, 'session/prompt');
  if (state.failure) return state.failure();
  const prompt = request.payload.args.request;
  if (state.persist && state.result.accepted) session.projections.values.turnOutline.push({prompt: prompt.content[0].text});
  return rpc(state.result);
 };
 const adapter = new DshWake({home: root, env: {}, discoverUrl: async () => state.url, fetchImpl});
 return {root, secret, calls, session, state, adapter, fetchImpl, resources, binding: {provider: 'dsh', session: session.sessionId, workspace: root, credentialPath: path.join(root, 'red.credential.json')}};
}

test('DSH is a registered wake provider and is included in the standalone client', () => {
 assert.equal(providerName('DSH'), 'dsh');
 assert.equal(supportsWake('DSH'), true);
 assert.ok(createWakeAdapters().dsh instanceof DshWake);
 assert.ok(clientFiles.includes('lib/wake/dsh.mjs'));
});

test('DSH signs each current origin, rediscovers ports and reads only the selected session', async t => {
 const f = fixture(t);
 f.state.sessions.unshift({...f.session, sessionId: 'another-session', cwd: path.dirname(f.root)});
 const info = await f.adapter.verify(f.binding);
 assert.equal(info.session, f.session.sessionId);
 assert.equal(info.workspace, f.root);
 assert.equal(info.status, 'idle');
 assert.deepEqual(info.messages, [{role: 'user', text: '用户消息'}, {role: 'assistant', text: '助手回复'}]);
 for (const url of ['http://127.0.0.1:51002', 'http://[::1]:51003', 'https://localhost:51004']) {
  f.state.url = url;
  f.session.running = true;
  assert.equal((await f.adapter.read(f.binding)).status, 'active');
  assert.ok(f.calls.at(-1).url.startsWith(url));
 }
 assert.ok(!/Cookie|secret|51004/.test(JSON.stringify(info)));
 await assert.rejects(f.adapter.read({...f.binding, session: 'missing'}), /identity or workspace/);
 await assert.rejects(f.adapter.read({...f.binding, workspace: path.dirname(f.root)}), /identity or workspace/);
 f.state.sessions.push(f.session);
 await assert.rejects(f.adapter.read(f.binding), /identity or workspace/);
});

test('DSH follows bounded pagination and rejects malformed or cycling host pages', async t => {
 const f = fixture(t), requests = [];
 f.state.page = args => {
  requests.push(args);
  return rpc(args._request.cursor ? {items: [f.session]} : {items: [], nextCursor: 'second-page'});
 };
 assert.equal((await f.adapter.read(f.binding)).session, f.binding.session);
 assert.deepEqual(requests, [{_request: {}}, {_request: {cursor: 'second-page'}}]);
 f.state.page = () => rpc({items: [], nextCursor: 'loop'});
 await assert.rejects(f.adapter.read(f.binding), /Invalid DSH session cursor/);
 f.state.page = () => rpc({items: {}, nextCursor: null});
 await assert.rejects(f.adapter.read(f.binding), /Unsupported DSH session list/);
 f.state.page = () => rpc({items: [], nextCursor: {token: 'invalid'}});
 await assert.rejects(f.adapter.read(f.binding), /Invalid DSH session cursor/);
});

test('DSH resolves an invitation only from a unique user prompt in the exact workspace', async t => {
 const f = fixture(t), invitation = 'a'.repeat(64), binding = {workspace: f.root, invitation};
 f.session.projections.values.turnOutline = [{prompt: 'other', response: invitation}];
 await assert.rejects(f.adapter.resolveSession(binding), /未在当前工作区/);
 f.session.projections.values.turnOutline.push({prompt: invitation}, {prompt: invitation});
 f.state.sessions.unshift({...f.session, sessionId: 'foreign-session', cwd: path.dirname(f.root)});
 assert.equal(await f.adapter.resolveSession(binding), f.session.sessionId);
 f.state.sessions.push({...f.session, sessionId: 'ambiguous-session'});
 await assert.rejects(f.adapter.resolveSession(binding), /命中 2 个 DSH/);
 await assert.rejects(f.adapter.resolveSession({...binding, invitation: 'invalid'}), /需要本次邀请/);
 f.state.sessions = [f.session];
 const prepared = await prepareHost({provider: 'dsh', credentialPath: f.binding.credentialPath, invitation}, {workspace: f.root, adapters: {dsh: f.adapter}, requireWorkspace: true});
 assert.equal(prepared.session, f.session.sessionId);
 assert.equal(prepared.workspaceVerified, true);
 assert.ok(!JSON.stringify(prepared).includes(invitation));
 assert.ok(!/Cookie|secret/.test(JSON.stringify(prepared)));
 // An explicit ID remains authoritative even when the invitation is absent from history.
 f.session.projections.values.turnOutline = [];
 assert.equal((await prepareHost(f.binding, {workspace: f.root, adapters: {dsh: f.adapter}})).session, f.session.sessionId);
 await assert.rejects(prepareHost({...f.binding, model: 'provider/model'}, {workspace: f.root, adapters: {dsh: f.adapter}}), /omit --model/);
});

test('DSH queues an idle cold session with its original model and guards busy or stale bindings', async t => {
 const f = fixture(t), prompt = '[LLM-GAME-WAKE:fixture] 领取自己的任务';
 // Cold sessions need not have an active agent; only an explicit false prevents restoration.
 delete f.session.agentAvailable;
 const delivered = await f.adapter.send(f.binding, prompt);
 assert.deepEqual(delivered, {delivered: true, evidence: 'host-accepted'});
 const request = f.calls.at(-1).request.payload.args.request;
 assert.equal(request.sessionId, f.session.sessionId);
 assert.equal(request.mode, 'queue');
 assert.equal(request.clientTimeZone, 'Asia/Shanghai');
 assert.deepEqual(request.content, [{type: 'text', text: prompt}]);
 assert.equal(request.model, undefined);
 assert.equal(hasMarker(await f.adapter.read(f.binding), 'LLM-GAME-WAKE:fixture'), true);
 for (const running of [true, undefined, 'false']) {
  f.session.running = running;
  await assert.rejects(f.adapter.send(f.binding, prompt), error => error.safeToRetry === true);
 }
 f.session.running = false;
 f.session.agentAvailable = false;
 assert.equal((await f.adapter.read(f.binding)).status, 'unknown');
 await assert.rejects(f.adapter.send(f.binding, prompt), error => error.safeToRetry === true);
 f.session.agentAvailable = true;
 await assert.rejects(f.adapter.send({...f.binding, canSend: () => false}, prompt), error => error.safeToRetry === true);
 await assert.rejects(f.adapter.send({...f.binding, workspace: path.dirname(f.root)}, prompt), error => error.safeToRetry === true);
 await assert.rejects(f.adapter.send({...f.binding, model: 'provider/model'}, prompt), /omit --model/);
 assert.equal(f.calls.filter(call => call.request.method === 'session/prompt').length, 1);
});

test('DSH protects local credentials and never exposes host error bodies or retries uncertain sends', async t => {
 const f = fixture(t);
 for (const baseUrl of ['http://example.com', 'http://192.168.0.2:51001', 'file:///tmp/host', 'http://127.0.0.1/?token=secret', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost/#secret']) {
  const adapter = new DshWake({home: 'missing', baseUrl, fetchImpl: () => assert.fail('must not send credentials')});
  await assert.rejects(adapter.read(f.binding), /loopback origin/);
 }
 f.state.result = {accepted: false};
 await assert.rejects(f.adapter.send(f.binding, 'test'), error => !error.safeToRetry && /unconfirmed/.test(error.message));
 for (const failure of [
  () => Response.json({result: {ok: false, error: {message: 'private-cookie'}}}),
  () => new Response('private-cookie', {status: 401}),
  () => new Response('private-cookie', {status: 503}),
  () => new Response('private-cookie'),
  () => { throw Error('private-cookie'); }
 ]) {
  f.state.failure = failure;
  await assert.rejects(f.adapter.send(f.binding, 'test'), error => !error.safeToRetry && !error.message.includes('private-cookie'));
 }
 fs.writeFileSync(path.join(f.root, '.credentials.yaml'), 'records:\n  other-record:\n    secret: ' + f.secret.toString('base64url') + '\n');
 const calls = f.calls.length;
 await assert.rejects(f.adapter.read(f.binding), /secret missing or invalid/);
 assert.equal(f.calls.length, calls);
});

test('DSH integration preserves failed invitations and reconciles uncertain notifications without replay', async t => {
 const f = fixture(t), app = await serve({port: 0, host: '127.0.0.1', root: path.join(f.root, 'server'), autoTick: false, wakeOptions: {workspace: f.root, adapters: {dsh: f.adapter}}});
 f.resources.push(() => app.close());
 const id = app.arena.create({kind: 'xiangqi'}).id, invitation = app.arena.invite(id, 'red', app.origin), token = tokenOf(invitation);
 assert.match(invitation.text, /DeepSeek Harness/);
 assert.match(relayInvitation(invitation, app.origin, id).text, /DSH_WEB_URL/);
 const input = {match: id, seat: 'red', invitation: token, provider: 'dsh', credentialPath: f.binding.credentialPath};
 await assert.rejects(app.wake.connect(input), /未在当前工作区/);
 await assert.rejects(app.wake.connect({...input, session: 'wrong-session'}), /identity or workspace/);
 assert.ok(app.arena.get(id).invites.red);
 f.session.projections.values.turnOutline.push({prompt: invitation.text});
 const connected = await app.wake.connect(input);
 assert.equal(connected.parked, true);
 assert.equal(connected.continuationMode, 'wake');
 const blackInvite = app.arena.invite(id, 'black', app.origin);
 app.arena.connect({match: id, seat: 'black', provider: 'simulated', session: 'black', invitation: tokenOf(blackInvite)});
 app.arena.start(id);
 f.state.failure = () => { throw Error('connection lost'); };
 await Promise.all(app.wake.tick());
 assert.equal(app.wake.diagnostics(id)[0].status, 'uncertain');
 await Promise.all(app.wake.tick({force: true}));
 assert.equal(f.calls.filter(call => call.request.method === 'session/prompt').length, 1);
 const job = app.arena.get(id).jobs[0];
 f.session.projections.values.turnOutline.push({response: '[' + markerFor(job.attemptId) + ']'});
 await Promise.all(app.wake.tick({force: true}));
 assert.equal(app.wake.diagnostics(id)[0].status, 'uncertain', 'assistant echoes do not prove delivery');
 f.session.projections.values.turnOutline.push({prompt: '[' + markerFor(job.attemptId) + ']'});
 await Promise.all(app.wake.tick({force: true}));
 assert.equal(app.wake.diagnostics(id)[0].status, 'sent');
 assert.equal(f.calls.filter(call => call.request.method === 'session/prompt').length, 1);
 assert.equal(job.clientId, null, 'delivery does not claim or submit a move');
 assert.equal(app.arena.park(app.arena.identity(connected.token)).job.seat, 'red');
});

for (const transport of ['local', 'relay']) test('DSH real Node client ' + transport + ' verifies, wakes, claims and submits through isolated HTTP', async t => {
 const f = fixture(t);
 const bridge = http.createServer(async (req, res) => {
  try {
   let body = '';
   for await (const chunk of req) body += chunk;
   const response = await f.fetchImpl(new URL(req.url, f.state.url), {method: req.method, redirect: 'error', signal: new AbortController().signal, headers: {Cookie: req.headers.cookie}, body});
   res.writeHead(response.status, {'Content-Type': 'application/json'});
   res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(error.message); }
 });
 await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
 f.state.url = 'http://127.0.0.1:' + bridge.address().port;
 const adapter = transport === 'local' ? f.adapter : {verify() { assert.fail('remote DSH must not be inspected on the game server'); }};
 const app = await serve({port: 0, host: '127.0.0.1', root: path.join(f.root, 'server'), autoTick: false, wakeOptions: {workspace: f.root, adapters: {dsh: adapter}}});
 let relayFile, relayPid;
 f.resources.push(async () => {
  if (relayFile) {
   try { relayPid ||= JSON.parse(fs.readFileSync(relayFile + '.lock', 'utf8')).pid; } catch {}
   if (relayPid) {
    try { process.kill(relayPid); } catch {}
    for (let i = 0; i < 50; i++) {
     try { process.kill(relayPid, 0); } catch { break; }
     await sleep(100);
    }
   }
  }
  await app.close();
  bridge.closeAllConnections();
  await new Promise(resolve => bridge.close(resolve));
 });
 const id = app.arena.create({kind: 'xiangqi'}).id, invitation = app.arena.invite(id, 'red', app.origin);
 f.session.projections.values.turnOutline.push({prompt: invitation.text});
 let script = path.resolve('client.mjs');
 if (transport === 'relay') {
  await run(process.execPath, [path.resolve('public/arena-bootstrap.mjs'), '--url', app.origin, '--workspace', f.root], {cwd: f.root});
  script = path.join(f.root, 'tmp', 'arena-client', 'client.mjs');
  assert.ok(fs.existsSync(path.join(f.root, 'tmp', 'arena-client', 'lib', 'wake', 'dsh.mjs')));
 }
 const credential = path.join(f.root, 'tmp', 'red.credential.json');
 const env = {...process.env, DSH_WEB_URL: f.state.url, DSH_HOME: f.root, CODEX_THREAD_ID: 'wrong-codex-session', OPENCODE_SESSION_ID: 'wrong-opencode-session'};
 const args = [script, 'connect', '--url', app.origin, '--match', id, '--seat', 'red', '--invitation', tokenOf(invitation), '--provider', 'dsh', '--wake-transport', transport, '--workspace', f.root, '--out', credential];
 await assert.rejects(run(process.execPath, [...args, '--session', 'missing'], {cwd: f.root, env}), /identity or workspace/);
 await assert.rejects(run(process.execPath, [...args, '--session', f.session.sessionId, '--model', 'provider/model'], {cwd: f.root, env}), /omit --model/);
 assert.ok(app.arena.get(id).invites.red);
 assert.ok(!fs.existsSync(credential));
 // Local resolves from the invitation; remote also covers an explicit host-provided ID.
 const {stdout} = await run(process.execPath, transport === 'local' ? args : [...args, '--session', f.session.sessionId], {cwd: f.root, env});
 const connected = JSON.parse(stdout);
 assert.equal(connected.parked, true);
 assert.ok(!stdout.includes(f.session.sessionId));
 const privateCredential = JSON.parse(fs.readFileSync(credential, 'utf8'));
 assert.ok(!stdout.includes(privateCredential.token));
 relayFile = privateCredential.relayCredentialPath;
 if (relayFile) {
  const configText = fs.readFileSync(relayFile, 'utf8');
  assert.ok(!configText.includes(f.secret.toString('base64url')));
  assert.ok(!configText.includes('Cookie'));
  assert.ok(!configText.includes(f.state.url));
 }
 const blackInvite = app.arena.invite(id, 'black', app.origin);
 app.arena.connect({match: id, seat: 'black', provider: 'simulated', session: 'black', invitation: tokenOf(blackInvite)});
 app.arena.start(id);
 if (transport === 'local') await Promise.all(app.wake.tick());
 for (let i = 0; i < 80 && !f.calls.some(call => call.request.method === 'session/prompt'); i++) await sleep(100);
 assert.equal(f.calls.filter(call => call.request.method === 'session/prompt').length, 1);
 assert.equal(app.arena.get(id).jobs[0].clientId, null);
 const job = JSON.parse((await run(process.execPath, [script, 'resume', '--credential', credential], {cwd: f.root, env})).stdout).job;
 assert.equal(job.seat, 'red');
 const response = path.join(f.root, 'tmp', 'response.json');
 fs.writeFileSync(response, JSON.stringify({from: [0,6], to: [0,5]}));
 const result = await run(process.execPath, [script, 'submit', '--credential', credential, '--task', job.taskId, '--attempt', job.attemptId, '--file', response], {cwd: f.root, env});
 assert.equal(JSON.parse(result.stdout).ok, true);
 assert.equal(app.arena.get(id).game.ply, 1);
 if (relayFile) relayPid = JSON.parse(fs.readFileSync(relayFile + '.lock', 'utf8')).pid;
 app.arena.revoke(id, 'red');
 if (relayFile) {
  for (let i = 0; i < 60 && fs.existsSync(relayFile + '.lock'); i++) await sleep(100);
  assert.equal(fs.existsSync(relayFile + '.lock'), false);
 }
});
