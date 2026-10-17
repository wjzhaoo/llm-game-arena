import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../lib/store.mjs';
import {Arena} from '../lib/arena.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

const kinds=['xiangqi','blind','werewolf','groupchat'];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const roomFile=(root,match)=>path.join(root,match.kind,match.id+'.json');
function directory(t){const root=temporaryDirectory('arena-storage-');t.after(()=>removeTemporaryDirectory(root));return root}
function fixture(t,options){
 const root=directory(t),f={root,store:new Store(root,options)};
 f.a=new Arena(f.store,{now:()=>10000,chatPick:()=>0});
 t.after(()=>f.store.close());
 f.restart=()=>{f.store.close();f.store=new Store(root);f.a=new Arena(f.store,{now:()=>10000,chatPick:()=>0})};
 return f;
}
function create(a,kind='xiangqi'){return a.create({kind,title:'中文房间 / 测试',topic:'中文讨论话题'}).id}
function connectAll(a,id){
 const m=a.get(id),seats=m.kind==='groupchat'?Array.from({length:2},(_,i)=>a.chatMembers(id,{action:'add-ai',nickname:'成员'+i,profile:{personality:'独立性格',initialOpinion:'初始观点'}}).seat):a.seats(m);
 return seats.map(seat=>{
  const inv=a.invite(id,seat,'http://127.0.0.1:4318','中文选手'),c=a.connect({match:id,seat,invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1],provider:'simulated',session:id+'-'+seat});
  return {token:c.token,identity:a.identity(c.token)};
 });
}
function submit(a,identity,result){const {job}=a.claim(identity);assert.ok(job);return a.submit(identity,{...job,result})}
function legacy(t,{all=false,oldPolicies=false}={}){
 const source=fixture(t),tokens=[];
 for(const kind of all?kinds:['xiangqi']){
  const id=create(source.a,kind),connections=connectAll(source.a,id);tokens.push(...connections);source.a.start(id);
  if(kind==='groupchat'){
   submit(source.a,connections[0].identity,{score:90});submit(source.a,connections[1].identity,{score:0});submit(source.a,connections[0].identity,{type:'speak',text:'需要永久保留的中文消息'});
  }else if(kind==='xiangqi')submit(source.a,connections[0].identity,{from:[0,6],to:[0,5]});
  source.a.restart(id,{expectedRunId:source.a.get(id).runId,topic:'新话题'});source.a.start(id);
 }
 const state=structuredClone(source.store.state);state.version=1;
 if(oldPolicies)for(const match of Object.values(state.matches))for(const key of ['participantPolicy','participantTypes','runId','runNumber','runCreatedAt','participantNames','chessInteractionPolicy'])delete match[key];
 const raw=Buffer.from(JSON.stringify(state,null,1)+'\r\n','utf8'),root=directory(t);fs.writeFileSync(path.join(root,'state.json'),raw);
 return {root,raw,state,tokens};
}
function faultIO(){
 const fault={rename:null,unlink:null,writes:[]};
 const io={...fs,
  renameSync(from,to){if(fault.rename?.(to))throw Object.assign(Error('模拟磁盘替换失败'),{code:'EIO'});fault.writes.push(to);fs.renameSync(from,to)},
  unlinkSync(file){if(fault.unlink?.(file))throw Object.assign(Error('模拟磁盘删除失败'),{code:'EIO'});fs.unlinkSync(file)},
 };
 return {io,fault};
}

test('New stores use small version-2 metadata and reopen without changing files',t=>{
 const f=fixture(t);assert.deepEqual(read(f.store.file),{version:2,revision:0});
 const bytes=fs.readFileSync(f.store.file);f.restart();assert.deepEqual(fs.readFileSync(f.store.file),bytes);
 assert.deepEqual(f.store.state,{version:2,revision:0,matches:{}});assert.equal(fs.existsSync(f.store.backup),false);assert.equal(fs.existsSync(f.store.journal),false);
});

test('All four game types and multiple rooms persist independently with UTF-8 names and full state',t=>{
 const f=fixture(t);
 for(const kind of kinds)for(let n=0;n<2;n++)create(f.a,kind);
 const expected=structuredClone(f.store.state);
 for(const match of Object.values(expected.matches)){
  const file=roomFile(f.root,match),raw=fs.readFileSync(file);assert.deepEqual(read(file),match);
  assert.equal(raw.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])),false);assert.ok(raw.toString('utf8').includes('中文房间 / 测试'));assert.ok(!raw.toString('utf8').includes('\ufffd'));
 }
 assert.deepEqual(Object.keys(read(f.store.file)),['version','revision']);f.restart();assert.deepEqual(f.store.state,expected);
});

