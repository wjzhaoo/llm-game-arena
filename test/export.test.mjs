import {submitAction} from './action-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Arena} from '../lib/arena.mjs';
import {Store} from '../lib/store.mjs';
import {serve} from '../server.mjs';
import {initialWerewolf} from '../lib/werewolf.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

const now = Date.parse('2026-10-17T02:03:04Z');
const games = {xiangqi:'中国象棋',blind:'覆棋盲棋',werewolf:'六人狼人杀',groupchat:'自由群聊'};
function fixture(t) {
 const root = temporaryDirectory('arena-export-'),store = new Store(root),a = new Arena(store,{now:()=>now,chatPick:()=>0});
 t.after(()=>{store.close();removeTemporaryDirectory(root)});
 return {a,root};
}
function connect(a,id,seat,name=seat) {
 const inv = a.invite(id,seat,'http://127.0.0.1:4318',name);
 const c = a.connect({match:id,seat,provider:'simulated',session:'PRIVATE-EXPORT-SESSION-'+id+'-'+seat,invitation:inv.text.match(/--invitation ([a-f0-9]+)/)[1]});
 return {...c,identity:a.identity(c.token)};
}
function players(a,kind,title='导出验收') {
 const id = a.create({kind,title,topic:'第一个话题'}).id;
 if (kind==='groupchat') for (const nickname of ['甲','乙']) a.chatMembers(id,{action:'add-ai',nickname,profile:{personality:'PRIVATE-PERSONALITY',initialOpinion:'PRIVATE-OPINION'}});
 const connections = a.seats(a.get(id)).map(seat=>connect(a,id,seat,seat==='red'?'红方棋友':'模型'+seat));
 return {id,connections};
}
function submit(a,connection,result) {
 const {job} = a.claim(connection.identity);
 assert.ok(job);
 assert.equal(submitAction(a,connection.identity,{...job,result}).ok,true);
}
function record(a,id,text) {a.store.change(s=>a.record(a.get(id,s),'notice',text))}
function saved(root) {
 return Object.fromEntries(fs.readdirSync(root,{recursive:true}).filter(name=>fs.statSync(path.join(root,name)).isFile()).sort()
  .map(name=>[name,fs.readFileSync(path.join(root,name)).toString('base64')]));
}

for (const [kind,label] of Object.entries(games)) test(kind+' exports every game state without changing memory or disk',t=>{
 const {a,root} = fixture(t),{id,connections} = players(a,kind);
 const check = expected=>{
  const before = JSON.stringify(a.store.state),files = saved(root),out = a.exportRecords(id);
  assert.ok(out.content.includes(label));assert.ok(out.content.includes('- 状态：'+expected));
  assert.ok(out.content.includes('- 导出时间：2026-10-17 10:03:04'));
  assert.ok(out.content.includes('Asia/Shanghai'));assert.match(out.filename,/_第1局_20261017-100304\.md$/);
  for (const secret of ['PRIVATE-EXPORT-SESSION','PRIVATE-PERSONALITY','PRIVATE-OPINION','tokenHash','credentialPath',...connections.map(c=>c.token)]) assert.ok(!out.content.includes(secret),secret);
  const bytes = Buffer.from(out.content);assert.notEqual(bytes.subarray(0,3).toString('hex'),'efbbbf');assert.ok(!out.content.includes('\ufffd'));
  assert.equal(JSON.stringify(a.store.state),before);assert.deepEqual(saved(root),files);
 };
 check('未开局');a.start(id);check('进行中');a.pause(id);check('已暂停');a.end(id);check('已结束');
});

