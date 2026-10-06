// Adapted from task-dispatch's Codex Desktop named-pipe transport.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {sameWorkspace, confirmMessage, assertCanSend} from './common.mjs';

export function rpc(pipe, message, timeoutMs = 10000) {
 return new Promise((resolve, reject) => {
  const socket = net.createConnection(pipe);
  let buffer = Buffer.alloc(0), finished = false;
  const finish = (error, value) => {
   if (finished) return;
   finished = true;
   clearTimeout(timer);
   socket.destroy();
   error ? reject(error) : resolve(value);
  };
  const timer = setTimeout(() => finish(Error('Codex Desktop pipe timed out')), timeoutMs);
  socket.on('error', () => finish(Error('Codex Desktop pipe unavailable')));
  socket.on('close', () => finish(Error('Codex Desktop pipe closed')));
  socket.on('connect', () => {
   const text = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
   header.writeUInt32LE(text.length);
   socket.write(Buffer.concat([header, text]));
  });
  socket.on('data', chunk => {
   buffer = Buffer.concat([buffer, chunk]);
   if (buffer.length > 8 * 1024 * 1024 + 4) return finish(Error('Codex Desktop response too large'));
   if (buffer.length < 4) return;
   const size = buffer.readUInt32LE();
   if (size > 8 * 1024 * 1024) return finish(Error('Codex Desktop response too large'));
   if (buffer.length >= size + 4) {
    try { finish(null, JSON.parse(buffer.subarray(4, size + 4).toString('utf8'))); }
    catch { finish(Error('Invalid Codex Desktop response')); }
   }
  });
 });
}

export class CodexWake {
 constructor({rpcImpl = rpc, pipe, sessionRoot, env = process.env} = {}) {
  this.rpc = rpcImpl;
  this.pipe = pipe;
  this.sessionRoot = sessionRoot || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
 }
 async resolveTurn(session, workspace) {
  if (!/^[a-zA-Z0-9-]{8,200}$/.test(session)) throw Error('Invalid Codex session ID');
  const files = [];
  const visit = async dir => {
   for (const entry of await fs.promises.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && entry.name.includes(session) && entry.name.endsWith('.jsonl')) files.push(file);
   }
  };
  await visit(this.sessionRoot);
  const candidates = await Promise.all(files.map(async file => ({file, time: (await fs.promises.stat(file)).mtimeMs})));
  candidates.sort((a, b) => b.time - a.time);
  for (const {file} of candidates) {
   const lines = readline.createInterface({input: fs.createReadStream(file, {encoding: 'utf8'}), crlfDelay: Infinity});
   let verified = false, turnId;
   for await (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'session_meta') verified = row.payload?.id === session && sameWorkspace(workspace, row.payload?.cwd);
    if (row.type === 'turn_context' && typeof row.payload?.turn_id === 'string') turnId = row.payload.turn_id;
   }
   if (verified && turnId) return turnId;
  }
  throw Error('Codex needs the real turn ID; use --turn-id');
 }
 async discover() {
  if (this.pipe) return this.pipe;
  if (this.discovery) return this.discovery;
  this.discovery = (async () => {
   if (process.platform !== 'win32') throw Error('Codex Desktop wake currently supports Windows');
   const root = '\\\\.\\pipe\\';
   for (const name of await fs.promises.readdir(root)) {
    if (!name.toLowerCase().includes('codex-browser-use-')) continue;
    try {
     const result = await this.rpc(root + name, {id: 1, jsonrpc: '2.0', method: 'tools/list', params: {threadStartKind: 'all'}}, 2500);
     if (['read_thread', 'send_message_to_thread'].every(tool => result.result?.tools?.some(t => t.namespace === 'codex_app' && t.name === tool))) return this.pipe = root + name;
    } catch {}
   }
   throw Error('Compatible Codex Desktop pipe unavailable');
  })().finally(() => { this.discovery = null; });
  return this.discovery;
 }
 async call(binding, tool, args) {
  try {
   const pipe = await this.discover();
   if (tool === 'send_message_to_thread') assertCanSend(binding);
   const result = await this.rpc(pipe, {id: 2, jsonrpc: '2.0', method: 'tools/call', params: {namespace: 'codex_app', tool, threadId: binding.session, turnId: binding.turnId, callId: randomUUID(), arguments: args}});
   if (result.error || result.result?.success !== true) throw Error('Codex Desktop call was not confirmed');
   return JSON.parse(result.result.contentItems?.find(i => i.type === 'inputText')?.text);
  } catch (error) { this.pipe = null; throw error; }
 }
 async read(binding) {
  const info = await this.call(binding, 'read_thread', {threadId: binding.session, turnLimit: 20});
  const messages = (info.turns || []).flatMap(t => (t.items || []).map(item => ({role: item.type === 'userMessage' ? 'user' : 'assistant', text: typeof item.content === 'string' ? item.content : (item.content || []).map(c => c.text || '').join('\n')})));
  const status = info.thread?.status?.type;
  return {session: info.thread?.id, workspace: info.thread?.cwd, status: status === 'idle' ? 'idle' : ['active', 'busy', 'running'].includes(status) ? 'active' : 'unknown', messages};
 }
 async send(binding, prompt, marker) {
  await this.call(binding, 'send_message_to_thread', {threadId: binding.session, prompt});
  return confirmMessage(this, binding, marker);
 }
}
