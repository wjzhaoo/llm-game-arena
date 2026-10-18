import test from 'node:test';
import assert from 'node:assert/strict';
import {namedEvent} from '../lib/event-names.mjs';
import {Arena} from '../lib/arena.mjs';

const people=[{seat:'red',nickname:'小红'},{seat:'black',nickname:'小黑'},{seat:'p1',nickname:'阿明'},{seat:'p2',nickname:'阿华'}];
test('比赛记录统一标注行动、投票、出局、表情和悔棋中的昵称',()=>{
 for(const [type,text,expected] of [
  ['action','red：{"from":[0,0]}','小红（红方）：{"from":[0,0]}'],
  ['action','black：卒前进','小黑（黑方）：卒前进'],
  ['vote','放逐结果：p2；公开票型：p1→p2','放逐结果：阿华（2 号）；公开票型：阿明（1 号）→阿华（2 号）'],
  ['dawn','p1、p2 出局','阿明（1 号）、阿华（2 号） 出局'],
  ['emote','红方：鼓励','小红（红方）：鼓励'],
  ['undo-request','黑方申请悔棋','小黑（黑方）申请悔棋'],
 ]) assert.equal(namedEvent({type,text},people).text,expected);
});
test('发言正文保持原文，历史昵称快照优先且格式化可重复调用',()=>{
 const event={type:'action',text:'p1：p2 说 red 和黑方',eventPeople:[{seat:'p1',nickname:'旧名字'}]};
 const named=namedEvent(event,people);
 assert.equal(named.text,'旧名字（1 号）：p2 说 red 和黑方');
 assert.equal(namedEvent(named,people).text,named.text);
 assert.equal(namedEvent({type:'connected',text:'p3 已接入'},people).text,'3 号 已接入');
});
test('群聊使用消息发送时的昵称和席位',()=>{
 assert.equal(namedEvent({type:'chat-message',text:'旧记录',message:{seat:'p1',sender:{seat:'p1',nickname:'发送时昵称'},text:'p2 原文'}},people).text,'发送时昵称（1 号）：p2 原文');
});
test('公开接口、历史回放和导出保留记录时的昵称',()=>{
 const state={matches:{}},a=new Arena({state,change:fn=>fn(state)});
 for(const kind of ['xiangqi','blind','werewolf','groupchat']){
  const {id}=a.create({kind,topic:'昵称测试'}),m=a.get(id);
  const seat=kind==='groupchat'?a.chatMembers(id,{action:'add-ai',nickname:'旧昵称'}).seat:a.seats(m)[0];
  m.participantNames[seat]='旧昵称';
  a.record(m,'connected',seat+' 已接入');
  m.participantNames[seat]='新昵称';
  const view=a.public(m);
  assert.match(view.events.at(-1).text,/旧昵称（/);
  assert.equal(view.history.at(-1).text,view.events.at(-1).text);
  assert.match(JSON.stringify(a.exportRecords(id)),/旧昵称（/);
 }
});
