import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Arena} from '../lib/arena.mjs';
import {ANIMALS,STATES,migratePresentation} from '../lib/presentation.mjs';
import {initialWerewolf} from '../lib/werewolf.mjs';
import {Store} from '../lib/store.mjs';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

class MemoryStore {
 state={matches:{}};
 change(fn){const next=structuredClone(this.state),result=fn(next);this.state=next;return result}
}
function fixture(kind,{human=false}={}) {
 const store=new MemoryStore(),clock={now:10000},a=new Arena(store,{now:()=>clock.now,chatPick:()=>0});
 const {id}=a.create({kind,topic:'表情与演技测试',playerCount:kind==='undercover'?4:kind==='spyfall'?3:kind==='liarsdice'?2:undefined,timeoutSeconds:10});
 if(kind==='groupchat')for(const nickname of ['甲','乙'])a.chatMembers(id,{action:'add-ai',nickname});
 const ids={};
 for(const seat of a.seats(a.get(id))){
  let c;
  if(human&&kind!=='groupchat'){
   a.setParticipantType(id,seat,'human');const invite=a.roomInvite(id,'http://localhost:4318');
   c=a.joinHuman({match:id,seat,nickname:seat,invitation:new URL(invite.url).hash.slice(6)});
  }else{
   const invite=a.invite(id,seat,'http://localhost:4318');
   c=a.connect({match:id,seat,provider:'simulated',session:kind+'-'+seat,invitation:invite.text.match(/--invitation ([a-f0-9]+)/)[1]});
  }
  ids[seat]=a.identity(c.token);
 }
 a.start(id);return {a,id,ids,clock,store};
}
function act(f,seat,action,state='平静') {
 const {job}=f.a.claim(f.ids[seat]);assert.ok(job);
 const payload={...job,result:{...action,state}},reply=f.a.submit(f.ids[seat],payload);
 assert.equal(reply.ok,true,JSON.stringify(reply));return {job,payload,reply};
}
function day(f){
 while(['wolf','seer','witch'].includes(f.a.get(f.id).game.phase)){
  const phase=f.a.get(f.id).game.phase;
  for(const seat of f.a.pending(f.a.get(f.id)))act(f,seat,phase==='wolf'?{type:'kill',target:null}:phase==='seer'?{type:'inspect',target:null}:{type:'witch',save:false,poison:null});
 }
}
const publicPerson=(f,seat)=>f.a.public(f.a.get(f.id)).participants.find(p=>p.seat===seat);
const firstAction={xiangqi:{from:[0,6],to:[0,5]},blind:{from:[0,6],to:[0,5]},undercover:{type:'describe',text:'先说一个抽象的特点。'},liarsdice:{type:'bid',quantity:2,face:2},codenames:{type:'clue',word:'嘀咕咕',count:1},spyfall:{type:'question',target:'p2',text:'这里通常忙吗？'},werewolf:{type:'speak',text:'我是诚实的小动物。'},groupchat:{type:'bid',score:100}};

for(const kind of Object.keys(firstAction))test(kind+' accepts a state, preserves rules, supplies model observations and keeps an exact receipt',()=>{
 const f=fixture(kind);if(kind==='werewolf')day(f);
 const seat=f.a.pending(f.a.get(f.id))[0],before=publicPerson(f,seat),{job,payload}=act(f,seat,firstAction[kind],'嚣张');
 assert.equal(job.stateProtocol,1);assert.equal(job.view.participants.length,f.a.seats(f.a.get(f.id)).length);
 assert.equal(job.view.stateCatalog.length,16);assert.ok(job.view.stateCatalog.every(s=>s.description&&s.label));
 assert.match(job.stateInstructions,/可以伪装/);assert.match(job.view.stateGuidance,/不是系统认证/);
 assert.ok(JSON.stringify(job.actionSchema).includes('嚣张'));
 if(kind==='groupchat'){
  assert.equal(publicPerson(f,seat).state,'平静');for(const other of f.a.pending(f.a.get(f.id)))act(f,other,{type:'bid',score:0});
 }
 assert.equal(publicPerson(f,seat).state,'嚣张');assert.equal(publicPerson(f,seat).animalId,before.animalId);
 const sequence=f.a.get(f.id).sequence;
 assert.equal(f.a.submit(f.ids[seat],payload).duplicate,true);assert.equal(f.a.get(f.id).sequence,sequence);
 assert.throws(()=>f.a.submit(f.ids[seat],{...payload,result:{...payload.result,state:'真诚'}}),/Conflicting/);
 const context=f.a.modelStatus(f.ids[seat]);
 assert.equal(context.game.participants.find(p=>p.seat===seat).state,'嚣张');
 assert.ok(context.game.recentStateChanges.some(c=>c.seat===seat&&c.state==='嚣张'));
});

