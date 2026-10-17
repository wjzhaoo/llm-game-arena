import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CodeArtsWake} from '../lib/wake/codearts.mjs';
import {prepareHost} from '../lib/wake/host.mjs';
import {ArenaCodeArts} from '../.opencode/plugins/arena-codearts.js';
import {serve} from '../server.mjs';
import {temporaryDirectory, removeTemporaryDirectory} from '../lib/temp.mjs';

const run = promisify(execFile), invitation = 'ab'.repeat(32);
function fixture(t) {
 const root = temporaryDirectory('codearts-content-'), dbPath = path.join(root, 'opencode.db');
 const db = new DatabaseSync(dbPath);
 db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, project_id TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
 for (let i = 0; i < 17; i++) db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL)').run('ses_fixture' + i, root, 'global', '历史会话', i);
 let seq = 0;
 const add = (session, {role = 'user', type = 'text', text = `邀请 --invitation ${invitation}`, metadata} = {}) => {
  const id = 'message-' + seq++;
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(id, session, JSON.stringify({role}));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('part-' + id, id, session, JSON.stringify({type, text, ...metadata}));
 };
 const adapter = new CodeArtsWake({dbPath, discoveryDir: path.join(root, 'absent'), env: {}});
 const cleanups = [];
 t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); db.close(); removeTemporaryDirectory(root); });
 return {root, dbPath, db, add, adapter, cleanups, binding: {workspace: root, invitation}};
}

test('CodeArts locates one of 17 sessions by literal user part content, including live WAL, without writing', async t => {
 const f = fixture(t);
 f.add('ses_fixture0'); f.add('ses_fixture0');
 f.add('ses_fixture1', {role: 'assistant'});
 f.add('ses_fixture2', {type: 'tool'});
 f.add('ses_fixture3', {text: '其他内容', metadata: {token: invitation}});
 const before = [f.dbPath, f.dbPath + '-wal'].map(file => fs.readFileSync(file));
 assert.equal(await f.adapter.resolveSession(f.binding), 'ses_fixture0');
 assert.equal(await f.adapter.resolveSession(f.binding), 'ses_fixture0');
 for (const [i, file] of [f.dbPath, f.dbPath + '-wal'].entries()) assert.deepEqual(fs.readFileSync(file), before[i]);
});

test('CodeArts refuses copied invitations, missing user content, wrong directories and archived matches', async t => {
 const f = fixture(t);
 f.add('ses_fixture0'); f.add('ses_fixture1');
 await assert.rejects(f.adapter.resolveSession(f.binding), /命中 2 个 CodeArts 会话/);
 f.db.prepare('UPDATE session SET time_archived = 10 WHERE id = ?').run('ses_fixture1');
 assert.equal(await f.adapter.resolveSession(f.binding), 'ses_fixture0');
 f.db.prepare('UPDATE session SET directory = ? WHERE id = ?').run(path.join(f.root, 'other'), 'ses_fixture0');
 await assert.rejects(f.adapter.resolveSession(f.binding), /尚未.*找到本次邀请/);
 f.add('ses_fixture2', {role: 'assistant'});
 await assert.rejects(f.adapter.resolveSession(f.binding), /尚未.*找到本次邀请/);
});

test('CodeArts fails closed on an incompatible database and lets explicit session bypass content discovery', async t => {
 const f = fixture(t);
 f.db.exec('DROP TABLE part');
 await assert.rejects(f.adapter.resolveSession(f.binding), /数据库读取失败/);
 const adapter = {resolveSession: () => { throw Error('Must not discover explicit session'); }, read: async b => ({session: b.session, workspace: b.workspace})};
 const binding = await prepareHost({provider: 'codearts', session: 'ses_explicit', invitation, credentialPath: path.join(f.root, 'tmp', 'seat.credential.json')}, {workspace: f.root, adapters: {codearts: adapter}});
 assert.equal(binding.session, 'ses_explicit');
 assert.ok(!Object.hasOwn(binding, 'invitation'));
});

