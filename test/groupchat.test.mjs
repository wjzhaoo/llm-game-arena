import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Arena} from '../lib/arena.mjs';
import {Store} from '../lib/store.mjs';
import {serve} from '../server.mjs';
import {WakeService} from '../lib/wake.mjs';
import {RelayService} from '../lib/relay.mjs';
import {RelayWorker} from '../lib/relay-worker.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
import {initialGroupchat,addChatMember,beginChatRound,applyGroupchat,timeoutGroupchat,groupchatView,chatMessages,removeChatMember} from '../lib/groupchat.mjs';
const options={now:10000,timeoutMs:10000,pick:()=>0};
function engine(count=3){const g=initialGroupchat({topic:'怎样建设月球城市？'});for(let i=0;i<count;i++){const p=addChatMember(g,{type:'ai',profile:{personality:'秘密性格'+i,initialOpinion:'秘密观点'+i}});p.connected=true}beginChatRound(g,options);return g}
function fixture(t){const root=temporaryDirectory('arena-chat-'),store=new Store(root),clock={now:10000},a=new Arena(store,{now:()=>clock.now,chatPick:()=>0});t.after(()=>{store.close();removeTemporaryDirectory(root)});return {root,store,clock,a}}
function addAI(a,id,nickname='AI',profile){const {seat}=a.chatMembers(id,{action:'add-ai',nickname,profile}),inv=a.invite(id,seat,'http://127.0.0.1:4318'),c=a.connect({match:id,seat,provider:'simulated',session:'chat-'+seat,invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1]});return a.identity(c.token)}
function submit(a,identity,result){const {job}=a.claim(identity);assert.ok(job);return a.submit(identity,{...job,result})}