for (const kind of Object.keys(games)) test(kind+' exports the explicitly selected archived run or all runs in order',t=>{
 const {a} = fixture(t),{id} = players(a,kind);a.start(id);record(a,id,'只属于旧局的内容');
 const old = a.get(id).runId;a.restart(id,{expectedRunId:old,topic:'第二个话题'});record(a,id,'只属于新局的内容');
 const current = a.exportRecords(id),past = a.exportRecords(id,{runId:old}),all = a.exportRecords(id,{scope:'room'});
 assert.ok(current.content.includes('只属于新局的内容'));assert.ok(!current.content.includes('只属于旧局的内容'));
 assert.ok(past.content.includes('只属于旧局的内容'));assert.ok(!past.content.includes('只属于新局的内容'));
 assert.ok(all.content.indexOf('只属于旧局的内容')<all.content.indexOf('只属于新局的内容'));
 assert.equal((all.content.match(/^## /gm)||[]).length,2);assert.match(all.filename,/_全部记录_/);
 assert.match(past.filename,/_第1局_/);assert.match(current.filename,/_第2局_/);
 if (kind==='groupchat') {assert.ok(past.content.includes('第一个话题'));assert.ok(!past.content.includes('第二个话题'));assert.ok(all.content.includes('第二个话题'))}
 a.revoke(id,a.seats(a.get(id))[0]);assert.equal(a.exportRecords(id,{runId:old}).content,past.content);
});

test('Chat export includes all original messages beyond pagination and context limits with literal Markdown and historical senders',t=>{
 const {a} = fixture(t),{id,connections} = players(a,'groupchat');
 const silent=a.chatMembers(id,{action:'add-ai',nickname:'离开的旁听成员',profile:{personality:'PRIVATE-SILENT-PERSONALITY'}});a.revoke(id,silent.seat);a.start(id);
 const original = '首条全文\n# 标题 | **强调** [链接](https://example.test)\n<script>alert(1)</script>\n```js\n中文🙂\n```';
 const huge = '末条全文'+('汉🙂'.repeat(12000))+'全文结束';
 a.store.change(s=>{
  const m = a.get(id,s);
  for (let i=1;i<=65;i++) {
   const message = {seq:i,at:new Date(now+i*1000).toISOString(),type:'speak',seat:connections[0].seat,
    sender:{seat:connections[0].seat,nickname:'发言时昵称',type:'ai',provider:'simulated'},
    text:i===1?original:i===65?huge:'中间消息 '+i+'汉'.repeat(500),
    emote:i===1?{id:'encourage',emoji:'💪',label:'鼓励',targetSeat:connections[1].seat,target:{seat:connections[1].seat,nickname:'当时的对象'}}:null};
   m.game.messages.push(message);a.record(m,'chat-message',message.text,{message,seat:message.seat});
  }
 });
 assert.equal(a.public(a.get(id)).game.messages.length,1);assert.equal(a.public(a.get(id)).game.messages[0].truncated,true);
 const {content} = a.exportRecords(id);
 assert.ok(!a.public(a.get(id)).participants.some(p=>p.seat===silent.seat));assert.ok(content.includes('离开的旁听成员'));assert.ok(!content.includes('PRIVATE-SILENT-PERSONALITY'));
 assert.equal((content.match(/· 聊天消息/g)||[]).length,65);assert.ok(content.includes(huge));
 assert.ok(content.includes('> \\# 标题 \\| \\*\\*强调\\*\\*'));assert.ok(content.includes('&lt;script&gt;alert\\(1\\)&lt;/script&gt;'));
 assert.ok(!content.includes('<script>'));assert.ok(content.includes('> \\`\\`\\`js\n> 中文🙂'));
 assert.ok(content.includes('发言时昵称'));assert.ok(content.includes('表情：💪 鼓励 → 当时的对象'));
 assert.ok(content.indexOf('首条全文')<content.indexOf('中间消息 2'));assert.ok(content.indexOf('中间消息 64')<content.indexOf('末条全文'));
});

test('Chat export includes only settled public scores and preserves standalone and attached emotes',t=>{
 const {a} = fixture(t),{id,connections:[first,second]} = players(a,'groupchat');a.start(id);
 submit(a,first,{score:91});assert.ok(!a.exportRecords(id).content.includes('公开分数：'));
 submit(a,second,{score:0});submit(a,first,{type:'speak',text:'第一行\n第二行',emote:{id:'encourage',targetSeat:second.seat}});
 a.emote(second.identity,{emote:'think',targetSeat:first.seat});
 const {content} = a.exportRecords(id);
 assert.ok(content.includes('公开分数：'));assert.ok(content.includes('：91'));assert.ok(content.includes('：0'));
 assert.ok(content.includes('> 第一行\n> 第二行'));assert.ok(content.includes('鼓励 →'));assert.ok(content.includes('疑惑 →'));
 for (const secret of ['PRIVATE-PERSONALITY','PRIVATE-OPINION','PRIVATE-EXPORT-SESSION',first.token,second.token]) assert.ok(!content.includes(secret));
});

test('Werewolf export keeps night actions and findings private, while retaining speeches, public votes and final roles',t=>{
 const {a} = fixture(t),{id,connections} = players(a,'werewolf');
 a.store.change(s=>{a.get(id,s).game=initialWerewolf({roles:['wolf','wolf','seer','witch','villager','villager']})});a.start(id);
 const c = seat=>connections.find(p=>p.seat===seat);
 submit(a,c('p1'),{type:'kill',target:'p5'});submit(a,c('p2'),{type:'kill',target:'p5'});
 submit(a,c('p3'),{type:'inspect',target:'p1'});submit(a,c('p4'),{type:'witch',save:false,poison:null});
 a.store.change(s=>{const m=a.get(id,s);m.game.findings.p3[0].privateMarker='PRIVATE-FINDING';m.game.night.privateMarker='PRIVATE-NIGHT'});
 for (const seat of a.pending(a.get(id)).slice()) submit(a,c(seat),{type:'speak',text:'公开发言 '+seat+'\n保留第二行'});
 for (const seat of a.pending(a.get(id)).slice()) submit(a,c(seat),{type:'vote',target:'p1'});
 let out = a.exportRecords(id).content;
 assert.ok(out.includes('公开发言 p2\n> 保留第二行'));assert.ok(out.includes('公开票型：'));assert.ok(out.includes('模型p2（2 号）→模型p1（1 号）'));
 assert.ok(!out.includes('| 狼人 |'));assert.ok(!out.includes('PRIVATE-FINDING'));assert.ok(!out.includes('PRIVATE-NIGHT'));
 a.end(id);out=a.exportRecords(id).content;assert.ok(out.includes('| 狼人 |'));assert.ok(out.includes('| 预言家 |'));
 for (const secret of ['PRIVATE-FINDING','PRIVATE-NIGHT','findings','potions','wolfVotes','tokenHash']) assert.ok(!out.includes(secret));
});

test('Chess export retains move coordinates, emotes and undo events without dumping hidden boards',t=>{
 const {a} = fixture(t),{id,connections} = players(a,'xiangqi');a.start(id);
 submit(a,connections[0],{from:[0,6],to:[0,5]});a.emote(connections[0].identity,{emote:'good'});
 a.requestUndo(connections[0].identity,{boardRevision:a.get(id).boardRevision});const job=a.claim(connections[1].identity).job;
 assert.equal(submitAction(a,connections[1].identity,{...job,result:{type:'undo-response',requestId:a.get(id).undoRequest.id,accept:true}}).ok,true);
 const {content} = a.exportRecords(id);assert.ok(content.includes('从 \\[0,6\\] 到 \\[0,5\\]'));assert.ok(content.includes('好棋'));assert.ok(content.includes('撤回'));assert.ok(content.includes('棋局已从第 1 手回到第 0 手'));
 const blind = players(a,'blind').id;
 a.store.change(s=>{a.get(blind,s).game.board.flat().find(p=>p?.h).privateMarker='PRIVATE-BLIND-IDENTITY'});
 const text=a.exportRecords(blind).content;assert.ok(!text.includes('PRIVATE-BLIND-IDENTITY'));assert.ok(!text.includes('board'));assert.ok(!text.includes('coverKind'));
});

test('Export HTTP downloads UTF-8 Markdown with safe Chinese filenames, stays public and read-only, and reports invalid targets',async t=>{
 const root = temporaryDirectory('arena-export-http-');
 const app = await serve({root,port:0,adminToken:'fixture-export-admin',autoTick:false,arenaOptions:{now:()=>now}});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const {id}=players(app.arena,'groupchat','中文/房间:"*?<>|\\\r\n');app.arena.start(id);record(app.arena,id,'旧话题公开内容');
 app.arena.restart(id,{expectedRunId:id,topic:'新话题'});record(app.arena,id,'当前话题公开内容');
 const before=JSON.stringify(app.arena.store.state),files=saved(root),base=app.origin+'/api/matches/'+id+'/export';
 const response=await fetch(base+'?runId='+id),bytes=Buffer.from(await response.arrayBuffer()),past=bytes.toString('utf8');
 assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'text/markdown; charset=utf-8');
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
 const disposition=response.headers.get('Content-Disposition');assert.match(disposition,/^attachment; filename="arena-records.md"; filename\*=UTF-8''/);
 const filename=decodeURIComponent(disposition.split("UTF-8''")[1]);assert.ok(filename.startsWith('中文_房间'));assert.match(filename,/_第1局_20261017-100304\.md$/);
 assert.ok(!/[<>:"/\\|?*\r\n]/.test(filename));assert.notEqual(bytes.subarray(0,3).toString('hex'),'efbbbf');assert.ok(past.includes('旧话题公开内容'));assert.ok(!past.includes('当前话题公开内容'));
 assert.equal(await (await fetch(base+'?runId='+id+'&reveal=1',{headers:{Authorization:'Bearer fixture-export-admin'}})).text(),past);
 const current=await (await fetch(base)).text();assert.ok(current.includes('当前话题公开内容'));assert.ok(!current.includes('旧话题公开内容'));
 const all=await (await fetch(base+'?scope=room&runId=missing')).text();assert.ok(all.includes('旧话题公开内容'));assert.ok(all.includes('当前话题公开内容'));
 for (const query of ['?scope=bad','?scope=']) assert.equal((await fetch(base+query)).status,400);
 assert.equal((await fetch(base+'?runId=missing')).status,404);assert.equal((await fetch(app.origin+'/api/matches/missing/export')).status,404);
 assert.equal((await fetch(base,{headers:{Origin:'http://foreign.test'}})).status,403);
 assert.equal(JSON.stringify(app.arena.store.state),before);assert.deepEqual(saved(root),files);
 app.arena.delete(id,{expectedRunId:app.arena.get(id).runId});assert.equal((await fetch(base)).status,404);
});
