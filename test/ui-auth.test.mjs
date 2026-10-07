import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
import {initialXiangqi,xiangqiView} from '../lib/xiangqi.mjs';

async function browser({saved='',validToken='fixture-admin',legacy=[],href='http://127.0.0.1:4318/',blocked=false}={}){
 const elements=new Map(),storage=new Map([...(saved?[['arenaAdmin',saved]]:[]),...legacy]),calls=[],storageCalls={reads:0,writes:0};
 const roomId=new URL(href).searchParams.get('room'),game=xiangqiView(initialXiangqi());
 const room={id:roomId,title:'页面内存验证',kind:'xiangqi',started:false,paused:false,game,participants:['red','black'].map(seat=>({seat,type:'human',connected:false})),events:[],history:[]};
 const element=id=>{
  if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,checked:false,open:false,dataset:{},options:[],querySelector(){return null},addEventListener(){},showModal(){this.open=true},close(){this.open=false}});
  return elements.get(id);
 };
 const ctx=vm.createContext({URL,URLSearchParams,Date,Map,Set,JSON,Error,Promise,console,
  location:{href,origin:'http://127.0.0.1:4318'},history:{replaceState(){}},
  sessionStorage:{get length(){if(blocked)throw Error('blocked');return storage.size},key:index=>[...storage.keys()][index],getItem(){storageCalls.reads++;throw Error('No persistent reads allowed')},setItem(){storageCalls.writes++;throw Error('No persistent writes allowed')},removeItem:key=>storage.delete(key)},
  document:{getElementById:element,querySelectorAll:()=>[],addEventListener(){}},
  ArenaTheme:{preference:'system',set(){}},navigator:{},setInterval(){},
  fetch:async(route,options)=>{
   const headers=new Headers(options.headers);
   calls.push({route,headers,body:options.body});
   let status=200,data={};
   if(route==='/api/network')data={localOrigin:'http://127.0.0.1:4318',lanOrigins:[]};
   else if(route==='/api/matches')data=roomId?[room]:[];
   else if(route==='/api/admin'||route==='/api/matches/'+roomId+'/admin'){
    status=headers.get('Authorization')==='Bearer '+validToken?200:401;
    data=status===200?{ok:true}:{error:'Admin authorization required'};
   }else if(route==='/api/matches/'+roomId)data=room;
   else if(route==='/api/player'){
    const body=JSON.parse(options.body);
    if(body.action==='join'){
     room.participants.find(p=>p.seat===body.seat).connected=true;
     data={token:'page-player',match:roomId,seat:body.seat};
    }else data={match:room,seat:'red',privateView:game,serverNow:Date.now()};
   }else if(route==='/api/invite'){
    const body=JSON.parse(options.body);data={seat:body.seat,text:'本席位邀请：'+body.seat};
   }
   return {ok:status===200,status,json:async()=>data};
  }
 });
 vm.runInContext(fs.readFileSync(new URL('../public/ui.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),ctx);
 await new Promise(resolve=>setImmediate(resolve));
 return {ctx,element,storage,calls,storageCalls};
}

test('Admin input with Chinese, full-width or control characters stays in dialog and never reaches fetch',async()=>{
 const b=await browser({saved:'fixture-admin'});
 for(const value of ['管理码：fixture-admin','ｆｉｘｔｕｒｅ','fixture admin','fixture\nadmin']){
  b.element('adminDialog').showModal();b.element('adminCode').value=value;
  const before=b.calls.length;
  await b.element('saveAdmin').onclick();
  assert.equal(b.calls.length,before);
  assert.equal(b.storage.has('arenaAdmin'),false);
  assert.equal(b.element('adminDialog').open,true);
  assert.match(b.element('notice').textContent,/管理码.*格式/);
  assert.equal(b.element('saveAdmin').disabled,false);
 }
});

test('Admin codes are verified before use in page memory; rejection preserves the previous valid code',async()=>{
 const b=await browser({saved:'old-admin'});
 b.element('adminCode').value='  fixture-admin  ';
 await b.element('saveAdmin').onclick();
 assert.equal(b.storage.has('arenaAdmin'),false);
 assert.equal(b.element('adminCode').value,'');
 assert.equal(b.element('adminDialog').open,false);
 assert.match(b.element('notice').textContent,/仅当前页面有效/);
 b.element('adminDialog').showModal();b.element('adminCode').value='wrong-code';
 await b.element('saveAdmin').onclick();
 assert.equal(b.element('adminDialog').open,true);
 assert.match(b.element('notice').textContent,/管理码无效/);
 assert.equal(b.calls.filter(c=>c.route==='/api/admin').length,2);
 await b.ctx.api('/api/invite',{match:'room',seat:'red'},true);
 assert.equal(b.calls.at(-1).headers.get('Authorization'),'Bearer fixture-admin');
 assert.deepEqual(b.storageCalls,{reads:0,writes:0});
});

test('Legacy management, player and invitation data are removed without restoring identities',async()=>{
 const b=await browser({saved:'本次管理码：fixture-admin',legacy:[['arenaPlayer:room','{"token":"old-player"}'],['arenaJoin:room','old-invite'],['other-app','keep']]});
 assert.equal(b.storage.has('arenaAdmin'),false);
 assert.equal(b.storage.has('arenaPlayer:room'),false);
 assert.equal(b.storage.has('arenaJoin:room'),false);
 assert.equal(b.storage.get('other-app'),'keep');
 assert.equal(b.ctx.credential(),null);
 assert.ok(b.calls.some(c=>c.route==='/api/matches'));
 assert.ok(b.calls.every(c=>!c.headers.has('Authorization')));
 assert.deepEqual(b.storageCalls,{reads:0,writes:0});
});

test('Page-only player identity, invitation and admin are discarded by reload; blocked storage is supported',async()=>{
 const b=await browser({blocked:true,href:'http://127.0.0.1:4318/?room=memory-room#join=page-invite'});
 b.element('humanSeat').value='red';b.element('nickname').value='棋友';
 await b.element('joinHuman').onclick();
 b.element('adminCode').value='fixture-admin';await b.element('saveAdmin').onclick();
 assert.equal(b.ctx.credential().token,'page-player');
 assert.equal(b.ctx.stored('arenaJoin:memory-room'),'page-invite');
 const join=b.calls.find(c=>c.route==='/api/player'&&JSON.parse(c.body).action==='join');
 assert.equal(JSON.parse(join.body).invitation,'page-invite');
 assert.equal(b.element('playerControls').hidden,false);
 assert.deepEqual(b.storageCalls,{reads:0,writes:0});
 const reload=await browser({href:'http://127.0.0.1:4318/?room=memory-room',blocked:true});
 assert.equal(reload.ctx.credential(),null);
 assert.equal(reload.ctx.stored('arenaJoin:memory-room'),null);
 assert.equal(reload.element('playerControls').hidden,true);
 await reload.ctx.api('/api/invite',{match:'memory-room',seat:'black'},true);
 assert.equal(reload.calls.at(-1).headers.has('Authorization'),false);
 assert.deepEqual(reload.storageCalls,{reads:0,writes:0});
});

test('Consecutive AI invitations keep Chinese text in JSON and only send the verified ASCII bearer',async()=>{
 const b=await browser();
 b.element('adminDialog').showModal();b.element('adminCode').value='fixture-admin';
 await b.element('saveAdmin').onclick();
 for(const seat of ['red','black']){
  const out=await b.ctx.api('/api/invite',{match:'same-room',seat,title:'中文房间'},true);
  assert.equal(out.seat,seat);
 }
 const calls=b.calls.filter(c=>c.route==='/api/invite');
 assert.equal(calls.length,2);
 assert.deepEqual(calls.map(c=>JSON.parse(c.body).seat),['red','black']);
 assert.ok(calls.every(c=>c.headers.get('Authorization')==='Bearer fixture-admin'));
 assert.ok(calls.every(c=>JSON.parse(c.body).title==='中文房间'));
 const before=b.calls.length;
 await assert.rejects(b.ctx.api('/api/player',{action:'status'},false,'失效席位凭据'),/凭据.*重新加入/);
 assert.equal(b.calls.length,before);
});

test('Admin verification requires authorization and valid origin; second AI can bind after the first',async t=>{
 const root=temporaryDirectory('arena-auth-http-');
 const app=await serve({port:0,root,adminToken:'fixture-admin',autoTick:false});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 for(const token of ['', 'wrong-code', 'fixture-admin']){
  const response=await fetch(app.origin+'/api/admin',{headers:token?{Authorization:'Bearer '+token}:{}});
  assert.equal(response.status,token==='fixture-admin'?200:401);
  if(response.ok)assert.deepEqual(await response.json(),{ok:true});
 }
 assert.equal((await fetch(app.origin+'/api/admin',{headers:{Authorization:'Bearer fixture-admin',Origin:'http://foreign.example'}})).status,403);
 const room=app.arena.create({kind:'xiangqi',title:'连续 AI 邀请验收'}).id;
 let redBinding;
 for(const seat of ['red','black']){
  const response=await fetch(app.origin+'/api/invite',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-admin'},body:JSON.stringify({match:room,seat})});
  assert.equal(response.status,200);
  const invitation=await response.json();assert.equal(invitation.seat,seat);
  app.arena.connect({match:room,seat,provider:'simulated',session:'auth-test-'+seat,invitation:invitation.text.match(/--invitation ([a-f0-9]+)/)[1]});
  if(seat==='red')redBinding=JSON.stringify(app.arena.get(room).bindings.red);
  else assert.equal(JSON.stringify(app.arena.get(room).bindings.red),redBinding);
 }
 assert.equal(app.arena.public(app.arena.get(room)).participants.filter(p=>p.connected).length,2);
 await assert.rejects(serve({port:0,root,adminToken:'中文管理码'}),/ASCII/);
});
