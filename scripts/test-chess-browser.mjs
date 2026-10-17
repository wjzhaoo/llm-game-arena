// Optional real-browser acceptance. Production and npm test stay dependency-free.
// ARENA_PLAYWRIGHT_MODULE may point to a bundled Playwright index.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

const modulePath=process.env.ARENA_PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath&&path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath||'playwright');
const root=temporaryDirectory('arena-chess-browser-');let app,context;
const errors=[],checks=[];
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name)};
try{
 app=await serve({port:0,root:path.join(root,'data'),adminToken:'isolated-browser-fixture'});
 context=await chromium.launchPersistentContext(path.join(root,'profile'),{headless:true,channel:process.env.ARENA_BROWSER_CHANNEL||undefined,viewport:{width:1360,height:1000},hasTouch:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 async function joined(id,seat,invite){
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.location().url.endsWith('/favicon.ico'))errors.push(message.text())});
  await page.goto(invite.url);await page.locator('#joinDialog').waitFor({state:'visible'});await page.locator('#nickname').fill(seat==='red'?'红方棋友':'黑方棋友');await page.locator('#humanSeat').selectOption(seat);await page.locator('#joinHuman').click();await page.locator('#playerControls').waitFor({state:'visible'});return page;
 }
 async function room(kind){
  const id=app.arena.create({kind,title:kind==='blind'?'覆棋立体验收':'象棋立体验收',timeoutSeconds:180}).id;
  for(const seat of ['red','black'])app.arena.setParticipantType(id,seat,'human');
  const invite=app.arena.roomInvite(id,app.origin),red=await joined(id,'red',invite),black=await joined(id,'black',invite);app.arena.start(id);
  for(const page of [red,black])await page.waitForFunction(()=>match?.started&&!!humanJob=== (playerData?.seat==='red'));
  return {id,red,black};
 }
 async function three(page){await page.bringToFront();await page.locator('[data-board-mode="3d"]').click();await page.waitForFunction(()=>!!chessStage?.player);await page.locator('.chess3d-canvas').waitFor({state:'visible'})}
 async function ply(page,n){await page.waitForFunction(ply=>match?.game.ply===ply,n)}
 async function pick(page,square){await page.bringToFront();await page.locator('.chess3d-canvas').scrollIntoViewIfNeeded();const point=await page.evaluate(square=>chessStage.player.screenPoint(square),square);if(page.viewportSize().width<700)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y)}
 async function move3d(page,from,to,n){await pick(page,from);await page.waitForFunction(square=>selectedCell?.join(',')===square.join(','),from);await pick(page,to);await ply(page,n)}
 async function move2d(page,from,to,n){await page.bringToFront();await page.locator('.chess-flat [data-cell="'+from+'"]').click();await page.locator('.chess-flat [data-target="'+to+'"]').click();await ply(page,n)}

 const {id,red,black}=await room('xiangqi');
 check('Default 2D and explicit red-turn markers',await red.locator('.chess-flat .turn-edge.red.active').count()===1);
 check('Black orientation keeps server coordinates',(await black.locator('.chess-flat .chess').getAttribute('aria-label')).includes('黑方朝下'));
 await three(red);await red.evaluate(()=>globalThis.acceptanceCanvas=document.querySelector('.chess3d-canvas'));
 const centerBefore=await red.evaluate(()=>chessStage.player.screenPoint([0,6]));await red.locator('.chess3d-canvas').hover();await red.mouse.wheel(0,-400);await red.waitForTimeout(350);const centerAfter=await red.evaluate(()=>chessStage.player.screenPoint([0,6]));check('Wheel zoom changes perspective',Math.hypot(centerAfter.x-centerBefore.x,centerAfter.y-centerBefore.y)>1);await red.locator('[data-camera-reset]').click();
 await red.waitForTimeout(2300);check('Polling preserves WebGL canvas',await red.evaluate(()=>acceptanceCanvas===document.querySelector('.chess3d-canvas')));
 const bounds=await red.locator('.chess3d-canvas').boundingBox();await red.mouse.move(bounds.x+bounds.width*.45,bounds.y+bounds.height*.5);await red.mouse.down();await red.mouse.move(bounds.x+bounds.width*.62,bounds.y+bounds.height*.54,{steps:12});await red.mouse.up();await red.waitForTimeout(300);
 check('Camera drag does not submit or select',app.arena.get(id).game.ply===0&&await red.evaluate(()=>selectedCell===null));
 await move3d(red,[0,6],[0,5],1);check('Ray-picked move after rotating camera',app.arena.get(id).game.board[5][0]==='rP');
 await ply(black,1);await three(black);await move3d(black,[0,3],[0,4],2);await ply(red,2);check('Black-side 3D picking uses original coordinates',app.arena.get(id).game.board[4][0]==='bP');
 check('Position updates preserve camera canvas',await red.evaluate(()=>acceptanceCanvas===document.querySelector('.chess3d-canvas')));
 await red.locator('[data-emote="good"]').click();await black.locator('.chess-emote.red').waitFor({state:'visible'});check('Emote is shared with opponent',(await black.locator('.chess-emote.red').textContent()).includes('好棋'));
 await red.locator('[data-undo]').click();await black.locator('[data-undo-answer="true"]').waitFor({state:'visible'});await red.waitForFunction(()=>document.querySelector('.chess-turn').textContent.includes('确认悔棋'));check('Confirmation replaces chess turn UI');
 await black.locator('[data-undo-answer="true"]').click();await ply(red,0);check('Consented two-ply rollback updates 3D and timeline',app.arena.get(id).game.turn==='red'&&app.arena.get(id).history.some(e=>e.type==='undo-accepted'));
 await red.locator('#themePreference').selectOption('dark');await red.waitForTimeout(2300);check('Dark theme reaches 3D',await red.evaluate(()=>document.documentElement.dataset.theme==='dark'));
 for(let i=0;i<6;i++){await red.evaluate(()=>globalThis.previousGL=document.querySelector('.chess3d-canvas').getContext('webgl2'));await red.locator('[data-board-mode="2d"]').click();check('2D releases canvas '+i,await red.locator('.chess3d-canvas').count()===0);await red.waitForFunction(()=>previousGL.isContextLost());check('WebGL context released '+i);await three(red);check('Single WebGL surface '+i,await red.locator('.chess3d-canvas').count()===1)}
 red.once('dialog',dialog=>dialog.accept());await red.locator('[data-resign]').click();await red.waitForFunction(()=>match?.game.status==='finished');check('Resignation declares correct winner',app.arena.get(id).game.winner==='black');
 const index=app.arena.get(id).history.findIndex(e=>e.type==='emote');await red.locator('#replay').evaluate((input,index)=>{input.value=String(index);input.dispatchEvent(new Event('input',{bubbles:true}))},index);
 check('Replay disables participant operations',await red.locator('#playerControls').isHidden());check('Replay shows selected historical emote',(await red.locator('.chess-emote.red').textContent()).includes('好棋'));
 const before=JSON.stringify(app.arena.get(id).game);await pick(red,[2,6]);await pick(red,[2,5]);check('3D replay cannot change finished game',JSON.stringify(app.arena.get(id).game)===before);
 await red.evaluate(()=>{const c=document.querySelector('.chess3d-canvas');c.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()});await red.waitForFunction(()=>chessMode==='2d');check('WebGL context loss falls back to 2D',await red.locator('.chess-flat .chess').count()===1);
 await red.close();await black.close();

 const fallback=await context.newPage();await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /^(webgl2?|experimental-webgl)$/.test(type)?null:original.call(this,type,...args)}});await fallback.goto(app.origin+'/?room='+id);await fallback.locator('[data-board-mode="3d"]').click();await fallback.waitForFunction(()=>chessMode==='2d'&&!chessStage?.loading);check('WebGL initialization failure restores 2D',await fallback.locator('.chess-flat .chess').count()===1);await fallback.close();

 const blind=await room('blind');await three(blind.red);
 check('3D blind projection contains only covered identities',await blind.red.evaluate(()=>match.game.board.flat().filter(p=>p?.hidden).length===30&&!JSON.stringify(match).includes('"cs"')));
 await move3d(blind.red,[4,9],[4,8],1);await ply(blind.black,1);await move2d(blind.black,[4,0],[4,1],2);await ply(blind.red,2);await blind.red.locator('[data-undo]').click();await blind.black.locator('[data-undo-answer="true"]').click();await ply(blind.red,0);
 check('Open-piece blind rollback is available in 3D',app.arena.get(blind.id).game.ply===0);
 await blind.red.locator('#themePreference').selectOption('dark');await blind.red.waitForTimeout(2300);
 if(process.env.ARENA_CHESS_SCREENSHOT)await blind.red.locator('.stage').screenshot({path:process.env.ARENA_CHESS_SCREENSHOT});
 await blind.red.setViewportSize({width:390,height:844});await blind.red.waitForTimeout(300);
 check('Mobile board fits viewport',await blind.red.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await move3d(blind.red,[0,6],[0,5],1);check('Blind reveal disables undo',await blind.red.locator('[data-undo]').isDisabled());check('Disabled undo explains reveal restriction',(await blind.red.locator('[data-undo]').getAttribute('title')).includes('揭子'));
 await blind.red.emulateMedia({reducedMotion:'reduce'});await blind.red.locator('[data-board-mode="2d"]').click();await blind.red.waitForFunction(()=>getComputedStyle(document.querySelector('.turn-edge.active')).animationName==='none');check('Reduced-motion CSS removes edge animation');
 await three(blind.red);await blind.red.evaluate(()=>globalThis.previousGL=document.querySelector('.chess3d-canvas').getContext('webgl2'));const otherId=app.arena.create({kind:'xiangqi'}).id;await blind.red.locator('[data-id="'+otherId+'"]').click();await blind.red.waitForFunction(id=>chessStage?.room?.startsWith(id+':')&&!!chessStage.player,otherId);await blind.red.waitForFunction(()=>previousGL.isContextLost());check('Room switch releases old WebGL context and creates one scene',await blind.red.locator('.chess3d-canvas').count()===1);
 assert.deepEqual(errors,[],'browser errors');console.log(JSON.stringify({browser:await context.browser().version(),checks:checks.length,passed:checks},null,2));
}finally{await context?.close();await app?.close();removeTemporaryDirectory(root)}
