// Isolated visual/interaction acceptance. Uses the same optional Playwright setup as other browser checks.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {serve} from '../server.mjs';
import {applyParty} from '../lib/party.mjs';
import {applyXiangqi} from '../lib/xiangqi.mjs';
import {applyBlind} from '../lib/blind.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

const modulePath=process.env.ARENA_PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath&&path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath||'playwright');
const root=temporaryDirectory('arena-actions-browser-');
let app,browser;
const speech='我认为这个判断需要更多证据，先听一听其他人的想法。'.repeat(5);
try{
 app=await serve({port:0,root:path.join(root,'data'),adminToken:'isolated-actions-browser',autoTick:false});
 browser=await chromium.launchPersistentContext(path.join(root,'profile'),{headless:true,channel:process.env.ARENA_BROWSER_CHANNEL||undefined,viewport:{width:1440,height:1000}});
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const rooms={};
 for(const kind of ['liarsdice','undercover','spyfall','codenames','werewolf','xiangqi','blind','groupchat']){
  const id=app.arena.create({kind,title:'角色行动验收 · '+kind,playerCount:4,topic:'公开讨论'}).id;rooms[kind]=id;
  if(kind==='groupchat')app.arena.chatMembers(id,{action:'add-ai',nickname:'讨论者'});
  app.arena.store.change(state=>{
   const m=state.matches[id];m.started=true;
   if(['liarsdice','undercover','spyfall','codenames'].includes(kind)){
    const result=kind==='liarsdice'?{type:'bid',quantity:2,face:4,text:speech.slice(0,120)}:kind==='undercover'?{type:'describe',text:speech}:kind==='spyfall'?{type:'question',target:'p2',text:speech}:{type:'clue',word:'联想',count:2};
    applyParty(m.game,'p1',result);app.arena.record(m,'action','完成');
    if(kind==='liarsdice')for(const [i,text]of ['我再加一个，看看谁先开骰。','这一口我跟了，你们继续。','我觉得还可以更高，你信吗？'].entries()){
     applyParty(m.game,'p'+(i+2),{type:'bid',quantity:i+3,face:4,text});app.arena.record(m,'action','完成');
    }
   }else if(kind==='werewolf'){
    m.game.phase='discuss';app.arena.record(m,'action','公开发言',{seat:'p1',round:1,speech});
   }else if(kind==='groupchat'){
    app.arena.record(m,'chat-message','讨论者发言',{message:{seat:'p1',type:'speak',round:1,text:speech,sender:{seat:'p1',nickname:'讨论者'},seq:1,at:new Date().toISOString()}});
   }else{
    (kind==='xiangqi'?applyXiangqi:applyBlind)(m.game,'red',{from:[0,6],to:[0,5]});
    app.arena.record(m,'action','行棋',{seat:'red',ply:m.game.ply,move:m.game.lastMove});
   }
  });
 }
 for(const [kind,id]of Object.entries(rooms)){
  await page.goto(app.origin+'/?room='+id);
  await page.locator('.character-action.latest').first().waitFor();
  assert.ok(await page.locator('.character-action').count()>0,kind+' has cards');
  assert.equal(await page.locator('#transcriptPanel').evaluate(el=>el.open),false);
  if(kind==='liarsdice'){
   assert.ok((await page.locator('.dice-pot').boundingBox()).height<=120,'compact dice summary');
   const details=page.locator('.action-speech').first();await details.locator('summary').click();
   await page.evaluate(()=>refresh());assert.equal(await details.evaluate(el=>el.open),true,'expansion survives refresh');
   await page.evaluate(()=>{replay=0;render()});assert.equal(await page.locator('.character-action.latest').count(),0,'no future action in first snapshot');
   await page.evaluate(()=>{replay=null;render()});
   await page.evaluate(()=>document.documentElement.dataset.theme='dark');
   await page.locator('#board').screenshot({path:path.join(root,'desktop.jpg'),type:'jpeg',quality:75,animations:'disabled'});
  }
  for(const theme of ['light','dark'])for(const width of [1440,390]){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,kind+' fits '+width);
   const overlaps=await page.locator('.character-action').evaluateAll(nodes=>nodes.some((a,i)=>nodes.slice(i+1).some(b=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return x.width&&y.width&&x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top})));
   assert.equal(overlaps,false,kind+' cards do not overlap');
  }
  if(kind==='liarsdice')await page.locator('#board').screenshot({path:path.join(root,'mobile.jpg'),type:'jpeg',quality:70,animations:'disabled'});
  await page.setViewportSize({width:1440,height:1000});
 }
 // Exercise the unchanged human form against the real submission controller.
 const humanRoom=app.arena.create({kind:'liarsdice',playerCount:2,title:'真人行动验收'}).id;
 app.arena.setParticipantType(humanRoom,'p1','human');
 const aiInvite=app.arena.invite(humanRoom,'p2',app.origin,'模型乙');
 app.arena.connect({match:humanRoom,seat:'p2',provider:'simulated',session:'actions-human-test',invitation:aiInvite.text.match(/--invitation ([a-f0-9]+)/)[1]});
 await page.goto(app.arena.roomInvite(humanRoom,app.origin).url);
 await page.locator('#nickname').fill('玩家甲');await page.locator('#humanSeat').selectOption('p1');
 await page.locator('#joinHuman').click();await page.locator('#joinDialog').waitFor({state:'hidden'});
 app.arena.start(humanRoom);await page.evaluate(()=>refresh());
 await page.locator('#diceQuantity').fill('2');await page.locator('#diceFace').selectOption('4');
 await page.locator('#diceText').fill('真人表单依然可用');
 await page.locator('#partyActionForm button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('[data-action-seat="p1"]')?.textContent.includes('真人表单依然可用'));
 assert.ok(await page.locator('#playerControls').isVisible());
 assert.deepEqual(errors,[]);
 for(const name of ['desktop.jpg','mobile.jpg'])assert.ok(fs.statSync(path.join(root,name)).size<1024*1024);
 console.log('PASS: all 8 modes, desktop/mobile, compact dice summary, expansion, replay, human form submission, no overlaps or browser errors.');
 if(process.env.ARENA_KEEP_ACTION_SCREENSHOTS==='1'){
  const target=path.resolve('tmp','action-previews');fs.mkdirSync(target,{recursive:true});
  for(const name of ['desktop.jpg','mobile.jpg'])fs.copyFileSync(path.join(root,name),path.join(target,name));
  console.log('Screenshots: '+target);
 }
}finally{
 await browser?.close();await app?.close();removeTemporaryDirectory(root);
}
