import test from 'node:test';
import assert from 'node:assert/strict';
import {Arena} from '../lib/arena.mjs';
import {participantContext} from '../lib/participant-context.mjs';
import {groupchatView,chatMessages} from '../lib/groupchat.mjs';

function assertNeutral(value){
 if(!value||typeof value!=='object')return;
 assert.ok(!['human','ai'].includes(value.type),'participant type must be absent');
 assert.ok(!Object.hasOwn(value,'provider'),'platform must be absent');
 assert.ok(!Object.hasOwn(value,'continuationMode'),'connection mode must be absent');
 for(const item of Object.values(value))assertNeutral(item);
}
test('mixed chat hides identity in tasks, selections, historical messages, targets and model status',()=>{
 const state={matches:{}},a=new Arena({state,change:fn=>fn(state)},{now:()=>10000,chatPick:()=>0});
 const {id}=a.create({kind:'groupchat',topic:'成员匿名类型'}),{seat}=a.chatMembers(id,{action:'add-ai',nickname:'甲'});
 const invitation=a.invite(id,seat,'http://127.0.0.1:4318');
 const ai=a.identity(a.connect({match:id,seat,provider:'simulated',session:'test-ai',invitation:invitation.text.match(/--invitation ([a-f0-9]+)/)[1]}).token);
 const human=a.identity(a.joinHuman({match:id,nickname:'乙',invitation:new URL(a.roomInvite(id,'http://127.0.0.1:4318').url).hash.slice(6)}).token);
 a.start(id);
 const bid=a.claim(ai).job;assertNeutral(bid.view);assert.deepEqual(bid.view.pendingSeats,[ai.seat,human.seat]);
 a.submit(ai,{...bid,result:{type:'bid',score:0}});
 const hb=a.claim(human).job;a.submit(human,{...hb,result:{type:'bid',score:100}});
 assertNeutral(a.view(a.get(id),ai.seat));
 const speech=a.claim(human).job;
 const original='human、AI、opencode 是发言正文，保持原样';
 a.submit(human,{...speech,result:{type:'speak',text:original,emote:{id:'agree',targetSeat:ai.seat}}});
 const m=a.get(id);
 assert.equal(m.game.messages[0].sender.type,'human','connection evidence remains internal');
 for(const view of [groupchatView(m.game,ai.seat),groupchatView(m.game,null,{snapshot:true}),chatMessages(m.game),a.messages(id),a.modelStatus(ai)])assertNeutral(view);
 assert.equal(a.messages(id).messages[0].text,original);
 assert.ok(!JSON.stringify(a.modelStatus(ai)).includes('真人已接入'));
 assert.equal(a.publicParticipants(m).find(p=>p.seat===human.seat).type,'human','host still manages participant types');
});

test('identity projection does not mutate snapshots or strip message and action types',()=>{
 const source={type:'chat-message',message:{type:'emote',sender:{seat:'p1',type:'human',provider:null,nickname:'甲'},text:'我是 human'},game:{members:[{seat:'p2',type:'ai',provider:'opencode'}]}};
 const result=participantContext(source);assertNeutral(result);
 assert.equal(result.type,'chat-message');assert.equal(result.message.type,'emote');assert.equal(result.message.text,source.message.text);
 assert.equal(source.message.sender.type,'human');
});
