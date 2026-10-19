import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function browser(){
 const elements=new Map(),requests=[];
 const element=id=>{
  if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',dataset:{},options:[],hidden:false,
   addEventListener(){},querySelectorAll(){return []},contains(){return false},
   querySelector(selector){if(selector.includes('data-state')){const match=/data-state="([^"]+)" aria-pressed="true"/.exec(this.innerHTML);return match?{dataset:{state:match[1]}}:null}return null},
  });return elements.get(id);
 };
 const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Date,JSON,Promise,Error,console,setInterval(){},
  location:{href:'http://127.0.0.1:4318/',origin:'http://127.0.0.1:4318'},history:{replaceState(){}},navigator:{},
  document:{documentElement:{dataset:{}},getElementById:element,querySelectorAll(){return []},addEventListener(){}},
  ArenaTheme:{preference:'light'},fetch:async(route,options)=>{
   if(options?.body)requests.push({route,body:JSON.parse(options.body)});
   return {ok:true,json:async()=>route==='/api/network'?{localOrigin:'http://127.0.0.1:4318',lanOrigins:[]}:route==='/api/matches'?[]:{ok:true}};
  }});
 for(const file of ['presentation.js','ui.js','app.js'])vm.runInContext(fs.readFileSync(new URL('../public/'+file,import.meta.url),'utf8'),ctx);
 await new Promise(resolve=>setImmediate(resolve));
 ctx.ArenaPresentation.configure(JSON.parse(fs.readFileSync(new URL('../public/assets/presentation/manifest.json',import.meta.url),'utf8')));
 ctx.fixtureRoom={id:'room',runId:'run',kind:'werewolf',started:true,paused:false,game:{status:'playing'},participants:[{seat:'p1',animalId:'cat',state:'平静'}],events:[],history:[]};
 ctx.fixturePlayer={seat:'p1',privateView:{phase:'discuss',ownPresentation:{privateState:'狡黠'}}};
 vm.runInContext("match=fixtureRoom;current='room';playerData=fixturePlayer;humanJob={taskId:'task',attemptId:'attempt'};save('arenaPlayer:room',JSON.stringify({token:'page-token',seat:'p1',match:'room'}));renderStatePicker()",ctx);
 return {ctx,element,requests};
}

test('human day picker and submission do not carry a previous private night expression into public speech',async()=>{
 const b=await browser();assert.match(b.element('stateControls').innerHTML,/<b>平静<\/b>/);
 await vm.runInContext("submitHuman({type:'speak',text:'天亮后的公开发言'})",b.ctx);
 const submission=b.requests.find(r=>r.body.action==='submit');assert.equal(submission.body.result.state,'平静');
});

test('human night picker displays an own private choice, while a fresh explicit day choice persists across renders',async()=>{
 const b=await browser();vm.runInContext("playerData.privateView.phase='wolf';renderStatePicker()",b.ctx);
 assert.match(b.element('stateControls').innerHTML,/<b>狡黠<\/b>/);
 vm.runInContext("playerData.privateView.phase='discuss';expressionDrafts.set(expressionKey(),'无辜');renderStatePicker();renderStatePicker()",b.ctx);
 assert.match(b.element('stateControls').innerHTML,/<b>无辜<\/b>/);
 await vm.runInContext("submitHuman({type:'speak',text:'这是主动选择的公开状态'})",b.ctx);
 assert.equal(b.requests.find(r=>r.body.action==='submit').body.result.state,'无辜');
});
