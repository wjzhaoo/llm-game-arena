import {submitAction} from './action-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../lib/store.mjs';
import {Arena} from '../lib/arena.mjs';
import {initialXiangqi} from '../lib/xiangqi.mjs';
import {initialBlind} from '../lib/blind.mjs';
import {WakeService} from '../lib/wake.mjs';
import {RelayService} from '../lib/relay.mjs';
import {RelayWorker} from '../lib/relay-worker.mjs';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
import {toWorld,fromWorld,visiblePiece} from '../public/chess-coordinates.mjs';

function connect(a,id,seat,human=true){
 if(human){a.setParticipantType(id,seat,'human');const i=a.roomInvite(id,'http://127.0.0.1:4318');return a.joinHuman({match:id,seat,nickname:seat,invitation:new URL(i.url).hash.slice(6)})}
 const i=a.invite(id,seat,'http://127.0.0.1:4318');return a.connect({match:id,seat,provider:'simulated',session:'test-'+seat,invitation:i.text.match(/--invitation ([a-f0-9]+)/)[1]});
}
function fixture(t,kind='xiangqi',human=true){
 const root=temporaryDirectory('arena-chess-'),store=new Store(root),clock={now:10000},a=new Arena(store,{now:()=>clock.now}),id=a.create({kind,timeoutSeconds:10}).id;
 const connections={red:connect(a,id,'red',human),black:connect(a,id,'black',human)},ids=Object.fromEntries(Object.entries(connections).map(([s,c])=>[s,a.identity(c.token)]));
 t.after(()=>{store.close();removeTemporaryDirectory(root)});a.start(id);return {root,store,clock,a,id,ids,connections};
}
function move(f,seat,result){const job=f.a.claim(f.ids[seat]).job;assert.equal(submitAction(f.a,f.ids[seat],{...job,result}).ok,true);return {...job,result}}
function request(f,seat='red'){return f.a.requestUndo(f.ids[seat],{boardRevision:f.a.get(f.id).boardRevision}).undoRequest}
function answer(f,accept=true){const r=f.a.get(f.id).undoRequest,j=f.a.claim(f.ids[r.responder]).job;assert.equal(j.kind,'undo-response');const submission={...j,result:{type:'undo-response',requestId:r.id,accept}};assert.equal(submitAction(f.a,f.ids[r.responder],submission).ok,true);return submission}

test('Accepted one-ply undo restores exact rules, original remaining time, fresh task and durable receipts',t=>{
 const f=fixture(t);f.clock.now+=2000;const original=move(f,'red',{from:[0,6],to:[0,5]}),old=f.a.claim(f.ids.black).job;
 f.clock.now+=1000;const r=request(f);assert.equal(r.plies,1);assert.equal(f.a.claim(f.ids.red).job,null);
 assert.throws(()=>submitAction(f.a,f.ids.black,{...old,result:{from:[0,3],to:[0,4]}}),/active/);
 f.clock.now+=500;const approval=answer(f);assert.deepEqual(f.a.get(f.id).game,initialXiangqi());
 const fresh=f.a.claim(f.ids.red).job;assert.equal(fresh.deadline,f.clock.now+8000);assert.notEqual(fresh.attemptId,original.attemptId);assert.equal(f.a.get(f.id).boardRevision,2);
 assert.equal(submitAction(f.a,f.ids.red,original).duplicate,true);assert.equal(f.a.get(f.id).game.ply,0);
 assert.equal(submitAction(f.a,f.ids.black,approval).duplicate,true);
 assert.equal(f.a.get(f.id).history.filter(e=>e.type==='action').length,1);assert.ok(f.a.get(f.id).history.some(e=>e.type==='undo-accepted'&&e.game.ply===0));
 const publicText=JSON.stringify(f.a.public(f.a.get(f.id)));for(const secret of ['undoStack','remainingMs','repetitions','tokenHash'])assert.ok(!publicText.includes('"'+secret+'"'));
});

test('Two-ply undo returns to requester, preserves captures and last move of the active line',t=>{
 const f=fixture(t);move(f,'red',{from:[0,6],to:[0,5]});move(f,'black',{from:[0,3],to:[0,4]});
 assert.equal(request(f).plies,2);answer(f);assert.deepEqual(f.a.get(f.id).game,initialXiangqi());
 move(f,'red',{from:[2,6],to:[2,5]});assert.equal(f.a.get(f.id).game.history.length,1);assert.deepEqual(f.a.get(f.id).game.lastMove.from,[2,6]);
});