test('Changing one room writes only its own file; callback and validation failures change nothing',t=>{
 const {io,fault}=faultIO(),f=fixture(t,{io}),first=create(f.a),second=create(f.a),other=create(f.a,'werewolf');
 fault.writes=[];const before=structuredClone(f.store.state),untouched=[second,other].map(id=>roomFile(f.root,f.a.get(id)));
 f.store.change(s=>{s.matches[first].title='仅修改本房间'});
 assert.ok(fault.writes.includes(roomFile(f.root,f.a.get(first))));for(const file of untouched)assert.ok(!fault.writes.includes(file));
 assert.deepEqual(f.a.get(second),before.matches[second]);assert.deepEqual(f.a.get(other),before.matches[other]);
 const saved=structuredClone(f.store.state);fault.writes=[];
 assert.throws(()=>f.store.change(s=>{s.matches[first].title='不会保存';throw Error('业务失败')}),/业务失败/);
 assert.throws(()=>f.store.change(s=>{s.matches[first].kind='../escape'}),/无效/);
 assert.deepEqual(f.store.state,saved);assert.deepEqual(fault.writes,[]);assert.equal(fs.existsSync(f.store.journal),false);
});

test('Deleting a room removes its file and all archived runs permanently across restarts',t=>{
 const f=fixture(t),id=create(f.a),other=create(f.a,'groupchat');connectAll(f.a,id);f.a.start(id);f.a.restart(id,{expectedRunId:f.a.get(id).runId});
 assert.equal(f.a.get(id).archivedRuns.length,1);const file=roomFile(f.root,f.a.get(id));
 f.a.delete(id,{expectedRunId:f.a.get(id).runId});assert.equal(fs.existsSync(file),false);f.restart();assert.equal(f.store.state.matches[id],undefined);assert.ok(f.a.get(other));
});

test('Version-1 migration backs up original bytes and preserves all games, history, credentials and receipts',t=>{
 const old=legacy(t,{all:true}),store=new Store(old.root);t.after(()=>store.close());const a=new Arena(store);
 assert.deepEqual(store.state.matches,old.state.matches);assert.equal(store.state.version,2);assert.equal(store.state.revision,old.state.revision+1);
 assert.deepEqual(fs.readFileSync(store.backup),old.raw);assert.deepEqual(read(store.file),{version:2,revision:store.state.revision});
 for(const match of Object.values(old.state.matches))assert.deepEqual(read(roomFile(old.root,match)),match);
 for(const c of old.tokens)assert.deepEqual(a.identity(c.token),c.identity);
 const chat=Object.values(store.state.matches).find(m=>m.kind==='groupchat');assert.equal(a.messages(chat.id,{runId:chat.archivedRuns[0].runId}).messages[0].text,'需要永久保留的中文消息');
 const chess=Object.values(store.state.matches).find(m=>m.kind==='xiangqi');assert.ok(Object.keys(chess.archivedRuns[0].receipts).length>0);
 const snapshot=structuredClone(store.state),backupTime=fs.statSync(store.backup).mtimeMs;store.close();const again=new Store(old.root);again.close();assert.deepEqual(again.state,snapshot);assert.deepEqual(fs.readFileSync(store.backup),old.raw);assert.equal(fs.statSync(store.backup).mtimeMs,backupTime);
});

test('Legacy storage migration still upgrades older participant, chess and run policies',t=>{
 const old=legacy(t,{oldPolicies:true}),store=new Store(old.root);t.after(()=>store.close());
 for(const match of Object.values(store.state.matches)){
  assert.equal(match.participantPolicy,'players-only-v1');assert.equal(match.chessInteractionPolicy,'v1');assert.equal(match.runId,match.id);assert.equal(match.participantTypes.red,'ai');
  assert.deepEqual(match.history,old.state.matches[match.id].history);assert.deepEqual(match.bindings,old.state.matches[match.id].bindings);
 }
 assert.deepEqual(fs.readFileSync(store.backup),old.raw);
});

