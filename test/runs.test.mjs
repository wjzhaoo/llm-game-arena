import {submitAction} from './action-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Arena} from '../lib/arena.mjs';
import {WakeService} from '../lib/wake.mjs';
import {RelayService} from '../lib/relay.mjs';
import {RelayWorker} from '../lib/relay-worker.mjs';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

function fixture(t){const root=temporaryDirectory('arena-runs-'),store=new Store(root),clock={now:10000},a=new Arena(store,{now:()=>clock.now,chatPick:()=>0});t.after(()=>{store.close();removeTemporaryDirectory(root)});return {root,store,clock,a}}
function ai(a,id,seat,name='模型甲',wake=null){const inv=a.invite(id,seat,'http://127.0.0.1:4318',name),c=a.connect({match:id,seat,provider:wake?'opencode':'simulated',session:wake?.session||'run-'+id+'-'+seat,invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1]},{wake});return {...c,identity:a.identity(c.token)}}
function players(a,kind){
 const id=a.create({kind,topic:'旧话题',timeoutSeconds:10}).id,connections=[];
 if(kind==='groupchat'){
  const p=a.chatMembers(id,{action:'add-ai',nickname:'模型甲',profile:{personality:'秘密性格',initialOpinion:'旧立场'}});connections.push(ai(a,id,p.seat));
 }else for(const seat of a.seats(a.get(id)).slice(1))connections.push(ai(a,id,seat));
 const humanSeat=kind==='groupchat'?undefined:a.seats(a.get(id))[0];if(humanSeat)a.setParticipantType(id,humanSeat,'human');
 const inv=a.roomInvite(id,'http://127.0.0.1:4318'),c=a.joinHuman({match:id,seat:humanSeat,nickname:'真人乙',profile:kind==='groupchat'?{personality:'温和',initialOpinion:'旧观点'}:undefined,invitation:new URL(inv.url).hash.slice(6)});
 connections.push({...c,identity:a.identity(c.token)});a.start(id);return {id,connections};
}
function submit(a,identity,result){const {job}=a.claim(identity);assert.ok(job);return submitAction(a,identity,{...job,result})}

for(const kind of ['xiangqi','blind','werewolf','groupchat'])for(const state of ['playing','paused','finished'])test(kind+' restarts from '+state+' with durable read-only history and reusable mixed identities',t=>{
 const {a,store}=fixture(t),{id,connections}=players(a,kind),before=a.public(a.get(id)),actor=connections.find(c=>a.pending(a.get(id)).includes(c.seat)),old=actor&&a.claim(actor.identity).job;
 if(state==='paused')a.pause(id);if(state==='finished')a.end(id);
 const firstRun=a.get(id).runId,revision=a.get(id).boardRevision;
 const result=a.control(id,{action:'restart',expectedRunId:firstRun,...(kind==='groupchat'?{topic:'新的讨论'}:{})});
 assert.equal(result.match.id,id);assert.notEqual(result.match.runId,firstRun);assert.equal(result.match.runNumber,2);assert.equal(result.match.started,false);assert.equal(result.match.paused,false);
 assert.equal(a.get(id).jobs.length,0);assert.equal(a.get(id).adminTasks.length,0);assert.equal(a.get(id).roomInvitation,undefined);assert.deepEqual(a.get(id).invites,{});
 assert.deepEqual(result.match.participants.map(p=>[p.seat,p.type,p.nickname]),before.participants.map(p=>[p.seat,p.type,p.nickname]));
 for(const c of connections)assert.deepEqual(a.identity(c.token),c.identity);
 assert.equal(a.claim(connections[0].identity).job,null);
 if(old)assert.throws(()=>submitAction(a,actor.identity,{...old,result:{}}),/Stale/);
 const past=a.publicRun(id,firstRun);assert.equal(past.readOnly,true);assert.equal(past.game.status,'finished');assert.equal(past.runs.length,2);assert.ok(past.events.some(e=>e.type==='started'));
 for(const secret of ['tokenHash','credentialPath','session','秘密性格','旧立场'])assert.ok(!JSON.stringify(past).includes(secret),secret);
 if(kind==='groupchat'){
  assert.equal(result.match.game.topic,'新的讨论');assert.equal(result.match.game.round,0);assert.equal(result.match.game.messages.length,0);
  assert.equal(a.profile(connections[0].identity).profile.personality,'秘密性格');assert.equal(a.profile(connections[0].identity).profile.initialOpinion,'');assert.equal(a.profile(connections.at(-1).identity).profile.initialOpinion,'');
 }else if(kind==='werewolf'){
  assert.equal(a.get(id).game.players.filter(p=>p.alive).length,6);assert.equal(result.match.game.round,1);assert.ok(result.match.game.players.every(p=>!('role' in p)));
 }else{assert.equal(result.match.game.ply,0);assert.ok(result.match.boardRevision>revision);if(kind==='blind')assert.equal(result.match.game.board.flat().filter(p=>p?.hidden).length,30)}
 assert.throws(()=>a.restart(id,{expectedRunId:firstRun,topic:'重复'}),error=>error.status===409);
 const archived=JSON.stringify(store.state.matches[id].archivedRuns[0]);a.start(id);assert.ok(a.get(id).jobs.length>0);assert.equal(JSON.stringify(store.state.matches[id].archivedRuns[0]),archived);
});

