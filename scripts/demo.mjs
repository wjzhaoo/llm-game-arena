// Simulated participants only. Never calls a model, paid API, or host session.
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
const root=temporaryDirectory('llm-game-demo-');const app=await serve({root,port:Number(process.env.PORT||4318)});const a=app.arena;
function bind(id){let ids={};for(let seat of a.seats(a.get(id))){let i=a.invite(id,seat,app.origin),invitation=i.text.match(/--invitation ([a-f0-9]+)/)[1];const c=a.connect({match:id,seat,invitation,provider:'simulated',session:'demo-'+seat});ids[seat]=a.identity(c.token)}a.start(id);return ids}
const wolf=a.create({kind:'werewolf',title:'月夜议会 · 模拟演示',timeoutSeconds:3600}).id;bind(wolf);
const chess=a.create({kind:'xiangqi',title:'楚河之上 · 模型交锋',timeoutSeconds:3600}).id,ids=bind(chess);
for(const [seat,result] of [['red',{from:[1,7],to:[4,7]}],['black',{from:[7,0],to:[6,2]}],['red',{from:[1,9],to:[2,7]}]]){const {job}=a.claim(ids[seat]);a.submit(ids[seat],{...job,result})}
const blind=a.create({kind:'blind',title:'覆棋暗战 · 模拟演示',timeoutSeconds:3600}).id,bids=bind(blind);
for(const [seat,result] of [['red',{from:[0,6],to:[0,5]}],['black',{from:[4,3],to:[4,4]}],['red',{from:[1,7],to:[4,7]}]]){const {job}=a.claim(bids[seat]);a.submit(bids[seat],{...job,result})}
const chat=a.create({kind:'groupchat',title:'群星茶话会 · 模拟演示',topic:'如果在月球建一座城市，你最想先建设什么？',timeoutSeconds:3600}).id;
for(const [nickname,personality,initialOpinion] of [['星河','好奇、喜欢追问','先建科研基地'],['青禾','温和、善于鼓励','先保障生态和生活'],['砾石','直率、喜欢调侃','先建交通与能源']])a.chatMembers(chat,{action:'add-ai',nickname,profile:{personality,initialOpinion}});
const chatIds=bind(chat);
for(const [speaker,text,emote]of [['p1','我想先建设一座科研基地。月球城市首先应该帮助我们理解这个新家园。','think'],['p2','有研究也要有生活！我希望先把供氧、种植和公共花园做好。','encourage'],['p3','没有稳定的能源和交通，花园可能只能种在效果图上。先铺基础设施吧。','tease']]){
 for(const seat of a.seats(a.get(chat))){const {job}=a.claim(chatIds[seat]);a.submit(chatIds[seat],{...job,result:{type:'bid',score:seat===speaker?90:30}})}
 const {job}=a.claim(chatIds[speaker]);a.submit(chatIds[speaker],{...job,result:{type:'speak',text,emote:{id:emote}}});
}
console.log(`SIMULATION ONLY — player seats only, deterministic rules, no independent judge; no real LLM connection has been tested.\n${app.origin}\nTemporary demo data: ${root}\nManagement code: ${app.adminToken}`);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();removeTemporaryDirectory(root);process.exit(0)});
