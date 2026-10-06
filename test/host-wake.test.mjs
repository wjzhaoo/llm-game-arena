import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CodexWake} from '../lib/wake/codex.mjs';
import {MimoWake, effectivePermission} from '../lib/wake/mimo.mjs';
import {QoderWake} from '../lib/wake/qoder.mjs';
import {CodeArtsWake} from '../lib/wake/codearts.mjs';
import {ArenaCodeArts} from '../.opencode/plugins/arena-codearts.js';
import {temporaryDirectory, removeTemporaryDirectory} from '../lib/temp.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
const workspace = path.resolve('.'), marker = 'LLM-GAME-WAKE:fixture-attempt', prompt = `[${marker}]\n请领取任务。`;
function directory(t, prefix) { const root = temporaryDirectory(prefix); t.after(() => removeTemporaryDirectory(root)); return root; }

test('Codex pipe payload uses the bound thread and turn; send requires user-message readback', async () => {
 const session = 'fixture-codex-session', turnId = 'fixture-turn', messages = [], calls = [];
 const adapter = new CodexWake({pipe: 'fixture-pipe', rpcImpl: async (pipe, request) => {
  calls.push(request);
  const {tool, arguments: args} = request.params;
  assert.equal(request.params.threadId, session);
  assert.equal(request.params.turnId, turnId);
  if (tool === 'send_message_to_thread') { messages.push({type: 'userMessage', content: [{text: args.prompt}]}); return {result: {success: true, contentItems: [{type: 'inputText', text: '{}'}]}}; }
  return {result: {success: true, contentItems: [{type: 'inputText', text: JSON.stringify({thread: {id: session, cwd: workspace, status: {type: 'idle'}}, turns: [{items: messages}]})}]}};
 }});
 const binding = {session, turnId, workspace};
 assert.equal((await adapter.read(binding)).status, 'idle');
 assert.equal((await adapter.send(binding, prompt, marker)).delivered, true);
 assert.equal(calls.filter(c => c.params.tool === 'send_message_to_thread').length, 1);
 await assert.rejects(adapter.send({...binding, canSend: () => false}, prompt, marker), error => error.safeToRetry === true);
});

test('Codex resolves a real turn from the current session log and rejects workspace mismatch', async t => {
 const root = directory(t, 'codex-turn-'), session = '12345678-1234-1234-1234-123456789abc';
 const content = [{type: 'session_meta', payload: {id: session, cwd: workspace}}, {type: 'turn_context', payload: {turn_id: 'actual-fixture-turn'}}].map(r => JSON.stringify(r)).join('\n');
 fs.writeFileSync(path.join(root, `rollout-${session}_resumed.jsonl`), content, 'utf8');
 const adapter = new CodexWake({sessionRoot: root});
 assert.equal(await adapter.resolveTurn(session, workspace), 'actual-fixture-turn');
 await assert.rejects(adapter.resolveTurn(session, path.join(workspace, 'wrong')), /real turn ID/);
});