for(const same of [true,false])test('An existing legacy backup is '+(same?'reused without rewriting':'never overwritten by another snapshot'),t=>{
 const old=legacy(t),backup=path.join(old.root,'state.v1.backup.json'),bytes=same?old.raw:Buffer.from('另一份原始备份');fs.writeFileSync(backup,bytes);const time=fs.statSync(backup).mtimeMs;
 if(same){const store=new Store(old.root);store.close();assert.equal(fs.statSync(backup).mtimeMs,time)}
 else{assert.throws(()=>new Store(old.root),/备份已存在且内容不同/);assert.deepEqual(fs.readFileSync(path.join(old.root,'state.json')),old.raw);assert.equal(fs.existsSync(path.join(old.root,'service.lock')),false)}
 assert.deepEqual(fs.readFileSync(backup),bytes);
});

test('A failed backup replacement leaves the legacy source intact and can be retried',t=>{
 const old=legacy(t),{io,fault}=faultIO();fault.rename=file=>file===path.join(old.root,'state.v1.backup.json');
 assert.throws(()=>new Store(old.root,{io}),/模拟磁盘/);assert.deepEqual(fs.readFileSync(path.join(old.root,'state.json')),old.raw);assert.equal(fs.existsSync(path.join(old.root,'transaction.json')),false);
 const store=new Store(old.root);store.close();assert.deepEqual(fs.readFileSync(store.backup),old.raw);assert.deepEqual(store.state.matches,old.state.matches);
});

test('Interrupted legacy migration replays before scanning partially written rooms',t=>{
 const old=legacy(t,{all:true}),{io,fault}=faultIO(),matches=Object.values(old.state.matches);fault.rename=file=>file===roomFile(old.root,matches[1]);
 assert.throws(()=>new Store(old.root,{io}),/存档写入失败/);assert.deepEqual(fs.readFileSync(path.join(old.root,'state.json')),old.raw);assert.ok(fs.existsSync(roomFile(old.root,matches[0])));assert.ok(fs.existsSync(path.join(old.root,'transaction.json')));
 const store=new Store(old.root);store.close();assert.deepEqual(store.state.matches,old.state.matches);assert.deepEqual(fs.readFileSync(store.backup),old.raw);assert.equal(fs.existsSync(store.journal),false);
});

for(const phase of ['journal','room','metadata','cleanup'])test('Write failure at '+phase+' blocks later writes and recovers a consistent revision',t=>{
 const {io,fault}=faultIO(),f=fixture(t,{io}),first=create(f.a),second=create(f.a,'groupchat'),before=structuredClone(f.store.state),expected=structuredClone(before);
 expected.matches[first].title='事务内更新一';expected.matches[second].title='事务内更新二';expected.revision++;
 const target={journal:f.store.journal,room:roomFile(f.root,f.a.get(second)),metadata:f.store.file}[phase];
 if(phase==='cleanup')fault.unlink=file=>file===f.store.journal;else fault.rename=file=>file===target;
 assert.throws(()=>f.store.change(s=>{s.matches[first].title='事务内更新一';s.matches[second].title='事务内更新二'}),/存档写入失败/);
 assert.deepEqual(f.store.state,before);assert.throws(()=>f.store.change(()=>{}),/重启服务恢复/);assert.equal(fs.existsSync(f.store.journal),phase!=='journal');
 f.restart();assert.deepEqual(f.store.state,phase==='journal'?before:expected);assert.equal(fs.existsSync(f.store.journal),false);
 const recovered=structuredClone(f.store.state);f.restart();assert.deepEqual(f.store.state,recovered);
});

for(const phase of ['delete','metadata'])test('An interrupted delete at '+phase+' replays without resurrecting the room',t=>{
 const {io,fault}=faultIO(),f=fixture(t,{io}),deleted=create(f.a),kept=create(f.a,'werewolf'),file=roomFile(f.root,f.a.get(deleted));
 if(phase==='delete')fault.unlink=target=>target===file;else fault.rename=target=>target===f.store.file;
 assert.throws(()=>f.store.change(s=>{delete s.matches[deleted];s.matches[kept].title='同时保留的更新'}),/存档写入失败/);
 assert.ok(fs.existsSync(f.store.journal));assert.equal(fs.existsSync(file),phase==='delete');f.restart();assert.equal(fs.existsSync(file),false);assert.equal(f.a.get(kept).title,'同时保留的更新');f.restart();assert.equal(f.store.state.matches[deleted],undefined);
});

