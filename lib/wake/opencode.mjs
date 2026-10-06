import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {hasMarker, retryable, sameWorkspace, assertCanSend} from './common.mjs';

export function findOpenCodeCli(env = process.env) {
 if (env.ARENA_OPENCODE_CLI) {
  const file = path.resolve(env.ARENA_OPENCODE_CLI);
  if (!fs.statSync(file).isFile()) throw Error('OpenCode CLI override is not a file');
  return file;
 }
 // Prefer Desktop's matching 2.x sidecar to an older CLI on PATH. Sort versions numerically.
 const root = path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai.opencode.desktop', 'cli');
 if (fs.existsSync(root)) {
  const versions = fs.readdirSync(root, {withFileTypes: true}).filter(e => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name)).map(e => e.name).sort((a, b) => {
   const left = a.split('.').map(Number), right = b.split('.').map(Number);
   for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
   return 0;
  });
  for (const version of versions) {
   const file = path.join(root, version, process.platform === 'win32' ? 'opencode-cli.exe' : 'opencode-cli');
   if (fs.existsSync(file)) return file;
  }
 }
 for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
  for (const name of process.platform === 'win32' ? ['opencode-cli.exe', 'opencode.exe'] : ['opencode', 'opencode-cli']) {
   const file = path.join(dir.replace(/^"|"$/g, ''), name);
   if (fs.existsSync(file)) return file;
  }
 }
 throw Error('OpenCode CLI unavailable; set ARENA_OPENCODE_CLI to the official executable');
}

export function runOpenCodeCli(file, args, options) {
 // No shell interpolation, permission escalation, standalone server, fork, or new session.
 const child = spawn(file, args, {...options, windowsHide: true, shell: false, stdio: 'ignore'});
 const done = new Promise(resolve => {
  child.once('error', error => resolve({spawnError: error.code}));
  child.once('exit', (code, signal) => resolve({code, signal}));
 });
 // The host turn belongs to the participant; stopping Arena does not kill that turn.
 child.unref();
 return {done};
}

export class OpenCodeWake {
 constructor({dbPath, cliPath, runCli = runOpenCodeCli, confirmTimeoutMs = 30000, pollMs = 200, sourceSession, env = process.env} = {}) {
  this.dbPath = dbPath || env.ARENA_OPENCODE_DB || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
  this.cliPath = cliPath;
  this.runCli = runCli;
  this.confirmTimeoutMs = confirmTimeoutMs;
  this.pollMs = pollMs;
  this.sourceSession = sourceSession;
  this.env = env;
  this.running = new Map();
 }
 async verify(binding) {
  const info = await this.read(binding);
  this.cliPath ||= findOpenCodeCli(this.env);
  return info;
 }
 async read(binding) {
  if (!/^ses_[A-Za-z0-9_-]{4,196}$/.test(binding.session)) throw Error('OpenCode requires a real ses_ session ID');
  if (!fs.existsSync(this.dbPath)) throw Error('OpenCode session database unavailable; set ARENA_OPENCODE_DB');
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(this.dbPath, {readOnly: true});
  try {
   db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250');
   const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
   if (!tables.has('session_v2') || !tables.has('session_message')) throw Error('OpenCode 2.x session tables are required; legacy tables are not used');
   const session = db.prepare('SELECT id, directory, agent, time_archived, time_idle, idle_outcome FROM session_v2 WHERE id = ?').get(binding.session);
   if (!session) throw Error('OpenCode session does not exist; no new session will be created');
   if (session.time_archived != null && session.time_archived !== 0) throw Error('OpenCode session is archived');
   const latest = db.prepare('SELECT seq, type, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(binding.session);
   const messages = db.prepare("SELECT seq, data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC").all(binding.session).map(row => {
    let data; try { data = JSON.parse(row.data); } catch { data = {}; }
    return {seq: row.seq, role: 'user', text: data.text || ''};
   });
   let pending = false, unknownQueue = false;
   for (const table of ['session_inbox', 'session_pending']) {
    if (!tables.has(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!columns.includes('session_id')) { unknownQueue = true; continue; }
    if (db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ? LIMIT 1`).get(binding.session)) pending = true;
   }
   // time_idle can retain the previous turn's timestamp during a new active turn.
   const status = pending ? 'active' : !unknownQueue && latest?.type === 'idle' && session.time_idle != null ? 'idle' : latest && latest.type !== 'idle' ? 'active' : 'unknown';
   return {session: session.id, workspace: session.directory, agent: session.agent, status, messages, latestSeq: latest?.seq, idleOutcome: session.idle_outcome};
  } finally { db.close(); }
 }
 async send(binding, prompt, marker) {
  if (this.sourceSession && this.sourceSession === binding.session) throw retryable('OpenCode self-wake is not allowed');
  const current = await this.read(binding);
  if (!sameWorkspace(current.workspace, binding.workspace)) throw retryable('OpenCode workspace changed');
  if (hasMarker(current, marker)) return {delivered: true, evidence: 'database-user-message'};
  if (current.status !== 'idle' || this.running.has(binding.session)) throw retryable('OpenCode session is not idle');
  let file;
  try { file = this.cliPath || findOpenCodeCli(this.env); } catch { throw retryable('OpenCode CLI unavailable; check ARENA_OPENCODE_CLI'); }
  const args = ['run', '--session', binding.session, '--format', 'json'];
  // --auto is an explicit operator setting; wake otherwise preserves the session policy.
  if (this.env.ARENA_OPENCODE_AUTO === '1') args.push('--auto');
  if (binding.model) args.push('--model', binding.model);
  args.push(prompt);
  assertCanSend(binding);
  let launch;
  try { launch = this.runCli(file, args, {cwd: binding.workspace, env: this.env}); }
  catch { throw retryable('OpenCode CLI could not be started'); }
  let outcome;
  const done = Promise.resolve(launch.done).then(value => { outcome = value; }, () => { outcome = {code: 1}; }).finally(() => {
   if (this.running.get(binding.session) === done) this.running.delete(binding.session);
  });
  this.running.set(binding.session, done);
  const until = Date.now() + this.confirmTimeoutMs;
  let endedReads = 0;
  do {
   try {
    const info = await this.read(binding);
    if (hasMarker(info, marker)) return {delivered: true, evidence: 'database-user-message', turnEnded: info.status === 'idle'};
   } catch {}
   if (outcome?.spawnError) throw retryable('OpenCode CLI failed to start');
   if (outcome && ++endedReads >= 3) break;
   await new Promise(resolve => setTimeout(resolve, this.pollMs));
  } while (Date.now() < until);
  throw Error('OpenCode delivery uncertain: no matching user message in session_message; do not resend');
 }
}
