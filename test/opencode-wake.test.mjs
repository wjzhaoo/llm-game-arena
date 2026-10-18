import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {OpenCodeWake, findOpenCodeCli, runOpenCodeCli} from '../lib/wake/opencode.mjs';
import {temporaryDirectory, removeTemporaryDirectory} from '../lib/temp.mjs';

function fixture(t) {
 const root = temporaryDirectory('opencode-wake-'), dbPath = path.join(root, 'opencode.db'), session = 'ses_fixture0001', workspace = path.resolve('.');
 const db = new DatabaseSync(dbPath);
 db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, agent TEXT, time_archived INTEGER, time_idle INTEGER, idle_outcome TEXT);
 CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT);
 CREATE TABLE session_inbox (session_id TEXT, payload TEXT);
 CREATE TABLE session_pending (session_id TEXT, data TEXT);
 CREATE TABLE session (id TEXT, directory TEXT);`);
 db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, NULL, 1, ?)').run(session, workspace, 'build', 'succeeded');
 db.prepare('INSERT INTO session VALUES (?, ?)').run(session, 'wrong-legacy-workspace');
 db.prepare('INSERT INTO session_message VALUES (?, 1, ?, ?)').run(session, 'idle', JSON.stringify({outcome: 'succeeded'}));
 db.close();
 const add = (type, data = {}) => {
  const writer = new DatabaseSync(dbPath);
  try {
   const next = writer.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_message WHERE session_id = ?').get(session).seq;
   writer.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)').run(session, next, type, JSON.stringify(data));
  } finally { writer.close(); }
 };
 const mutate = callback => { const writer = new DatabaseSync(dbPath); try { callback(writer); } finally { writer.close(); } };
 t.after(() => removeTemporaryDirectory(root));
 return {root, dbPath, session, workspace, add, mutate, binding: {provider: 'opencode', session, workspace}, adapter: new OpenCodeWake({dbPath, cliPath: process.execPath, env: {}, pollMs: 1, confirmTimeoutMs: 20})};
}

test('OpenCode reads the exact v2 session in read-only mode and ignores the legacy session table', async t => {
 const f = fixture(t), before = fs.readFileSync(f.dbPath);
 const info = await f.adapter.read(f.binding);
 assert.equal(info.workspace, f.workspace);
 assert.equal(info.status, 'idle');
 assert.deepEqual(fs.readFileSync(f.dbPath), before);
 await assert.rejects(f.adapter.read({...f.binding, session: 'ses_missing0001'}), /does not exist/);
 await assert.rejects(f.adapter.read({...f.binding, session: 'bad-session'}), /real ses_/);
 f.mutate(db => db.prepare('UPDATE session_v2 SET time_archived = 10 WHERE id = ?').run(f.session));
 await assert.rejects(f.adapter.read(f.binding), /archived/);
});

test('A previous time_idle does not make an active or queued session idle', async t => {
 const f = fixture(t);
 f.add('user', {text: '当前回合仍在执行'});
 assert.equal((await f.adapter.read(f.binding)).status, 'active');
 await assert.rejects(f.adapter.send(f.binding, '[marker] 唤醒', 'marker'), /not idle/);
 f.add('idle', {outcome: 'succeeded'});
 f.mutate(db => db.prepare('INSERT INTO session_inbox VALUES (?, ?)').run(f.session, '{}'));
 assert.equal((await f.adapter.read(f.binding)).status, 'active');
 f.mutate(db => { db.exec('DELETE FROM session_inbox'); db.prepare('INSERT INTO session_pending VALUES (?, ?)').run(f.session, '{}'); });
 assert.equal((await f.adapter.read(f.binding)).status, 'active');
});

test('OpenCode confirms the unique user marker, independently of CLI exit text or completion', async t => {
 const f = fixture(t), marker = 'LLM-GAME-WAKE:fixture-attempt', prompt = `[${marker}]\n请领取本角色任务。`;
 let calls = 0;
 f.adapter.runCli = (file, args, options) => {
  calls++;
  assert.equal(file, process.execPath);
  assert.deepEqual(args, ['run', '--session', f.session, '--format', 'json', prompt]);
  assert.equal(options.cwd, f.workspace);
  f.add('user', {text: prompt});
  return {done: Promise.resolve({code: 1})};
 };
 const receipt = await f.adapter.send(f.binding, prompt, marker);
 assert.equal(receipt.delivered, true);
 assert.equal(receipt.turnEnded, false, 'message delivery does not mean the turn or game action ended');
 f.add('assistant', {content: [{type: 'text', text: '已收到'}]});
 f.add('idle', {outcome: 'succeeded'});
 assert.equal((await f.adapter.send(f.binding, prompt, marker)).delivered, true);
 assert.equal(calls, 1, 'a recovered marker never launches another CLI turn');
});

test('A zero exit code or assistant-only marker is not proof of delivery', async t => {
 const f = fixture(t), marker = 'LLM-GAME-WAKE:unconfirmed', prompt = `[${marker}] 唤醒`;
 f.adapter.runCli = () => { f.add('assistant', {content: [{type: 'text', text: prompt}]}); f.add('idle'); return {done: Promise.resolve({code: 0})}; };
 await assert.rejects(f.adapter.send(f.binding, prompt, marker), /delivery uncertain/);
 assert.ok(!(await f.adapter.read(f.binding)).messages.some(m => m.text === prompt));
});

test('Only a definite CLI startup failure is safe to retry; missing sessions never launch a new one', async t => {
 const f = fixture(t);
 f.adapter.runCli = () => ({done: Promise.resolve({spawnError: 'ENOENT'})});
 await assert.rejects(f.adapter.send(f.binding, '[marker] 唤醒', 'marker'), error => error.safeToRetry === true);
 let called = false; f.adapter.runCli = () => { called = true; return {done: Promise.resolve({code: 0})}; };
 await assert.rejects(f.adapter.send({...f.binding, session: 'ses_absent0001'}, '[marker]', 'marker'), /does not exist/);
 assert.equal(called, false);
});

test('OpenCode refuses self-wake and rechecks revocation immediately before starting the CLI', async t => {
 const f = fixture(t);
 f.adapter.sourceSession = f.session;
 await assert.rejects(f.adapter.send(f.binding, '[marker]', 'marker'), /self-wake/);
 f.adapter.sourceSession = undefined;
 let called = false; f.adapter.runCli = () => { called = true; return {done: Promise.resolve({code: 0})}; };
 await assert.rejects(f.adapter.send({...f.binding, canSend: () => false}, '[marker]', 'marker'), error => error.safeToRetry === true);
 assert.equal(called, false);
});

test('OpenCode permissions/model are preserved unless explicitly configured', async t => {
 const f = fixture(t), marker = 'LLM-GAME-WAKE:explicit', prompt = `[${marker}] 唤醒`;
 f.adapter.env = {ARENA_OPENCODE_AUTO: '1'};
 f.adapter.runCli = (file, args) => {
  assert.deepEqual(args, ['run', '--session', f.session, '--format', 'json', '--auto', '--model', 'fixture/model', prompt]);
  assert.ok(!args.includes('--standalone'));
  assert.ok(!args.includes('--fork'));
  f.add('user', {text: prompt});
  return {done: Promise.resolve({code: 0})};
 };
 assert.equal((await f.adapter.send({...f.binding, model: 'fixture/model'}, prompt, marker)).delivered, true);
});

test('Desktop CLI discovery sorts 2.0.24 after 2.0.9, with explicit overrides taking precedence', t => {
 const root = temporaryDirectory('opencode-cli-discovery-');
 t.after(() => removeTemporaryDirectory(root));
 const name = process.platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli';
 for (const version of ['2.0.9', '2.0.24']) {
  const dir = path.join(root, 'ai.opencode.desktop', 'cli', version);
  fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, name), '', 'utf8');
 }
 const env = {APPDATA: root, PATH: ''};
 assert.equal(findOpenCodeCli(env), path.join(root, 'ai.opencode.desktop', 'cli', '2.0.24', name));
 assert.equal(findOpenCodeCli({...env, ARENA_OPENCODE_CLI: process.execPath}), process.execPath);
});

test('Desktop update/restart rediscovers the CLI after the verified version is removed', async t => {
 const f=fixture(t),name=process.platform==='win32'?'opencode-cli.exe':'opencode-cli';
 const install=version=>{
  const file=path.join(f.root,'ai.opencode.desktop','cli',version,name);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'','utf8');return file;
 };
 const old=install('2.0.29-'+process.arch);
 f.adapter.cliPath=undefined;f.adapter.env={APPDATA:f.root,PATH:''};
 await f.adapter.verify(f.binding);
 fs.unlinkSync(old);
 const current=install('2.0.32-'+process.arch);
 let calls=0;
 f.adapter.runCli=(file,args)=>{
  calls++;assert.equal(file,current);assert.equal(args[2],f.session);
  f.add('user',{text:args.at(-1)});return {done:Promise.resolve({code:0})};
 };
 assert.equal((await f.adapter.send(f.binding,'[restart-marker] 领取任务','restart-marker')).delivered,true);
 assert.equal(calls,1);
 assert.equal(f.adapter.cliPath,undefined,'auto-discovered paths must not persist across desktop restarts');
});

test('CLI transport launches a literal executable without a shell or visible console', async t => {
 const root = temporaryDirectory('opencode-cli-transport-');
 t.after(() => removeTemporaryDirectory(root));
 const {done} = runOpenCodeCli(process.execPath, ['-e', 'process.exit(0)'], {cwd: root});
 // Keep the test alive while the deliberately unref'ed client finishes.
 const keepAlive = setInterval(() => {}, 1000);
 try { assert.equal((await done).code, 0); } finally { clearInterval(keepAlive); }
});

test('CLI transport captures bounded errors without retaining transcript or credentials', async t => {
 const root=temporaryDirectory('opencode-cli-errors-');t.after(()=>removeTemporaryDirectory(root));
 const secret='a'.repeat(64),source=`console.log(JSON.stringify({type:'text',part:{text:'PRIVATE-ASSISTANT-TEXT'}}));console.log(JSON.stringify({type:'error',error:{message:'启动失败 token=sample-secret ${secret}'}}));process.exitCode=1;`;
 const {done}=runOpenCodeCli(process.execPath,['-e',source],{cwd:root});
 const keepAlive=setInterval(()=>{},1000);
 try{
  const outcome=await done;assert.equal(outcome.code,1);assert.ok(outcome.errorMessage.includes('启动失败'));
  for(const hidden of ['PRIVATE-ASSISTANT-TEXT',secret,'sample-secret'])assert.ok(!JSON.stringify(outcome).includes(hidden));
 }finally{clearInterval(keepAlive)}
});

test('CLI exit errors remain uncertain while preserving the actionable diagnostic', async t => {
 const f=fixture(t);f.adapter.runCli=()=>({done:Promise.resolve({code:1,errorMessage:'Session environment rejected'})});
 await assert.rejects(f.adapter.send(f.binding,'[error-marker] 唤醒','error-marker'),error=>{
  assert.notEqual(error.safeToRetry,true);assert.ok(error.wakeHint.includes('Session environment rejected'));return true;
 });
});

test('Desktop CLI discovery supports native architecture suffixes without links and skips unusable candidates', t => {
 const root = temporaryDirectory('opencode-cli-arch-');
 t.after(() => removeTemporaryDirectory(root));
 const name = process.platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli';
 const cliRoot = path.join(root, 'ai.opencode.desktop', 'cli');
 const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
 const add = (version, file = true) => {
  const dir = path.join(cliRoot, version);
  fs.mkdirSync(dir, {recursive: true});
  if (file) fs.writeFileSync(path.join(dir, name), '', 'utf8');
  return path.join(dir, name);
 };
 const old = add('2.0.9'), native = add('2.0.29-' + process.arch);
 add('2.0.29'); add('9.0.0-' + otherArch); add('9.0.1-backup'); add('10.0.0', false);
 const directory = add('11.0.0', false); fs.mkdirSync(directory);
 const env = {APPDATA: root, PATH: ''};
 assert.equal(findOpenCodeCli(env), native, 'native suffix wins ties and other architectures are ignored');
 fs.unlinkSync(native);
 assert.equal(findOpenCodeCli(env), path.join(cliRoot, '2.0.29', name));
 fs.unlinkSync(path.join(cliRoot, '2.0.29', name));
 assert.equal(findOpenCodeCli(env), old, 'missing binaries and directories fall back to the next usable version');
});
