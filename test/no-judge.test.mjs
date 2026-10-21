import {submitAction} from './action-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Arena} from '../lib/arena.mjs';
import {Store} from '../lib/store.mjs';
import {WakeService} from '../lib/wake.mjs';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const invitationToken=invitation=>invitation.text.match(/--invitation ([a-f0-9]+)/)[1];
function fixture(t){
 const root=temporaryDirectory('arena-no-judge-'),clock={now:10000},f={root,clock};
 f.store=new Store(root);f.arena=new Arena(f.store,{now:()=>clock.now});
 f.restart=()=>{f.store.close();f.store=new Store(root);f.arena=new Arena(f.store,{now:()=>clock.now})};
 t.after(()=>{f.store.close();removeTemporaryDirectory(root)});
 return f;
}
function connectAll(arena,id){
 const ids={};
 for(const seat of arena.seats(arena.get(id))){const invitation=arena.invite(id,seat,'http://127.0.0.1:4318');assert.doesNotMatch(invitation.text,/裁判|verdict/);const connection=arena.connect({match:id,seat,invitation:invitationToken(invitation),provider:'simulated',session:'fixture-'+seat});ids[seat]=arena.identity(connection.token)}
 return ids;
}
function act(arena,identity,result){const {job}=arena.claim(identity);assert.ok(job);return submitAction(arena,identity,{...job,result})}
function noJudge(arena,id){const m=arena.get(id);assert.equal(m.jobs.some(j=>j.seat==='judge'),false);assert.equal(arena.public(m).participants.some(p=>p.seat==='judge'),false)}

test('Two-player Xiangqi completes a full legal threefold game with no judge seat or final job',t=>{
 const {arena}=fixture(t),id=arena.create({kind:'xiangqi'}).id,ids=connectAll(arena,id);
 assert.deepEqual(arena.seats(arena.get(id)),['red','black']);
 assert.throws(()=>arena.invite(id,'judge','http://localhost'),/Invalid seat/);
 arena.start(id);
 const cycle=[['red',{from:[1,9],to:[2,7]}],['black',{from:[1,0],to:[2,2]}],['red',{from:[2,7],to:[1,9]}],['black',{from:[2,2],to:[1,0]}]];
 for(const [seat,result] of [...cycle,...cycle]){assert.equal(act(arena,ids[seat],result).ok,true);noJudge(arena,id)}
 assert.equal(arena.get(id).game.status,'finished');assert.equal(arena.get(id).game.reason,'threefold-repetition');assert.equal(arena.get(id).game.ply,8);
 assert.equal(arena.get(id).jobs.filter(j=>j.status==='open').length,0);
 for(const identity of Object.values(ids))assert.equal(arena.claim(identity).completed,true);
 assert.equal(arena.adminView(id).tasks.length,0);
});

test('Six-player Werewolf completes two full rounds and deterministic good victory without a judge',t=>{
 const {arena}=fixture(t),id=arena.create({kind:'werewolf'}).id,ids=connectAll(arena,id);arena.start(id);
 assert.equal(Object.keys(ids).length,6);
 const players=arena.get(id).game.players,wolves=players.filter(p=>p.role==='wolf').map(p=>p.id),seer=players.find(p=>p.role==='seer').id,witch=players.find(p=>p.role==='witch').id,acted=new Set();
 for(let round=1;round<=2;round++){
  const state=arena.get(id).game;assert.equal(state.round,round);assert.equal(state.phase,'wolf');
  for(const seat of wolves.filter(seat=>arena.get(id).game.players.find(p=>p.id===seat).alive)){assert.equal(act(arena,ids[seat],{type:'kill',target:null}).ok,true);acted.add(seat)}
  assert.equal(act(arena,ids[seer],{type:'inspect',target:wolves[round-1]}).ok,true);acted.add(seer);
  assert.equal(act(arena,ids[witch],{type:'witch',save:false,poison:null}).ok,true);acted.add(witch);
  for(const player of arena.get(id).game.players.filter(p=>p.alive)){assert.equal(act(arena,ids[player.id],{type:'speak',text:`第 ${round} 天公开发言`}).ok,true);acted.add(player.id)}
  const view=arena.public(arena.get(id));assert.equal(view.game.phase,'vote');assert.ok(view.game.players.every(p=>!Object.hasOwn(p,'role')));
  for(const player of arena.get(id).game.players.filter(p=>p.alive))assert.equal(act(arena,ids[player.id],{type:'vote',target:wolves[round-1]}).ok,true);
  noJudge(arena,id);
 }
 const m=arena.get(id);assert.equal(m.game.status,'finished');assert.equal(m.game.winner,'good');assert.equal(m.game.reason,'all-wolves-eliminated');assert.equal(acted.size,6);
 assert.equal(m.jobs.filter(j=>j.status==='open').length,0);assert.equal(m.adminTasks.length,0);
 for(const identity of Object.values(ids))assert.equal(arena.claim(identity).completed,true);
 assert.equal(arena.public(m).game.players.filter(p=>p.role==='wolf').length,2);
});