test('new tasks require exact fixed states; invalid moves, invalid choices and missing choices never update presentation',()=>{
 const f=fixture('xiangqi',{human:true}),{job}=f.a.claim(f.ids.red),sequence=f.a.get(f.id).sequence;
 for(const result of [{...firstAction.xiangqi},{...firstAction.xiangqi,state:'自定义'}, {...firstAction.xiangqi,state:{label:'真诚'}},{from:[0,6],to:[0,3],state:'愤怒'}]){
  assert.equal(f.a.submit(f.ids.red,{...job,result}).ok,false);assert.equal(publicPerson(f,'red').state,'平静');
 }
 assert.equal(f.a.get(f.id).game.ply,0);assert.equal(f.a.get(f.id).sequence,sequence);assert.equal(f.a.get(f.id).jobs[0].invalid,0);
 assert.equal(f.a.submit(f.ids.red,{...job,result:{...firstAction.xiangqi,state:'真诚',description:'请相信我'}}).ok,false);
});

test('night choices are private to their owner and administrator, even at dawn and after reconnect',()=>{
 const f=fixture('werewolf');
 f.store.change(s=>{s.matches[f.id].game=initialWerewolf({roles:['wolf','wolf','seer','witch','villager','villager']});f.a.sync(s.matches[f.id])});
 const sequence=f.a.get(f.id).sequence;
 act(f,'p1',{type:'kill',target:null},'狡黠');
 assert.equal(f.a.get(f.id).sequence,sequence);assert.equal(publicPerson(f,'p1').state,'平静');
 assert.equal(f.a.view(f.a.get(f.id),'p1').ownPresentation.privateState,'狡黠');
 assert.ok(!JSON.stringify(f.a.view(f.a.get(f.id),'p2')).includes('"privateState":"狡黠"'));
 assert.equal(f.a.public(f.a.get(f.id),true).game.privatePresentation.night.p1,'狡黠');
 assert.ok(!JSON.stringify(f.a.public(f.a.get(f.id))).includes('"state":"狡黠"'));
 act(f,'p2',{type:'kill',target:null},'嚣张');act(f,'p3',{type:'inspect',target:null},'思考');act(f,'p4',{type:'witch',save:false,poison:null},'无辜');
 assert.equal(f.a.get(f.id).game.phase,'discuss');assert.equal(publicPerson(f,'p1').state,'平静');
 assert.ok(!f.a.get(f.id).events.some(e=>e.changes?.some(c=>['狡黠','嚣张','思考','无辜'].includes(c.state))));
 act(f,'p1',{type:'speak',text:'先听大家说。'},'真诚');assert.equal(publicPerson(f,'p1').state,'真诚');
 assert.equal(f.a.view(f.a.get(f.id),'p1').ownPresentation.privateState,null);
});

test('the final public discussion still records speech and appearance when it advances into a sealed vote',()=>{
 const f=fixture('werewolf');day(f);
 for(const seat of f.a.pending(f.a.get(f.id)))act(f,seat,{type:'speak',text:'公开发言 '+seat},'真诚');
 assert.equal(f.a.get(f.id).game.phase,'vote');
 const speeches=f.a.get(f.id).events.filter(e=>e.type==='action'&&e.speech);
 assert.equal(speeches.length,6);assert.ok(speeches.every(e=>e.eventPeople.find(p=>p.seat===e.seat).state==='真诚'));
});