test('MiMo verifies identity/model without SSE during connect and preserves the session permission', async t => {
 const root = directory(t, 'mimo-host-'), file = path.join(root, 'desktop-api.json'), token = 'a'.repeat(64), history = [{info: {role: 'assistant', providerID: 'fixture', modelID: 'model'}, parts: [{type: 'text', text: '待命'}]}];
 fs.writeFileSync(file, JSON.stringify({api: 1, port: 5001, token}), 'utf8');
 fs.writeFileSync(path.join(root, 'preferences.json'), JSON.stringify({perm: '完全访问权限', fullAccessEnabled: false, permByConvo: {'fixture-mimo': '默认权限'}}), 'utf8');
 let eventCalls = 0, sent;
 const adapter = new MimoWake({credentialFile: file, fetchImpl: async (url, options) => {
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, `Bearer ${token}`);
  const route = new URL(url).pathname;
  if (route.endsWith('/events')) { eventCalls++; return new Response('event: idle\ndata: {}\n\n'); }
  if (route.endsWith('/turns')) { sent = JSON.parse(options.body); history.push({info: {role: 'user'}, parts: [{type: 'text', text: sent.message}]}); return json({ok: true}, 202); }
  if (route.endsWith('/messages')) return json({messages: history});
  return json({sessions: [{id: 'fixture-mimo', directory: workspace}]});
 }});
 const binding = {session: 'fixture-mimo', workspace, model: 'fixture/model'};
 assert.equal((await adapter.verify(binding)).model, 'fixture/model'); assert.equal(eventCalls, 0);
 assert.equal((await adapter.read(binding)).status, 'idle');
 assert.equal((await adapter.send(binding, prompt, marker)).delivered, true);
 assert.equal(sent.perm, '默认权限');
 assert.equal(sent.dir, workspace);
 assert.equal(effectivePermission({perm: '完全访问权限', fullAccessEnabled: false}, binding.session), '默认权限');
 assert.equal(effectivePermission({perm: '接受编辑权限'}, binding.session), '帮我审批');
});

test('MiMo 202 without the matching user message remains uncertain; permission events mean active', async t => {
 const root = directory(t, 'mimo-unconfirmed-'), file = path.join(root, 'desktop-api.json');
 fs.writeFileSync(file, JSON.stringify({api: 1, port: 5002, token: 'a'.repeat(64)}), 'utf8');
 const adapter = new MimoWake({credentialFile: file, fetchImpl: async url => {
  const route = new URL(url).pathname;
  if (route.endsWith('/events')) return new Response('event: permission\ndata: {}\n\n');
  if (route.endsWith('/turns')) return json({ok: true}, 202);
  if (route.endsWith('/messages')) return json([{info: {role: 'assistant'}, parts: [{type: 'text', text: prompt}]}]);
  return json([{id: 'fixture-mimo', directory: workspace}]);
 }});
 const binding = {session: 'fixture-mimo', workspace, model: 'fixture/model'};
 assert.equal((await adapter.read(binding)).status, 'active');
 await assert.rejects(adapter.send(binding, prompt, marker), /not been verified/);
});

test('Qoder uses the live App Plugin and stable requestId, honestly reporting missing workspace/history attestation', async t => {
 const root = directory(t, 'qoder-host-'), file = path.join(root, 'bridge.json');
 fs.writeFileSync(file, JSON.stringify({version: 1, pid: process.pid, baseUrl: 'http://127.0.0.1:5003', token: 'b'.repeat(64)}), 'utf8');
 let body;
 const adapter = new QoderWake({descriptorPath: file, fetchImpl: async (url, options) => {
  assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-Task-Dispatch-Key'], 'b'.repeat(64));
  if (options.method === 'POST') { body = JSON.parse(options.body); return json({sessionId: 'fixture-qoder', accepted: true, runtimeState: 'opening'}, 202); }
  return json({sessionId: 'fixture-qoder', runtimeState: 'ready'});
 }});
 const binding = {session: 'fixture-qoder', workspace};
 const info = await adapter.read(binding);
 assert.equal(info.workspaceVerified, false); assert.equal(info.workspace, undefined);
 assert.equal((await adapter.send(binding, prompt, marker)).evidence, 'bridge-accepted');
 assert.equal(body.requestId, marker); assert.equal(body.prompt, prompt);
});