test('Invalid replies create bounded admin tasks while rules remain authoritative and retry cannot reset limits',t=>{
 const {arena}=fixture(t),id=arena.create({kind:'xiangqi',timeoutSeconds:10}).id,ids=connectAll(arena,id);arena.start(id);
 const {job}=arena.claim(ids.red),deadline=job.deadline;
 const invalid={from:[0,6],to:[0,3]};assert.equal(submitAction(arena,ids.red,{...job,result:invalid}).remaining,1);
 assert.equal(submitAction(arena,ids.red,{...job,result:invalid}).duplicate,true);
 const task=arena.adminView(id).tasks[0];assert.equal(task.canRetry,true);assert.equal(task.kind,'invalid_action');
 const before=structuredClone(arena.get(id).game);
 arena.control(id,{action:'retry',taskId:task.id});
 assert.deepEqual(arena.get(id).game,before);assert.equal(arena.get(id).jobs[0].deadline,deadline);assert.equal(arena.get(id).jobs[0].invalid,1);assert.equal(arena.get(id).jobs[0].priorAttempts[0].attemptId,job.attemptId);
 assert.throws(()=>submitAction(arena,ids.red,{...job,result:{from:[0,6],to:[0,5]}}),/Stale attempt/);
 assert.throws(()=>arena.control(id,{action:'retry',taskId:task.id}),/cannot be retried/);
 const next=arena.claim(ids.red).job;assert.notEqual(next.attemptId,job.attemptId);
 assert.equal(submitAction(arena,ids.red,{...next,result:{from:[0,6],to:[1,6]}}).remaining,0);
 assert.equal(arena.get(id).game.winner,'black');assert.ok(arena.adminView(id).tasks.every(t=>!t.canRetry));noJudge(arena,id);
});

test('Pause survives restart, freezes remaining deadlines, prevents mutation, and requires explicit resume',t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi',timeoutSeconds:10}).id,ids=connectAll(f.arena,id);f.arena.start(id);
 const {job}=f.arena.claim(ids.red);f.clock.now+=3000;f.arena.control(id,{action:'pause'});
 const pausedAt=f.arena.get(id).pausedAt,game=structuredClone(f.arena.get(id).game);
 f.clock.now+=50000;f.arena.pause(id);assert.equal(f.arena.get(id).pausedAt,pausedAt);
 f.restart();f.clock.now+=50000;f.arena.tick();assert.equal(f.arena.get(id).paused,true);assert.deepEqual(f.arena.get(id).game,game);assert.equal(f.arena.claim(ids.red).paused,true);
 assert.throws(()=>submitAction(f.arena,ids.red,{...job,result:{from:[0,6],to:[0,5]}}),/paused/);
 f.arena.control(id,{action:'resume'});assert.equal(f.arena.get(id).jobs[0].deadline-f.clock.now,7000);assert.equal(f.arena.public(f.arena.get(id)).paused,false);
 const resumedDeadline=f.arena.get(id).jobs[0].deadline;f.arena.resume(id);assert.equal(f.arena.get(id).jobs[0].deadline,resumedDeadline);
 f.clock.now+=6999;f.arena.tick();assert.equal(f.arena.get(id).game.status,'playing');
 f.clock.now++;f.arena.tick();assert.equal(f.arena.get(id).game.winner,'black');assert.equal(f.arena.adminView(id).tasks[0].kind,'timeout');noJudge(f.arena,id);
});