test('undo confirmation records the chosen state with the public confirmation event',()=>{
 const f=fixture('xiangqi');act(f,'red',firstAction.xiangqi,'得意');
 f.a.requestUndo(f.ids.red,{boardRevision:1});const request=f.a.get(f.id).undoRequest;
 act(f,'black',{type:'undo-response',requestId:request.id,accept:true},'委屈');
 const confirmation=f.a.get(f.id).events.find(e=>e.type==='undo-accepted');
 assert.equal(confirmation.eventPeople.find(p=>p.seat==='black').state,'委屈');assert.equal(f.a.get(f.id).game.ply,0);
});

for(const kind of ['undercover','spyfall','werewolf','groupchat'])test(kind+' seals states and actor identity until one atomic public resolution',()=>{
 const f=fixture(kind);if(kind==='werewolf')day(f);
 while(!['vote','bid'].includes(f.a.get(f.id).game.phase)){
  const g=f.a.get(f.id).game;
  for(const seat of f.a.pending(f.a.get(f.id))){
   if(kind==='werewolf')act(f,seat,{type:'speak',text:'公开讨论。'});
   else if(kind==='undercover')act(f,seat,{type:'describe',text:'先说一个抽象的特点。'});
   else act(f,seat,g.phase==='question'?{type:'question',target:seat==='p1'?'p2':'p1',text:'你怎么看？'}:{type:'answer',text:'我觉得挺好。'});
  }
 }
 const m=f.a.get(f.id),pending=f.a.pending(m),sequence=m.sequence,first=pending[0];
 act(f,first,kind==='groupchat'?{type:'bid',score:100}:{type:'vote',target:null},'无辜');
 const view=f.a.public(f.a.get(f.id));assert.equal(view.sequence,sequence);assert.equal(publicPerson(f,first).state,'平静');assert.equal(view.game.pendingSeats,undefined);
 assert.equal(f.a.view(f.a.get(f.id),first).ownPresentation.sealedState,'无辜');
 for(const seat of pending.slice(1))act(f,seat,kind==='groupchat'?{type:'bid',score:0}:{type:'vote',target:null},'紧张');
 assert.equal(publicPerson(f,first).state,'无辜');
 const changes=f.a.get(f.id).events.slice(sequence).filter(e=>e.type==='participant-state');
 assert.equal(changes.length,1);assert.equal(changes[0].changes.length,pending.length);assert.equal(new Set(changes[0].changes.map(c=>c.at)).size,1);
});

test('timeouts release prior sealed states only with the public outcome, without a new reveal phase',()=>{
 const f=fixture('groupchat');act(f,'p1',{type:'bid',score:100},'挑衅');
 f.clock.now+=11000;f.a.tick();assert.equal(f.a.get(f.id).game.phase,'speak');assert.equal(publicPerson(f,'p1').state,'挑衅');
});

test('animal assignment is balanced, independent of roles, and adjustable only before start or paused',()=>{
 const f=fixture('groupchat');assert.throws(()=>f.a.setAppearance(f.id,'p1','fox'),/开局前/);
 f.a.pause(f.id);f.a.setAppearance(f.id,'p1','fox');assert.equal(publicPerson(f,'p1').animalId,'fox');f.a.resume(f.id);
 for(let i=0;i<24;i++)f.a.chatMembers(f.id,{action:'add-ai'});
 const animals=f.a.public(f.a.get(f.id)).participants.map(p=>p.animalId),counts=ANIMALS.map(a=>animals.filter(id=>id===a.id).length);
 assert.ok(Math.max(...counts)-Math.min(...counts)<=1);assert.equal(animals.length,26);
 assert.throws(()=>f.a.setAppearance(f.id,'p1','wolf'),/有效/);
 const turnover=fixture('groupchat');
 for(let i=0;i<10;i++)turnover.a.chatMembers(turnover.id,{action:'add-ai'});
 for(const seat of turnover.a.seats(turnover.a.get(turnover.id)).slice(2))turnover.a.revoke(turnover.id,seat);
 const joined=turnover.a.chatMembers(turnover.id,{action:'add-ai'}).seat;
 const live=turnover.a.public(turnover.a.get(turnover.id)).participants;
 assert.equal(new Set(live.map(p=>p.animalId)).size,live.length,'departed members do not cause duplicate active animals');
 assert.equal(live.find(p=>p.seat===joined).animalId,'fox');
});

