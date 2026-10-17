import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isUtf8} from 'node:buffer';
import {isDeepStrictEqual} from 'node:util';
import upstream from '../vendor/task-dispatch/storage.cjs';
import {migrateRuns} from './runs.mjs';
import {lockMessage} from './service-lock.mjs';

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
 constructor(root,{io=fs}={}){
  this.io=io;this.root=path.resolve(root);io.mkdirSync(this.root,{recursive:true,mode:0o700});
  this.file=path.join(this.root,'state.json');this.journal=path.join(this.root,'transaction.json');this.backup=path.join(this.root,'state.v1.backup.json');
  this.lock=path.join(this.root,'service.lock');this.owner=randomUUID();
  try{io.writeFileSync(this.lock,JSON.stringify({pid:process.pid,owner:this.owner}),{flag:'wx',mode:0o600})}catch(error){if(error.code==='EEXIST')throw Error(lockMessage(this.lock));throw error}
  try{
   this.recover();
   const hasMetadata=this.plain(this.file),metadata=hasMetadata?this.read(this.file):null;
   if(hasMetadata)validateMetadata(metadata);
   const matches=this.readRooms();
   if(!hasMetadata){
    if(Object.keys(matches).length)throw Error('缺少 state.json，已有房间文件不会被覆盖');
    this.state={version:2,revision:0,matches:{}};this.atomic(this.file,{version:2,revision:0});
   }else if(metadata.version===1){
    if(Object.keys(matches).length)throw Error('旧存档与分文件存档同时存在，请先核实数据目录');
    validateMatches(metadata.matches);this.backupLegacy();
    const before={version:2,revision:metadata.revision??0,matches:{}};
    const next={version:2,revision:before.revision+1,matches:metadata.matches};
    migrate(next);this.commit(before,next);this.state=next;
   }else{
    this.state={...metadata,matches};
    const next=structuredClone(this.state);
    if(migrate(next)){next.revision++;this.commit(this.state,next);this.state=next}
   }
  }catch(error){this.close();throw error}
 }
 // Never follow a room-directory junction or a file symlink outside the data root.
 plain(file,directory=false){
  let stat;try{stat=this.io.lstatSync(file)}catch(error){if(error.code==='ENOENT')return false;throw error}
  if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile()))throw Error('存档路径必须是普通'+(directory?'目录':'文件')+'：'+file);
  return true;
 }
 read(file){
  this.plain(file);
  try{
   const raw=this.io.readFileSync(file);
   if(!isUtf8(raw))throw Error('存档必须使用有效的 UTF-8 编码');
   return JSON.parse(raw.toString('utf8'));
  }catch(error){throw Error('存档 JSON 无法读取：'+file,{cause:error})}
 }
 atomic(file,value){
  this.plain(file);
  // The legacy backup keeps the exact bytes, including its original formatting.
  const io=Buffer.isBuffer(value)?{...this.io,writeFileSync:fd=>this.io.writeFileSync(fd,value)}:this.io;
  upstream.atomic(file,Buffer.isBuffer(value)?null:value,{io});
 }
 roomFile(kind,id){
  validateLocation(kind,id);
  const directory=path.join(this.root,kind);this.plain(directory,true);
  const file=path.join(directory,id+'.json');this.plain(file);return file;
 }
 readRooms(){
  const matches={};
  for(const kind of gameKinds){
   const directory=path.join(this.root,kind);if(!this.plain(directory,true))continue;
   for(const name of this.io.readdirSync(directory).sort()){
    if(!name.endsWith('.json'))continue;
    const id=name.slice(0,-5),file=this.roomFile(kind,id),match=this.read(file);
    try{validateRoom(match,id,kind)}catch(error){throw Error('房间存档无效：'+file,{cause:error})}
    if(Object.hasOwn(matches,id))throw Error('房间 ID 重复：'+id);
    matches[id]=match;
   }
  }
  return matches;
 }
 backupLegacy(){
  const raw=this.io.readFileSync(this.file);
  if(this.plain(this.backup)){
   if(!raw.equals(this.io.readFileSync(this.backup)))throw Error('旧存档备份已存在且内容不同，不会覆盖：'+this.backup);
  }else this.atomic(this.backup,raw);
 }
 recover(){
  if(!this.plain(this.journal))return;
  const transaction=this.read(this.journal);validateTransaction(transaction);
  const metadata=this.read(this.file);validateMetadata(metadata);
  const revision=metadata.revision??0;
  if(revision!==transaction.baseRevision&&!(metadata.version===2&&revision===transaction.revision))throw Error('事务日志与存档修订号不匹配，保留原文件');
  this.apply(transaction);
 }
 apply(transaction){
  // Replay is idempotent. Metadata advances last; the journal stays until every
  // replacement/deletion succeeds, so a partial commit cannot be loaded as final.
  for(const match of transaction.upserts){
   const file=this.roomFile(match.kind,match.id);
   this.io.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});this.atomic(file,match);
  }
  for(const {kind,id} of transaction.deletes){
   const file=this.roomFile(kind,id);
   try{this.io.unlinkSync(file)}catch(error){if(error.code!=='ENOENT')throw error}
  }
  this.atomic(this.file,{version:2,revision:transaction.revision});
  this.io.unlinkSync(this.journal);
 }
 commit(before,next){
  validateMatches(next.matches);
  const upserts=Object.values(next.matches).filter(match=>!isDeepStrictEqual(match,before.matches[match.id]));
  const deletes=Object.values(before.matches).filter(match=>next.matches[match.id]?.kind!==match.kind).map(({id,kind})=>({id,kind}));
  const transaction={version:2,baseRevision:before.revision,revision:next.revision,upserts,deletes};
  validateTransaction(transaction);
  try{this.atomic(this.journal,transaction);this.apply(transaction)}catch(error){
   this.writeError=error;
   throw Object.assign(Error('存档写入失败，已阻止后续写入；请重启服务恢复：'+error.message,{cause:error}),{status:503});
  }
 }
 change(fn){
  if(this.closed)throw Error('存储已关闭');
  if(this.writeError||this.plain(this.journal))throw Object.assign(Error('存档有未完成的写入，请重启服务恢复'),{status:503});
  const next=structuredClone(this.state),result=fn(next);next.version=2;next.revision=this.state.revision+1;
  this.commit(this.state,next);this.state=next;return result;
 }
 close(){
  if(this.closed)return;
  try{if(JSON.parse(this.io.readFileSync(this.lock,'utf8')).owner===this.owner)this.io.unlinkSync(this.lock)}catch(error){if(error.code!=='ENOENT')throw error}
  this.closed=true;
 }
}

