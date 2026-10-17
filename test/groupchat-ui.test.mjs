import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {initialGroupchat,addChatMember,beginChatRound,applyGroupchat,groupchatView,CHAT_EMOTES} from '../lib/groupchat.mjs';
function ui(){const ctx={Date,Map,globalThis:null};ctx.globalThis=ctx;vm.runInNewContext(fs.readFileSync(new URL('../public/ui.js',import.meta.url),'utf8'),ctx);vm.runInNewContext(fs.readFileSync(new URL('../public/groupchat.js',import.meta.url),'utf8'),ctx);return ctx.ArenaGroupchat}
function game(){const g=initialGroupchat({topic:'<script>话题</script>'});for(const nickname of ['甲','乙']){const p=addChatMember(g,{type:'human',nickname,profile:{personality:'PRIVATE'}});p.connected=true}beginChatRound(g,{now:100,timeoutMs:10000});return g}
test('Groupchat public stage escapes content, shows closed ballots and never renders private profiles',()=>{
 const u=ui(),g=game();applyGroupchat(g,'p1',{type:'bid',score:99},{now:100,timeoutMs:10000});
 let html=u.stage(groupchatView(g),{started:true});assert.ok(html.includes('1 / 2'));assert.ok(!html.includes('99'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('PRIVATE'));
 applyGroupchat(g,'p2',{type:'bid',score:1},{now:100,timeoutMs:10000,pick:()=>0});html=u.stage(groupchatView(g),{started:true});assert.ok(html.includes('<b>99</b>'));assert.ok(html.includes('等待 甲 发言'));
 applyGroupchat(g,'p1',{type:'speak',text:'<img onerror="alert(1)">',emote:{id:'mock',targetSeat:'p2'}},{now:100,timeoutMs:10000});
 html=u.stage(groupchatView(g),{started:true,messages:g.messages});assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img onerror'));assert.ok(html.includes('嘲讽 → 乙'));
 g.status='finished';assert.ok(u.stage(groupchatView(g)).includes('聊天已结束'));assert.ok(!u.stage(groupchatView(g)).includes('平局'));
});
test('Groupchat human forms distinguish bids, speeches, emotes and read-only phases',()=>{
 const u=ui(),g=game(),interactions={emotes:CHAT_EMOTES,emoteAvailableAt:0};
 let html=u.actions(groupchatView(g,'p1'),{kind:'chat-bid'},interactions,{started:true,now:100});assert.ok(html.includes('id="chatScore"'));assert.ok(html.includes('本轮弃权'));assert.ok(html.includes('我的私有设定'));assert.equal((html.match(/data-emote=/g)||[]).length,9);
 assert.ok(!u.actions(groupchatView(g,'p1'),{},interactions,{started:true,paused:true}).includes('<form'));
 applyGroupchat(g,'p1',{type:'bid',score:100},{now:100,timeoutMs:10000});applyGroupchat(g,'p2',{type:'bid',score:0},{now:100,timeoutMs:10000,pick:()=>0});
 html=u.actions(groupchatView(g,'p1'),{kind:'chat-speak'},interactions,{started:true});assert.ok(html.includes('id="speechText"'));assert.ok(html.includes('id="chatSpeechEmote"'));assert.ok(!html.includes('maxlength="600"'));
 assert.ok(!u.actions(groupchatView(g,'p2'),null,interactions,{started:true}).includes('<form'));
});
test('Groupchat controller replay uses historical membership and exposes no live member controls',async()=>{
 const elements=new Map(),element=id=>{
  if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',innerHTML:'',dataset:{},className:'',options:[],hidden:false,querySelector(){return null},querySelectorAll(){return []},addEventListener(){},contains(){return false}});
  return elements.get(id);
 };
 const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Date,JSON,Error,Promise,console,setInterval(){},
  location:{href:'http://127.0.0.1:4318/',origin:'http://127.0.0.1:4318'},history:{replaceState(){}},navigator:{},
  sessionStorage:{length:0},ArenaTheme:{preference:'system'},document:{getElementById:element,querySelectorAll:()=>[],addEventListener(){}},
  fetch:async route=>({ok:true,json:async()=>route==='/api/network'?{localOrigin:'http://127.0.0.1:4318',lanOrigins:[]}:route==='/api/matches'?[]:{}})});
 for(const file of ['ui.js','groupchat.js','app.js'])vm.runInContext(fs.readFileSync(new URL('../public/'+file,import.meta.url),'utf8'),ctx);
 await new Promise(resolve=>setImmediate(resolve));
 const g=game(),past=groupchatView(g,null,{snapshot:true});const late=addChatMember(g,{type:'human',nickname:'后来加入的人'});late.connected=true;
 const current=groupchatView(g),room={id:'chat',kind:'groupchat',title:'回放',started:true,paused:false,game:current,participants:current.members,events:[],history:[{game:past,started:true,paused:false,text:'早期'}],connections:[],admin:{tasks:[]}};
 ctx.fixtureRoom=room;vm.runInContext("match=fixtureRoom;current='chat';admin='test-admin';replay=0;render()",ctx);
 assert.ok(!element('players').innerHTML.includes('后来加入的人'));assert.ok(!element('players').innerHTML.includes('data-profile-seat'));assert.ok(element('players').innerHTML.includes('只读回放'));assert.equal(element('count').textContent,'2 位成员');assert.equal(element('chatAdminTools').hidden,true);
});
