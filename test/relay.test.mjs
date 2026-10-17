import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../lib/store.mjs';
import {Arena} from '../lib/arena.mjs';
import {WakeService} from '../lib/wake.mjs';
import {RelayService} from '../lib/relay.mjs';
import {RelayWorker} from '../lib/relay-worker.mjs';
import {prepareHost} from '../lib/wake/host.mjs';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
const run=promisify(execFile),workspace=path.resolve('.');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t){
 const root=temporaryDirectory('arena-relay-'),store=new Store(root),clock={now:10000},arena=new Arena(store,{now:()=>clock.now}),wake=new WakeService(arena,{workspace,adapters:{opencode:{read(){throw Error('Remote host must not be inspected on game server')}}}}),relay=new RelayService(arena,wake);
 t.after(()=>{wake.stop();store.close();removeTemporaryDirectory(root)});return {root,store,clock,arena,wake,relay};
}
function connect(f,id,seat,deviceId='a'.repeat(64),session='ses_remote_fixture'){
 const invitation=f.arena.invite(id,seat,'http://127.0.0.1:4318');
 return f.relay.connect({match:id,seat,provider:'opencode',session,invitation:invitation.text.match(/--invitation ([a-f0-9]+)/)[1],relayVerification:{verified:true,workspaceVerified:true,deviceId}});
}
function human(f,id,seat){
 f.arena.setParticipantType(id,seat,'human');const invite=f.arena.roomInvite(id,'http://127.0.0.1:4318');
 const c=f.arena.joinHuman({match:id,seat,nickname:'真人',invitation:new URL(invite.url).hash.slice(6)});return f.arena.identity(c.token);
}
function worker(f,connected,{messages=[],calls=[],send,instanceId='fixture-instance',...options}={}){
 const config={provider:'opencode',session:'ses_remote_fixture',workspace,credentialPath:path.join(f.root,'remote.credential.json')};
 const adapter={read:async()=>({session:config.session,workspace,status:'idle',messages}),send:send||(async(binding,prompt)=>{assert.equal(binding.canSend(),true);calls.push(prompt);messages.push({role:'user',text:prompt});return {delivered:true,evidence:'user-message'}})};
 const instance=new RelayWorker({config,adapter,script:path.join(workspace,'client.mjs'),instanceId,now:()=>Date.now()+86400000,request:async body=>{
  const identity=f.relay.identity(connected.relayToken);return body.action==='poll'?f.relay.poll(identity,body):f.relay.report(identity,body);
 },...options});
 return {instance,adapter,messages,calls};
}