test('restart keeps animals, resets states, retains receipt history and freezes archived appearances',()=>{
 const f=fixture('xiangqi');act(f,'red',firstAction.xiangqi,'得意');const old=f.a.get(f.id).runId,animal=publicPerson(f,'red').animalId;
 const history=structuredClone(f.a.get(f.id).history),event=history.find(e=>e.type==='action');
 f.a.restart(f.id,{expectedRunId:old});assert.equal(publicPerson(f,'red').animalId,animal);assert.equal(publicPerson(f,'red').state,'平静');
 f.a.setAppearance(f.id,'red','penguin');const archived=f.a.publicRun(f.id,old);
 assert.equal(archived.participants.find(p=>p.seat==='red').state,'得意');assert.equal(archived.participants.find(p=>p.seat==='red').animalId,animal);
 assert.deepEqual(archived.history.find(e=>e.type==='action').eventPeople,event.eventPeople);
 assert.match(f.a.exportRecords(f.id,{runId:old}).content,/得意/);
});

test('message senders and historical speech keep their own animal and state after later changes',()=>{
 const f=fixture('groupchat');act(f,'p1',{type:'bid',score:100});act(f,'p2',{type:'bid',score:0});
 act(f,'p1',{type:'speak',text:'这是当时说的话。'},'开心');
 const sender=structuredClone(f.a.messages(f.id).messages[0].sender);
 f.a.pause(f.id);f.a.setAppearance(f.id,'p1','penguin');f.a.resume(f.id);
 act(f,'p1',{type:'bid',score:100},'沮丧');act(f,'p2',{type:'bid',score:0});
 assert.deepEqual(f.a.messages(f.id).messages[0].sender,sender);assert.equal(sender.state,'开心');assert.notEqual(sender.animalId,'penguin');
});

test('migration preserves old jobs, connections, receipts and old records; subsequent jobs require state',()=>{
 const f=fixture('xiangqi'),job=f.a.claim(f.ids.red).job;
 f.store.change(s=>{const m=s.matches[f.id];delete m.presentation;for(const j of m.jobs)delete j.stateProtocol;m.history=[{type:'created',text:'旧记录',game:{game:'xiangqi'}}]});
 assert.equal(migratePresentation(f.store.state),true);const old=f.a.claim(f.ids.red).job;assert.equal(old.stateProtocol,0);
 assert.equal(f.a.submit(f.ids.red,{...old,result:firstAction.xiangqi}).ok,true);assert.equal(publicPerson(f,'red').state,'平静');
 assert.equal(f.a.get(f.id).history[0].eventPeople,undefined);assert.equal(f.a.get(f.id).jobs.find(j=>j.status==='open').stateProtocol,1);
 assert.equal(f.a.submit(f.ids.red,{...old,result:firstAction.xiangqi}).duplicate,true);
 assert.equal(f.a.claim(f.ids.black).job.stateProtocol,1);assert.equal(job.view.stateCatalog.length,16);
});

test('store reload preserves sealed choices and resumes existing task attempts',t=>{
 const root=temporaryDirectory('appearance-restore-'),f=fixture('groupchat');let store=new Store(root);
 t.after(()=>{store.close();removeTemporaryDirectory(root)});
 store.change(s=>Object.assign(s.matches,structuredClone(f.store.state.matches)));f.a=new Arena(store,{now:()=>f.clock.now});
 act(f,'p1',{type:'bid',score:100},'狡黠');const before=f.a.claim(f.ids.p2).job;store.close();store=new Store(root);f.a=new Arena(store,{now:()=>f.clock.now});
 assert.equal(f.a.claim(f.ids.p2).job.attemptId,before.attemptId);assert.equal(publicPerson(f,'p1').state,'平静');
 act(f,'p2',{type:'bid',score:0},'老实');assert.equal(publicPerson(f,'p1').state,'狡黠');
});