test('Pause/retry controls cannot alter hidden roles or inject moves; ending cancels tasks without choosing winner',t=>{
 const {arena,clock}=fixture(t),id=arena.create({kind:'werewolf',timeoutSeconds:10}).id,ids=connectAll(arena,id);arena.start(id);
 const roles=structuredClone(arena.get(id).game.players),wolf=roles.find(p=>p.role==='wolf').id,{job}=arena.claim(ids[wolf]);
 submitAction(arena,ids[wolf],{...job,result:{type:'kill',target:'no-such-seat'}});const task=arena.adminView(id).tasks[0];
 for(const input of [{action:'retry',taskId:task.id,result:{type:'kill',target:'p1'}},{action:'pause',game:{}},{action:'end',winner:'wolves'},{action:'set-role',seat:wolf,role:'villager'}])assert.throws(()=>arena.control(id,input),/Only|Invalid/);
 arena.pause(id);clock.now+=100000;arena.retry(id,{taskId:task.id});arena.tick();
 assert.deepEqual(arena.get(id).game.players,roles);assert.equal(arena.get(id).game.phase,'wolf');assert.equal(arena.get(id).paused,true);
 arena.end(id);const m=arena.get(id);assert.equal(m.game.status,'finished');assert.equal(m.game.winner,null);assert.equal(m.game.reason,'admin-ended');assert.deepEqual(m.game.players,roles);assert.equal(m.paused,false);
 assert.equal(m.jobs.some(j=>j.status==='open'),false);assert.equal(arena.claim(ids[wolf]).completed,true);noJudge(arena,id);
});

test('Night faults and admin tasks expose no role, actor, action, phase, invitation or credential secrets',t=>{
 const {arena}=fixture(t),id=arena.create({kind:'werewolf'}).id,ids=connectAll(arena,id);arena.start(id);
 const m=arena.get(id),wolf=m.game.players.find(p=>p.role==='wolf').id,{job}=arena.claim(ids[wolf]);
 const publicBefore=JSON.stringify(arena.public(arena.get(id)));
 submitAction(arena,ids[wolf],{...job,result:{type:'kill',target:'private-night-target-sentinel'}});
 assert.equal(JSON.stringify(arena.public(arena.get(id))),publicBefore);
 const admin=JSON.stringify(arena.adminView(id));
 for(const privateValue of [job.taskId,job.attemptId,job.phase,wolf,'private-night-target-sentinel','targetTask','sourceTask','tokenHash','session','nightVictim'])assert.ok(!admin.includes(privateValue),privateValue);
 assert.equal(arena.public(arena.get(id)).game.phase,'night');assert.ok(arena.public(arena.get(id)).game.players.every(p=>!('role' in p)));
});