test('Groupchat strict bidding, private ballots, random tied winners and consecutive speakers',()=>{
 const g=engine();
 for(const score of [-1,101,0.5,'100',null])assert.throws(()=>applyGroupchat(g,'p1',{type:'bid',score},options));
 applyGroupchat(g,'p1',{type:'bid',score:100},options);
 assert.equal(groupchatView(g).submitted,1);assert.ok(!JSON.stringify(groupchatView(g)).includes('秘密'));
 assert.equal(groupchatView(g,'p2').self.score,null);assert.equal(groupchatView(g,'p1').self.score,100);
 assert.throws(()=>applyGroupchat(g,'p1',{type:'bid',score:99},options));
 applyGroupchat(g,'p2',{type:'bid',score:100},options);applyGroupchat(g,'p3',{type:'bid',score:0},{...options,pick:n=>{assert.equal(n,2);return 1}});
 assert.equal(g.speaker,'p2');assert.deepEqual(g.lastSelection.scores.map(p=>p.score),[100,100,0]);
 assert.throws(()=>applyGroupchat(g,'p1',{type:'speak',text:'越权'},options));
 applyGroupchat(g,'p2',{type:'speak',text:'支持月球基地',emote:{id:'encourage',targetSeat:'p1'}},options);
 assert.equal(g.round,2);assert.equal(g.messages.length,1);assert.equal(g.messages[0].emote.label,'鼓励');
 for(const id of g.roster.slice())applyGroupchat(g,id,{type:'bid',score:id==='p2'?100:0},options);
 assert.equal(g.speaker,'p2');
});
test('Groupchat abstention, timeout, membership snapshots and next-round profiles',()=>{
 const g=engine(2);g.members[0].profile.personality='下轮性格';
 assert.equal(groupchatView(g,'p1').self.profile.personality,'秘密性格0');
 const p=addChatMember(g,{type:'human'});p.connected=true;
 assert.deepEqual(g.roster,['p1','p2']);
 applyGroupchat(g,'p1',{type:'bid',score:0},options);timeoutGroupchat(g,'p2',options);
 assert.equal(g.phase,'idle');assert.equal(g.idleReason,'abstained');assert.equal(g.lastSelection.scores[1].score,null);
 beginChatRound(g,options);assert.deepEqual(g.roster,['p1','p2','p3']);assert.equal(groupchatView(g,'p1').self.profile.personality,'下轮性格');
 for(const id of g.roster.slice())applyGroupchat(g,id,{type:'bid',score:id==='p1'?100:0},options);
 timeoutGroupchat(g,'p1',options);assert.equal(g.round,3);assert.equal(g.messages.length,0);
 removeChatMember(g,'p1',options);assert.ok(!g.roster.includes('p1'));removeChatMember(g,'p2',options);assert.equal(g.idleReason,'members');
});
test('Groupchat context is bounded, historical messages complete and projections isolated',()=>{
 const g=engine(2);
 for(let i=1;i<=65;i++)g.messages.push({seq:i,type:'speak',text:'汉'.repeat(1000),seat:'p1',sender:{seat:'p1'},at:'2026-10-16T00:00:00.000Z',emote:null});
 const view=groupchatView(g);assert.equal(view.messages.length,20);assert.equal(view.contextTruncated,true);assert.equal(view.historyBefore,46);
 assert.equal(view.messages.reduce((n,m)=>n+Array.from(m.text).length,0),20000);
 let page=chatMessages(g,{before:46,limit:10});assert.equal(page.messages[0].seq,36);assert.equal(page.nextBefore,36);assert.equal(page.hasMore,true);
 page.messages[0].text='改写';assert.notEqual(g.messages[35].text,'改写');
 assert.throws(()=>chatMessages(g,{limit:101}));assert.throws(()=>chatMessages(g,{before:0}));
 assert.equal('messages' in groupchatView(g,null,{snapshot:true}),false);
 g.messages.at(-1).text='🙂'.repeat(25000);const huge=groupchatView(g).messages.at(-1);assert.equal(Array.from(huge.text).length,20000);assert.equal(huge.truncated,true);
});
test('Arena groupchat dynamic joins, independent emotes, profile privacy, invalid actions and receipts',t=>{
 const {a,clock}=fixture(t),id=a.create({kind:'groupchat',topic:'月球城市',timeoutSeconds:10}).id;
 assert.throws(()=>a.start(id),/All players/);
 const first=addAI(a,id,'甲',{personality:'PRIVATE-PERSONALITY',initialOpinion:'PRIVATE-OPINION'}),second=addAI(a,id,'乙');
 a.chatMembers(id,{action:'add-ai',nickname:'尚未接入'});a.start(id);
 const job=a.claim(first).job,originalDeadline=job.deadline;
 a.profile(first,{profile:{personality:'NEXT-PRIVATE'}});assert.equal(a.claim(first).job.view.self.profile.personality,'PRIVATE-PERSONALITY');
 assert.ok(!JSON.stringify(a.public(a.get(id),true)).includes('PRIVATE'));assert.ok(JSON.stringify(a.adminView(id)).includes('NEXT-PRIVATE'));
 assert.equal(a.claim(second).job.view.self.profile.personality,'');
 a.emote(second,{emote:'provoke',targetSeat:first.seat});assert.equal(a.claim(first).job.deadline,originalDeadline);assert.equal(a.get(id).game.round,1);
 assert.throws(()=>a.emote(second,{emote:'mock'}),/过快/);clock.now+=1500;assert.throws(()=>a.emote(second,{emote:'mock',targetSeat:'p999'}),/目标/);
 const result={type:'bid',score:91};assert.equal(a.submit(first,{...job,result}).ok,true);assert.equal(a.submit(first,{...job,result}).duplicate,true);
 assert.equal(a.get(id).game.lastSelection,null);submit(a,second,{type:'bid',score:10});
 const speech=a.claim(first).job,action={type:'speak',text:'先建设研究站',emote:{id:'encourage'}};
 assert.equal(a.submit(first,{...speech,result:action}).ok,true);assert.equal(a.submit(first,{...speech,result:action}).duplicate,true);
 assert.equal(a.get(id).game.messages.filter(m=>m.type==='speak').length,1);assert.equal(a.claim(first).job.view.self.profile.personality,'NEXT-PRIVATE');
 const old=a.claim(first).job;a.revoke(id,first.seat);assert.throws(()=>a.submit(first,{...old,result:{type:'bid',score:100}}),/revoked/);
 assert.equal(a.get(id).jobs.filter(j=>j.status==='open').length,0);
 const late=addAI(a,id,'新成员');assert.equal(a.get(id).game.phase,'bid');assert.ok(a.get(id).game.roster.includes(late.seat));
 assert.ok(!JSON.stringify(a.public(a.get(id))).includes('PRIVATE'));
});
test('Arena groupchat simultaneous human allocation, idle restart, timeout, pause and durable recovery',t=>{
 const {a,clock,store,root}=fixture(t),id=a.create({kind:'groupchat',topic:'自由话题',timeoutSeconds:10}).id;
 const invitation=new URL(a.roomInvite(id,'http://127.0.0.1:4318').url).hash.slice(6),ids=[];
 for(let i=0;i<12;i++){const c=a.joinHuman({match:id,invitation,nickname:'成员'+i,profile:{initialOpinion:'个人秘密'+i}});ids.push(a.identity(c.token))}
 assert.equal(new Set(ids.map(p=>p.seat)).size,12);assert.equal(ids.at(-1).seat,'p12');a.start(id);
 const j=a.claim(ids[0]).job;a.pause(id);clock.now+=5000;a.resume(id);assert.equal(a.claim(ids[0]).job.deadline,j.deadline+5000);
 for(const me of ids)submit(a,me,{type:'bid',score:0});assert.equal(a.get(id).game.phase,'idle');
 assert.equal(a.get(id).jobs.some(j=>j.status==='open'),false);a.restartChat(id,ids[1]);const round=a.get(id).game.round;
 assert.equal(a.restartChat(id,ids[1]).duplicate,true);assert.equal(a.get(id).game.round,round);
 const invalid=a.claim(ids[0]).job;assert.equal(a.submit(ids[0],{...invalid,result:{type:'bid',score:101}}).ok,false);assert.equal(a.get(id).jobs.find(j=>j.taskId===invalid.taskId).invalid,0);
 clock.now+=10001;a.tick();assert.equal(a.get(id).game.phase,'idle');
 a.restartChat(id,ids[0]);for(const me of ids)submit(a,me,{type:'bid',score:me===ids[0]?100:0});
 const winner=a.get(id).game.speaker,deadline=a.get(id).game.phaseDeadline;store.close();
 const restored=new Store(root);try{const b=new Arena(restored,{now:()=>clock.now});assert.equal(b.get(id).game.speaker,winner);assert.equal(b.get(id).game.phaseDeadline,deadline);assert.equal('boardRevision' in b.get(id),false);assert.ok(!JSON.stringify(b.public(b.get(id),true)).includes('个人秘密'));b.end(id);assert.equal(b.get(id).game.phase,'finished');assert.equal(b.claim(ids[0]).completed,true);assert.ok(!JSON.stringify(b.public(b.get(id))).includes('平局'))}finally{restored.close()}
});
test('Groupchat removed highest bidder loses eligibility, late joins wait, and paused removal keeps frozen time',t=>{
 const {a,clock}=fixture(t),id=a.create({kind:'groupchat',topic:'动态成员',timeoutSeconds:10}).id;
 const ids=[addAI(a,id,'甲'),addAI(a,id,'乙'),addAI(a,id,'丙'),addAI(a,id,'丁')];a.start(id);
 submit(a,ids[0],{type:'bid',score:100});a.revoke(id,ids[0].seat);
 const late=addAI(a,id,'后来者');assert.equal(a.claim(late).job,null);
 submit(a,ids[1],{type:'bid',score:30});submit(a,ids[2],{type:'bid',score:50});submit(a,ids[3],{type:'bid',score:0});assert.equal(a.get(id).game.speaker,ids[2].seat);
 assert.ok(!a.get(id).game.lastSelection.scores.some(p=>p.seat===ids[0].seat));
 a.pause(id);clock.now+=7000;a.revoke(id,ids[2].seat);assert.equal(a.get(id).game.phase,'bid');assert.equal(a.get(id).jobs.some(j=>j.status==='open'),false);
 clock.now+=3000;a.resume(id);const job=a.claim(ids[1]).job;assert.equal(job.deadline-clock.now,10000);assert.ok(a.get(id).game.roster.includes(late.seat));
 const before=a.get(id).game.round;a.claim(late);submit(a,ids[1],{type:'bid',score:2});submit(a,ids[3],{type:'bid',score:0});
 const bad=a.claim(late).job;a.submit(late,{...bad,result:{type:'bid',score:101}});a.submit(late,{...bad,result:{type:'bid',score:-1}});
 assert.equal(a.get(id).game.round,before);assert.equal(a.get(id).game.phase,'speak');assert.equal(a.get(id).game.speaker,ids[1].seat);
 const oldFrame=a.get(id).history.find(h=>h.type==='started').game;assert.ok(!oldFrame.members.some(p=>p.seat===late.seat));assert.equal('messages' in oldFrame,false);
});
test('Groupchat HTTP authorization, paged history, private profiles and actual CLI commands',async t=>{
 const root=temporaryDirectory('arena-chat-http-'),app=await serve({port:0,root,adminToken:'chat-admin',autoTick:false});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const post=async(route,body,token='')=>{const r=await fetch(app.origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 let r=await post('/api/matches',{kind:'groupchat',topic:'未来交通'},'chat-admin');assert.equal(r.status,201);const id=r.body.id;
 assert.equal((await post('/api/chat-members',{match:id,action:'add-ai'})).status,401);
 const add=await post('/api/chat-members',{match:id,action:'add-ai',profile:{personality:'HTTP-SECRET'}},'chat-admin'),seat=add.body.seat;
 const inv=app.arena.invite(id,seat,app.origin),credential=path.join(root,'chat.credential.json'),run=promisify(execFile);
 await run(process.execPath,['client.mjs','connect','--url',app.origin,'--match',id,'--seat',seat,'--invitation',inv.text.match(/--invitation ([a-f0-9]+)/)[1],'--provider','simulated','--session','chat-cli','--out',credential]);
 const invitation=new URL(app.arena.roomInvite(id,app.origin).url).hash.slice(6);
 const joined=await post('/api/player',{action:'join',match:id,invitation,nickname:'真人',profile:{initialOpinion:'HUMAN-SECRET'}});assert.equal(joined.status,200);
 app.arena.start(id);
 const cli=async(...args)=>JSON.parse((await run(process.execPath,['client.mjs',...args,'--credential',credential])).stdout);
 assert.equal((await cli('profile')).profile.personality,'HTTP-SECRET');
 const file=path.join(root,'profile.json');fs.writeFileSync(file,JSON.stringify({personality:'CLI-SECRET'}));assert.equal((await cli('profile','--file',file)).ok,true);
 assert.equal((await cli('emote','--emote','entice','--target',joined.body.seat)).ok,true);assert.equal((await cli('history')).messages[0].emote.label,'诱惑');
 assert.equal((await fetch(app.origin+'/api/matches/'+id+'/messages?limit=0')).status,400);
 assert.ok(!JSON.stringify(await (await fetch(app.origin+'/api/matches/'+id)).json()).includes('SECRET'));
 const token=JSON.parse(fs.readFileSync(credential)).token;
 const other=await post('/api/player',{action:'profile',seat,profile:{initialOpinion:'OWN-ONLY'}},joined.body.token);assert.equal(other.body.ok,true);assert.equal((await cli('profile')).profile.personality,'CLI-SECRET');
 assert.equal((await post('/api/player',{action:'profile'},token)).status,401);
 assert.equal((await fetch(app.origin+'/groupchat.js')).status,200);
});
for(const transport of ['local','relay'])test('Groupchat '+transport+' wakes bidding and speaking jobs without exposing profiles in notifications',async t=>{
 const {a,root}=fixture(t),workspace=path.resolve('.'),calls=[],messages=[];
 const adapter={read:async b=>({session:b.session,workspace,status:'idle',messages}),send:async(_b,prompt)=>{calls.push(prompt);messages.push({role:'user',text:prompt});return {delivered:true}}};
 const wake=new WakeService(a,{workspace,adapters:{opencode:adapter}}),relay=new RelayService(a,wake);t.after(()=>wake.stop());
 const id=a.create({kind:'groupchat',topic:'测试唤醒',timeoutSeconds:3600}).id,{seat}=a.chatMembers(id,{action:'add-ai',profile:{personality:'WAKE-PRIVATE'}});
 const inv=a.invite(id,seat,'http://127.0.0.1:4318'),input={match:id,seat,provider:'opencode',session:'ses_chat_'+transport,credentialPath:path.join(root,'chat.credential.json'),invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1]};
 const connection=transport==='local'?await wake.connect(input):relay.connect({...input,relayVerification:{verified:true,workspaceVerified:true,deviceId:'b'.repeat(64)}});
 const invitation=new URL(a.roomInvite(id,'http://127.0.0.1:4318').url).hash.slice(6),human=a.identity(a.joinHuman({match:id,invitation,nickname:'真人'}).token),identity=a.identity(connection.token);
 const worker=transport==='relay'?new RelayWorker({config:{...input,workspace},adapter,script:path.resolve('client.mjs'),instanceId:'groupchat-worker',request:async body=>{const me=relay.identity(connection.relayToken);return body.action==='poll'?relay.poll(me,body):relay.report(me,body)}}):null;
 const deliver=async()=>{if(worker)await worker.step();else await Promise.all(wake.tick())};
 a.start(id);await deliver();await deliver();assert.equal(calls.length,1);
 assert.ok(!calls[0].includes('WAKE-PRIVATE'));const bid=a.claim(identity).job;assert.equal(bid.kind,'chat-bid');assert.equal(bid.view.self.profile.personality,'WAKE-PRIVATE');assert.equal(bid.interactions.emotes.length,9);
 a.submit(identity,{...bid,result:{type:'bid',score:100}});a.park(identity);submit(a,human,{type:'bid',score:0});await deliver();assert.equal(calls.length,2);
 assert.equal(a.claim(identity).job.kind,'chat-speak');a.end(id);assert.equal(a.claim(identity).completed,true);
});
