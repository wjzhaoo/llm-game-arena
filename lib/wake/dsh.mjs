import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sameWorkspace, retryable, assertCanSend} from './common.mjs';

const run = promisify(execFile);

// Desktop chooses a random port. Rediscover it for each operation after restarts.
async function discoverHost() {
 if (process.platform !== 'win32') throw Error('DSH requires DSH_WEB_URL on this platform');
 const script = "$ErrorActionPreference='Stop'; $dshHosts=@(Get-CimInstance Win32_Process -Filter \"Name = 'DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -match 'dsh-desktop-host' } | Select-Object -ExpandProperty ProcessId); @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $dshHosts -and $_.LocalAddress -in @('127.0.0.1','::1') } | ForEach-Object { if ($_.LocalAddress -eq '::1') { 'http://[::1]:' + $_.LocalPort } else { 'http://127.0.0.1:' + $_.LocalPort } } | Sort-Object -Unique) | ConvertTo-Json -Compress";
 let urls;
 try {
  const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, timeout: 8000});
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  urls = Array.isArray(parsed) ? parsed : [parsed];
 } catch { throw Error('DSH host discovery failed; set DSH_WEB_URL to the current Desktop host URL'); }
 if (urls.length !== 1 || typeof urls[0] !== 'string') throw Error('DSH host is missing or ambiguous; set DSH_WEB_URL to the current Desktop host URL');
 return urls[0];
}

function localUrl(value) {
 let url;
 try { url = new URL(value); } catch { throw Error('Invalid DSH host URL'); }
 if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('DSH host URL must be a loopback origin');
 return url;
}

function browserSecret(home) {
 let lines;
 try { lines = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8').split(/\r?\n/); }
 catch { throw Error('DSH browser credentials unavailable'); }
 let inRecord = false;
 for (const line of lines) {
  if (/^\s{2}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue; }
  if (inRecord && /^\s{2}\S/.test(line)) break;
  const match = inRecord && line.match(/^\s+secret:\s*["']?([A-Za-z0-9_-]{43}=?)["']?\s*$/);
  if (match) {
   const bytes = Buffer.from(match[1], 'base64url');
   if (bytes.length === 32) return bytes;
  }
 }
 throw Error('DSH browser-session secret missing or invalid');
}

function cookieFor(url, secret) {
 const authority = url.protocol === 'https:' ? 'https://' + url.host : url.host, now = Date.now();
 const body = Buffer.from(JSON.stringify({version: 1, authority, issuedAt: now, expiresAt: now + 300000})).toString('base64url');
 return 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url') + '=v1.' + body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}

export class DshWake {
 constructor({env = process.env, home, baseUrl, discoverUrl = discoverHost, fetchImpl = fetch, timeoutMs = 10000} = {}) {
  Object.assign(this, {env, home, baseUrl, discoverUrl, fetch: fetchImpl, timeoutMs});
 }
 async connection() {
  const url = localUrl(this.baseUrl || this.env.DSH_WEB_URL || await this.discoverUrl());
  return {url, cookie: cookieFor(url, browserSecret(this.home || this.env.DSH_HOME || path.join(os.homedir(), '.dsh')))};
 }
 async call(connection, method, args) {
  let response;
  try {
   response = await this.fetch(new URL('/api/' + method, connection.url), {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: {'Content-Type': 'application/json; charset=utf-8', Cookie: connection.cookie}, body: JSON.stringify({type: 'client-request', rpcId: randomUUID(), method, payload: {args}})});
  } catch { throw Error('DSH ' + method + ' request failed; delivery may be uncertain'); }
  // Host/proxy error bodies may contain the signed Cookie. Never expose them.
  if (!response.ok) throw Error('DSH ' + method + ': HTTP ' + response.status);
  let envelope;
  try { envelope = await response.json(); } catch { throw Error('Invalid DSH RPC response'); }
  if (envelope?.result?.ok !== true) throw Error('DSH ' + method + ' RPC rejected');
  return envelope.result.value;
 }
 async list(connection) {
  const items = [], seen = new Set();
  let cursor;
  do {
   const page = await this.call(connection, 'session/list', {_request: cursor ? {cursor} : {}});
   if (!Array.isArray(page?.items)) throw Error('Unsupported DSH session list');
   items.push(...page.items);
   cursor = page.nextCursor;
   if (cursor) {
    if (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 100) throw Error('Invalid DSH session cursor');
    seen.add(cursor);
   }
  } while (cursor);
  return items;
 }
 async session(connection, binding) {
  if (typeof binding.session !== 'string' || !binding.session.trim() || binding.session.length > 200) throw Error('DSH session ID required');
  const matches = (await this.list(connection)).filter(item => item?.sessionId === binding.session);
  if (matches.length !== 1 || !sameWorkspace(binding.workspace, matches[0].cwd)) throw Error('DSH session identity or workspace mismatch');
  return matches[0];
 }
 info(session) {
  const outline = session.projections?.values?.turnOutline || [];
  if (!Array.isArray(outline)) throw Error('Unsupported DSH turn outline');
  return {session: session.sessionId, workspace: session.cwd, status: session.running === true ? 'active' : session.running === false && session.agentAvailable !== false ? 'idle' : 'unknown', messages: outline.flatMap(turn => [
   {role: 'user', text: typeof turn?.prompt === 'string' ? turn.prompt : ''},
   {role: 'assistant', text: typeof turn?.response === 'string' ? turn.response : ''}
  ])};
 }
 async read(binding) { return this.info(await this.session(await this.connection(), binding)); }
 verify(binding) {
  if (binding.model) throw Error('DSH wake preserves the session model; omit --model');
  return this.read(binding);
 }
 async resolveSession(binding) {
  if (typeof binding.invitation !== 'string' || !/^[a-f0-9]{64}$/.test(binding.invitation)) throw Error('DSH 需要本次邀请定位当前会话，或显式传 --session <真实会话标识>');
  const matches = new Set();
  for (const session of await this.list(await this.connection())) {
   if (typeof session?.sessionId !== 'string' || !session.sessionId.trim() || session.sessionId.length > 200 || !sameWorkspace(binding.workspace, session.cwd)) continue;
   if (this.info(session).messages.some(message => message.role === 'user' && message.text.includes(binding.invitation))) matches.add(session.sessionId);
  }
  if (matches.size === 1) return [...matches][0];
  if (matches.size > 1) throw Error(`本次邀请命中 ${matches.size} 个 DSH 会话，请显式传 --session <真实会话标识>`);
  throw Error('未在当前工作区的 DSH 用户回合摘要中找到本次邀请，请稍后重试或显式传 --session <真实会话标识>');
 }
 async send(binding, prompt) {
  if (binding.model) throw Error('DSH wake preserves the session model; omit --model');
  if (typeof prompt !== 'string' || !prompt.trim()) throw Error('DSH message required');
  let connection, session;
  try { connection = await this.connection(); session = await this.session(connection, binding); }
  catch (error) { error.safeToRetry = true; throw error; }
  if (session.running !== false || session.agentAvailable === false) throw retryable('DSH session is not idle or cannot be restored');
  assertCanSend(binding);
  const result = await this.call(connection, 'session/prompt', {request: {requestId: randomUUID(), sessionId: binding.session, mode: 'queue', content: [{type: 'text', text: prompt}], clientTimeZone: 'Asia/Shanghai'}});
  if (result?.accepted !== true) throw Error('DSH delivery unconfirmed');
  return {delivered: true, evidence: 'host-accepted'};
 }
}