test('Legacy judge migration preserves history, converts pending tasks once and revokes every old credential path',async t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi'}).id,ids=connectAll(f.arena,id);f.arena.start(id);
 const token='old-judge-token',invitation='old-judge-invitation',historical={taskId:'past-judge',attemptId:'past-attempt',seat:'judge',status:'submitted',final:true,receipt:{verdict:'acknowledge'}},verdict={id:'historical-verdict',type:'verdict',text:'裁判：确认规则处理',at:'2025-01-01T00:00:00.000Z'};
 f.store.change(state=>{const m=state.matches[id];delete m.participantPolicy;m.bindings.judge={clientId:'old-judge-client',tokenHash:digest(token),provider:'opencode',session:'legacy-judge-session',armed:true,wake:{provider:'opencode',session:'legacy-judge-session',workspace:path.resolve('.'),credentialPath:path.join(f.root,'judge.credential.json')}};m.invites.judge={invitationId:'old-invite',hash:digest(invitation),expiresAt:999999};m.jobs.push({taskId:'pending-judge',attemptId:'pending-attempt',seat:'judge',status:'open',phase:'ply:0',clientId:'old-judge-client',deadline:20000,targetTask:m.jobs[0].taskId,fault:{reason:'invalid_action',seat:'red'}},structuredClone(historical));m.events.push(verdict);m.history.push({index:m.history.length,...verdict,game:f.arena.view(m)});m.receipts['past-attempt']={digest:'stored',reply:{ok:true}}});
 const history=structuredClone(f.arena.get(id).history),events=structuredClone(f.arena.get(id).events),oldIdentity={match:id,seat:'judge',clientId:'old-judge-client'};
 f.restart();const m=f.arena.get(id),converted=m.jobs.find(j=>j.taskId==='pending-judge');
 assert.equal(converted.status,'converted');assert.equal(converted.legacyStatus,'open');assert.equal(converted.fault.seat,'red');assert.equal(m.adminTasks.length,1);assert.equal(m.adminTasks[0].id,converted.convertedToAdminTask);
 assert.deepEqual(m.jobs.find(j=>j.taskId==='past-judge'),historical);assert.deepEqual(m.history,history);assert.deepEqual(m.events,events);assert.equal(m.receipts['past-attempt'].digest,'stored');assert.equal(m.bindings.judge.tokenHash,digest(token));assert.equal(m.bindings.judge.armed,false);assert.ok(m.bindings.judge.revokedAt);assert.ok(m.invites.judge.revokedAt);
 assert.throws(()=>f.arena.identity(token),/Unauthorized/);assert.throws(()=>f.arena.claim(oldIdentity),/revoked/);assert.throws(()=>f.arena.park(oldIdentity),/revoked/);assert.throws(()=>submitAction(f.arena,oldIdentity,{taskId:'pending-judge',attemptId:'pending-attempt',result:{verdict:'acknowledge'}}),/revoked/);assert.throws(()=>f.arena.connect({match:id,seat:'judge',invitation,provider:'simulated',session:'old'}),/Invalid seat/);assert.throws(()=>f.arena.revoke(id,'judge'),/Invalid seat/);
 assert.deepEqual(f.arena.public(m).participants.map(p=>p.seat),['red','black']);
 const roomFile=path.join(f.root,'xiangqi',id+'.json'),beforeRestart=fs.readFileSync(roomFile,'utf8'),metadata=fs.readFileSync(path.join(f.root,'state.json'),'utf8');f.restart();assert.equal(fs.readFileSync(roomFile,'utf8'),beforeRestart);assert.equal(fs.readFileSync(path.join(f.root,'state.json'),'utf8'),metadata);assert.equal(f.arena.get(id).adminTasks.length,1);
 let reads=0,sends=0;const wake=new WakeService(f.arena,{adapters:{opencode:{async read(){reads++;return {}},async send(){sends++;return {delivered:true}}}}});
 await Promise.all(wake.tick());assert.equal(reads,0);assert.equal(sends,0);assert.throws(()=>wake.requestManual({match:id,seat:'judge',bindingId:'old-judge-client',attemptId:'pending-attempt'}),/Invalid seat/);wake.stop();
 assert.equal(act(f.arena,ids.red,{from:[0,6],to:[0,5]}).ok,true);
});

test('Legacy completed final judge work becomes an admin task without holding completion open',t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi',timeoutSeconds:10}).id,ids=connectAll(f.arena,id);f.arena.start(id);f.clock.now+=11000;f.arena.tick();
 f.store.change(s=>{const m=s.matches[id];delete m.participantPolicy;m.jobs.push({taskId:'legacy-final',attemptId:'legacy-final-attempt',seat:'judge',phase:'ply:0',status:'open',deadline:100000,final:true,fault:{reason:'final_result'}})});
 f.restart();assert.equal(f.arena.get(id).jobs.find(j=>j.taskId==='legacy-final').status,'converted');assert.equal(f.arena.adminView(id).tasks.find(t=>t.id==='legacy-judge:legacy-final').canRetry,false);
 for(const identity of Object.values(ids))assert.equal(f.arena.claim(identity).completed,true);
});