test('Qoder variants select the exact session and reject ambiguous matches or non-loopback descriptors', async t => {
 const root = directory(t, 'qoder-variants-');
 for (const [dir, port] of [['.qoder-cn', 5004], ['.qoder', 5005]]) {
  fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, dir, 'task-dispatch-bridge.json'), JSON.stringify({version: 1, pid: process.pid, baseUrl: `http://127.0.0.1:${port}`, token: 'b'.repeat(64)}), 'utf8');
 }
 let ambiguous = false, port;
 const adapter = new QoderWake({home: root, env: {}, fetchImpl: async (url, options) => {
  const current = new URL(url);
  if (current.port === '5004' && !ambiguous) return json({error: 'not found'}, 404);
  if (options.method === 'POST') { port = current.port; return json({sessionId: 'fixture-qoder', accepted: true}, 202); }
  return json({sessionId: 'fixture-qoder', runtimeState: 'idle'});
 }});
 const binding = {session: 'fixture-qoder', workspace};
 assert.equal((await adapter.send(binding, prompt, marker)).delivered, true); assert.equal(port, '5005');
 ambiguous = true; await assert.rejects(adapter.read(binding), /exactly one/);
 const invalid = path.join(root, 'invalid.json'); fs.writeFileSync(invalid, JSON.stringify({version: 1, pid: process.pid, baseUrl: 'http://example.com', token: 'b'.repeat(64)}), 'utf8');
 assert.throws(() => new QoderWake({descriptorPath: invalid}).discovery(), /unavailable/);
});

test('CodeArts project-local bridge authenticates SDK requests and confirms message persistence', async t => {
 const root = directory(t, 'codearts-sdk-'), history = [], session = 'fixture-codearts', requests = [];
 const hooks = await ArenaCodeArts({directory: root, client: {session: {
  list: async () => ({data: []}), get: async options => ({data: {id: options.path.id, directory: root}}),
  status: async () => ({data: {[session]: {type: 'idle'}}}), messages: async () => ({data: history}),
  promptAsync: async options => { requests.push(options); history.push({info: {role: 'user'}, parts: options.body.parts}); return {data: {}}; }
 }}});
 t.after(() => hooks.dispose());
 await hooks.event({event: {type: 'session.created', properties: {info: {id: session, directory: root}}}});
 const file = path.join(root, 'tmp', 'codearts-bridge', 'bridge.json'), descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
 assert.equal((await fetch(descriptor.url + '/v1/status')).status, 401);
 const adapter = new CodeArtsWake({credentialFile: file}), binding = {session, workspace: root};
 assert.equal((await adapter.read(binding)).status, 'idle');
 assert.equal((await adapter.send(binding, prompt, marker)).delivered, true);
 assert.equal(requests[0].path.id, session);
 assert.equal(requests[0].query.directory, root);
 assert.ok(!Object.hasOwn(requests[0].body, 'model'));
 await assert.rejects(adapter.read({...binding, workspace}), /descriptor/);
});

test('CodeArts retains compatible Basic Auth bridges and rejects foreign endpoints', async t => {
 const root = directory(t, 'codearts-legacy-'), file = path.join(root, 'bridge.json');
 const descriptor = {version: 1, sessionId: 'fixture-codearts', directory: workspace, url: 'http://127.0.0.1:5006', username: 'fixture-user', password: 'fixture-pass'};
 fs.writeFileSync(file, JSON.stringify(descriptor), 'utf8');
 let model;
 const adapter = new CodeArtsWake({credentialFile: file, fetchImpl: async (url, options) => {
  assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('fixture-user:fixture-pass').toString('base64'));
  const current = new URL(url); assert.equal(current.searchParams.get('directory'), workspace);
  if (current.pathname.endsWith('/prompt_async')) { model = JSON.parse(options.body).model; return new Response(null, {status: 204}); }
  if (current.pathname.endsWith('/message')) return json([{info: {role: 'user'}, parts: [{type: 'text', text: prompt}]}]);
  if (current.pathname === '/session/status') return json({});
  return json({id: descriptor.sessionId, directory: workspace});
 }});
 assert.equal((await adapter.send({session: descriptor.sessionId, workspace, model: 'fixture/model'}, prompt, marker)).delivered, true);
 assert.deepEqual(model, {providerID: 'fixture', modelID: 'model'});
 fs.writeFileSync(file, JSON.stringify({...descriptor, url: 'https://example.com'}), 'utf8');
 assert.throws(() => adapter.discovery({session: descriptor.sessionId, workspace}), /loopback/);
});
