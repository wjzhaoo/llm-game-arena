import {initialXiangqi} from './xiangqi.mjs';
import {initialBlind} from './blind.mjs';
import {initialWerewolf} from './werewolf.mjs';
import {initialGroupchat} from './groupchat.mjs';
import {isParty,initialParty} from './party.mjs';
export {nickname} from './participants.mjs';

export function initialGame(kind,options={}) {
 if(isParty(kind))return initialParty(kind,options);
 const factory={xiangqi:initialXiangqi,blind:initialBlind,werewolf:initialWerewolf,groupchat:initialGroupchat}[kind];
 if(!factory)throw Error('Invalid game');
 return factory(options);
}

export function runSummary(m) {
 return {runId:m.runId,runNumber:m.runNumber,createdAt:m.runCreatedAt||m.createdAt,
  topic:m.kind==='groupchat'?m.game.topic:null,status:m.game.status,started:m.started,archived:!!m.archived};
}

// Only terminal jobs can resolve a fault automatically; a live invalid attempt
// still retains its original deadline and bounded retry budget.
export function settleAdminTasks(m,at=new Date().toISOString()) {
 let changed=false;
 for(const task of m.adminTasks||[]) {
  if(task.status!=='pending')continue;
  const job=(m.jobs||[]).find(j=>j.taskId===task.targetTask);
  const resolution=job?.status==='submitted'?'已重新提交并通过校验':job?.status==='timedout'?'规则引擎已按固定规则处理':job?.status==='cancelled'||m.game.status==='finished'?'任务已结束或取消':null;
  if(!resolution)continue;
  task.status=['submitted','timedout'].includes(job?.status)?'resolved':'closed';
  task.resolution=resolution;task.resolvedAt=at;changed=true;
 }
 return changed;
}

export function migrateRuns(state) {
 let changed=false;
 for(const m of Object.values(state.matches)) {
  if(!m.runId){m.runId=m.id;m.runNumber=1;m.runCreatedAt=m.createdAt;changed=true}
  if(!m.archivedRuns){m.archivedRuns=[];changed=true}
  if(!m.participantNames){m.participantNames=Object.fromEntries(Object.entries(m.bindings||{}).filter(([,b])=>b.nickname).map(([seat,b])=>[seat,b.nickname]));changed=true}
  for(const task of m.adminTasks||[]){
   const job=(m.jobs||[]).find(j=>j.taskId===task.targetTask);if(!job)continue;
   if(task.kind==='invalid_action'&&!task.details){
    const attempts=[job.attemptId,...(job.priorAttempts||[]).map(a=>a.attemptId)].filter(Boolean);
    const details=[...new Set(Object.entries(m.rejections||{}).filter(([key])=>attempts.some(attempt=>key.startsWith(attempt))).map(([,rejection])=>rejection.details).filter(Boolean))];
    if(details.length){task.details=m.kind==='werewolf'?'行动不符合当前身份或阶段':details.join('；');changed=true}
   }
   if(task.status==='resolved'&&!task.resolution&&['submitted','timedout'].includes(job.status)){task.resolution=job.status==='submitted'?'已重新提交并通过校验':'规则引擎已按固定规则处理';changed=true}
  }
  if(settleAdminTasks(m))changed=true;
 }
 return changed;
}