test('CodeArts retains bridge discovery when the database is absent and never creates it', async t => {
 const f = fixture(t), absent = path.join(f.root, 'absent.db'), file = path.join(f.root, 'bridge.json');
 fs.writeFileSync(file, JSON.stringify({version: 1, sessionId: 'ses_pinned', directory: f.root, url: 'http://127.0.0.1:5007', username: 'u', password: 'p'}), 'utf8');
 const adapter = new CodeArtsWake({dbPath: absent, credentialFile: file, fetchImpl: () => { throw Error('Pinned bridge does not need HTTP discovery'); }});
 assert.equal(await adapter.resolveSession(f.binding), 'ses_pinned');
 assert.ok(!fs.existsSync(absent));
});

for (const transport of ['local', 'relay']) test(`CodeArts ${transport} CLI connects without --session using invitation content and still verifies the host`, async t => {
 const f = fixture(t), root = f.root;
 let hostWorkspace = root;
 const hooks = await ArenaCodeArts({directory: root, client: {session: {
  list: async () => { throw Error('Content discovery must not depend on session listing'); },
  get: async ({path: p}) => ({data: {id: p.id, directory: hostWorkspace}}),
  messages: async () => ({data: []}), status: async () => ({data: {}}), promptAsync: async () => ({data: {}})
 }}});
 const localAdapter = new CodeArtsWake({dbPath: f.dbPath, discoveryDir: path.join(root, 'absent'), env: {}});
 let hostReads = 0;
 const read = localAdapter.read.bind(localAdapter);
 localAdapter.read = async binding => { hostReads++; return read(binding); };
 const app = await serve({port: 0, root: path.join(root, 'server'), autoTick: false, wakeOptions: {adapters: {codearts: transport === 'local' ? localAdapter : {read: () => { throw Error('Server must not inspect the remote host'); }}}}});
 const credential = path.join(root, 'tmp', 'red.credential.json'), relayFile = credential.replace('.credential.json', '.relay.credential.json');
 f.cleanups.push(async () => {
  try { const lock = JSON.parse(fs.readFileSync(relayFile + '.lock', 'utf8')); process.kill(lock.pid); } catch {}
  app.server.closeAllConnections();
  await app.close(); await hooks.dispose();
 });
 const id = app.arena.create({kind: 'xiangqi'}).id, invite = app.arena.invite(id, 'red', app.origin);
 const token = invite.text.match(/--invitation ([a-f0-9]+)/)[1];
 f.add('ses_fixture0', {text: invite.text});
 const env = {...process.env, ARENA_CODEARTS_DB: f.dbPath, ARENA_CODEARTS_DISCOVERY: path.join(root, 'tmp', 'codearts-bridge', 'bridge.json')};
 let script = path.resolve('client.mjs');
 if (transport === 'relay') {
  await run(process.execPath, [path.resolve('public/arena-bootstrap.mjs'), '--url', app.origin, '--workspace', root], {cwd: root});
  script = path.join(root, 'tmp', 'arena-client', 'client.mjs');
 }
 const args = [script, 'connect', '--url', app.origin, '--match', id, '--seat', 'red', '--invitation', token, '--provider', 'codearts', '--wake-transport', transport, '--workspace', root, '--out', credential];
 f.add('ses_fixture1', {text: invite.text});
 await assert.rejects(run(process.execPath, args, {cwd: root, env}), /命中 2 个 CodeArts 会话/);
 assert.ok(app.arena.get(id).invites.red); assert.ok(!fs.existsSync(credential));
 f.db.prepare('UPDATE session SET time_archived = 1 WHERE id = ?').run('ses_fixture1');
 hostWorkspace = path.join(root, 'wrong-host-workspace');
 await assert.rejects(run(process.execPath, args, {cwd: root, env}), /session or workspace mismatch/);
 assert.ok(app.arena.get(id).invites.red); assert.ok(!fs.existsSync(credential));
 hostWorkspace = root;
 const result = await run(process.execPath, args, {cwd: root, env});
 assert.equal(JSON.parse(result.stdout).parked, true);
 assert.equal(app.arena.get(id).bindings.red.session, 'ses_fixture0');
 assert.equal(hostReads > 0, transport === 'local');
 assert.ok(!result.stdout.includes(token)); assert.ok(!result.stdout.includes('ses_fixture0'));
 if (transport === 'relay') {
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(relayFile, 'utf8')).config, 'invitation'));
  for (let i = 0; i < 100 && !fs.existsSync(relayFile + '.lock'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(relayFile + '.lock'));
 }
});