const gameKinds=['xiangqi','blind','werewolf','groupchat'];
const roomId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const revision=value=>Number.isSafeInteger(value)&&value>=0;

function validateLocation(kind,id){
 if(!gameKinds.includes(kind)||typeof id!=='string'||!roomId.test(id))throw Error('无效的游戏类型或房间 ID');
}
function validateRoom(match,id,kind){
 validateLocation(kind,id);
 if(!record(match)||match.id!==id||match.kind!==kind||!record(match.game)||typeof match.game.status!=='string'||!record(match.bindings)||!record(match.invites)||!record(match.receipts)||!['jobs','events','history'].every(key=>Array.isArray(match[key]))||kind==='groupchat'&&!Array.isArray(match.game.members))throw Error('房间数据与路径不匹配或字段缺失');
}
function validateMatches(matches){
 if(!record(matches))throw Error('存档缺少房间数据');
 for(const [id,match] of Object.entries(matches))validateRoom(match,id,match?.kind);
}
function validateMetadata(metadata){
 if(!record(metadata)||![1,2].includes(metadata.version))throw Error('Unsupported data version');
 if(!revision(metadata.revision??(metadata.version===1?0:NaN)))throw Error('存档修订号无效');
 const keys=metadata.version===1?['version','revision','matches']:['version','revision'];
 if(Object.keys(metadata).some(key=>!keys.includes(key))||metadata.version===1&&!record(metadata.matches))throw Error('存档元数据无效');
}
function validateTransaction(transaction){
 if(!record(transaction)||transaction.version!==2||!revision(transaction.baseRevision)||!revision(transaction.revision)||transaction.revision!==transaction.baseRevision+1||!Array.isArray(transaction.upserts)||!Array.isArray(transaction.deletes))throw Error('事务日志无效');
 const ids=new Set(),locations=new Set();
 for(const match of transaction.upserts){
  validateRoom(match,match?.id,match?.kind);
  if(ids.has(match.id))throw Error('事务日志包含重复房间');
  ids.add(match.id);locations.add(match.kind+'/'+match.id);
 }
 for(const item of transaction.deletes){
  validateLocation(item?.kind,item?.id);const location=item.kind+'/'+item.id;
  if(locations.has(location))throw Error('事务日志包含冲突路径');
  locations.add(location);
 }
}
function migrate(state){
 return [migratePlayersOnly(state),migrateChess(state),migrateParticipants(state),migrateRuns(state)].some(Boolean);
}

function migrateChess(state) {
 let changed=false;
 for(const m of Object.values(state.matches)){
  if(!['xiangqi','blind'].includes(m.kind)||m.chessInteractionPolicy==='v1')continue;
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
  const seats=m.kind==='groupchat'?m.game.members.filter(p=>!p.removed).map(p=>p.id):m.kind==='werewolf'?['p1','p2','p3','p4','p5','p6']:['red','black'];
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
