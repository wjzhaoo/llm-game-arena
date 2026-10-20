import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {initialParty,partyView,applyParty} from '../lib/party.mjs';
import {initialGroupchat,addChatMember,beginChatRound,applyGroupchat,groupchatView} from '../lib/groupchat.mjs';
import {initialWerewolf,werewolfView,pendingWerewolf,timeoutWerewolf,applyWerewolf} from '../lib/werewolf.mjs';

const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../public/ui.js',import.meta.url),'utf8'),ctx);
const indicators=(...args)=>JSON.parse(JSON.stringify(ctx.ArenaUI.turnIndicators(...args)));
const seats=turns=>Object.keys(turns);
function chat(){
 const g=initialGroupchat({topic:'当前轮到谁'});
 for(const nickname of ['甲','乙'])addChatMember(g,{type:'human',nickname}).connected=true;
 beginChatRound(g,{now:100,timeoutMs:10000});return g;
}
function day(){
 const g=initialWerewolf({roles:['wolf','wolf','seer','witch','villager','villager']});
 while(['wolf','seer','witch'].includes(g.phase))for(const seat of pendingWerewolf(g))timeoutWerewolf(g,seat);
 return g;
}

for(const kind of ['xiangqi','blind'])test(kind+' highlights the current side or undo responder and clears on pause/end',()=>{
 const g={status:'playing',turn:'red'};
 assert.deepEqual(seats(indicators(kind,g)),['red']);
 assert.match(indicators(kind,g,{ownSeat:'red'}).red.label,/轮到你/);
 assert.deepEqual(indicators(kind,g,{undoRequest:{responder:'black'}}),{black:{label:'等待确认悔棋',mode:'confirming'}});
 for(const options of [{paused:true},{started:false}])assert.deepEqual(indicators(kind,g,options),{});
 assert.deepEqual(indicators(kind,{...g,status:'finished'}),{});
 assert.match(indicators(kind,g,{replay:true}).red.label,/^回放/);
});

for(const kind of ['undercover','liarsdice','codenames','spyfall'])test(kind+' highlights its public actor and follows the next turn',()=>{
 const g=initialParty(kind),view=()=>partyView(g);
 assert.deepEqual(seats(indicators(kind,view())),view().pendingSeats);
 const before=view().pendingSeats[0];
 if(kind==='undercover')applyParty(g,before,{type:'describe',text:'一个日常可见的事物'});
 if(kind==='liarsdice')applyParty(g,before,{type:'bid',quantity:1,face:2});
 if(kind==='codenames')applyParty(g,before,{type:'clue',word:'概念',count:1});
 if(kind==='spyfall')applyParty(g,before,{type:'question',target:'p2',text:'这里最常见的声音是什么？'});
 assert.deepEqual(seats(indicators(kind,view())),view().pendingSeats);
 assert.notEqual(view().pendingSeats[0],before);
});

test('groupchat keeps the entire bid cohort highlighted before and after a sealed submission',()=>{
 const g=chat(),before=indicators('groupchat',groupchatView(g));
 assert.deepEqual(seats(before),['p1','p2']);assert.equal(before.p1.mode,'collecting');
 applyGroupchat(g,'p1',{type:'bid',score:99},{now:100,timeoutMs:10000});
 assert.deepEqual(indicators('groupchat',groupchatView(g)),before);
 assert.deepEqual(indicators('groupchat',groupchatView(g,null,{reveal:true})),before);
 applyGroupchat(g,'p2',{type:'bid',score:1},{now:100,timeoutMs:10000});
 assert.deepEqual(indicators('groupchat',groupchatView(g)),{p1:{label:'等待发言',mode:'active'}});
});

test('werewolf highlights remaining public speeches but never identifies another night actor',()=>{
 const g=day();assert.equal(seats(indicators('werewolf',werewolfView(g))).length,6);
 applyWerewolf(g,'p1',{type:'speak',text:'公开发言'});
 assert.ok(!seats(indicators('werewolf',werewolfView(g))).includes('p1'));
 const night=initialWerewolf({roles:['wolf','wolf','seer','witch','villager','villager']});
 for(const reveal of [false,true])assert.deepEqual(indicators('werewolf',werewolfView(night,null,reveal)),{});
 assert.deepEqual(indicators('werewolf',werewolfView(night,'p1'),{ownSeat:'p1',ownCanAct:true}),{p1:{label:'轮到你 · 等待夜间行动',mode:'active'}});
});

test('secret voting highlights eligible players consistently without submission identity changes',()=>{
 for(const kind of ['undercover','spyfall','werewolf']){
  const g=kind==='werewolf'?day():initialParty(kind);
  g.phase='vote';g.votes={};if(kind==='undercover')g.players[3].alive=false;
  const view=()=>kind==='werewolf'?werewolfView(g):partyView(g);
  const before=indicators(kind,view()),seat=Object.keys(before)[0];
  assert.ok(Object.values(before).every(t=>t.mode==='collecting'));
  if(kind==='undercover')assert.ok(!before.p4);
  if(kind==='werewolf')applyWerewolf(g,seat,{type:'vote',target:null});else applyParty(g,seat,{type:'vote',target:null});
  assert.deepEqual(indicators(kind,view()),before);
 }
});
