// MiMo protocol and permission normalization follow task-dispatch.
import fs from 'node:fs';
import path from 'node:path';
import {messagesFromParts, confirmMessage, retryable, assertCanSend} from './common.mjs';

export function effectivePermission(settings, session) {
 const normalize = value => value === '接受编辑权限' ? '帮我审批' : ['默认权限', '帮我审批', '完全访问权限'].includes(value) ? value : null;
 let values = settings.permByConvo;
 if (typeof values === 'string') { try { values = JSON.parse(values); } catch { values = null; } }
 const value = normalize(values?.[session]) || normalize(settings.perm) || '帮我审批';
 return value === '完全访问权限' && (settings.fullAccessEnabled === false || settings.fullAccessEnabled === '0') ? '默认权限' : value;
}

export class MimoWake {
 constructor({credentialFile, fetchImpl = fetch, timeoutMs = 10000, eventTimeoutMs = 800, env = process.env} = {}) {
  this.file = credentialFile || env.ARENA_MIMO_DISCOVERY || path.join(env.APPDATA || '', 'Xiaomi MiMo', 'desktop-api.json');
  this.fetch = fetchImpl;
  this.timeoutMs = timeoutMs;
  this.eventTimeoutMs = eventTimeoutMs;
 }
 async request(route, options = {}) {
  const config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
  if (config.api !== 1 || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-f0-9]{64}$/i.test(config.token)) throw Error('Invalid MiMo Desktop discovery file');
  return this.fetch(`http://127.0.0.1:${config.port}/v1/${route}`, {...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(this.timeoutMs), headers: {'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${config.token}`}});
 }
 async json(route) {
  const response = await this.request(route);
  if (!response.ok) throw Error(`MiMo query failed: HTTP ${response.status}`);
  return response.json();
 }
 async status(session, directory) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.eventTimeoutMs);
  let reader;
  try {
   const response = await this.request(`sessions/${encodeURIComponent(session)}/events?dir=${encodeURIComponent(directory)}`, {signal: controller.signal});
   if (!response.ok || !response.body) return 'unknown';
   reader = response.body.getReader();
   let buffer = '';
   const decoder = new TextDecoder();
   while (true) {
    const {value, done} = await reader.read();
    if (done) return 'unknown';
    buffer += decoder.decode(value, {stream: true}).replace(/\r\n/g, '\n');
    if (buffer.length > 65536) return 'unknown';
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
     const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
     const event = /^event:\s*(\S+)/m.exec(frame)?.[1];
     if (event === 'idle') return 'idle';
     if (['busy', 'permission'].includes(event)) return 'active';
     if (event === 'closed') return 'unknown';
    }
   }
  } catch { return 'unknown'; }
  finally { clearTimeout(timer); controller.abort(); if (reader) await reader.cancel().catch(() => {}); }
 }
 async inspect(binding, includeStatus) {
  const listing = await this.json('sessions'), sessions = Array.isArray(listing) ? listing : listing.sessions;
  const session = sessions?.find(s => s.id === binding.session);
  if (!session || !path.isAbsolute(session.directory || '')) throw Error('MiMo session not found or has no workspace');
  const history = await this.json(`sessions/${encodeURIComponent(binding.session)}/messages?dir=${encodeURIComponent(session.directory)}`);
  const messages = Array.isArray(history) ? history : history.messages;
  if (!Array.isArray(messages)) throw Error('Unsupported MiMo history');
  const latest = [...messages].reverse().find(m => m.info?.role === 'assistant' && !m.info.error && m.info.providerID && m.info.modelID);
  return {session: session.id, workspace: session.directory, status: includeStatus ? await this.status(session.id, session.directory) : 'unknown', messages: messagesFromParts(messages), model: latest ? `${latest.info.providerID}/${latest.info.modelID}` : undefined};
 }
 verify(binding) { return this.inspect(binding, false); }
 read(binding) { return this.inspect(binding, true); }
 async send(binding, prompt, marker) {
  if (!/^[^\s/]+\/\S+$/.test(binding.model || '')) throw retryable('MiMo needs a confirmed provider/model');
  let perm;
  try { perm = effectivePermission(JSON.parse(fs.readFileSync(path.join(path.dirname(this.file), 'preferences.json'), 'utf8')), binding.session); } catch {}
  assertCanSend(binding);
  const response = await this.request(`sessions/${encodeURIComponent(binding.session)}/turns`, {method: 'POST', body: JSON.stringify({message: prompt, model: binding.model, dir: binding.workspace, ...(perm ? {perm} : {}), origin: 'llm-game-arena'})});
  const body = await response.json();
  if (body.code === 'busy' && response.status >= 400 && response.status < 500) throw retryable('MiMo session is busy');
  if (response.status !== 202 || body.ok !== true) throw Error('MiMo delivery was not confirmed');
  return confirmMessage(this, binding, marker);
 }
}
