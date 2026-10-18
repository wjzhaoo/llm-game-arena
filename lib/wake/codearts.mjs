import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {loopbackUrl, messagesFromParts, confirmMessage, retryable, sameWorkspace, assertCanSend} from './common.mjs';

// Reuses the authenticated, per-session bridge descriptors installed by task-dispatch.
export class CodeArtsWake {
 constructor({credentialFile, discoveryDir, dbPath, fetchImpl = fetch, timeoutMs = 10000, env = process.env} = {}) {
  this.file = credentialFile || env.ARENA_CODEARTS_DISCOVERY;
  this.dir = discoveryDir || path.join(os.homedir(), '.codeartsdoer', 'task-dispatch');
  this.dbPath = dbPath || env.ARENA_CODEARTS_DB || path.join(os.homedir(), '.codeartsdoer', 'codearts-data', 'opencode.db');
  this.fetch = fetchImpl;
  this.timeoutMs = timeoutMs;
 }
 discovery(binding, {generic = false} = {}) {
  const local = path.join(binding.workspace, 'tmp', 'codearts-bridge');
  const names = generic ? ['bridge.json'] : [createHash('sha256').update(binding.session).digest('hex') + '.json', 'bridge.json'];
  const candidates = names.flatMap(name => [path.join(local, name), path.join(this.dir, name)]);
  const file = this.file || candidates.find(fs.existsSync);
  if (!file) throw Error('CodeArts bridge descriptor unavailable; install the task-dispatch bridge');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  loopbackUrl(config.url);
  if (![1, 2].includes(config.version) || (!generic && config.sessionId && config.sessionId !== binding.session) || !sameWorkspace(config.directory, binding.workspace) || (config.version === 1 && (typeof config.username !== 'string' || !config.username || config.username.includes(':') || typeof config.password !== 'string' || !config.password)) || (config.version === 2 && !/^[a-f0-9]{64}$/i.test(config.token))) throw Error('Invalid CodeArts bridge descriptor');
  return config;
 }
 // The full one-time invitation already occurs in the receiving user's message.
 // Use literal content evidence, never project.worktree, title or update ordering.
 async sessionFromInvitation(binding) {
  if (typeof binding.invitation !== 'string' || !/^[a-f0-9]{64}$/.test(binding.invitation) || !fs.existsSync(this.dbPath)) return null;
  const {DatabaseSync} = await import('node:sqlite');
  let db, rows;
  try {
   db = new DatabaseSync(this.dbPath, {readOnly: true});
   db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250');
   rows = db.prepare(`SELECT s.id, s.directory, s.time_archived, p.data AS part, m.data AS message
    FROM part p JOIN session s ON s.id = p.session_id
    JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
    WHERE instr(p.data, ?) > 0`).all(binding.invitation);
  } catch {
   throw Error('CodeArts 会话数据库读取失败，请检查 ARENA_CODEARTS_DB 或显式传 --session <真实会话标识>');
  } finally { db?.close(); }
  const matches = new Set();
  for (const row of rows) {
   if (!/^[A-Za-z0-9._:-]{4,200}$/.test(row.id) || !sameWorkspace(row.directory, binding.workspace) || (row.time_archived != null && row.time_archived !== 0)) continue;
   try {
    const part = JSON.parse(row.part), message = JSON.parse(row.message);
    if (message.role === 'user' && part.type === 'text' && typeof part.text === 'string' && part.text.includes(binding.invitation)) matches.add(row.id);
   } catch { /* Malformed history is not identity evidence. */ }
  }
  if (matches.size === 1) return [...matches][0];
  if (matches.size > 1) throw Error(`本次邀请命中 ${matches.size} 个 CodeArts 会话，请显式传 --session <真实会话标识>，不会按最近更新猜测`);
  throw Error('尚未在当前工作区的 CodeArts 用户消息正文中找到本次邀请，请待消息落库后重试，或显式传 --session <真实会话标识>');
 }
 async resolveSession(binding) {
  const matched = await this.sessionFromInvitation(binding);
  if (matched) return matched;
  const config = this.discovery(binding, {generic: true});
  if (config.sessionId) return config.sessionId;
  let sessions;
  try {
   const response = await this.request(binding, '/sessions', {}, config);
   if (!response.ok) throw Error(`CodeArts query failed: HTTP ${response.status}`);
   sessions = await response.json();
  } catch {
   throw Error('当前 CodeArts 桥接不支持会话列表，请显式传 --session <真实会话标识>');
  }
  const matches = (Array.isArray(sessions) ? sessions : []).filter(item => item && typeof item.id === 'string' && /^[A-Za-z0-9._:-]{4,200}$/.test(item.id) && sameWorkspace(item.directory, binding.workspace));
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw Error('当前工作区未发现 CodeArts 会话，请显式传 --session <真实会话标识>');
  throw Error(`当前工作区有 ${matches.length} 个 CodeArts 会话，请显式传 --session 指定其一`);
 }
 async request(binding, route, options = {}, discovered) {
  const config = discovered || this.discovery(binding);
  try { return await this.requestWithConfig(route, options, config); }
  catch (error) {
   // Startup refreshes the generic descriptor before the restored session emits an event.
   // A refused connection cannot have accepted a prompt; ambiguous failures must not retry.
   if (discovered || this.file || !config.sessionId || ![error.code, error.cause?.code].includes('ECONNREFUSED')) throw error;
   const current = this.discovery(binding, {generic: true});
   if (current.url === config.url) throw error;
   return this.requestWithConfig(route, options, current);
  }
 }
 async requestWithConfig(route, options, config) {
  const bridgeRoute = route === '/session/status' ? '/v1/status' : route.endsWith('/message') ? '/v1' + route.replace(/\/message$/, '/messages') : route.endsWith('/prompt_async') ? '/v1' + route.replace(/\/prompt_async$/, '/prompt') : '/v1' + route;
  const url = new URL(config.version === 2 ? bridgeRoute : route, config.url);
  if (config.version === 1) url.searchParams.set('directory', config.directory);
  return this.fetch(url.href, {...options, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: {'Content-Type': 'application/json; charset=utf-8', Authorization: config.version === 2 ? `Bearer ${config.token}` : 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64')}});
 }
 async json(binding, route) {
  const response = await this.request(binding, route);
  if (!response.ok) throw Error(`CodeArts query failed: HTTP ${response.status}`);
  return response.json();
 }
 async read(binding) {
  const route = '/session/' + encodeURIComponent(binding.session);
  const session = await this.json(binding, route), messages = await this.json(binding, route + '/message'), statuses = await this.json(binding, '/session/status');
  if (session.id !== binding.session || !sameWorkspace(session.directory, binding.workspace) || !Array.isArray(messages) || !statuses || Array.isArray(statuses) || typeof statuses !== 'object') throw Error('CodeArts session or workspace mismatch');
  const type = statuses[binding.session]?.type;
  return {session: session.id, workspace: session.directory, status: !Object.hasOwn(statuses, binding.session) || type === 'idle' ? 'idle' : ['busy', 'retry'].includes(type) ? 'active' : 'unknown', messages: messagesFromParts(messages)};
 }
 async send(binding, prompt, marker) {
  if ((await this.read(binding)).status !== 'idle') throw retryable('CodeArts session is not idle');
  const body = {parts: [{type: 'text', text: prompt}]};
  if (binding.model) { const [providerID, ...model] = binding.model.split('/'); body.model = {providerID, modelID: model.join('/')}; }
  assertCanSend(binding);
  const response = await this.request(binding, '/session/' + encodeURIComponent(binding.session) + '/prompt_async', {method: 'POST', body: JSON.stringify(body)});
  if (response.status === 409 || response.status === 429) throw retryable('CodeArts rejected a busy session');
  if (response.status !== 204 && response.status !== 202) throw Error('CodeArts delivery was not confirmed');
  return confirmMessage(this, binding, marker);
 }
}