test('Actual score-only and null-emote failures are accepted without weakening validation or idempotency',t=>{
 const {a}=fixture(t),id=a.create({kind:'groupchat',topic:'回归测试'}).id;
 const actors=Array.from({length:2},()=>{const {seat}=a.chatMembers(id,{action:'add-ai'});return ai(a,id,seat).identity});a.start(id);
 const first=a.claim(actors[0]).job;
 const bad={type:'bid',score:101};assert.equal(submitAction(a,actors[0],{...first,result:bad}).remaining,1);assert.equal(submitAction(a,actors[0],{...first,result:bad}).duplicate,true);
 const valid={score:85};assert.equal(submitAction(a,actors[0],{...first,result:valid}).ok,true);assert.equal(submitAction(a,actors[0],{...first,result:valid}).duplicate,true);
 assert.equal(a.get(id).jobs.find(j=>j.taskId===first.taskId).invalid,1);assert.equal(a.adminView(id).tasks[0].status,'resolved');assert.match(a.adminView(id).tasks[0].details,/0\.\.100/);
 submit(a,actors[1],{type:'bid',score:0});const speech=a.claim(actors[0]).job;
 assert.equal(submitAction(a,actors[0],{...speech,result:{type:'speak',text:'有效发言',emote:null}}).ok,true);assert.equal(a.get(id).game.messages[0].emote,null);
 assert.equal(a.get(id).adminTasks.length,1);assert.ok(a.claim(actors[0]).job.actionExample);
 for(const action of [{score:'85'},{score:50,extra:true}])assert.equal(submitAction(a,actors[1],{...a.claim(actors[1]).job,result:action}).ok,false);
 assert.equal(a.get(id).adminTasks.filter(t=>t.status==='pending').length,0);
});

test('Archived chat messages and names stay independent of later topics and member changes',t=>{
 const {a}=fixture(t),{id,connections}=players(a,'groupchat'),speaker=connections[0].identity,other=connections[1].identity;
 submit(a,speaker,{score:85});submit(a,other,{type:'bid',score:0});submit(a,speaker,{type:'speak',text:'只属于旧话题'});
 const oldId=a.get(id).runId;a.restart(id,{expectedRunId:oldId,topic:'第二个话题'});
 assert.equal(a.messages(id,{runId:oldId}).messages[0].text,'只属于旧话题');assert.equal(a.messages(id).messages.length,0);
 a.revoke(id,speaker.seat);assert.equal(a.publicRun(id,oldId).participants.find(p=>p.seat===speaker.seat).nickname,'模型甲');
 assert.throws(()=>a.publicRun(id,'missing'),error=>error.status===404);
});

test('Run migration preserves old credentials/history, settles terminal faults, and is idempotent',t=>{
 const f=fixture(t),{id,connections}=players(f.a,'xiangqi'),history=structuredClone(f.a.get(id).history);
 f.store.change(s=>{const m=s.matches[id];for(const key of ['runId','runNumber','runCreatedAt','archivedRuns','participantNames'])delete m[key];m.jobs.push({taskId:'old-timeout',status:'timedout'},{taskId:'old-resolved',attemptId:'old-attempt',status:'submitted'});m.adminTasks.push({id:'old-fault',targetTask:'old-timeout',kind:'timeout',status:'pending'},{id:'old-fixed',targetTask:'old-resolved',kind:'invalid_action',status:'resolved'});m.rejections={'old-attempt-digest':{details:'请提交合法报分'}}});
 f.store.close();const restored=new Store(f.root);try{const a=new Arena(restored);assert.equal(a.get(id).runId,id);assert.deepEqual(a.get(id).history,history);assert.equal(a.get(id).adminTasks[0].status,'resolved');assert.equal(a.get(id).adminTasks[1].details,'请提交合法报分');assert.match(a.get(id).adminTasks[1].resolution,/重新提交/);assert.deepEqual(a.identity(connections[0].token),connections[0].identity)}finally{restored.close()}
 const roomFile=path.join(f.root,'xiangqi',id+'.json'),saved=fs.readFileSync(roomFile,'utf8'),metadata=fs.readFileSync(path.join(f.root,'state.json'),'utf8'),again=new Store(f.root);again.close();assert.equal(fs.readFileSync(roomFile,'utf8'),saved);assert.equal(fs.readFileSync(path.join(f.root,'state.json'),'utf8'),metadata);
});

