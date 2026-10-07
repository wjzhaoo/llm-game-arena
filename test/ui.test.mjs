import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';import {initialXiangqi,xiangqiView} from '../lib/xiangqi.mjs';
import {createHash} from 'node:crypto';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
function theme({saved,system=false,blocked=false}={}){const events={},mediaEvents={},root={dataset:{},style:{}},control={value:''},stored={value:saved,reads:0,writes:0};let media={matches:system,addEventListener:(name,fn)=>mediaEvents[name]=fn};let ctx={document:{documentElement:root,getElementById:()=>control},localStorage:{getItem(){stored.reads++;throw Error('No persistent reads allowed')},setItem(){stored.writes++;throw Error('No persistent writes allowed')},removeItem(key){if(blocked)throw Error('blocked');assert.equal(key,'arena-theme-preference');delete stored.value}},matchMedia:()=>media,addEventListener:(name,fn)=>events[name]=fn};vm.runInNewContext(read('public/theme.js'),ctx);return {ctx,root,control,stored,media,mediaEvents,events}}
function helpers(){let ctx={};vm.runInNewContext(read('public/ui.js'),ctx);return ctx.ArenaUI}
test('Theme stays in page memory, reload defaults to system, and legacy preference is removed',()=>{const t=theme({saved:'light',system:true});assert.equal(t.root.dataset.theme,'dark');assert.equal(t.stored.value,undefined);t.ctx.ArenaTheme.set('light');t.media.matches=true;t.mediaEvents.change();assert.equal(t.root.dataset.theme,'light');const reload=theme({system:true});assert.equal(reload.root.dataset.theme,'dark');assert.equal(reload.ctx.ArenaTheme.preference,'system');t.ctx.ArenaTheme.set('system');t.media.matches=false;t.mediaEvents.change();assert.equal(t.root.dataset.theme,'light');assert.equal(t.events.storage,undefined);assert.equal(t.stored.reads,0);assert.equal(t.stored.writes,0);});
test('Theme switching tolerates blocked storage and ignores invalid choices without persistence',()=>{const t=theme({saved:'dark',blocked:true});assert.equal(t.ctx.ArenaTheme.preference,'system');assert.equal(t.root.dataset.theme,'light');t.ctx.ArenaTheme.set('dark');assert.equal(t.root.dataset.theme,'dark');t.ctx.ArenaTheme.set('<script>');assert.equal(t.ctx.ArenaTheme.preference,'dark');assert.equal(t.stored.reads,0);assert.equal(t.stored.writes,0);});
test('Theme script is before CSS; accessible three-state control and local helper scripts exist',()=>{const html=read('public/index.html');assert.ok(html.indexOf('/theme.js')<html.indexOf('/style.css'));for(const value of ['system','light','dark'])assert.ok(html.includes(`value="${value}"`));assert.ok(html.includes('aria-label="外观主题"'));assert.ok(html.includes('/ui.js'));});
test('Xiangqi renders both redundant side marks, read-only legal targets, capture rings and last-move outlines',()=>{const ui=helpers(),g=xiangqiView(initialXiangqi());let html=ui.chess(g,[0,6]);assert.equal((html.match(/data-cell=/g)||[]).length,32);assert.equal((html.match(/class="piece red/g)||[]).length,16);assert.equal((html.match(/class="piece black/g)||[]).length,16);assert.ok(html.includes('piece-side'));assert.ok(html.includes('aria-pressed="true"'));assert.ok(html.includes('legal-target'));assert.ok(html.includes('不提交棋步'));g.board[5][0]='bP';g.lastMove={from:[0,3],to:[0,5]};html=ui.chess(g,[0,6]);assert.ok(html.includes('capture-target'));assert.ok(html.includes('last-from'));assert.ok(html.includes('last-to'));assert.ok(!ui.chess(g,['bad',6]).includes('class="move-target'));});
test('Avatar helper accepts local SVG/PNG, safely escapes labels and has unknown/error fallback',()=>{
 const ui=helpers(),manifest={providers:{qoder:{label:'Qoder',src:'/assets/avatars/qoder.png'},evil:{label:'<img>',src:'https://evil.test/x.png'},codex:{label:'Codex',initials:'CX',kind:'fallback'}},aliases:{qodercn:'qoder'}};
 assert.ok(ui.avatar('QoderCN',manifest).includes('/assets/avatars/qoder.png'));
 for(const src of ['https://evil.test/x.png','/assets/avatars/../x.png','/assets/avatars/x.png?token=secret','data:image/png;base64,AAAA','/assets/avatars/x.html']){
  manifest.providers.evil.src=src;const html=ui.avatar('evil',manifest);assert.ok(!html.includes('class="avatar-image"'));assert.ok(html.includes('&lt;img&gt;'));
 }
 assert.ok(!ui.avatar('__proto__',manifest).includes('<img'));assert.ok(ui.avatar(null,manifest).includes('未知平台'));assert.ok(ui.avatar('codex',manifest).includes('文字占位标识'));assert.ok(read('public/app.js').includes("event.target.hidden=true"));
});
test('Wake button follows server capability and status, never provider branding',()=>{const ui=helpers();assert.equal(ui.wakeControl({mode:'wait',provider:'codex'}),null);assert.equal(ui.wakeControl({mode:'wake',verified:false}),null);let d={mode:'wake',verified:true,canWake:true,status:'parked'};assert.equal(ui.wakeControl(d).label,'唤醒');assert.equal(ui.wakeControl(d,true).disabled,true);assert.equal(ui.wakeControl({...d,status:'uncertain'}).label,'核验送达');assert.equal(ui.wakeControl({...d,canWake:false,status:'sent'}).label,'已送达 · 待领取');});
function luminance(hex){const c=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
test('Both themes maintain readable chess text and distinguishable selected/legal/capture markers',()=>{const css=read('public/style.css');const light=css.slice(css.indexOf('/* Theme tokens:')),dark=light.slice(light.indexOf(':root[data-theme="dark"]'));for(const block of [light,dark]){const get=name=>block.match(new RegExp('--'+name+':(#[0-9a-f]{6})'))[1];for(const side of ['red','black'])assert.ok(contrast(get(side+'-face'),get(side+'-ink'))>=7,side+' piece text');for(const state of ['selected','legal','capture'])assert.ok(contrast(get(state),get('board'))>=3,state+' marker');assert.ok(contrast(get('ink'),get('card'))>=7);assert.ok(contrast(get('muted'),get('card'))>=4.5);}assert.ok(css.includes('border-style:double'));assert.ok(css.includes('3px dashed var(--capture)'));});
test('Bundled avatars have verified hashes, bounded PNG pixels or static SVG and provenance',()=>{
 const manifest=JSON.parse(read('public/assets/avatars/manifest.json'));
 for(const [key,info] of Object.entries(manifest.providers)){
  assert.match(info.src,/^\/assets\/avatars\/[a-z0-9-]+\.(?:svg|png)$/);
  const bytes=fs.readFileSync(new URL('../public'+info.src,import.meta.url));assert.ok(bytes.length<1024*1024);assert.equal(createHash('sha256').update(bytes).digest('hex'),info.sha256);
  if(info.src.endsWith('.png')){
   assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));assert.equal(bytes.toString('ascii',12,16),'IHDR');assert.equal(bytes.readUInt32BE(16),256);assert.equal(bytes.readUInt32BE(20),256);
   assert.equal(info.kind,'installed-application-icon');assert.ok(info.source.startsWith('installed-application:'));assert.ok(info.sourceFileName);assert.match(info.extractedAt,/^\d{4}-\d{2}-\d{2}$/);
  }else{
   const svg=bytes.toString('utf8');assert.ok(svg.includes('<svg'));assert.ok(!/<script|<foreignObject|<image|<animate|\son[a-z]+=|(?:href|src)=/i.test(svg),key+' safe SVG');assert.ok(!/url\(\s*['"]?(?:https?:|\/\/|data:)/i.test(svg));
  }
  assert.ok(info.license);if(info.kind==='official-repository-logo'){assert.ok(info.source.startsWith('https://'));assert.ok(info.licenseFile)}
 }
 assert.equal(manifest.aliases.qodercn,'qoder');assert.ok(helpers().avatar('not-a-provider',manifest).includes('/assets/avatars/default.svg'));
 for(const alias of ['codeartsdoer','qodercn','mimo-code','minimax-code','kimi-code','trae-solo-cn'])assert.ok(helpers().avatar(alias,manifest).includes('.png'));
});
import {initialBlind,blindView,applyBlind} from '../lib/blind.mjs';
import {initialWerewolf,werewolfView} from '../lib/werewolf.mjs';
test('Blind board renders covered pieces with cover hints, open kings, reveal banner and capture tray',()=>{const ui=helpers();const state=initialBlind({seed:42});let html=ui.chess(blindView(state),null);assert.equal((html.match(/data-cell=/g)||[]).length,32);assert.equal((html.match(/covered/g)||[]).length>=30,true);assert.equal((html.match(/piece-cover/g)||[]).length,30);assert.ok(html.includes('暗棋 · 走动后揭开'));assert.ok(!html.includes('captured-chip red')&&!html.includes('captured-chip black'));applyBlind(state,'red',{from:[0,6],to:[0,5]});const view=blindView(state);html=ui.chess(view,[0,5]);assert.ok(html.includes('reveal-banner'));assert.ok(html.includes('上一手揭晓'));assert.ok((html.match(/piece-cover/g)||[]).length===29);assert.ok(html.includes('不提交棋步'));view.captured.red.push({hidden:false,side:'black',kind:'R'});html=ui.chess(view,null);assert.ok(html.includes('captured-chip black'));assert.ok(html.includes('红方缴获'));assert.ok(html.includes('黑方缴获'));});

test('Human chess orientation keeps server coordinates; inactive targets and replay remain safe',()=>{
 const ui=helpers(),view=xiangqiView(initialXiangqi());
 const html=ui.chess(view,[0,6],{interactive:true,canAct:true,side:'black'});
 assert.ok(html.includes('黑方朝下'));
 assert.ok(html.includes('style="left:95%;top:35%" data-cell="0,6"'));
 assert.ok(html.includes('data-target="0,5" aria-label="可落子位置 0,5，提交棋步"'));
 assert.ok(ui.chess(view,[0,6],{interactive:true,canAct:false}).includes('data-target="0,5" disabled'));
 const readonly=ui.chess(view,[0,6],{side:'black'});
 assert.ok(readonly.includes('只读观战'));assert.ok(readonly.includes('不提交棋步'));assert.ok(!readonly.includes('提交棋步"'));
});
test('Werewolf human forms use private role projections and keep target/potion rules',()=>{
 const ui=helpers(),game=initialWerewolf({roles:['wolf','wolf','seer','witch','villager','villager']});
 assert.equal(ui.werewolfActions(werewolfView(game),{}),'');
 let html=ui.werewolfActions(werewolfView(game,'p1'),{});
 assert.ok(html.includes('狼队友：p2'));assert.ok(!html.includes('value="p1"'));assert.ok(!html.includes('value="p2"'));assert.ok(html.includes('value="p3"'));
 game.phase='seer';game.findings.p3=[{round:1,target:'p1',wolf:true}];
 html=ui.werewolfActions(werewolfView(game,'p3'),{});
 assert.ok(html.includes('p1 是狼人'));assert.ok(!html.includes('value="p3"'));assert.ok(html.includes('value="p1"'));
 game.phase='witch';game.night.target='p5';
 html=ui.werewolfActions(werewolfView(game,'p4'),{});assert.ok(html.includes('今晚刀口：p5'));assert.ok(!html.includes('value="save" disabled'));
 game.potions.save=false;game.potions.poison=false;
 html=ui.werewolfActions(werewolfView(game,'p4'),{});assert.ok(html.includes('value="save" disabled'));assert.ok(html.includes('value="poison" disabled'));assert.ok(!html.includes('今晚刀口：p5'));
 game.phase='discuss';html=ui.werewolfActions(werewolfView(game,'p5'),{});assert.ok(html.includes('id="speechText" maxlength="600"'));
 game.phase='vote';html=ui.werewolfActions(werewolfView(game,'p5'),{});assert.ok(html.includes('value="p5"'));assert.ok(!ui.werewolfActions(werewolfView(game,'p5'),null).includes('<form'));
});