test('Rejection, invalid confirmation and timeout preserve frozen move budget and block repeated requests',t=>{
 const f=fixture(t,'xiangqi',false);move(f,'red',{from:[0,6],to:[0,5]});const old=f.a.claim(f.ids.black).job;
 submitAction(f.a,f.ids.black,{...old,result:{from:[0,3],to:[0,7]}});assert.equal(f.a.get(f.id).jobs.at(-1).invalid,1);
 f.clock.now+=2000;const before=structuredClone(f.a.get(f.id).game);request(f);f.clock.now+=3000;
 const approval=f.a.claim(f.ids.black).job;assert.equal(submitAction(f.a,f.ids.black,{...approval,result:{from:[0,3],to:[0,4]}}).ok,false);
 answer(f,false);assert.deepEqual(f.a.get(f.id).game,before);const fresh=f.a.claim(f.ids.black).job;assert.equal(fresh.deadline,f.clock.now+8000);assert.equal(f.a.get(f.id).jobs.at(-1).invalid,1);
 assert.throws(()=>request(f),/申请过/);
 move(f,'black',{from:[0,3],to:[0,4]});request(f);const r=f.a.get(f.id).undoRequest;f.clock.now=r.deadline+1;f.a.tick();
 assert.equal(f.a.get(f.id).game.status,'playing');assert.equal(f.a.get(f.id).undoRequest,undefined);assert.equal(f.a.claim(f.ids.red).job.deadline,f.clock.now+10000);
});

test('Capture rollback restores the previous active line and publishes a separate rollback event',t=>{
 const f=fixture(t);move(f,'red',{from:[0,6],to:[0,5]});move(f,'black',{from:[0,3],to:[0,4]});
 const before=structuredClone(f.a.get(f.id).game);move(f,'red',{from:[0,5],to:[0,4]});move(f,'black',{from:[2,3],to:[2,4]});request(f);answer(f);
 assert.deepEqual(f.a.get(f.id).game,before);const rollback=f.a.get(f.id).history.at(-1);
 assert.equal(rollback.type,'undo-rollback');assert.equal(rollback.fromPly,4);assert.equal(rollback.toPly,2);assert.equal(rollback.game.board[4][0],'bP');
 assert.equal(f.a.get(f.id).history.filter(e=>e.type==='action').length,4);
});

test('Two invalid AI confirmations reject undo, close decision faults and cannot forfeit the chess game',t=>{
 const f=fixture(t,'xiangqi',false);move(f,'red',{from:[0,6],to:[0,5]});f.clock.now+=2000;request(f);const decision=f.a.claim(f.ids.black).job;
 for(const result of [{accept:'yes'},{accept:'no'}])assert.equal(submitAction(f.a,f.ids.black,{...decision,result}).ok,false);
 const m=f.a.get(f.id);assert.equal(m.undoRequest,undefined);assert.equal(m.game.status,'playing');assert.equal(m.jobs.at(-1).deadline,f.clock.now+8000);
 assert.equal(m.adminTasks.filter(t=>t.status==='pending').length,0);assert.equal(f.a.claim(f.ids.black).job.kind,'move');
});

test('Pause, process restart and revocation preserve confirmation and frozen clocks',t=>{
 const f=fixture(t);move(f,'red',{from:[0,6],to:[0,5]});f.clock.now+=2000;const r=request(f);f.a.pause(f.id);f.clock.now+=5000;f.a.tick();
 assert.equal(f.a.get(f.id).undoRequest.id,r.id);f.store.close();const restored=new Store(f.root);t.after(()=>restored.close());f.a=new Arena(restored,{now:()=>f.clock.now});
 assert.equal(f.a.get(f.id).undoRequest.deadline,r.deadline);f.a.resume(f.id);assert.equal(f.a.get(f.id).undoRequest.deadline,r.deadline+5000);
 f.a.pause(f.id);f.clock.now+=1000;f.a.revoke(f.id,'red');assert.equal(f.a.get(f.id).undoRequest,undefined);f.clock.now+=1000;f.a.resume(f.id);
 assert.equal(f.a.claim(f.ids.black).job.deadline,f.clock.now+8000);
});