test('Recovery itself can be interrupted and safely replayed again',t=>{
 const {io,fault}=faultIO(),f=fixture(t,{io}),id=create(f.a),file=roomFile(f.root,f.a.get(id));fault.rename=target=>target===f.store.file;
 assert.throws(()=>f.store.change(s=>{s.matches[id].title='重复恢复仍然一致'}),/存档写入失败/);f.store.close();
 fault.rename=target=>target===file;assert.throws(()=>new Store(f.root,{io}),/模拟磁盘/);assert.ok(fs.existsSync(f.store.journal));
 f.restart();assert.equal(f.a.get(id).title,'重复恢复仍然一致');assert.equal(fs.existsSync(f.store.journal),false);
});

for(const content of ['{broken','null','false','{"version":-1,"matches":{}}','{"version":2,"revision":-1}','{"version":2,"revision":0,"matches":{}}'])test('Invalid metadata is preserved instead of becoming an empty store: '+content,t=>{
 const root=directory(t),file=path.join(root,'state.json');fs.writeFileSync(file,content);
 assert.throws(()=>new Store(root),/JSON|Unsupported|无效/);assert.equal(fs.readFileSync(file,'utf8'),content);assert.equal(fs.existsSync(path.join(root,'service.lock')),false);
});

for(const problem of ['json','encoding','id','kind','fields','duplicate','missing-metadata'])test('Corrupt split storage is rejected without overwriting data: '+problem,t=>{
 const f=fixture(t),id=create(f.a),match=structuredClone(f.a.get(id)),file=roomFile(f.root,match);f.store.close();
 if(problem==='json')fs.writeFileSync(file,'{incomplete');
 if(problem==='encoding'){const raw=Buffer.from(JSON.stringify({...match,title:'BADENCODING'}));raw[raw.indexOf('BADENCODING')]=0xff;fs.writeFileSync(file,raw)}
 if(problem==='id')fs.writeFileSync(file,JSON.stringify({...match,id:randomUUID()}));
 if(problem==='kind')fs.writeFileSync(file,JSON.stringify({...match,kind:'blind'}));
 if(problem==='fields')fs.writeFileSync(file,JSON.stringify({id,kind:'xiangqi'}));
 if(problem==='duplicate'){fs.mkdirSync(path.join(f.root,'blind'));fs.writeFileSync(path.join(f.root,'blind',id+'.json'),JSON.stringify({...match,kind:'blind'}))}
 if(problem==='missing-metadata')fs.unlinkSync(f.store.file);
 const bytes=fs.readFileSync(file);assert.throws(()=>new Store(f.root),/JSON|无效|重复|缺少 state/);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(fs.existsSync(f.store.lock),false);
});

for(const problem of ['json','revision','path','duplicate'])test('Invalid transaction logs are rejected before any replay: '+problem,t=>{
 const f=fixture(t),id=create(f.a),match=structuredClone(f.a.get(id)),file=roomFile(f.root,match),before=fs.readFileSync(file),metadata=fs.readFileSync(f.store.file);f.store.close();
 match.title='不应写入';const tx={version:2,baseRevision:f.store.state.revision,revision:f.store.state.revision+1,upserts:[match],deletes:[]};
 if(problem==='revision'){tx.baseRevision+=10;tx.revision+=10}
 if(problem==='path')tx.deletes.push({kind:'../outside',id});
 if(problem==='duplicate')tx.upserts.push(match);
 const raw=problem==='json'?'{incomplete':JSON.stringify(tx);fs.writeFileSync(f.store.journal,raw);
 assert.throws(()=>new Store(f.root),/JSON|事务|无效/);assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(f.store.file),metadata);assert.equal(fs.readFileSync(f.store.journal,'utf8'),raw);assert.equal(fs.existsSync(f.store.lock),false);
});

test('Game directory junctions cannot redirect storage outside the data root',t=>{
 const f=fixture(t),destination=directory(t);f.store.close();
 fs.symlinkSync(destination,path.join(f.root,'xiangqi'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>new Store(f.root),/普通目录/);assert.deepEqual(fs.readdirSync(destination),[]);assert.equal(fs.existsSync(f.store.lock),false);
});