for(const transport of ['local','relay'])test(transport+' wakes resume across completed runs; deletion cancels in-flight delivery',async t=>{
 const {a,root}=fixture(t),workspace=path.resolve('.'),messages=[],calls=[];let release,hold=false;
 const adapter={async read(config){if(hold)await new Promise(resolve=>{release=resolve});return {session:config.session,workspace,status:'idle',messages}},async send(config,prompt,marker){assert.ok(config.canSend());calls.push(marker);messages.push({role:'user',text:prompt});return {delivered:true}}};
 const wake=new WakeService(a,{workspace,adapters:{opencode:adapter}}),relay=new RelayService(a,wake);t.after(()=>wake.stop());
 const id=a.create({kind:'xiangqi'}).id,inv=a.invite(id,'red','http://127.0.0.1:4318'),input={match:id,seat:'red',provider:'opencode',session:'ses_reusable_'+transport,workspace,credentialPath:path.join(root,'red.credential.json'),invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1]};
 const c=transport==='local'?await wake.connect(input):relay.connect({...input,relayVerification:{verified:true,workspaceVerified:true,deviceId:'a'.repeat(64)}});ai(a,id,'black');
 const identity=a.identity(c.token),worker=transport==='relay'?new RelayWorker({config:{...input},adapter,script:path.join(workspace,'client.mjs'),request:body=>{const i=relay.identity(c.relayToken);return body.action==='poll'?relay.poll(i,body):relay.report(i,body)}}):null;
 const tick=()=>worker?worker.step():Promise.all(wake.tick({force:true}));
 a.start(id);await tick();assert.equal(calls.length,1);a.end(id);await tick();const firstCompletion=calls.at(-1);a.park(identity);await tick();if(worker)assert.equal(worker.stopped,false);
 const old=a.get(id).runId;a.restart(id,{expectedRunId:old});a.start(id);await tick();assert.equal(calls.length,3);a.end(id);await tick();assert.notEqual(calls.at(-1),firstCompletion);
 a.restart(id,{expectedRunId:a.get(id).runId});a.start(id);hold=true;const work=tick();while(!release)await new Promise(resolve=>setTimeout(resolve,1));const before=calls.length;
 a.delete(id,{expectedRunId:a.get(id).runId});release();if(worker)await assert.rejects(work,/Stale|Unauthorized/);else await work;
 assert.equal(calls.length,before);assert.throws(()=>a.identity(c.token),/Unauthorized/);assert.equal(a.store.state.matches[id],undefined);
});

test('Restart checks reused host-session conflicts without changing either room',t=>{
 const {a,root}=fixture(t),first=a.create({kind:'xiangqi'}).id,wake={provider:'opencode',session:'ses_shared_fixture',workspace:path.resolve('.'),credentialPath:path.join(root,'shared.json'),transport:'local'};
 ai(a,first,'red','甲',wake);ai(a,first,'black');a.start(first);a.end(first);
 const second=a.create({kind:'xiangqi'}).id;ai(a,second,'red','乙',wake);const before=JSON.stringify(a.get(first));
 assert.throws(()=>a.restart(first,{expectedRunId:a.get(first).runId}),/会话正在参与/);assert.equal(JSON.stringify(a.get(first)),before);
});

test('HTTP run/deletion boundaries, naming and stale-version conflicts remain enforced',async t=>{
 const root=temporaryDirectory('arena-runs-http-'),app=await serve({root,port:0,adminToken:'runs-admin',autoTick:false});t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const {id,connections}=players(app.arena,'groupchat'),runId=app.arena.get(id).runId;
 const post=async(body,token='runs-admin')=>fetch(app.origin+'/api/control',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({match:id,...body})});
 assert.equal((await post({action:'restart',expectedRunId:runId,topic:'新话题'},'')).status,401);
 assert.equal((await post({action:'restart',expectedRunId:runId,topic:'新话题'})).status,200);
 assert.equal((await post({action:'restart',expectedRunId:runId,topic:'重复'})).status,409);
 const past=await (await fetch(app.origin+'/api/matches/'+id+'/runs/'+runId)).json();assert.equal(past.readOnly,true);assert.equal(past.game.topic,'旧话题');
 assert.equal((await post({action:'delete',expectedRunId:runId})).status,409);
 assert.equal((await post({action:'delete',expectedRunId:app.arena.get(id).runId})).status,200);
 assert.equal((await fetch(app.origin+'/api/matches/'+id)).status,404);assert.equal((await fetch(app.origin+'/api/matches/'+id+'/runs/'+runId)).status,404);
 assert.throws(()=>app.arena.identity(connections[0].token),/Unauthorized/);assert.deepEqual(await (await fetch(app.origin+'/api/matches')).json(),[]);
 const chess=app.arena.create({kind:'xiangqi'}).id;
 const inv=await (await fetch(app.origin+'/api/invite',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer runs-admin'},body:JSON.stringify({match:chess,seat:'red',nickname:'千问\n棋手'})})).json();
 assert.equal(inv.nickname,'千问棋手');assert.ok(!inv.text.includes('--nickname'));
 const joined=app.arena.connect({match:chess,seat:'red',provider:'simulated',session:'http-named',invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1]});assert.equal(app.arena.public(app.arena.get(chess)).participants[0].nickname,'千问棋手');assert.ok(joined.token);
});
