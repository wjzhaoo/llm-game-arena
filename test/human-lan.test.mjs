import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../lib/store.mjs';
import {Arena} from '../lib/arena.mjs';
import {initialWerewolf} from '../lib/werewolf.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
import {serve,clientFiles} from '../server.mjs';
import {arenaUrl,networkAddresses} from '../lib/network.mjs';
import {loopbackUrl} from '../lib/wake/common.mjs';
import {prepareHost} from '../lib/wake/host.mjs';

function fixture(t){
 const root=temporaryDirectory('arena-human-'),store=new Store(root),clock={now:10000},a=new Arena(store,{now:()=>clock.now});
 t.after(()=>{store.close();removeTemporaryDirectory(root)});return {root,store,clock,a};
}
const joinToken=invite=>new URL(invite.url).hash.slice('#join='.length);
function participants(a,id,humanSeats=a.seats(a.get(id))){
 const invitation=a.roomInvite(id,'http://127.0.0.1:4318'),identities={};
 for(const seat of a.seats(a.get(id))){
  let c;
  if(humanSeats.includes(seat)){
   a.setParticipantType(id,seat,'human');c=a.joinHuman({match:id,seat,nickname:'棋友 '+seat,invitation:joinToken(invitation)});
  }else{
   const i=a.invite(id,seat,'http://127.0.0.1:4318');
   c=a.connect({match:id,seat,provider:'simulated',session:'fixture-'+seat,invitation:i.text.match(/--invitation ([a-f0-9]+)/)[1]});
  }
  identities[seat]=a.identity(c.token);
 }
 return identities;
}
for(const kind of ['xiangqi','blind']){
 test(kind+' human and mixed games preserve ownership, retries, deadlines and durable receipts',t=>{
  const {a,clock}=fixture(t),id=a.create({kind,timeoutSeconds:10}).id,ids=participants(a,id,['red']);
  assert.throws(()=>a.setParticipantType(id,'red','ai'),/撤销/);
  a.start(id);assert.throws(()=>a.setParticipantType(id,'black','human'),/开始后/);
  const {job}=a.claim(ids.red),deadline=job.deadline;
  for(let i=0;i<3;i++){assert.equal(a.submit(ids.red,{...job,result:{from:[0,6],to:[0,3]}}).ok,false)}
  assert.equal(a.get(id).jobs[0].invalid,0);assert.equal(a.get(id).jobs[0].deadline,deadline);assert.equal(a.get(id).game.ply,0);
  assert.throws(()=>a.submit(ids.black,{...job,result:{from:[0,6],to:[0,5]}}),/foreign/);
  const action={...job,result:{from:[0,6],to:[0,5]}};
  assert.equal(a.submit(ids.red,action).ok,true);assert.equal(a.submit(ids.red,action).duplicate,true);assert.equal(a.get(id).game.ply,1);
  if(kind==='blind'){
   const view=a.public(a.get(id));assert.equal(view.game.board.flat().filter(p=>p?.hidden).length,29);
   assert.ok(!JSON.stringify(view).includes('"cs"'));assert.ok(!JSON.stringify(view.history).includes('"ck"'));
  }
  const black=a.claim(ids.black).job;a.pause(id);clock.now+=5000;assert.throws(()=>a.submit(ids.black,{...black,result:{from:[0,3],to:[0,4]}}),/paused/);a.resume(id);
  assert.equal(a.get(id).jobs.find(j=>j.taskId===black.taskId).deadline,black.deadline+5000);
  clock.now=a.get(id).jobs.find(j=>j.taskId===black.taskId).deadline+1;a.tick();assert.equal(a.get(id).game.winner,'red');
 });
 test(kind+' all-human game supports refresh, same-type replacement and resignation',t=>{
  const {a}=fixture(t),id=a.create({kind}).id,ids=participants(a,id);a.start(id);
  const first=a.claim(ids.red).job;
  assert.equal(a.playerStatus(ids.red).task.taskId,first.taskId);
  a.revoke(id,'red');assert.throws(()=>a.playerStatus(ids.red),/revoked/);
  const invite=a.roomInvite(id,'http://127.0.0.1:4318'),joined=a.joinHuman({match:id,seat:'red',nickname:'接续',invitation:joinToken(invite)}),replacement=a.identity(joined.token),next=a.claim(replacement).job;
  assert.equal(next.deadline,first.deadline);assert.notEqual(next.attemptId,first.attemptId);
  assert.throws(()=>a.submit(ids.red,{...first,result:{from:[0,6],to:[0,5]}}),/revoked/);
  assert.equal(a.resign(replacement).completed,true);assert.equal(a.get(id).game.winner,'black');
  assert.equal(a.get(id).jobs.filter(j=>j.status==='open').length,0);
 });
}
for(const humanSeats of [['p1','p2','p3','p4','p5','p6'],['p1','p3']]){
 test('Werewolf completes full human/mixed rounds with only seat-private role actions ('+humanSeats.length+' humans)',t=>{
  const {a,store}=fixture(t),id=a.create({kind:'werewolf'}).id;
  store.change(s=>{s.matches[id].game=initialWerewolf({roles:['wolf','wolf','seer','witch','villager','villager']})});
  const ids=participants(a,id,humanSeats);a.start(id);
  const publicBefore=JSON.stringify(a.public(a.get(id)));
  assert.ok(!publicBefore.includes('"self"'));assert.ok(!publicBefore.includes('"role":"wolf"'));
  assert.equal(a.playerStatus(ids.p1).privateView.self.role,'wolf');
  assert.equal(a.view(a.get(id),'p3').phase,'night');
  let safety=0;
  while(a.get(id).game.status!=='finished'&&safety++<100){
   const m=a.get(id),phase=m.game.phase,round=m.game.round;
   for(const seat of a.pending(m)){
    const job=a.claim(ids[seat]).job;
    const result=phase==='wolf'?{type:'kill',target:round===1?'p5':'p6'}:phase==='seer'?{type:'inspect',target:round===1?'p1':'p2'}:phase==='witch'?{type:'witch',save:false,poison:null}:phase==='discuss'?{type:'speak',text:'公开发言'}:{type:'vote',target:round===1?'p1':'p2'};
    assert.equal(a.submit(ids[seat],{...job,result}).ok,true);
   }
  }
  assert.equal(a.get(id).game.winner,'good');
  const history=a.public(a.get(id)).history;assert.ok(!JSON.stringify(history.filter(s=>s.game.status!=='finished')).includes('"revealed"'));
  assert.ok(history.every(snapshot=>snapshot.game.status==='finished'||snapshot.game.players.every(p=>!p.role)));
 });
}
test('Room invitation expiry, AI/human type boundaries and restart defaults are enforced',t=>{
 const {a,clock,root,store}=fixture(t),id=a.create({kind:'xiangqi'}).id;
 const invitation=a.roomInvite(id,'http://127.0.0.1:4318');
 assert.throws(()=>a.joinHuman({match:id,seat:'red',nickname:'x',invitation:joinToken(invitation)}),/真人/);
 a.setParticipantType(id,'red','human');assert.throws(()=>a.invite(id,'red','http://127.0.0.1:4318'),/真人/);
 clock.now+=1800001;assert.throws(()=>a.joinHuman({match:id,seat:'red',nickname:'x',invitation:joinToken(invitation)}),/过期/);
 store.change(s=>{delete s.matches[id].participantTypes});store.close();
 const restored=new Store(root);
 assert.equal(restored.state.matches[id].participantTypes.red,'ai');assert.equal(restored.state.matches[id].history.length,a.get(id).history.length);restored.close();
});
test('LAN Host/Origin, simultaneous joins, credentials and client downloads have strict boundaries',async t=>{
 const root=temporaryDirectory('arena-lan-http-'),app=await serve({port:0,root,adminToken:'fixture-admin',autoTick:false,interfaces:{wifi:[{family:'IPv4',internal:false,address:'192.168.50.2'}]}});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const post=(route,body,token,headers={})=>fetch(app.origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:JSON.stringify(body)});
 const id=app.arena.create({kind:'blind'}).id;for(const seat of ['red','black'])app.arena.setParticipantType(id,seat,'human');
 const invitation=app.arena.roomInvite(id,app.lanOrigins[0]),body={action:'join',match:id,seat:'red',nickname:'真人',invitation:joinToken(invitation)};
 const requests=await Promise.all([post('/api/player',body),post('/api/player',body)]);
 assert.deepEqual(requests.map(r=>r.status).sort(),[200,400]);
 const joined=await requests.find(r=>r.status===200).json();
 assert.equal((await post('/desktop',{action:'claim'},joined.token)).status,401);
 assert.equal((await post('/api/relay',{action:'poll',instanceId:'fixture-relay'},joined.token)).status,401);
 assert.equal((await post('/api/start',{match:id},joined.token)).status,401);
 const black=await post('/api/player',{...body,seat:'black'});assert.equal(black.status,200);
 assert.equal((await post('/api/start',{match:id},'fixture-admin')).status,200);
 const status=await (await post('/api/player',{action:'status'},joined.token)).json();assert.equal(status.seat,'red');assert.ok(status.task);
 const lanHost=new URL(app.lanOrigins[0]).host;
 const rawStatus=headers=>new Promise((resolve,reject)=>{const request=http.get(app.origin+'/api/network',{headers},response=>{response.resume();resolve(response.statusCode)});request.on('error',reject)});
 assert.equal(await rawStatus({Host:lanHost,Origin:app.lanOrigins[0]}),200);
 assert.equal(await rawStatus({Host:lanHost,Origin:app.origin}),403);
 assert.equal(await rawStatus({Host:'evil.example:'+app.server.address().port}),403);
 const manifest=await (await fetch(app.origin+'/api/client-manifest')).json();assert.equal(manifest.files.length,clientFiles.length);
 assert.equal((await fetch(app.origin+'/downloads/server.mjs')).status,404);
 assert.equal((await fetch(app.origin+'/downloads/.arena/state.json')).status,404);
 const remote=path.join(root,'remote');fs.mkdirSync(remote);
 const run=promisify(execFile);
 await run(process.execPath,[path.resolve('public/arena-bootstrap.mjs'),'--url',app.origin,'--workspace',remote],{cwd:remote});
 for(const file of clientFiles)assert.ok(fs.existsSync(path.join(remote,'tmp','arena-client',file)));
 await run(process.execPath,['--check',path.join(remote,'tmp','arena-client','client.mjs')],{cwd:remote});
 const linked=path.join(root,'linked-workspace'),outside=path.join(root,'link-target');
 fs.mkdirSync(linked);fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(linked,'tmp'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(run(process.execPath,[path.resolve('public/arena-bootstrap.mjs'),'--url',app.origin,'--workspace',linked],{cwd:linked}),/without directory links/);
 assert.deepEqual(fs.readdirSync(outside),[],'reject linked ancestors before creating any external directories');
 await assert.rejects(prepareHost({provider:'mimo',session:'fixture',credentialPath:path.join(linked,'tmp','red.credential.json')},{workspace:linked,adapters:{mimo:{}}}),/directory links/);
});
test('Game LAN origins and host bridge origins use different validation policies',()=>{
 assert.equal(arenaUrl('http://192.168.1.2:4318/desktop').hostname,'192.168.1.2');
 for(const url of ['https://192.168.1.2','http://8.8.8.8','http://user:secret@192.168.1.2','http://example.com'])assert.throws(()=>arenaUrl(url));
 assert.throws(()=>loopbackUrl('http://192.168.1.2:5000'));
 assert.equal(networkAddresses(4318,'127.0.0.1',{wifi:[{family:'IPv4',address:'192.168.1.2'}]}).lanOrigins.length,0);
});
