import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from './lib/store.mjs';
import {Arena} from './lib/arena.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function serve({port=Number(process.env.PORT||4318),root=process.env.ARENA_DATA||path.join(here,'.arena'),adminToken=process.env.ARENA_ADMIN_TOKEN||randomBytes(32).toString('hex')}={}){
 const store=new Store(root),arena=new Arena(store);let origin;
 const server=http.createServer(async(req,res)=>{const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
 try{if(req.headers.host!==new URL(origin).host)return reply(403,{error:'Invalid host'});if(req.headers.origin&&req.headers.origin!==origin)return reply(403,{error:'Foreign origin blocked'});const url=new URL(req.url,origin);const bearer=(req.headers.authorization||'').replace(/^Bearer /,'');const admin=()=>{let a=Buffer.from(bearer),b=Buffer.from(adminToken);if(a.length!==b.length||!timingSafeEqual(a,b))throw Error('Admin authorization required')};
 if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)){const f=url.pathname==='/'?'index.html':url.pathname.slice(1);res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html; charset=utf-8':f.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});return res.end(fs.readFileSync(path.join(here,'public',f)))}
 if(req.method==='GET'&&url.pathname==='/api/matches')return reply(200,Object.values(store.state.matches).map(m=>({id:m.id,title:m.title,kind:m.kind,createdAt:m.createdAt,status:m.game.status,started:m.started})));
 let match=url.pathname.match(/^\/api\/matches\/([^/]+)$/);if(req.method==='GET'&&match){const reveal=url.searchParams.get('reveal')==='1';if(reveal)admin();return reply(200,arena.public(arena.get(match[1]),reveal))}
 if(req.method!=='POST')return reply(404,{error:'Not found'});if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'JSON required'});let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)return reply(413,{error:'Body too large'})}const v=JSON.parse(body||'{}');
 if(url.pathname==='/api/connect')return reply(200,arena.connect(v));
 if(url.pathname==='/desktop'){const identity=arena.identity(bearer);if(v.action==='claim'||v.action==='resume')return reply(200,arena.claim(identity));if(v.action==='submit')return reply(200,arena.submit(identity,v));if(v.action==='status')return reply(200,{...arena.public(arena.get(identity.match)),privateView:arena.view(arena.get(identity.match),identity.seat==='judge'?null:identity.seat)});throw Error('Unknown desktop action')}
 admin();if(url.pathname==='/api/matches')return reply(201,arena.create(v));if(url.pathname==='/api/invite')return reply(200,arena.invite(v.match,v.seat,origin));if(url.pathname==='/api/start'){arena.start(v.match);return reply(200,{ok:true})}if(url.pathname==='/api/revoke'){arena.revoke(v.match,v.seat);return reply(200,{ok:true})}return reply(404,{error:'Not found'});
 }catch(e){reply(/authorization|Unauthorized/.test(e.message)?401:400,{error:e.message})}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)}).catch(e=>{store.close();throw e});origin=`http://127.0.0.1:${server.address().port}`;const timer=setInterval(()=>{try{arena.tick()}catch(e){console.error('State persistence blocked:',e.message)}},1000);timer.unref();return {server,arena,origin,adminToken,close:async()=>{clearInterval(timer);await new Promise(r=>server.close(r));store.close()}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){let app=await serve();console.log(`弈境 / LLM Game Arena\n${app.origin}\n本次管理码（仅保存在当前进程，不加入 URL）：${app.adminToken}\n仅监听本机；无模型调用。Ctrl+C 停止。`);for(let signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0)})}