test('Stale revision, overlapping requests, unauthorized confirmation and resign during confirmation are safe',t=>{
 const f=fixture(t);assert.throws(()=>request(f),/暂无/);move(f,'red',{from:[0,6],to:[0,5]});
 assert.throws(()=>f.a.requestUndo(f.ids.red,{boardRevision:0}),/更新/);request(f);assert.throws(()=>request(f),/等待/);
 const j=f.a.claim(f.ids.black).job;assert.throws(()=>submitAction(f.a,f.ids.red,{...j,result:{type:'undo-response',requestId:f.a.get(f.id).undoRequest.id,accept:true}}),/foreign/);
 f.a.resign(f.ids.red);assert.equal(f.a.get(f.id).game.reason,'resigned');assert.equal(f.a.get(f.id).game.winner,'black');assert.equal(f.a.get(f.id).undoRequest,undefined);assert.equal(f.a.get(f.id).jobs.filter(j=>j.status==='open').length,0);
 assert.throws(()=>submitAction(f.a,f.ids.black,{...j,result:{type:'undo-response',requestId:'old',accept:true}}),/active/);
});

test('Blind undo refuses reveals and covered captures but restores ordinary open-piece moves',t=>{
 const f=fixture(t,'blind');move(f,'red',{from:[0,6],to:[0,5]});assert.throws(()=>request(f),/揭子/);
 const second=fixture(t,'blind');const initial=structuredClone(second.a.get(second.id).game);
 move(second,'red',{from:[4,9],to:[4,8]});move(second,'black',{from:[4,0],to:[4,1]});request(second);answer(second);assert.deepEqual(second.a.get(second.id).game,initial);
 const third=fixture(t,'blind');third.store.change(s=>{
  const game=initialBlind({seed:42});game.board=Array.from({length:10},()=>Array(9).fill(null));
  game.board[9][4]={s:'red',k:'K',h:false,cs:null,ck:null};game.board[0][4]={s:'black',k:'K',h:false,cs:null,ck:null};
  game.board[9][0]={s:'red',k:'R',h:false,cs:null,ck:null};game.board[6][0]={s:'black',k:'P',h:true,cs:'black',ck:'P'};s.matches[third.id].game=game;
 });move(third,'red',{from:[0,9],to:[0,6]});assert.throws(()=>request(third),/暗子/);
 for(const output of [second.a.public(second.a.get(second.id)),second.a.claim(second.ids.red)]){const text=JSON.stringify(output);assert.ok(!text.includes('"cs"'));assert.ok(!text.includes('"ck"'));assert.ok(!text.includes('undoStack'))}
});

test('Emotes use fixed ids, per-seat cooldown, public events and do not alter board or tasks',t=>{
 const f=fixture(t,'xiangqi',false),old=f.a.claim(f.ids.red).job;
 assert.equal(f.a.emote(f.ids.red,{emote:'good'}).ok,true);assert.throws(()=>f.a.emote(f.ids.red,{emote:'good'}),/过快/);
 assert.throws(()=>f.a.emote(f.ids.black,{emote:'<script>'}),/有效/);f.a.emote(f.ids.black,{emote:'think'});f.clock.now+=1500;f.a.emote(f.ids.red,{emote:'admire'});
 assert.equal(f.a.get(f.id).boardRevision,0);assert.equal(f.a.claim(f.ids.red).job.attemptId,old.attemptId);assert.equal(f.a.get(f.id).events.filter(e=>e.type==='emote').length,3);
 assert.equal(f.a.claim(f.ids.red).job.interactions.emotes.length,10);assert.throws(()=>request(f),/暂无/);
 f.a.pause(f.id);assert.throws(()=>f.a.emote(f.ids.red,{emote:'good'}),/当前/);
});

test('Legacy running chess migration preserves identity and deadlines but has no invented undo checkpoints',t=>{
 const f=fixture(t);const original=f.a.claim(f.ids.red).job;
 f.store.change(s=>{const m=s.matches[f.id];delete m.chessInteractionPolicy;delete m.boardRevision;delete m.undoStack;delete m.undoRequested;delete m.lastEmoteAt;m.jobs[0].phase='ply:0';delete m.jobs[0].kind});
 f.store.close();const restored=new Store(f.root);t.after(()=>restored.close());const a=new Arena(restored,{now:()=>f.clock.now});
 assert.equal(a.claim(f.ids.red).job.attemptId,original.attemptId);assert.equal(a.claim(f.ids.red).job.deadline,original.deadline);assert.equal(restored.state.matches[f.id].undoStack.length,0);
 assert.equal(submitAction(a,f.ids.red,{...original,result:{from:[0,6],to:[0,5]}}).ok,true);assert.equal(a.interactions(a.get(f.id),'red').undo.allowed,true);
});

