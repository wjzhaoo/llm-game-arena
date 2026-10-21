import test from 'node:test';
import assert from 'node:assert/strict';
import {initialGroupchat,addChatMember,beginChatRound,applyGroupchat,timeoutGroupchat,pendingGroupchat} from '../lib/groupchat.mjs';
import {initialLiarsdice,liarsdiceView} from '../lib/games/liarsdice.mjs';
import {Arena} from '../lib/arena.mjs';
import {Store} from '../lib/store.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
import {submitAction} from './action-fixture.mjs';
const options={now:1000,timeoutMs:10000,pick:()=>0};
function chat(){const g=initialGroupchat({topic:'讨论'});for(let i=0;i<2;i++)addChatMember(g).connected=true;beginChatRound(g,options);return g}
function round(g,other=0,skip=false){for(const seat of [...g.roster])applyGroupchat(g,seat,{type:'bid',score:seat==='p1'?100:other},options);if(skip)timeoutGroupchat(g,g.speaker,options);else applyGroupchat(g,g.speaker,{type:'speak',text:'新的观点'},options)}

test('solo discussion stops after fifth speech, stays idle, and explicit restart resets counters',()=>{
 const g=chat();for(let i=0;i<4;i++)round(g);assert.equal(g.phase,'bid');round(g);
 assert.equal(g.phase,'idle');assert.equal(g.idleReason,'solo-limit');assert.equal(g.messages.length,5);assert.deepEqual(pendingGroupchat(g),[]);
 timeoutGroupchat(g,'p1',options);assert.equal(g.round,5);
 beginChatRound(g,options);assert.equal(g.round,6);round(g);assert.equal(g.phase,'bid');assert.equal(g.soloRounds,1);
});
test('multiple applicants reset solo streak even when same speaker wins; forty rounds stop including skipped speech',()=>{
 const g=chat();for(let i=0;i<4;i++)round(g);round(g,1);assert.equal(g.soloRounds,0);
 for(let i=5;i<40;i++)round(g,1,i===39);
 assert.equal(g.idleReason,'round-limit');assert.equal(g.round,40);assert.equal(g.messages.length,39);
 beginChatRound(g,options);assert.equal(g.continuousRounds,1);assert.equal(g.round,41);
});
test('dice rule check includes ace conversion and uses only own dice plus public counts',()=>{
 const g=initialLiarsdice({playerCount:2});g.players[0].dice=[1,5,3,4,6];g.bid={seat:'p2',quantity:3,face:6};
 const check=liarsdiceView(g,'p1').ruleCheck;
 assert.deepEqual(check.minimumBids,[{face:1,quantity:2},...Array.from({length:5},(_,i)=>({face:i+2,quantity:4}))]);
 assert.equal(check.currentBid.knownMatches,2);assert.equal(check.currentBid.unknownDice,5);assert.ok(Math.abs(check.currentBid.expectedTotal-(2+5/3))<1e-12);
 g.players[1].dice=[1,1,1,1,1];assert.deepEqual(liarsdiceView(g,'p1').ruleCheck,check);
 assert.equal(liarsdiceView(g).ruleCheck.currentBid,undefined);
 g.bid={seat:'p2',quantity:5,face:1};assert.deepEqual(liarsdiceView(g,'p1').ruleCheck.minimumBids,[{face:1,quantity:6}]);
 assert.equal(liarsdiceView(g,'p1').ruleCheck.currentBid.unknownMatchProbability,1/6);
});
function arena(t){
 const root=temporaryDirectory('guards-'),store=new Store(root),clock={now:1000},a=new Arena(store,{now:()=>clock.now});
 t.after(()=>{store.close();removeTemporaryDirectory(root)});
 const id=a.create({kind:'groupchat',topic:'讨论',timeoutSeconds:10}).id,ids=[];
 for(let i=0;i<2;i++){const {seat}=a.chatMembers(id,{action:'add-ai',nickname:'选手'+i}),inv=a.invite(id,seat,'http://localhost'),c=a.connect({match:id,seat,provider:'simulated',session:'guard-'+seat,invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1]});ids.push(a.identity(c.token))}
 a.start(id);return {a,id,ids,clock,store,root};
}
test('second unclaimed timeout pauses whole room, survives reload and resume resets streaks',t=>{
 const {a,id,ids,clock,store,root}=arena(t);
 clock.now+=10001;a.tick();assert.equal(a.get(id).paused,false);a.restartChat(id);
 clock.now+=10001;a.tick();assert.equal(a.get(id).paused,true);
 assert.equal(a.adminView(id).connectionPause.reason,'未领取任务');assert.equal(a.get(id).jobs.filter(j=>j.status==='timedout').length,3,'remaining simultaneous task is frozen');
 const before=JSON.stringify(a.get(id).game);clock.now+=100000;a.tick();assert.equal(JSON.stringify(a.get(id).game),before);assert.equal(a.claim(ids[0]).paused,true);
 assert.ok(!JSON.stringify(a.public(a.get(id))).includes('connectionPause'));
 store.close();const restored=new Store(root);try{assert.equal(restored.state.matches[id].paused,true);assert.equal(restored.state.matches[id].connectionPause.reason,'未领取任务');const b=new Arena(restored,{now:()=>clock.now});b.resume(id);assert.deepEqual(b.get(id).timeoutStreaks,{});assert.equal(b.adminView(id).connectionPause,null)}finally{restored.close()}
});
test('successful submission resets deadline streak; claimed timeouts identify incomplete work',t=>{
 const {a,id,ids,clock}=arena(t);
 clock.now+=10001;a.tick();a.restartChat(id);
 for(const who of ids){const job=a.claim(who).job;assert.equal(submitAction(a,who,{...job,result:{type:'bid',score:0}}).ok,true)}
 a.restartChat(id);a.claim(ids[0]);clock.now+=10001;a.tick();assert.equal(a.get(id).paused,false);
 a.restartChat(id);a.claim(ids[0]);clock.now+=10001;a.tick();assert.equal(a.adminView(id).connectionPause.reason,'领取后未完成');
});
