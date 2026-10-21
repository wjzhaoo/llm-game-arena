import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {publicActions} from '../lib/action-display.mjs';
import {initialParty,applyParty,partyView} from '../lib/party.mjs';
import {Arena} from '../lib/arena.mjs';

function renderer(){
 const listeners={};const ctx={document:{addEventListener(type,fn){listeners[type]=fn}}};
 vm.runInNewContext(fs.readFileSync(new URL('../public/presentation.js',import.meta.url),'utf8'),ctx);
 return {p:ctx.ArenaPresentation,listeners};
}
function recordGame(kind,game){
 const m={kind,game,events:[],history:[],sequence:0};
 const arena=Object.create(Arena.prototype);
 arena.seats=()=>game.players?.map(p=>p.id)||['red','black'];
 arena.publicParticipants=()=>arena.seats().map(seat=>({seat}));
 arena.view=()=>structuredClone(game);arena.now=()=>0;
 return {m,record:(...args)=>arena.record(m,...args)};
}

test('dice public actions retain the bidder and challenger, never attribute a reveal to its loser',()=>{
 const g=initialParty('liarsdice',{playerCount:4}),{m,record}=recordGame('liarsdice',g);
 applyParty(g,'p1',{type:'bid',quantity:1,face:2,text:'这一口很稳'});
 record('action','完成');
 applyParty(g,'p2',{type:'challenge',text:'我不信'});record('action','完成');
 const actions=m.events.flatMap(e=>e.publicActions);
 assert.equal(actions.length,2);assert.equal(actions[0].seat,'p1');assert.equal(actions[0].speech,'这一口很稳');
 assert.equal(actions[1].seat,'p2');assert.equal(actions[1].speech,'我不信');assert.equal(actions[1].round,1);
 assert.equal(g.round,2);
 assert.deepEqual(m.history.map(e=>e.id),m.events.map(e=>e.id));
 assert.deepEqual(m.history.map(e=>e.publicActions),m.events.map(e=>e.publicActions));
});

test('sealed ballots produce no cards until the public resolution, then belong to the voters',()=>{
 const g=initialParty('undercover',{playerCount:4}),{m,record}=recordGame('undercover',g);
 for(const p of g.players){applyParty(g,p.id,{type:'describe',text:'公开描述'});record('action','完成')}
 const before=m.events.length;
 applyParty(g,'p1',{type:'vote',target:'p2'});record('action','秘密投票',{seat:'p1'},{hidden:true});
 assert.equal(m.events.length,before);
 assert.equal(partyView(g).ballots,undefined);
 for(const p of g.players.slice(1)){applyParty(g,p.id,{type:'vote',target:'p1'});record('action','秘密投票',{seat:p.id},{hidden:true})}
 const votes=m.events.find(e=>e.party?.type==='vote').publicActions;assert.equal(votes.length,4);
 assert.equal(votes.find(a=>a.seat==='p1').summary,'投票给 p2');
});

test('night events stay hidden and unrelated events cannot expose actions',()=>{
 const {m,record}=recordGame('werewolf',{players:[{id:'p1'}],phase:'wolf',status:'playing',log:[]});
 record('action','秘密',{seat:'p1',speech:'隐藏目标'},{hidden:true});
 assert.equal(m.events.length,0);assert.equal(m.history.length,0);
 assert.deepEqual(publicActions('connected',{seat:'p1',speech:'不是发言'},{}),[]);
});

test('all action adapters use explicit actors and keep public speech verbatim',()=>{
 for(const kind of ['undercover','spyfall','codenames']){
  const g=initialParty(kind,{playerCount:4});
  const result=kind==='undercover'?{type:'describe',text:'p3：<原话>'}:kind==='spyfall'?{type:'question',target:'p2',text:'p3：<原话>'}:{type:'clue',word:'联想',count:2};
  applyParty(g,'p1',result);
  const a=publicActions('party-event',{party:g.updates.at(-1)},g)[0];
  assert.equal(a.seat,'p1');assert.equal(a.round,1);
  if(kind!=='codenames')assert.equal(a.speech,'p3：<原话>');
 }
 assert.equal(publicActions('action',{seat:'red',ply:3,move:{from:[0,6],to:[0,5]}},{})[0].ply,3);
 assert.equal(publicActions('chat-message',{message:{seat:'p2',type:'speak',round:4,text:'你好'}},{})[0].round,4);
 assert.deepEqual(publicActions('action',{text:'p1：旧文本'},{}),[]);
});

test('cards preserve expansion on refresh, reset on a new action or room, and replay excludes future events',()=>{
 const {p,listeners}=renderer(),people=[{seat:'p1',nickname:'甲'},{seat:'p2',nickname:'乙'}];
 const events=[{id:'a',publicActions:[{seat:'p1',round:1,summary:'描述词语',speech:'<script>p2</script>'}]},{id:'b',publicActions:[{seat:'p2',round:2,summary:'投票给 p1',speech:''}]}];
 p.setActionContext('room:run');let actions=p.recentActions(events);
 let html=p.actionCard(people[0],{actions,people,turns:{p1:{label:'等待行动'}}});
 assert.match(html,/等待行动/);assert.match(html,/第 1 轮/);assert.match(html,/&lt;script&gt;p2/);assert.doesNotMatch(html,/最新行动/);
 listeners.toggle({target:{dataset:{actionId:'a:0'},isConnected:true,open:true}});
 actions=p.recentActions(events);html=p.actionCard(people[0],{actions});assert.match(html,/data-action-id="a:0" open/);
 const next=[...events,{id:'c',publicActions:[{seat:'p1',round:2,summary:'新行动',speech:'新发言'}]}];
 html=p.actionCard(people[0],{actions:p.recentActions(next)});assert.doesNotMatch(html,/ open/);
 actions=p.recentActions(events.slice(0,1));assert.equal(actions.p2,undefined);assert.equal(actions.p1.latest,true);
 p.setActionContext('new-room:run');html=p.actionCard(people[0],{actions});assert.doesNotMatch(html,/ open/);
 assert.match(p.actionCard(people[1]),/尚无公开行动/);
});
