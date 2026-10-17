import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {providerName,supportsWake,markerFor} from './wake/common.mjs';

const digest=value=>createHash('sha256').update(value||'').digest('hex');
const errors={host_unavailable:'无法核实远端宿主会话',busy:'远端会话正在执行，等待空闲',unknown:'无法确认远端会话空闲',delivery_uncertain:'通知送达不确定，先核验后续接',rejected:'远端宿主明确未接受通知，等待重试'};

// This coordinator never opens a host bridge on the game server.
export class RelayService {
 constructor(arena,wake,{leaseMs=90000,retryMs=3000}={}){this.arena=arena;this.wake=wake;this.leaseMs=leaseMs;this.retryMs=retryMs}
 connect(input){
  const provider=this.arena.validateInvitation(input);
  if(!supportsWake(provider))return this.arena.connect(input);
  const verification=input.relayVerification;
  if(!verification||verification.verified!==true||verification.workspaceVerified!==true||!/^[a-f0-9]{64}$/.test(verification.deviceId||''))throw Error('远端客户端须先核验真实宿主会话和工作目录');
  const relayToken=randomBytes(32).toString('hex');
  const wake={transport:'relay',provider,session:input.session,deviceId:verification.deviceId,workspaceVerified:verification.workspaceVerified,verifiedAt:this.arena.now(),relayTokenHash:digest(relayToken)};
  const connected=this.arena.connect(input,{wake});
  return {...connected,...this.arena.park(this.arena.identity(connected.token)),relayToken,wakeTransport:'relay'};
 }
 identity(token){
  const hashed=Buffer.from(digest(token));
  for(const m of Object.values(this.arena.store.state.matches))for(const [seat,b] of Object.entries(m.bindings)){
   if(this.arena.activeBinding(m,seat)&&b.wake?.transport==='relay'&&b.wake.relayTokenHash&&timingSafeEqual(hashed,Buffer.from(b.wake.relayTokenHash)))return {match:m.id,seat,clientId:b.clientId};
  }
  throw Error('Unauthorized relay');
 }
 target(identity){
  const b=this.arena.binding(identity),m=this.arena.get(identity.match),job=this.wake.candidate(m,identity.seat,b);
  return {b,m,job,current:job&&this.wake.current(m.id,identity.seat,b.clientId,job.attemptId)};
 }
 poll(identity,{instanceId}){
  if(typeof instanceId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(instanceId))throw Error('Invalid relay instance');
  let {b,m,job,current}=this.target(identity);
  if(m.game.status==='finished'&&(!m.started||!b.armed||job?.wakeNotice?.status==='sent'))return {idle:true,completed:true,runId:m.runId};
  if(!current||job.wakeNotice?.status==='sent'||job.wakeNotice?.nextCheckAt>this.arena.now())return {idle:true};
  const now=this.arena.now(),lease=b.wake.relayLease;
  if(lease?.until>now&&lease.owner!==instanceId)return {idle:true,leased:true};
  if(!lease||lease.owner!==instanceId||lease.until<now+this.leaseMs/2){
   this.arena.store.change(s=>{
    const binding=this.arena.binding(identity,s);
    binding.wake.relayLease={owner:instanceId,id:lease?.owner===instanceId&&lease.until>now?lease.id:randomUUID(),until:now+this.leaseMs};
   });
  }
  ({b,m,job,current}=this.target(identity));if(!current)return {idle:true};
  return {notification:{attemptId:job.attemptId,completion:!!job.completion,marker:markerFor(job.attemptId),status:job.wakeNotice?.status||'pending',leaseId:b.wake.relayLease.id,validForMs:Math.max(0,Math.min(b.wake.relayLease.until,job.deadline)-this.arena.now())}};
 }
 report(identity,input){
  const {b,job,current}=this.target(identity),lease=b.wake.relayLease;
  if(!current||job.attemptId!==input.attemptId||lease?.owner!==input.instanceId||lease.id!==input.leaseId||lease.until<=this.arena.now())throw Error('Stale relay delivery');
  if(input.action==='check')return {valid:true};
  if(!['pending','sending','sent','uncertain'].includes(input.status))throw Error('Invalid delivery status');
  const previous=job.wakeNotice?.status||'pending';
  if(previous==='sent')return {ok:true,duplicate:true};
  if(input.status==='sending'&&previous!=='pending')throw Error('Uncertain delivery must be checked before retry');
  if(input.status==='pending'&&previous!=='pending'&&!(previous==='sending'&&input.error==='rejected'))throw Error('Uncertain delivery must be checked before retry');
  this.wake.update({match:identity.match,seat:identity.seat,clientId:identity.clientId,attemptId:job.attemptId},notice=>{
   notice.status=input.status;notice.checkedAt=this.arena.now();
   if(input.status==='sending')notice.sendingAt=this.arena.now();
   if(input.status==='sent'){notice.sentAt=this.arena.now();notice.evidence=input.evidence==='user-message'?'user-message':'host-receipt';delete notice.error}
   else if(errors[input.error])notice.error=errors[input.error];else delete notice.error;
   notice.nextCheckAt=input.status==='sending'?0:this.arena.now()+this.retryMs;
  });
  return {ok:true};
 }
}