test('simulated model observes fixed visual cues and latest 12 public transitions without claiming real-model causality',()=>{
 const f=fixture('groupchat');let observed;
 const simulatedModel=job=>{observed=job.view;return {type:'bid',score:0,state:job.view.participants.some(p=>p.state==='嚣张')?'思考':'平静'}};
 for(let round=0;round<7;round++){
  act(f,'p1',{type:'bid',score:100},round%2?'嚣张':'真诚');act(f,'p2',{type:'bid',score:0},round%2?'疑惑':'开心');act(f,'p1',{type:'speak',text:'公开发言。'},'平静');
 }
 const job=f.a.claim(f.ids.p2).job,result=simulatedModel(job);assert.equal(observed.recentStateChanges.length,12);
 assert.deepEqual(observed.stateCatalog.map(s=>s.id),STATES.map(s=>s.id));assert.match(observed.stateCatalog.find(s=>s.id==='嚣张').description,/下巴/);
 assert.equal(f.a.submit(f.ids.p2,{...job,result}).ok,true);
});

test('atlas UI selects all 16 cells, labels old records, escapes names and provides text fallback',()=>{
 const ctx={document:{addEventListener(){}},globalThis:null};ctx.globalThis=ctx;
 vm.runInNewContext(fs.readFileSync(new URL('../public/presentation.js',import.meta.url),'utf8'),ctx);
 const ui=ctx.ArenaPresentation;ui.configure(JSON.parse(fs.readFileSync(new URL('../public/assets/presentation/manifest.json',import.meta.url),'utf8')));
 for(const [i,s] of STATES.entries()){
  const html=ui.avatar({animalId:'cat',state:s.id});assert.ok(html.includes('left:-'+i%4*100+'%'));assert.ok(html.includes('top:-'+Math.floor(i/4)*100+'%'));assert.ok(html.includes(s.id));
 }
 assert.match(ui.avatar({seat:'p1'}),/未记录/);assert.ok(!ui.roster([{nickname:'<script>',seat:'p1'}]).includes('<script>'));
 const picker=ui.picker({animalId:'fox'},'嚣张');assert.equal((picker.match(/data-state=/g)||[]).length,16);assert.ok(picker.includes('aria-pressed="true"'));
});

test('all 21 built-in image assets are local WebP files smaller than 1 MB, with a complete 192-cell manifest',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../public/assets/presentation/manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.animals.length,12);assert.equal(manifest.states.length,16);assert.equal(Object.keys(manifest.scenes).length,9);
 assert.equal(new Set(manifest.states.map(s=>s.row+','+s.column)).size,16);
 for(const src of [...manifest.animals.map(a=>a.src),...Object.values(manifest.scenes)]){
  const bytes=fs.readFileSync(new URL('../public'+src,import.meta.url));assert.ok(bytes.length<1_000_000);
  assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
 }
});

test('appearance endpoint requires admin, respects pause, and serves images with WebP MIME',async t=>{
 const root=temporaryDirectory('appearance-http-'),app=await serve({port:0,root,adminToken:'appearance-admin',autoTick:false});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const {id,runId}=app.arena.create({kind:'xiangqi'});
 const post=(body,token)=>fetch(app.origin+'/api/participant-appearance',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 const body={match:id,seat:'red',animalId:'fox',expectedRunId:runId};
 assert.equal((await post(body)).status,401);const response=await post(body,'appearance-admin');assert.equal(response.status,200);
 assert.equal((await response.json()).participants.find(p=>p.seat==='red').animalId,'fox');
 assert.equal((await post({...body,expectedRunId:'stale'},'appearance-admin')).status,409);
 const image=await fetch(app.origin+'/assets/presentation/animals/fox.webp');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
 assert.equal((await fetch(app.origin+'/assets/presentation/animals/../../arena.mjs')).status,404);
});
