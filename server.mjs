import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from './lib/store.mjs';
import {acquireServiceGuard} from './lib/service-lock.mjs';
import {Arena} from './lib/arena.mjs';
import {WakeService} from './lib/wake.mjs';
import {RelayService} from './lib/relay.mjs';
import {networkAddresses} from './lib/network.mjs';
import {relayInvitation} from './lib/invitation.mjs';
import {markdownDisposition} from './lib/export.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export const clientFiles=['client.mjs','relay-client.mjs','lib/network.mjs','lib/relay-worker.mjs','lib/wake/common.mjs','lib/wake/host.mjs','lib/wake/index.mjs','lib/wake/codex.mjs','lib/wake/mimo.mjs','lib/wake/qoder.mjs','lib/wake/codearts.mjs','lib/wake/opencode.mjs','lib/wake/dsh.mjs','.opencode/plugins/arena-codearts.js'];
const publicFiles=new Set(['index.html','app.js','ui.js','groupchat.js','groupchat.css','chess-ui.js','chess3d.mjs','chess-coordinates.mjs','chess.css','vendor/three/three.module.js','vendor/three/OrbitControls.js','werewolf.js','theme.js','style.css','werewolf.css','assets/avatars/manifest.json']);
const mime=file=>file.endsWith('.html')?'text/html; charset=utf-8':/\.(?:m?js)$/.test(file)?'text/javascript; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.json')?'application/json; charset=utf-8':'text/css; charset=utf-8';