test('3D coordinate conversion matches every public square and hides covered identities',()=>{
 for(let y=0;y<10;y++)for(let x=0;x<9;x++){const p=toWorld([x,y]);assert.deepEqual(fromWorld(p.x,p.z),[x,y])}
 assert.equal(fromWorld(4.6,0),null);assert.equal(fromWorld(0,5.2),null);
 assert.deepEqual(visiblePiece({hidden:true,side:'red',kind:'R'}),{side:'red',glyph:'暗',hidden:true,hint:'車'});
 const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('public/chess-ui.js','utf8'),ctx);const ui=ctx.ArenaChess;
 assert.equal(ui.state({status:'playing',turn:'black'},{started:true,interactive:true,side:'black'}).text,'轮到黑方 · 轮到你');
 assert.equal(ui.state({status:'playing',turn:'red'},{started:true,undoRequest:{responder:'black'}}).activeSide,null);
 assert.match(ui.state({status:'playing',turn:'red'},{started:true,replay:true}).text,/历史回放/);
});

test('HTTP and actual AI CLI support emote, undo confirmation and resignation with identity boundaries',async t=>{
 const root=temporaryDirectory('arena-chess-http-'),app=await serve({port:0,root,autoTick:false,adminToken:'chess-test'});t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const id=app.arena.create({kind:'xiangqi'}).id,red=connect(app.arena,id,'red',false),black=connect(app.arena,id,'black',true);app.arena.start(id);
 const post=(endpoint,token,body)=>fetch(app.origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 assert.equal((await post('/desktop',black.token,{action:'resign'})).status,401);assert.equal((await post('/api/player',red.token,{action:'emote',emote:'good'})).status,401);assert.equal((await post('/desktop','',{action:'resign'})).status,401);
 const credential=path.join(root,'red.credential.json');fs.writeFileSync(credential,JSON.stringify({...red,url:app.origin}));const run=promisify(execFile);
 const cli=async(...args)=>JSON.parse((await run(process.execPath,['client.mjs',...args,'--credential',credential])).stdout);
 assert.equal((await cli('emote','--emote','good')).ok,true);const job=(await cli('claim')).job,identity=app.arena.identity(red.token);submitAction(app.arena,identity,{...job,result:{from:[0,6],to:[0,5]}});
 assert.equal((await cli('undo-request','--revision','1')).ok,true);const human=app.arena.identity(black.token),confirmation=app.arena.claim(human).job;
 const r=await post('/api/player',black.token,{action:'submit',...confirmation,result:{type:'undo-response',requestId:app.arena.get(id).undoRequest.id,accept:true,state:'平静'}});assert.equal((await r.json()).ok,true);
 assert.equal((await cli('resign')).completed,true);assert.equal(app.arena.get(id).game.winner,'black');
 for(const asset of ['chess-ui.js','chess3d.mjs','chess.css','vendor/three/three.module.js','vendor/three/OrbitControls.js']){const response=await fetch(app.origin+'/'+asset);assert.equal(response.status,200);assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"))}
 assert.equal((await fetch(app.origin+'/vendor/three/LICENSE.txt')).status,404);
});

test('Pending undo is delivered through both local and remote wake and stale notices cannot submit moves',async t=>{
 const f=fixture(t,'xiangqi',false),workspace=path.resolve('.'),calls=[];
 const adapter={async read(config){return {provider:'mimo',session:config.session,workspace,status:'idle',messages:[],model:'fixture/model'}},async send(config,prompt){calls.push(prompt);return {delivered:true}}};
 const wake=new WakeService(f.a,{workspace,adapters:{mimo:adapter}});t.after(()=>wake.stop());
 f.store.change(s=>{const b=s.matches[f.id].bindings.black;b.provider='mimo';b.session='fixture';b.wake={provider:'mimo',session:'fixture',workspace,model:'fixture/model',credentialPath:path.join(f.root,'black.credential.json'),transport:'local',workspaceVerified:true};b.armed=true});
 move(f,'red',{from:[0,6],to:[0,5]});request(f);await Promise.all(wake.tick());assert.equal(calls.length,1);assert.match(calls[0],/undo-response/);answer(f,false);
 move(f,'black',{from:[0,3],to:[0,4]});f.store.change(s=>{s.matches[f.id].bindings.black.wake.transport='relay';s.matches[f.id].bindings.black.wake.deviceId='a'.repeat(64)});
 request(f);const relay=new RelayService(f.a,wake),identity=f.ids.black;
 const worker=new RelayWorker({config:f.a.get(f.id).bindings.black.wake,adapter,script:path.join(workspace,'client.mjs'),request:body=>Promise.resolve(body.action==='poll'?relay.poll(identity,body):relay.report(identity,body))});
 await worker.step();assert.equal(calls.length,2);assert.match(calls[1],/undo-response/);assert.equal(f.a.claim(identity).job.kind,'undo-response');worker.stop();
});
