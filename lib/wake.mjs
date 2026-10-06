import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bounded, hasMarker, markerFor, providerName, supportsWake, sameWorkspace} from './wake/common.mjs';
import {createWakeAdapters} from './wake/index.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class WakeService {
 constructor(arena, {workspace = projectRoot, adapters = createWakeAdapters(), readTimeoutMs = 15000, sendTimeoutMs = 35000, retryMs = 3000} = {}) {
  this.arena = arena;
  this.store = arena.store;
  this.workspace = path.resolve(workspace);
  this.adapters = adapters;
  this.readTimeoutMs = readTimeoutMs;
  this.sendTimeoutMs = sendTimeoutMs;
  this.retryMs = retryMs;
  this.inFlight = new Map();
  this.stopped = false;
 }
 adapter(provider) {
  const adapter = this.adapters[provider];
  if (!adapter) throw Error(`Wake adapter unavailable: ${provider}`);
  return adapter;
 }
 checkInfo(binding, info) {
  if (info.session !== binding.session) throw Error('Host returned a different session');
  // Qoder's existing bridge cannot attest workspace; keep this limitation explicit.
  if (!(binding.provider === 'qoder' && info.workspaceVerified === false) && !sameWorkspace(this.workspace, info.workspace)) throw Error('Host session workspace does not match the Arena project');
 }
 async prepare(input, previous) {
  const provider = providerName(input.provider || previous?.provider);
  if (!supportsWake(provider)) return null;
  const session = input.session || previous?.session;
  if (typeof session !== 'string' || !session.trim() || session.length > 200) throw Error('Receiver must confirm real provider and session');
  const credentialPath = input.credentialPath || previous?.credentialPath;
  if (typeof credentialPath !== 'string' || !path.isAbsolute(credentialPath) || /["\r\n\0]/.test(credentialPath)) throw Error('Wake requires the absolute credential file path');
  const relative = path.relative(this.workspace, credentialPath);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !credentialPath.endsWith('.credential.json')) throw Error('Wake credential file must be inside the Arena workspace');
  const adapter = this.adapter(provider);
  const binding = {provider, session, workspace: this.workspace, credentialPath, ...(input.turnId || previous?.turnId ? {turnId: input.turnId || previous.turnId} : {}), ...(input.model || previous?.model ? {model: input.model || previous.model} : {})};
  if (provider === 'codex' && !binding.turnId) binding.turnId = await bounded(() => adapter.resolveTurn(session, this.workspace), this.readTimeoutMs);
  if (provider === 'codex' && (typeof binding.turnId !== 'string' || !binding.turnId.trim())) throw Error('Codex requires a real turn ID');
  if (binding.model && (typeof binding.model !== 'string' || !/^[^\s/]+\/\S+$/.test(binding.model))) throw Error('Model must use provider/model');
  const info = await bounded(() => (adapter.verify || adapter.read).call(adapter, binding), this.readTimeoutMs);
  this.checkInfo(binding, info);
  if (provider === 'mimo' && !binding.model) binding.model = info.model;
  if (provider === 'mimo' && !/^[^\s/]+\/\S+$/.test(binding.model || '')) throw Error('MiMo requires a confirmed model; use --model provider/model');
  binding.verifiedAt = this.arena.now();
  binding.workspaceVerified = info.workspaceVerified !== false;
  return binding;
 }
 async connect(input) {
  // Host verification precedes invitation consumption. The invitation is checked again on commit.
  this.arena.validateInvitation(input);
  const wake = await this.prepare(input);
  const connected = this.arena.connect(input, {wake});
  if (!wake) return connected;
  return {...connected, ...this.arena.park(this.arena.identity(connected.token))};
 }
 async bind(identity, input = {}) {
  const current = this.arena.binding(identity);
  const provider = providerName(input.provider || current.provider);
  if (provider !== providerName(current.provider) || (input.session && input.session !== current.session)) throw Error('Wake must use the connected provider/session; revoke before replacing it');
  const wake = await this.prepare({...input, provider, session: current.session}, current.wake || current);
  if (!wake) throw Error('This provider supports wait only');
  this.store.change(state => {
   const match = this.arena.get(identity.match, state), binding = this.arena.binding(identity, state);
   for (const other of Object.values(state.matches)) for (const [seat, b] of Object.entries(other.bindings)) {
    if ((other.id !== match.id || seat !== identity.seat) && b.wake && b.provider === provider && b.session === wake.session && (other.game.status !== 'finished' || other.jobs.some(j => j.status === 'open'))) throw Error('Host session already bound to another participant');
   }
   binding.wake = wake;
   binding.provider = provider;
   binding.continuationMode = 'wake';
   binding.armed = false;
  });
  return {ok: true, continuationMode: 'wake', nextAction: 'resume'};
 }
 async resume(identity, input = {}) {
  let binding = this.arena.binding(identity);
  if (input.provider && providerName(input.provider) !== providerName(binding.provider)) throw Error('Resume must reuse the connected provider');
  if (!binding.wake && supportsWake(binding.provider)) {
   await this.bind(identity, input);
   binding = this.arena.binding(identity);
  }
  return binding.wake ? this.arena.park(identity) : this.arena.claim(identity);
 }
 prompt(match, job, binding) {
  const script = path.join(this.workspace, 'client.mjs');
  if (job.completion) return `[${markerFor(job.attemptId)}]\n弈境本场比赛已结束。请运行 node "${script}" resume --credential "${binding.wake.credentialPath}" 核实 completed:true，然后结束参与。不要提交过期行动或向其他会话转发通知。`;
  return `[${markerFor(job.attemptId)}]\n弈境有你的待领取任务。请在竞技场目录运行：\nnode "${script}" resume --credential "${binding.wake.credentialPath}"\n仅根据返回的本角色 job.view 和 actionSchema 决定行动。将行动 JSON 保存到竞技场 tmp 目录（UTF-8 无 BOM），使用 client.mjs submit 携带本次 taskId 和 attemptId 回传，随后继续 resume。parked:true 表示结束当前回合等待下一次唤醒；completed:true 表示比赛结束。通知送达不代表任务完成。不要向自己或其他会话转发，不借用其他角色凭据，不修改项目源码，不公开私有局面或凭据。`;
 }
 candidate(match, seat, binding) {
  const job = match.jobs.find(j => j.seat === seat && j.status === 'open');
  if (job) return job;
  if (match.game.status === 'finished') return {seat, completion: true, attemptId: `completed:${binding.clientId}`, deadline: Number.MAX_SAFE_INTEGER, wakeNotice: binding.completionNotice};
  return null;
 }
 current(matchId, seat, clientId, attemptId) {
  const match = this.store.state.matches[matchId], binding = match?.bindings[seat];
  if (this.stopped || !match?.started || !binding?.wake || !binding.armed || binding.clientId !== clientId) return null;
  const job = this.candidate(match, seat, binding);
  if (!job || job.clientId || job.attemptId !== attemptId || job.deadline <= this.arena.now()) return null;
  return {match, binding, job};
 }
 update(target, change) {
  if (!this.current(target.match, target.seat, target.clientId, target.attemptId)) return;
  this.store.change(state => {
   const match = state.matches[target.match], binding = match.bindings[target.seat];
   if (target.attemptId === `completed:${target.clientId}`) {
    binding.completionNotice ||= {marker: markerFor(target.attemptId), clientId: target.clientId, status: 'pending'};
    change(binding.completionNotice);
   } else {
    const job = match.jobs.find(j => j.attemptId === target.attemptId);
    job.wakeNotice ||= {marker: markerFor(target.attemptId), clientId: target.clientId, status: 'pending'};
    change(job.wakeNotice);
   }
  });
 }
 tick({match: onlyMatch, seat: onlySeat, force = false} = {}) {
  if (this.stopped) return [];
  const started = [];
  for (const match of Object.values(this.store.state.matches)) {
   if (!match.started || (onlyMatch && onlyMatch !== match.id)) continue;
   for (const [seat, binding] of Object.entries(match.bindings)) {
    if ((onlySeat && onlySeat !== seat) || !binding.wake || !binding.armed) continue;
    const job = this.candidate(match, seat, binding);
    if (!job || job.clientId || job.deadline <= this.arena.now() || job.wakeNotice?.status === 'sent' || (!force && job.wakeNotice?.nextCheckAt > this.arena.now())) continue;
    const key = `${match.id}:${seat}`;
    if (this.inFlight.has(key)) continue;
    const target = {match: match.id, seat, clientId: binding.clientId, attemptId: job.attemptId};
    const work = this.deliver(target).catch(() => {}).finally(() => { if (this.inFlight.get(key) === work) this.inFlight.delete(key); });
    this.inFlight.set(key, work);
    started.push(work);
   }
  }
  return started;
 }
 async deliver(target) {
  let current = this.current(target.match, target.seat, target.clientId, target.attemptId);
  if (!current) return;
  const adapter = this.adapter(current.binding.provider), config = current.binding.wake, marker = markerFor(target.attemptId);
  this.update(target, notice => { notice.nextCheckAt = this.arena.now() + this.retryMs; });
  let info;
  try {
   info = await bounded(() => adapter.read(config), this.readTimeoutMs);
   this.checkInfo(config, info);
  } catch {
   this.update(target, notice => { notice.error = '无法核实宿主会话；检查平台连接后重新核验'; notice.checkedAt = this.arena.now(); });
   return;
  }
  current = this.current(target.match, target.seat, target.clientId, target.attemptId);
  if (!current) return;
  if (hasMarker(info, marker)) {
   this.update(target, notice => { notice.status = 'sent'; notice.evidence = 'user-message'; notice.sentAt = this.arena.now(); delete notice.error; });
   return;
  }
  if (['sending', 'uncertain'].includes(current.job.wakeNotice?.status)) {
   this.update(target, notice => { notice.status = 'uncertain'; notice.error = '上次投递结果不确定，暂不重发；请在原会话领取或核实后 resume'; });
   return;
  }
  if (info.status !== 'idle') {
   this.update(target, notice => { notice.status = 'pending'; notice.error = info.status === 'active' ? '原会话正在执行，等待当前回合结束' : '无法确认原会话空闲，暂不投递'; });
   return;
  }
  this.update(target, notice => { notice.status = 'sending'; notice.sendingAt = this.arena.now(); delete notice.error; });
  current = this.current(target.match, target.seat, target.clientId, target.attemptId);
  if (!current) return;
  try {
   const sending = {...config, canSend: () => !!this.current(target.match, target.seat, target.clientId, target.attemptId)};
   const result = await bounded(() => adapter.send(sending, this.prompt(current.match, current.job, current.binding), marker), this.sendTimeoutMs);
   if (result?.delivered !== true) throw Error('Delivery not confirmed');
   this.update(target, notice => { notice.status = 'sent'; notice.sentAt = this.arena.now(); notice.evidence = result.evidence || 'host-receipt'; delete notice.error; });
  } catch (error) {
   this.update(target, notice => { notice.status = error.safeToRetry === true ? 'pending' : 'uncertain'; notice.error = error.safeToRetry === true ? '宿主明确未接受通知，将在空闲后重试' : '通知送达不确定，暂不重发；请在原会话核实后 resume'; });
  }
 }
 diagnostics(matchId) {
  const match = this.arena.get(matchId);
  return this.arena.seats(match).map(seat => {
   const binding = match.bindings[seat], job = binding && this.candidate(match, seat, binding);
   return {seat, mode: binding?.wake ? 'wake' : 'wait', verified: !!binding?.wake, workspaceVerified: binding?.wake?.workspaceVerified ?? false, armed: !!binding?.armed, completion: !!job?.completion, status: !binding ? 'disconnected' : job?.clientId ? 'claimed' : job?.wakeNotice?.status || (match.game.status === 'finished' && !binding.armed ? 'completed' : binding.armed ? 'parked' : 'connected'), ...(job?.wakeNotice?.error ? {error: job.wakeNotice.error} : {})};
  });
 }
 stop() { this.stopped = true; }
}
