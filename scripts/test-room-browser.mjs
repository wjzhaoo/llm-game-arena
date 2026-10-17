// Optional browser acceptance; production and npm test require no packages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

const modulePath=process.env.ARENA_PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath&&path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath||'playwright');
const root=temporaryDirectory('arena-room-browser-'),checks=[],errors=[];
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name)};
let app,context,page;
const inviteAI=(id,seat,name='测试模型')=>{
 const invite=app.arena.invite(id,seat,app.origin,name),out=app.arena.connect({match:id,seat,provider:'simulated',session:id+'-'+seat,invitation:invite.text.match(/--invitation ([a-f0-9]+)/)[1]});return app.arena.identity(out.token);
};
let exportCount=0;
const saveExport=async target=>{
 const [download]=await Promise.all([target.waitForEvent('download'),target.locator('#confirmExport').click()]);
 const file=path.join(root,'downloads','record-'+(++exportCount)+'.md');await download.saveAs(file);
 assert.equal(await download.failure(),null);
 const bytes=fs.readFileSync(file);assert.notEqual(bytes.subarray(0,3).toString('hex'),'efbbbf');
 return {filename:download.suggestedFilename(),content:bytes.toString('utf8')};
};
const exportRecords=async(target,scope='run')=>{
 await target.locator('#exportButton').click();await target.locator('#exportDialog').waitFor({state:'visible'});
 assert.equal(await target.locator('#exportScope').inputValue(),'run');
 await target.locator('#exportScope').selectOption(scope);return saveExport(target);
};
try{
 app=await serve({port:0,root:path.join(root,'data'),adminToken:'isolated-room-browser',autoTick:false});
 fs.mkdirSync(path.join(root,'downloads'),{recursive:true});
 context=await chromium.launchPersistentContext(path.join(root,'profile'),{headless:true,channel:process.env.ARENA_BROWSER_CHANNEL||undefined,viewport:{width:1440,height:1000},deviceScaleFactor:1,acceptDownloads:true,downloadsPath:path.join(root,'downloads')});
 page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 const chat=app.arena.create({kind:'groupchat',title:'群聊话题验收',topic:'AI 与人的日常协作',timeoutSeconds:600}).id;
 const member=app.arena.chatMembers(chat,{action:'add-ai',nickname:'模型甲',profile:{personality:'冷静好奇',initialOpinion:'原话题立场'}}),ai=inviteAI(chat,member.seat,'模型甲');
 const invite=app.arena.roomInvite(chat,app.origin);await page.goto(invite.url);await page.locator('#joinDialog').waitFor({state:'visible'});
 await page.locator('#nickname').fill('棋友乙');await page.locator('#joinPersonality').fill('温和');await page.locator('#joinOpinion').fill('旧观点');await page.locator('#joinHuman').click();
 await page.locator('#playerControls').waitFor({state:'visible'});await page.locator('#adminButton').click();await page.locator('#adminCode').fill('isolated-room-browser');await page.locator('#saveAdmin').click();await page.locator('#adminDialog').waitFor({state:'hidden'});
 check('Connections start expanded and transcript collapsed',await page.locator('#connectionsPanel').evaluate(el=>el.open)&&!await page.locator('#transcriptPanel').evaluate(el=>el.open));
 await page.locator('#startButton').click();await page.waitForFunction(()=>humanJob?.kind==='chat-bid');
 const bid=app.arena.claim(ai).job;app.arena.submit(ai,{...bid,result:{score:0}});
 await page.locator('#chatScore').fill('100');await page.locator('#actionForm button[type=submit]').click();await page.locator('#speechText').waitFor({state:'visible'});
 await page.locator('#speechText').fill('这条消息属于第一个话题');await page.locator('#actionForm button[type=submit]').click();await page.waitForFunction(()=>match?.game.round===2);
 app.arena.store.change(state=>{const m=state.matches[chat];for(let i=0;i<65;i++){const message={seq:m.game.messages.length+1,type:'speak',seat:ai.seat,sender:{seat:ai.seat,nickname:'模型甲',type:'ai',provider:'simulated'},text:'历史消息 '+(i+1),at:new Date().toISOString(),emote:null};m.game.messages.push(message);app.arena.record(m,'chat-message',message.text,{message,seat:ai.seat})}});
 await page.evaluate(()=>refresh());await page.waitForFunction(()=>document.querySelectorAll('#board .chat-message').length===50);
 const firstExport=await exportRecords(page);
 check('Downloads use Chinese room, run and timestamp filenames',/^群聊话题验收_第1局_\d{8}-\d{6}\.md$/.test(firstExport.filename));
 check('Export includes all messages before loading paginated history',firstExport.content.includes('这条消息属于第一个话题')&&firstExport.content.includes('历史消息 65')&&(firstExport.content.match(/· 聊天消息/g)||[]).length===66);
 check('Export excludes private member settings and sessions',!firstExport.content.includes('原话题立场')&&!firstExport.content.includes('温和')&&!firstExport.content.includes('tokenHash')&&!firstExport.content.includes(chat+'-'+ai.seat));
 let releaseExport,interceptExport,exportRequests=0;const intercepted=new Promise(resolve=>{interceptExport=resolve});
 await page.route('**/api/matches/*/export?*',async route=>{exportRequests++;await new Promise(resolve=>{releaseExport=resolve;interceptExport()});await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'暂时无法生成文档，请重试'})})});
 await page.locator('#exportButton').click();await page.locator('#confirmExport').click();await intercepted;await page.waitForFunction(()=>document.querySelector('#confirmExport').disabled);
 await page.evaluate(()=>{document.querySelector('#confirmExport').click();render()});
 check('Downloads remain disabled during polling and block duplicate submissions',await page.locator('#exportButton').isDisabled()&&await page.locator('#exportScope').isDisabled()&&exportRequests===1);
 releaseExport();await page.waitForFunction(()=>document.querySelector('#exportNotice').textContent.includes('暂时无法生成文档'));
 check('Download failure keeps dialog open and restores controls',await page.locator('#exportDialog').isVisible()&&await page.locator('#confirmExport').isEnabled()&&await page.locator('#exportScope').isEnabled());
 await page.unroute('**/api/matches/*/export?*');const retried=await saveExport(page);check('A failed download can be retried',retried.content.includes('历史消息 65'));
 await page.locator('[data-chat-history]').click();await page.waitForFunction(()=>document.querySelectorAll('#board .chat-message').length===66);
 check('History pagination loads the complete first topic');
 await page.locator('#connectionsPanel>summary').click();await page.locator('#transcriptPanel>summary').click();await page.evaluate(()=>refresh());
 check('Polling preserves manually toggled panels',!await page.locator('#connectionsPanel').evaluate(el=>el.open)&&await page.locator('#transcriptPanel').evaluate(el=>el.open));
 await page.locator('#connectionsPanel>summary').click();
 const invalid=app.arena.claim(ai).job;app.arena.submit(ai,{...invalid,result:{type:'bid',score:101}});await page.evaluate(()=>refresh());await page.waitForFunction(()=>document.querySelector('#taskList').textContent.includes('0..100'));
 app.arena.submit(ai,{...invalid,result:{score:0}});await page.evaluate(()=>refresh());await page.waitForFunction(()=>document.querySelector('#resolvedTaskSummary').textContent.includes('1'));
 check('Resolved faults show details in a collapsed history',!await page.locator('#resolvedTasks').evaluate(el=>el.open));
 const first=app.arena.get(chat).runId,human=app.arena.public(app.arena.get(chat)).participants.find(p=>p.type==='human').seat;
 await page.locator('#restartButton').click();await page.locator('[data-close=restartDialog]').click();check('Cancelling restart keeps the original run',app.arena.get(chat).runId===first);
 await page.locator('#restartButton').click();await page.locator('#restartTopic').fill('如果人类在月球建立城市');await page.locator('#confirmRestart').click();await page.waitForFunction(()=>match?.runNumber===2&&!match.started);
 check('New topic reuses room and browser identity',await page.evaluate(()=>!!credential()&&playerData?.seat===credential().seat)&&Object.keys(app.arena.store.state.matches).length===1);
 check('Personalities remain and initial opinions clear',app.arena.get(chat).game.members.every(p=>p.profile.initialOpinion==='')&&app.arena.get(chat).game.members.find(p=>p.id===human).profile.personality==='温和');
 check('New topic has no previous messages',await page.locator('#board .chat-message').count()===0);
 await page.locator('[data-run-id="'+first+'"]').click();await page.waitForFunction(()=>match?.readOnly===true);
 check('Old topic is read-only and restores its own cached history',await page.locator('#playerControls').isHidden()&&await page.locator('#startButton').isDisabled()&&await page.locator('[data-profile-seat]').count()===0&&await page.locator('#board .chat-message').count()===66);
 await page.evaluate(()=>{const slider=document.querySelector('#replay');slider.value='0';slider.dispatchEvent(new Event('input',{bubbles:true}))});
 const historicalExport=await exportRecords(page),roomExport=await exportRecords(page,'room');
 check('Archived export keeps the selected topic and ignores replay progress',historicalExport.filename.includes('_第1局_')&&historicalExport.content.includes('历史消息 65')&&!historicalExport.content.includes('如果人类在月球建立城市'));
 check('Whole-room export orders all topics including the current one',roomExport.filename.includes('_全部记录_')&&roomExport.content.indexOf('## 话题 1')<roomExport.content.indexOf('## 话题 2')&&roomExport.content.includes('如果人类在月球建立城市'));
 await page.locator('#backLive').click();
 await page.locator('#returnCurrent').click();await page.waitForFunction(()=>match?.runNumber===2&&!match.readOnly);
 await page.locator('#startButton').click();await page.waitForFunction(()=>humanJob?.kind==='chat-bid');const deadline=app.arena.get(chat).jobs.find(j=>j.seat===human).deadline;
 await page.locator('[data-run-id="'+first+'"]').click();await page.waitForFunction(()=>match?.readOnly===true);await page.evaluate(()=>refresh());check('Viewing history leaves current deadlines unchanged',app.arena.get(chat).jobs.find(j=>j.seat===human).deadline===deadline);
 for(const [theme,width,height]of [['dark',1440,1000],['light',390,844]]){
  await page.setViewportSize({width,height});await page.locator('#themePreference').selectOption(theme);await page.evaluate(()=>refresh());
  check(theme+' layout fits viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  check(theme+' chat uses the available board width',await page.evaluate(()=>{const board=document.querySelector('#board').getBoundingClientRect(),topic=document.querySelector('.chat-topic').getBoundingClientRect();return Math.abs(board.width-topic.width)<3}));
  await page.locator('#exportButton').click();
  check(theme+' export dialog fits the viewport',await page.evaluate(()=>{const r=document.querySelector('#exportDialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth}));
  const themedExport=await saveExport(page);check(theme+' export downloads selected history',themedExport.filename.includes('_第1局_')&&themedExport.content.includes('历史消息 65'));
  if(process.env.ARENA_ROOM_SCREENSHOT_DIR){
   const directory=path.resolve(process.env.ARENA_ROOM_SCREENSHOT_DIR),workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),relative=path.relative(workspace,directory);
   assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Screenshots stay in workspace');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'rooms-'+theme+'.jpg');
   await page.screenshot({path:file,type:'jpeg',quality:65,fullPage:true});check('Screenshot under 1 MiB: '+theme,fs.statSync(file).size<1024*1024);
  }
 }
 await page.setViewportSize({width:1440,height:1000});
 for(const kind of ['xiangqi','blind','werewolf']){
  const id=app.arena.create({kind,title:'取名验收 '+kind,timeoutSeconds:600}).id;await page.evaluate(()=>refresh());await page.locator('[data-id="'+id+'"]').click();await page.waitForFunction(id=>match?.id===id,id);
  const seat=kind==='werewolf'?'p1':'red';await page.locator('#players button[data-seat="'+seat+'"]').click();await page.locator('#inviteDialog').waitFor({state:'visible'});
  check(kind+' names before generating an invitation',await page.locator('#inviteText').inputValue()==='');await page.locator('#inviteNickname').fill('千问棋手');await page.locator('#generateInvite').click();await page.waitForFunction(()=>document.querySelector('#inviteText').value.includes('千问棋手'));
  const text=await page.locator('#inviteText').inputValue();app.arena.connect({match:id,seat,provider:'simulated',session:'browser-'+id,invitation:text.match(/--invitation ([a-f0-9]+)/)[1]});await page.locator('[data-close=inviteDialog]').click();
  for(const other of app.arena.seats(app.arena.get(id)).filter(s=>s!==seat))inviteAI(id,other,'模型 '+other);
  await page.evaluate(()=>refresh());await page.waitForFunction(()=>!document.querySelector('#startButton').disabled);await page.locator('#startButton').click();await page.waitForFunction(()=>match?.started);
  check(kind+' displays the AI nickname',await page.locator('#players').textContent().then(t=>t.includes('千问棋手')));
  if(kind==='werewolf')check('Werewolf stage displays nicknames',await page.locator('.ww-seat[data-seat=p1]').textContent().then(t=>t.includes('千问棋手')));
  if(kind==='werewolf'){await page.locator('#reveal').check();await page.waitForFunction(()=>match.game.players.every(p=>p.role));const revealedExport=await exportRecords(page);check('Omniscient checkbox does not expose hidden roles in export',!revealedExport.content.includes('| 狼人 |')&&!revealedExport.content.includes('| 预言家 |'));await page.locator('#reveal').uncheck()}
  await page.locator('#restartButton').click();await page.locator('#confirmRestart').click();await page.waitForFunction(()=>match?.runNumber===2&&!match.started);await page.locator('#runSelect').selectOption(id);await page.waitForFunction(()=>match?.readOnly);
  check(kind+' previous game controls are read-only',await page.locator('#restartButton').isDisabled()&&await page.locator('#players [data-seat]').count()===0);
  const gameExport=await exportRecords(page),allGames=await exportRecords(page,'room');
  check(kind+' exports archived games and the entire room',gameExport.filename.includes('_第1局_')&&gameExport.content.includes('千问棋手')&&!gameExport.content.includes('## 第 2 局')&&allGames.content.includes('## 第 2 局'));
 }
 const observer=await context.newPage();observer.on('pageerror',error=>errors.push(error.message));await observer.goto(app.origin+'/?room='+chat);await observer.waitForFunction(()=>match?.id);
 const publicExport=await exportRecords(observer,'room');check('Observers can download public history without a management code',publicExport.content.includes('历史消息 65')&&await observer.evaluate(()=>admin===''));
 await page.locator('[data-delete-id="'+chat+'"]').click();await page.locator('[data-close=deleteDialog]').click();check('Delete cancellation keeps room',!!app.arena.store.state.matches[chat]);
 await page.locator('[data-id="'+chat+'"]').click();await page.waitForFunction(id=>match?.id===id,chat);await page.locator('[data-delete-id="'+chat+'"]').click();await page.locator('#confirmDelete').click();await page.waitForFunction(id=>current!==id,chat);
 await observer.evaluate(()=>refresh());await observer.waitForFunction(id=>current!==id,chat);check('Deleted room is cleared from other pages',!app.arena.store.state.matches[chat]&&await observer.locator('#notice').textContent().then(t=>t.includes('已被删除')));
 while(Object.keys(app.arena.store.state.matches).length){const id=Object.keys(app.arena.store.state.matches)[0];await page.locator('[data-delete-id="'+id+'"]').click();await page.locator('#confirmDelete').click();await page.waitForFunction(id=>!roomList.some(m=>m.id===id),id)}
 check('Deleting the last room restores a complete empty state',await page.locator('#startButton').isDisabled()&&await page.locator('#exportButton').isDisabled()&&await page.locator('#players').textContent()===''&&await page.locator('#runNavigation').isHidden());
 assert.deepEqual(errors,[],'Browser script errors');console.log(JSON.stringify({browser:await context.browser().version(),checks:checks.length,passed:checks},null,2));
}catch(error){console.error(JSON.stringify({checks,errors,ui:await page?.evaluate(()=>({notice:document.querySelector('#notice')?.textContent,current,run:match?.runId,round:match?.game.round,events:match?.events.filter(e=>e.type==='chat-message').length,messages:document.querySelectorAll('#board .chat-message').length,refreshing,cache:[...chatHistory].map(([k,v])=>[k,v.messages.length])})).catch(()=>null)},null,2));throw error}
finally{await context?.close();await app?.close();removeTemporaryDirectory(root)}