test('Remote hosts must attest the workspace; local legacy Qoder remains compatible and failures retain invitations',async t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi'}).id,invite=f.arena.invite(id,'red','http://127.0.0.1:4318');
 const input={provider:'qoder',session:'fixture-qoder',credentialPath:path.join(f.root,'red.credential.json')};
 const options={workspace,adapters:{qoder:{verify:async()=>({session:input.session,workspaceVerified:false,status:'idle',messages:[]})}}};
 assert.equal((await prepareHost(input,options)).workspaceVerified,false);
 await assert.rejects(prepareHost(input,{...options,requireWorkspace:true}),/工作目录核验证据/);
 assert.throws(()=>f.relay.connect({...input,match:id,seat:'red',invitation:invite.text.match(/--invitation ([a-f0-9]+)/)[1],relayVerification:{verified:true,workspaceVerified:false,deviceId:'a'.repeat(64)}}),/工作目录/);
 assert.equal(f.arena.get(id).invites.red.invitationId,invite.invitationId);assert.equal(f.arena.activeBinding(f.arena.get(id),'red'),undefined);
});
test('Remote notification does not claim actions; completion wakes once and game-server adapters stay unused',async t=>{
 const f=fixture(t),id=f.arena.create({kind:'blind'}).id,black=human(f,id,'black'),red=connect(f,id,'red'),w=worker(f,red);
 assert.equal((await w.instance.step()).idle,true);
 f.arena.start(id);await Promise.all(f.wake.tick());assert.equal(w.calls.length,0);
 await w.instance.step();assert.equal(w.calls.length,1);assert.equal(f.arena.get(id).jobs[0].clientId,null);
 await w.instance.step();assert.equal(w.calls.length,1);
 const identity=f.arena.identity(red.token),job=f.arena.claim(identity).job;
 assert.equal(f.arena.submit(identity,{...job,result:{from:[0,6],to:[0,5]}}).ok,true);
 f.arena.park(identity);f.arena.resign(black);await w.instance.step();await w.instance.step();
 assert.equal(w.calls.length,2);assert.equal(w.instance.stopped,false);assert.equal((await w.instance.step()).completed,true);
 assert.ok(!JSON.stringify(f.arena.public(f.arena.get(id))).includes(red.relayToken));
 assert.throws(()=>f.arena.identity(red.relayToken),/Unauthorized/);
 assert.throws(()=>f.relay.identity(red.token),/Unauthorized/);
});
test('Uncertain delivery survives restart, relay leases prevent duplicates and marker readback reconciles',async t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi',timeoutSeconds:3600}).id;human(f,id,'black');const red=connect(f,id,'red');f.arena.start(id);
 const calls=[],messages=[],first=worker(f,red,{calls,messages,send:async(_binding,prompt)=>{calls.push(prompt);throw Error('Unknown delivery outcome')}});
 await first.instance.step();await first.instance.step();assert.equal(calls.length,1);
 f.clock.now+=3001;
 const another=worker(f,red,{calls,messages,instanceId:'second-instance'});
 assert.equal((await another.instance.step()).leased,true);assert.equal(calls.length,1);
 messages.push({role:'user',text:calls[0]});
 f.store.close();const restored=new Store(f.root),arena=new Arena(restored,{now:()=>f.clock.now}),wake=new WakeService(arena),relay=new RelayService(arena,wake);
 f.clock.now+=90001;
 const resumed=new RelayWorker({config:first.instance.config,adapter:first.adapter,script:path.join(workspace,'client.mjs'),instanceId:'restarted-instance',request:async body=>{const i=relay.identity(red.relayToken);return body.action==='poll'?relay.poll(i,body):relay.report(i,body)}});
 await resumed.step();assert.equal(calls.length,1);assert.equal(wake.diagnostics(id)[0].status,'sent');
 assert.equal(arena.get(id).jobs[0].clientId,null);wake.stop();restored.close();
});
test('Remote session uniqueness is scoped by device and revoke invalidates both credentials',t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi'}).id,red=connect(f,id,'red');
 assert.throws(()=>connect(f,id,'black'),/already bound/);
 const black=connect(f,id,'black','b'.repeat(64));assert.equal(black.parked,true);
 f.arena.start(id);const job=f.arena.claim(f.arena.identity(red.token)).job;
 f.arena.revoke(id,'red');assert.throws(()=>f.relay.identity(red.relayToken),/Unauthorized/);assert.throws(()=>f.arena.identity(red.token),/Unauthorized/);
 const replacement=connect(f,id,'red');assert.equal(f.arena.claim(f.arena.identity(replacement.token)).job.deadline,job.deadline);
});
test('Pause during remote host read prevents sending; resume preserves remaining deadline',async t=>{
 const f=fixture(t),id=f.arena.create({kind:'xiangqi'}).id;human(f,id,'black');const red=connect(f,id,'red');f.arena.start(id);
 const w=worker(f,red),original=w.adapter.read;let release;
 w.adapter.read=()=>new Promise(resolve=>{release=()=>original().then(resolve)});
 const attempt=w.instance.step();while(!release)await sleep(1);
 const deadline=f.arena.get(id).jobs[0].deadline;f.arena.pause(id);f.clock.now+=5000;release();
 await assert.rejects(attempt,/Stale relay/);assert.equal(w.calls.length,0);f.arena.resume(id);w.adapter.read=original;
 await w.instance.step();assert.equal(w.calls.length,1);assert.equal(f.arena.get(id).jobs[0].deadline,deadline+5000);
});
test('Automatic and manual local wakes racing deliver a single notification',async t=>{
 const root=temporaryDirectory('arena-wake-race-'),calls=[],messages=[];
 const adapter={verify:async b=>({session:b.session,workspace,status:'idle',messages}),read:async b=>({session:b.session,workspace,status:'idle',messages}),send:async(_b,prompt)=>{calls.push(prompt);messages.push({role:'user',text:prompt});return {delivered:true}}};
 const app=await serve({port:0,root,autoTick:false,wakeOptions:{workspace,adapters:{opencode:adapter}}});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const id=app.arena.create({kind:'xiangqi'}).id;
 for(const seat of ['red','black']){
  const invite=app.arena.invite(id,seat,app.origin);
  await app.wake.connect({match:id,seat,provider:'opencode',session:'ses_fixture_'+seat,credentialPath:path.join(root,seat+'.credential.json'),invitation:invite.text.match(/--invitation ([a-f0-9]+)/)[1]});
 }
 app.arena.start(id);const d=app.wake.diagnostics(id)[0];app.tick();
 const request=app.wake.requestManual({match:id,seat:'red',bindingId:d.bindingId,attemptId:d.attemptId});assert.equal(request.duplicate,true);
 await Promise.all(app.wake.inFlight.values());assert.equal(calls.length,1);
});
test('Downloaded CLI verifies a remote host before consuming invitation and relays only to that local host',async t=>{
 const root=temporaryDirectory('arena-relay-cli-'),remote=path.join(root,'remote');fs.mkdirSync(remote);
 const history=[{info:{role:'assistant',providerID:'fixture',modelID:'model'},parts:[{type:'text',text:'待命'}]}],sent=[];
 const bridgeToken='c'.repeat(64);
 const bridge=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+bridgeToken);
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.endsWith('/events')){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('event: idle\ndata: {}\n\n');return}
  if(url.pathname.endsWith('/turns')){
   let body='';for await(const c of req)body+=c;const action=JSON.parse(body);sent.push(action);history.push({info:{role:'user'},parts:[{type:'text',text:action.message}]});
   res.writeHead(202,{'Content-Type':'application/json'});res.end('{"ok":true}');return;
  }
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(url.pathname.endsWith('/messages')?{messages:history}:{sessions:[{id:'remote-mimo',directory:remote}]}));
 });
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
 const discovery=path.join(remote,'desktop-api.json');fs.writeFileSync(discovery,JSON.stringify({api:1,port:bridge.address().port,token:bridgeToken}));
 const app=await serve({port:0,root:path.join(root,'server'),autoTick:false,wakeOptions:{adapters:{mimo:{verify(){throw Error('Must not verify remote session on game server')}}}}});
 let relayFile;
 t.after(async()=>{
  if(relayFile){
   try{const lock=JSON.parse(fs.readFileSync(relayFile+'.lock','utf8'));process.kill(lock.pid)}catch{}
   await sleep(100);
  }
  await app.close();bridge.closeAllConnections();await new Promise(r=>bridge.close(r));removeTemporaryDirectory(root);
 });
 await run(process.execPath,[path.resolve('public/arena-bootstrap.mjs'),'--url',app.origin,'--workspace',remote],{cwd:remote});
 const script=path.join(remote,'tmp','arena-client','client.mjs'),credential=path.join(remote,'tmp','red.credential.json'),env={...process.env,ARENA_MIMO_DISCOVERY:discovery};
 const id=app.arena.create({kind:'xiangqi'}).id;app.arena.setParticipantType(id,'black','human');
 const invitation=app.arena.invite(id,'red',app.origin),token=invitation.text.match(/--invitation ([a-f0-9]+)/)[1];
 const connectArgs=[script,'connect','--url',app.origin,'--match',id,'--seat','red','--invitation',token,'--provider','mimo','--wake-transport','relay','--workspace',remote,'--out',credential,'--session'];
 await assert.rejects(run(process.execPath,[...connectArgs,'missing-session'],{cwd:remote,env}),/session not found/);
 assert.ok(app.arena.get(id).invites.red);assert.ok(!fs.existsSync(credential));
 const result=await run(process.execPath,[...connectArgs,'remote-mimo'],{cwd:remote,env}),connected=JSON.parse(result.stdout);
 assert.equal(connected.parked,true);relayFile=credential.replace('.credential.json','.relay.credential.json');
 const privateCredential=JSON.parse(fs.readFileSync(credential,'utf8')),privateRelay=JSON.parse(fs.readFileSync(relayFile,'utf8'));
 assert.ok(!result.stdout.includes(privateCredential.token));assert.ok(!result.stdout.includes(privateRelay.relayToken));assert.ok(!result.stdout.includes(bridgeToken));
 const room=app.arena.roomInvite(id,app.origin);app.arena.joinHuman({match:id,seat:'black',nickname:'真人',invitation:new URL(room.url).hash.slice(6)});app.arena.start(id);
 for(let i=0;i<80&&sent.length===0;i++)await sleep(100);
 assert.equal(sent.length,1);assert.equal(sent[0].model,'fixture/model');assert.equal(sent[0].dir,remote);assert.equal(app.arena.get(id).jobs[0].clientId,null);
 const claimed=JSON.parse((await run(process.execPath,[script,'resume','--credential',credential],{cwd:remote,env})).stdout);
 assert.equal(claimed.job.seat,'red');
 const response=path.join(remote,'tmp','response.json');fs.writeFileSync(response,JSON.stringify({from:[0,6],to:[0,5]}));
 const submitted=JSON.parse((await run(process.execPath,[script,'submit','--credential',credential,'--task',claimed.job.taskId,'--attempt',claimed.job.attemptId,'--file',response],{cwd:remote,env})).stdout);
 assert.equal(submitted.ok,true);assert.equal(app.arena.get(id).game.ply,1);
 app.arena.revoke(id,'red');
 for(let i=0;i<60&&fs.existsSync(relayFile+'.lock');i++)await sleep(100);
 assert.equal(fs.existsSync(relayFile+'.lock'),false);
});