test('Admin HTTP controls require authorization, reject arbitrary game fields, and hide task targets',async t=>{
 const root=temporaryDirectory('arena-no-judge-http-'),app=await serve({port:0,root,adminToken:'no-judge-admin'});t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const id=app.arena.create({kind:'xiangqi'}).id,ids=connectAll(app.arena,id);app.arena.start(id);
 const post=(input,token='no-judge-admin')=>fetch(app.origin+'/api/control',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({match:id,...input})});
 assert.equal((await fetch(app.origin+`/api/matches/${id}/admin`)).status,401);assert.equal((await post({action:'pause'},'wrong')).status,401);
 assert.equal((await post({action:'pause',game:{winner:'red'}})).status,400);assert.equal(app.arena.get(id).paused,false);
 assert.equal((await post({action:'pause'})).status,200);assert.equal(app.arena.get(id).paused,true);
 assert.equal((await post({action:'resume'})).status,200);assert.equal(app.arena.get(id).paused,false);
 const {job}=app.arena.claim(ids.red);submitAction(app.arena,ids.red,{...job,result:{from:[0,6],to:[0,3]}});
 const response=await fetch(app.origin+`/api/matches/${id}/admin`,{headers:{Authorization:'Bearer no-judge-admin'}}),admin=await response.json();assert.equal(admin.tasks.length,1);assert.ok(!JSON.stringify(admin).includes(job.taskId));
 assert.equal((await post({action:'retry',taskId:admin.tasks[0].id,result:{from:[0,6],to:[0,5]}})).status,400);
 assert.equal((await post({action:'end',winner:'red'})).status,400);assert.equal((await post({action:'end'})).status,200);assert.equal(app.arena.get(id).game.winner,null);
});

test('Pause cancels an in-flight host read before delivery and explicit resume restores the original remaining time',async t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi',timeoutSeconds:10}).id,workspace=path.resolve('.');let calls=0,release,entered;
 const read=async binding=>({session:binding.session,workspace,status:'idle',messages:[]});
 const adapter={read,async send(binding){assert.equal(binding.canSend(),true);calls++;return {delivered:true}}};
 const wake=new WakeService(f.arena,{adapters:{opencode:adapter},readTimeoutMs:1000});t.after(()=>wake.stop());
 for(const seat of f.arena.seats(f.arena.get(id))){const invitation=f.arena.invite(id,seat,'http://127.0.0.1:4318');await wake.connect({match:id,seat,provider:'opencode',session:'paused-wake-'+seat,credentialPath:path.join(f.root,seat+'.credential.json'),invitation:invitationToken(invitation)})}
 f.arena.start(id);const deadline=f.arena.get(id).jobs[0].deadline,ready=new Promise(resolve=>{entered=resolve});
 adapter.read=binding=>new Promise(resolve=>{release=()=>resolve(read(binding));entered()});
 const work=wake.tick();await ready;f.clock.now+=2000;f.arena.pause(id);release();await Promise.all(work);
 assert.equal(calls,0);assert.equal(wake.diagnostics(id).find(d=>d.seat==='red').canWake,false);
 f.clock.now+=100000;f.arena.tick();await Promise.all(wake.tick({force:true}));assert.equal(calls,0);assert.equal(f.arena.get(id).game.status,'playing');
 f.arena.resume(id);assert.equal(f.arena.get(id).jobs[0].deadline,deadline+100000);adapter.read=read;
 await Promise.all(wake.tick({force:true}));assert.equal(calls,1);assert.equal(f.arena.get(id).jobs[0].wakeNotice.status,'sent');
});

test('All six Werewolf connections and simultaneous player deadlines continue after explicit recovery from repeated timeouts',t=>{
 const {arena,clock}=fixture(t),id=arena.create({kind:'werewolf',timeoutSeconds:10}).id,ids=connectAll(arena,id);arena.start(id);
 let pauses=0;const expire=()=>{clock.now+=10000;arena.tick();for(let i=0;i<6&&arena.get(id).paused;i++){pauses++;arena.resume(id);arena.tick()}};
 const initial=arena.get(id).jobs.filter(j=>j.status==='open');assert.equal(initial.length,2);
 expire();assert.equal(arena.get(id).game.phase,'seer');assert.equal(arena.adminView(id).tasks.length,2);
 expire();assert.equal(arena.get(id).game.phase,'witch');
 expire();assert.equal(arena.get(id).game.phase,'discuss');assert.equal(arena.get(id).jobs.filter(j=>j.status==='open').length,6);
 expire();assert.equal(arena.get(id).game.phase,'vote');
 expire();assert.equal(arena.get(id).game.round,2);assert.equal(arena.get(id).game.phase,'wolf');
 assert.equal(arena.adminView(id).tasks.length,16);assert.equal(arena.get(id).paused,false);assert.equal(arena.get(id).game.players.filter(p=>p.alive).length,6);
 assert.ok(pauses>0);assert.equal(Object.keys(ids).length,6);noJudge(arena,id);
});
