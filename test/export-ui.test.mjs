import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {initialXiangqi,xiangqiView} from '../lib/xiangqi.mjs';

async function browser() {
 const elements=new Map(),requests=[],downloads=[],revoked=[],timers=[];
 let downloadResponse=()=>new Response('中文记录',{headers:{'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent('中文房间_第2局.md')}});
 const element=id=>{
  if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',innerHTML:'',disabled:false,checked:false,open:false,dataset:{},className:'',options:[],
   querySelector(){return null},querySelectorAll(){return []},addEventListener(){},contains(){return false},
   showModal(){this.open=true},close(){this.open=false},closest(){return element('exportDialog')}});
  return elements.get(id);
 };
 class DownloadURL extends URL {
  static createObjectURL(){return 'blob:export-fixture'}
  static revokeObjectURL(url){revoked.push(url)}
 }
 const context=vm.createContext({URL:DownloadURL,URLSearchParams,Map,Set,Date,JSON,Error,Promise,console,
  location:{href:'http://127.0.0.1:4318/',origin:'http://127.0.0.1:4318'},history:{replaceState(){}},
  navigator:{},sessionStorage:{length:0},ArenaTheme:{preference:'system'},
  setInterval(){},setTimeout(fn){timers.push(fn)},
  document:{getElementById:element,addEventListener(){},querySelectorAll:selector=>selector==='dialog [data-notice]'?[element('exportNotice')]:[],
   body:{append(){}},createElement(){return {click(){downloads.push({filename:this.download,href:this.href})},remove(){this.removed=true}}}},
  fetch:async(route,options)=>{
   if(route.includes('/export?')){requests.push({url:new URL(route,'http://127.0.0.1:4318'),options});return downloadResponse()}
   return {ok:true,json:async()=>route==='/api/network'?{localOrigin:'http://127.0.0.1:4318',lanOrigins:[]}:route==='/api/matches'?[]:{}};
  }
 });
 for(const file of ['presentation.js','ui.js','app.js'])vm.runInContext(fs.readFileSync(new URL('../public/'+file,import.meta.url),'utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));
 context.room={id:'room',runId:'archived-run',runNumber:2,kind:'xiangqi',title:'中文房间',started:true,paused:false,readOnly:true,
  game:xiangqiView(initialXiangqi()),events:[],history:[],participants:[]};
 vm.runInContext("match=room;current=room.id;selectedRun=room.runId;activeMatch={...room,runId:'live-run'};replay=0;admin='fixture-admin';$('reveal').checked=true;render()",context);
 return {context,element,requests,downloads,revoked,timers,response(fn){downloadResponse=fn}};
}

test('Export UI downloads the selected complete run even if polling changes the current run',async()=>{
 const b=await browser();assert.equal(b.element('exportButton').disabled,false);
 b.element('exportButton').onclick();assert.equal(b.element('exportScope').value,'run');assert.equal(b.element('exportDialog').open,true);
 assert.ok(b.element('exportDescription').textContent.includes('第 2 局'));
 vm.runInContext("match={...match,runId:'new-run',runNumber:3};replay=0",b.context);
 await b.element('confirmExport').onclick();
 assert.equal(b.requests.length,1);assert.equal(b.requests[0].url.searchParams.get('runId'),'archived-run');
 assert.equal(b.requests[0].url.searchParams.get('scope'),'run');assert.equal(b.requests[0].url.searchParams.has('reveal'),false);
 assert.deepEqual(Object.keys(b.requests[0].options.headers),[]);assert.equal(b.downloads[0].filename,'中文房间_第2局.md');
 assert.equal(b.element('exportDialog').open,false);assert.equal(b.element('confirmExport').disabled,false);
 for(const run of b.timers)run();assert.deepEqual(b.revoked,['blob:export-fixture']);
});

test('Export UI blocks duplicate submissions through polling and lets the user export the whole room',async()=>{
 const b=await browser();let release;b.response(()=>new Promise(resolve=>{release=resolve}));
 b.element('exportButton').onclick();b.element('exportScope').value='room';
 const pending=b.element('confirmExport').onclick();await b.element('confirmExport').onclick();
 vm.runInContext('render()',b.context);
 assert.equal(b.requests.length,1);assert.equal(b.element('confirmExport').disabled,true);assert.equal(b.element('exportButton').disabled,true);assert.equal(b.element('exportScope').disabled,true);
 assert.equal(b.requests[0].url.searchParams.get('scope'),'room');assert.equal(b.requests[0].url.searchParams.has('runId'),false);
 release(new Response('全部记录'));await pending;
 assert.equal(b.element('exportButton').disabled,false);assert.equal(b.element('exportScope').disabled,false);assert.equal(b.downloads.length,1);
});

for(const failure of ['http','network'])test('Export UI recovers from '+failure+' failure and retries without losing the selected run',async()=>{
 const b=await browser();b.response(()=>failure==='http'?Response.json({error:'临时无法生成记录'},{status:500}):Promise.reject(Error('Failed to fetch')));
 b.element('exportButton').onclick();await b.element('confirmExport').onclick();
 assert.equal(b.downloads.length,0);assert.equal(b.element('exportDialog').open,true);assert.equal(b.element('confirmExport').disabled,false);assert.equal(b.element('exportScope').disabled,false);
 assert.match(b.element('exportNotice').textContent,failure==='http'?/临时无法生成记录/:/导出失败，请检查网络后重试/);
 b.response(()=>new Response('重试成功'));await b.element('confirmExport').onclick();
 assert.equal(b.requests.length,2);assert.equal(b.downloads.length,1);assert.equal(b.requests[1].url.searchParams.get('runId'),'archived-run');
 assert.equal(b.element('exportDialog').open,false);
});
