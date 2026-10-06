import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {loopbackUrl, retryable, assertCanSend} from './common.mjs';

// Talks to task-dispatch's onStartup App Plugin, using chat.continueSession.
export class QoderWake {
 constructor({descriptorPath, fetchImpl = fetch, timeoutMs = 5000, env = process.env, home = os.homedir()} = {}) {
  this.files = descriptorPath || env.ARENA_QODER_DISCOVERY ? [descriptorPath || env.ARENA_QODER_DISCOVERY] : [...new Set([env.QODER_CONFIG_DIR, env.QODERCN_CONFIG_DIR, env.QODER_HOME, path.join(home, '.qoder-cn'), path.join(home, '.qoder')].filter(Boolean))].map(dir => path.join(dir, 'task-dispatch-bridge.json'));
  this.fetch = fetchImpl;
  this.timeoutMs = timeoutMs;
  this.sessions = new Map();
 }
 discovery(fileOverride) {
  for (const file of fileOverride ? [fileOverride] : this.files) {
   try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    loopbackUrl(config.baseUrl);
    if (config.version !== 1 || !/^[a-f0-9]{64}$/i.test(config.token) || !Number.isInteger(config.pid) || config.pid < 1) continue;
    try { process.kill(config.pid, 0); } catch (error) { if (error.code !== 'EPERM') continue; }
    return {...config, file};
   } catch {}
  }
  throw Error('Qoder bridge unavailable; install the task-dispatch App Plugin and restart Qoder');
 }
 async request(route, options = {}, file) {
  const config = this.discovery(file);
  const response = await this.fetch(config.baseUrl + route, {...options, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: {'X-Task-Dispatch-Key': config.token, 'Content-Type': 'application/json; charset=utf-8'}});
  if (!response.ok) {
   if ([409, 429, 503].includes(response.status)) throw retryable(`Qoder rejected the request: HTTP ${response.status}`);
   throw Error(`Qoder bridge failed: HTTP ${response.status}`);
  }
  return response.json();
 }
 async read(binding) {
  if (!/^[A-Za-z0-9._:-]{4,200}$/.test(binding.session)) throw Error('Invalid Qoder session ID');
  const found = [];
  for (const file of this.files) {
   try {
    const result = await this.request('/v1/sessions/' + encodeURIComponent(binding.session) + '/state', {}, file);
    if (result.sessionId === binding.session) found.push({result, file});
   } catch {}
  }
  if (found.length !== 1) throw Error('Qoder session must be found in exactly one live bridge');
  const {result, file} = found[0];
  this.sessions.set(binding.session, file);
  const state = String(result.runtimeState || '').toLowerCase();
  // The existing bridge verifies identity but does not expose a workspace or history.
  return {session: result.sessionId, workspace: result.directory || result.workspace, workspaceVerified: !!(result.directory || result.workspace), status: ['ready', 'idle', 'completed'].includes(state) ? 'idle' : ['opening', 'running', 'active', 'queued', 'waiting', 'needs_attention'].includes(state) ? 'active' : 'unknown', messages: []};
 }
 async send(binding, prompt, marker) {
  if ((await this.read(binding)).status !== 'idle') throw retryable('Qoder session is not idle');
  assertCanSend(binding);
  const result = await this.request('/v1/sessions/' + encodeURIComponent(binding.session) + '/messages', {method: 'POST', body: JSON.stringify({prompt, requestId: marker})}, this.sessions.get(binding.session));
  if (result.sessionId !== binding.session || result.accepted !== true) throw Error('Qoder delivery was not confirmed');
  return {delivered: true, evidence: 'bridge-accepted'};
 }
}
