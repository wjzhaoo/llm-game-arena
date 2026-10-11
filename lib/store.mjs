import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import upstream from '../vendor/task-dispatch/storage.cjs';

// Preserve every legacy record while retiring its authority. The journal marker
// makes the migration atomic and idempotent; completed judge history is untouched.
function migratePlayersOnly(state) {
 let changed=false;
 const at=new Date().toISOString();
 for(const match of Object.values(state.matches)) {
  if(match.participantPolicy==='players-only-v1')continue;
  match.adminTasks??=[];match.paused??=false;
  if(match.bindings?.judge){match.bindings.judge.revokedAt??=at;match.bindings.judge.revocationReason='independent-judge-removed';match.bindings.judge.armed=false}
  if(match.invites?.judge){match.invites.judge.revokedAt??=at;match.invites.judge.revocationReason='independent-judge-removed'}
  for(const job of match.jobs||[])if(job.seat==='judge'&&job.status==='open'){
   const id=`legacy-judge:${job.taskId}`;
   if(!match.adminTasks.some(task=>task.id===id))match.adminTasks.push({id,kind:'legacy_judge',status:'pending',createdAt:at,sourceTask:job.taskId,...(job.targetTask?{targetTask:job.targetTask}:{})});
   job.legacyStatus=job.status;job.status='converted';job.convertedToAdminTask=id;job.convertedAt=at;
  }
  match.participantPolicy='players-only-v1';changed=true;
 }
 return changed;
}

export class Store {
 constructor(root){
  this.root=path.resolve(root);fs.mkdirSync(this.root,{recursive:true,mode:0o700});this.file=path.join(this.root,'state.json');this.lock=path.join(this.root,'service.lock');this.owner=randomUUID();fs.writeFileSync(this.lock,JSON.stringify({pid:process.pid,owner:this.owner}),{flag:'wx',mode:0o600});
  try{this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,matches:{},revision:0};if(this.state.version!==1)throw Error('Unsupported data version');const changed=migratePlayersOnly(this.state),chessChanged=migrateChess(this.state);if(migrateParticipants(this.state)||changed||chessChanged){this.state.revision++;upstream.atomic(this.file,this.state)}}catch(e){this.close();throw e}
 }
 change(fn){const next=structuredClone(this.state),result=fn(next);next.revision++;upstream.atomic(this.file,next);this.state=next;return result}
 close(){if(fs.existsSync(this.lock)&&JSON.parse(fs.readFileSync(this.lock,'utf8')).owner===this.owner)fs.unlinkSync(this.lock)}
}

function migrateChess(state) {
 let changed=false;
 for(const m of Object.values(state.matches)){
  if(m.kind==='werewolf'||m.chessInteractionPolicy==='v1')continue;
  m.boardRevision??=0;m.undoStack??=[];m.undoRequested??={};m.lastEmoteAt??={};
  for(const j of m.jobs||[]){
   j.kind??='move';
   if(j.status==='open'&&j.phase===`ply:${m.game.ply}`)j.phase=`ply:${m.game.ply}:revision:${m.boardRevision}`;
  }
  m.chessInteractionPolicy='v1';changed=true;
 }
 return changed;
}

function migrateParticipants(state) {
 let changed=false;
 for(const m of Object.values(state.matches)){
  const seats=m.kind==='werewolf'?['p1','p2','p3','p4','p5','p6']:['red','black'];
  if(!m.participantTypes){m.participantTypes={};changed=true}
  for(const seat of seats){
   if(!m.participantTypes[seat]){m.participantTypes[seat]='ai';changed=true}
   const b=m.bindings[seat];
   if(b&&!b.type){b.type='ai';changed=true}
   if(b?.wake&&!b.wake.transport){b.wake.transport='local';changed=true}
  }
 }
 return changed;
}
