import {randomUUID} from 'node:crypto';
import {bounded,hasMarker,markerFor} from './wake/common.mjs';
import {checkHostInfo} from './wake/host.mjs';

// Exported separately so tests can use isolated hosts and a real HTTP coordinator.
export class RelayWorker {
 constructor({config,adapter,request,script,instanceId=randomUUID(),now=Date.now,readTimeoutMs=15000,sendTimeoutMs=35000}){
  Object.assign(this,{config,adapter,request,script,instanceId,now,readTimeoutMs,sendTimeoutMs});this.stopped=false;
 }
 prompt(notification){
  const command='node '+JSON.stringify(this.script)+' resume --credential '+JSON.stringify(this.config.credentialPath);
  if(notification.completion)return '['+markerFor(notification.attemptId)+']\n弈境本场比赛已结束。请运行 '+command+' 核实 completed:true，然后结束参与。';
  return '['+markerFor(notification.attemptId)+']\n弈境有你的待领取任务。请在原会话工作区运行：\n'+command+'\n仅根据自己 job.view 和 actionSchema 决定行动。棋类 job.interactions 列出表情、认输和申请悔棋的命令；kind=undo-response 时只确认同意或拒绝，不能提交棋步。旧任务失效时重新 resume。将行动 JSON 保存到工作区 tmp（UTF-8 无 BOM），用 client.mjs submit 携带本次 taskId 和 attemptId 回传，然后继续 resume。parked:true 时结束当前回合等待唤醒；completed:true 时结束参与。不要代替他人操作、转发通知、修改项目或公开私有信息。通知送达不代表任务已完成。';
 }
 async step(){
  const out=await this.request({action:'poll',instanceId:this.instanceId});
  if(out.stop){this.stopped=true;return out}
  const n=out.notification;if(!n)return out;
  const validUntil=this.now()+n.validForMs;
  const envelope={instanceId:this.instanceId,attemptId:n.attemptId,leaseId:n.leaseId};
  const report=(status,error,evidence)=>this.request({...envelope,action:'report',status,error,evidence});
  let info;
  try{info=await bounded(()=>this.adapter.read(this.config),this.readTimeoutMs);checkHostInfo(this.config,info,{requireWorkspace:true})}
  catch{return report(['sending','uncertain'].includes(n.status)?'uncertain':'pending','host_unavailable')}
  if(hasMarker(info,n.marker))return report('sent',null,'user-message');
  if(['sending','uncertain'].includes(n.status))return report('uncertain','delivery_uncertain');
  if(info.status!=='idle')return report('pending',info.status==='active'?'busy':'unknown');
  await report('sending');
  await this.request({...envelope,action:'check'});
  try{
   const result=await bounded(()=>this.adapter.send({...this.config,canSend:()=>!this.stopped&&this.now()<validUntil},this.prompt(n),n.marker),this.sendTimeoutMs);
   if(result?.delivered!==true)throw Error('Delivery unconfirmed');
   return report('sent',null,result.evidence);
  }catch(error){
   if(error.status)throw error;
   return report(error.safeToRetry===true?'pending':'uncertain',error.safeToRetry===true?'rejected':'delivery_uncertain');
  }
 }
 stop(){this.stopped=true}
}