export async function serve({port=Number(process.env.PORT||4318),host=process.env.HOST||'0.0.0.0',root=process.env.ARENA_DATA||path.join(here,'.arena'),adminToken=process.env.ARENA_ADMIN_TOKEN||randomBytes(32).toString('hex'),wakeOptions={},arenaOptions={},autoTick=true,interfaces}={}){
 if(!Number.isInteger(port)||port<0||port>65535||!['0.0.0.0','127.0.0.1'].includes(host))throw Error('Use PORT 1..65535 and HOST 0.0.0.0 or 127.0.0.1');
 if(typeof adminToken!=='string'||!/^[\x21-\x7e]+$/.test(adminToken))throw Error('ARENA_ADMIN_TOKEN must contain printable ASCII characters without spaces');
 const guard=await acquireServiceGuard(root);
 let store,arena,wake,relay;
 try{store=new Store(guard.root);arena=new Arena(store,arenaOptions);wake=new WakeService(arena,wakeOptions);relay=new RelayService(arena,wake)}catch(error){store?.close();await guard.release();throw error}
 let network;
 const server=http.createServer(async(req,res)=>{
  const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
  const staticFile=(file,download=false)=>{
   if(!fs.existsSync(file))return reply(404,{error:'Not found'});
   res.writeHead(200,{'Content-Type':mime(file),'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff',...(download?{'Content-Disposition':'attachment; filename="'+path.basename(file)+'"'}:{})});
   res.end(fs.readFileSync(file));
  };
  try{
   if(!network.allowedHosts.has(req.headers.host))return reply(403,{error:'Invalid host'});
   const requestOrigin='http://'+req.headers.host;
   if(req.headers.origin&&req.headers.origin!==requestOrigin)return reply(403,{error:'Foreign origin blocked'});
   const url=new URL(req.url,requestOrigin),bearer=(req.headers.authorization||'').replace(/^Bearer /,'');
   const admin=()=>{const a=Buffer.from(bearer),b=Buffer.from(adminToken);if(a.length!==b.length||!timingSafeEqual(a,b))throw Error('Admin authorization required')};
   if(req.method==='GET'){
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(publicFiles.has(file)||/^assets\/avatars\/[a-z0-9-]+\.(?:svg|png)$/.test(file))return staticFile(path.join(here,'public',file));
    if(url.pathname==='/downloads/arena-bootstrap.mjs')return staticFile(path.join(here,'public','arena-bootstrap.mjs'),true);
    if(url.pathname.startsWith('/downloads/')){
     const item=url.pathname.slice('/downloads/'.length);
     if(clientFiles.includes(item))return staticFile(path.join(here,item),true);
     return reply(404,{error:'Not found'});
    }
    if(url.pathname==='/api/client-manifest')return reply(200,{files:clientFiles.map(item=>{const bytes=fs.readFileSync(path.join(here,item));return {path:item,sha256:createHash('sha256').update(bytes).digest('hex')}})});
    if(url.pathname==='/api/network')return reply(200,{localOrigin:network.origin,lanOrigins:network.lanOrigins});
    if(url.pathname==='/api/admin'){admin();return reply(200,{ok:true})}
    if(url.pathname==='/api/matches')return reply(200,Object.values(store.state.matches).map(m=>({id:m.id,runId:m.runId,runNumber:m.runNumber,title:m.title,kind:m.kind,createdAt:m.createdAt,status:m.game.status,started:m.started})));
    let match=url.pathname.match(/^\/api\/matches\/([^/]+)\/export$/);
    if(match){
     const document=arena.exportRecords(match[1],{scope:url.searchParams.get('scope')??'run',runId:url.searchParams.get('runId')||undefined});
     res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':markdownDisposition(document.filename),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
     return res.end(document.content);
    }
    match=url.pathname.match(/^\/api\/matches\/([^/]+)\/messages$/);
    if(match)return reply(200,arena.messages(match[1],{runId:url.searchParams.get('runId')||undefined,...(url.searchParams.has('before')?{before:Number(url.searchParams.get('before'))}:{}),...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{})}));
    match=url.pathname.match(/^\/api\/matches\/([^/]+)\/runs\/([^/]+)$/);
    if(match)return reply(200,arena.publicRun(match[1],match[2]));
    match=url.pathname.match(/^\/api\/matches\/([^/]+)\/(admin|connections)$/);
    if(match){admin();return reply(200,match[2]==='admin'?arena.adminView(match[1]):wake.diagnostics(match[1]))}
    match=url.pathname.match(/^\/api\/matches\/([^/]+)$/);
    if(match){const reveal=url.searchParams.get('reveal')==='1';if(reveal)admin();return reply(200,arena.public(arena.get(match[1]),reveal))}
    return reply(404,{error:'Not found'});
   }
   if(req.method!=='POST')return reply(404,{error:'Not found'});
   if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'JSON required'});
   let size=0;const chunks=[];
   for await(const chunk of req){size+=chunk.length;if(size>65536)return reply(413,{error:'Body too large'});chunks.push(chunk)}
   const v=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
   if(!v||typeof v!=='object'||Array.isArray(v))throw Error('JSON object required');
   if(url.pathname==='/api/player'){
    if(v.expectedRunId!==undefined){const room=v.action==='join'?v.match:arena.identity(bearer).match;arena.assertRun(arena.get(room),v.expectedRunId)}
    if(v.action==='join')return reply(200,arena.joinHuman(v));
    const identity=arena.identity(bearer);arena.requireType(identity,'human');
    if(v.action==='status')return reply(200,arena.playerStatus(identity));
    if(v.action==='claim')return reply(200,arena.claim(identity));
    if(v.action==='submit')return reply(200,arena.submit(identity,v));
    if(v.action==='resign')return reply(200,arena.resign(identity));
    if(v.action==='emote')return reply(200,arena.emote(identity,v));
    if(v.action==='undo-request')return reply(200,arena.requestUndo(identity,v));
    if(v.action==='profile')return reply(200,arena.profile(identity,v));
    if(v.action==='chat-restart')return reply(200,arena.restartChat(identity.match,identity));
    throw Error('Unknown player action');
   }
   if(url.pathname==='/api/relay'){
    const identity=relay.identity(bearer);
    if(v.action==='poll')return reply(200,relay.poll(identity,v));
    if(v.action==='report'||v.action==='check')return reply(200,relay.report(identity,v));
    throw Error('Unknown relay action');
   }
   if(url.pathname==='/api/connect'){
    if(v.wakeTransport==='relay')return reply(200,relay.connect(v));
    if(v.wakeTransport&&v.wakeTransport!=='local')throw Error('Invalid wake transport');
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw Error('另一台电脑请使用 --wake-transport relay');
    return reply(200,await wake.connect(v));
   }
   if(url.pathname==='/desktop'){
    const identity=arena.identity(bearer);arena.requireType(identity,'ai');
    if(v.expectedRunId!==undefined)arena.assertRun(arena.get(identity.match),v.expectedRunId);
    if(v.action==='claim')return reply(200,arena.claim(identity));
    if(v.action==='resume')return reply(200,await wake.resume(identity,v));
    if(v.action==='park')return reply(200,arena.park(identity));
    if(v.action==='wake-bind')return reply(200,await wake.bind(identity,v));
    if(v.action==='submit')return reply(200,arena.submit(identity,v));
    if(v.action==='resign')return reply(200,arena.resign(identity));
    if(v.action==='emote')return reply(200,arena.emote(identity,v));
    if(v.action==='undo-request')return reply(200,arena.requestUndo(identity,v));
    if(v.action==='profile')return reply(200,arena.profile(identity,v));
    if(v.action==='history')return reply(200,arena.messages(identity.match,{runId:v.runId,before:v.before,limit:v.limit??50}));
    if(v.action==='chat-restart')return reply(200,arena.restartChat(identity.match,identity));
    if(v.action==='status')return reply(200,{...arena.modelStatus(identity),connection:wake.diagnostics(identity.match).find(c=>c.seat===identity.seat)});
    throw Error('Unknown desktop action');
   }
   admin();
   if(v.match&&v.expectedRunId!==undefined)arena.assertRun(arena.get(v.match),v.expectedRunId);
   if(url.pathname==='/api/wake-check')return reply(200,wake.requestManual(v));
   if(url.pathname==='/api/control'){const {match,...control}=v;return reply(200,arena.control(match,control))}
   if(url.pathname==='/api/matches')return reply(201,arena.create(v));
   if(url.pathname==='/api/chat-members'){const {match,...input}=v;return reply(200,arena.chatMembers(match,input))}
   if(url.pathname==='/api/participant-type')return reply(200,arena.setParticipantType(v.match,v.seat,v.type));
   if(url.pathname==='/api/room-invite'||url.pathname==='/api/invite'){
    const transport=v.wakeTransport||'local';
    if(!['local','relay'].includes(transport))throw Error('Invalid wake transport');
    const base=url.pathname==='/api/room-invite'||transport==='relay'?(v.base||network.lanOrigins[0]||network.origin):network.origin;
    if(![network.origin,...network.lanOrigins].includes(base))throw Error('请选择服务器显示的局域网地址');
    if(url.pathname==='/api/room-invite')return reply(200,arena.roomInvite(v.match,base));
    const invitation=arena.invite(v.match,v.seat,base,v.nickname);
    return reply(200,transport==='relay'?relayInvitation(invitation,base,v.match):{...invitation,wakeTransport:'local'});
   }
   if(url.pathname==='/api/start'){arena.start(v.match);return reply(200,{ok:true})}
   if(url.pathname==='/api/revoke'){arena.revoke(v.match,v.seat);return reply(200,{ok:true})}
   return reply(404,{error:'Not found'});
  }catch(error){reply(error.status||(/authorization|Unauthorized/.test(error.message)?401:400),{error:error.message})}
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});network=networkAddresses(server.address().port,host,interfaces)}catch(error){wake.stop();if(server.listening)await new Promise(resolve=>server.close(resolve));try{store.close()}finally{await guard.release()}throw error}
 const tick=()=>{try{arena.tick();wake.tick()}catch(error){console.error('State persistence blocked:',error.message)}};
 const timer=autoTick?setInterval(tick,1000):null;timer?.unref();
 let closing;
 return {server,arena,wake,relay,origin:network.origin,lanOrigins:network.lanOrigins,adminToken,tick,closeSync:()=>store.close(),close:()=>closing??=(async()=>{if(timer)clearInterval(timer);wake.stop();await new Promise(resolve=>server.close(resolve));try{store.close()}finally{await guard.release()}})()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let app;
 try{app=await serve()}catch(error){console.error('竞技场启动失败：'+error.message);process.exitCode=1}
 if(app){
 console.log('弈境 / LLM Game Arena\n本机：'+app.origin+'\n'+(app.lanOrigins.length?app.lanOrigins.map(url=>'局域网：'+url).join('\n'):'未发现可分享的局域网地址')+'\n本次管理码（仅保存在当前进程，不加入 URL）：'+app.adminToken+'\n真人通过房间链接加入；远端 AI 在自己的电脑运行转接进程。Ctrl+C 停止。');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0)});
 process.once('exit',()=>{try{app.closeSync()}catch{}});
 }
}
