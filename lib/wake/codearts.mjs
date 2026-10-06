import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {loopbackUrl, messagesFromParts, confirmMessage, retryable, sameWorkspace, assertCanSend} from './common.mjs';

// Reuses the authenticated, per-session bridge descriptors installed by task-dispatch.
export class CodeArtsWake {
 constructor({credentialFile, discoveryDir, fetchImpl = fetch, timeoutMs = 10000, env = process.env} = {}) {
  this.file = credentialFile || env.ARENA_CODEARTS_DISCOVERY;
  this.dir = discoveryDir || path.join(os.homedir(), '.codeartsdoer', 'task-dispatch');
  this.fetch = fetchImpl;
  this.timeoutMs = timeoutMs;
 }
 discovery(binding) {
  const name = createHash('sha256').update(binding.session).digest('hex') + '.json';
  const local = path.join(binding.workspace, 'tmp', 'codearts-bridge');
  const file = this.file || [path.join(local, name), path.join(this.dir, name), path.join(local, 'bridge.json'), path.join(this.dir, 'bridge.json')].find(fs.existsSync);
  if (!file) throw Error('CodeArts bridge descriptor unavailable; install the task-dispatch bridge');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  loopbackUrl(config.url);
  if (![1, 2].includes(config.version) || (config.sessionId && config.sessionId !== binding.session) || !sameWorkspace(config.directory, binding.workspace) || (config.version === 1 && (typeof config.username !== 'string' || !config.username || config.username.includes(':') || typeof config.password !== 'string' || !config.password)) || (config.version === 2 && !/^[a-f0-9]{64}$/i.test(config.token))) throw Error('Invalid CodeArts bridge descriptor');
  return config;
 }
 async request(binding, route, options = {}) {
  const config = this.discovery(binding);
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
