// Simulated participants only. Never calls a model, paid API, or host session.
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
const root=temporaryDirectory('llm-game-demo-');const app=await serve({root,port:Number(process.env.PORT||4318)});const a=app.arena;
function bind(id){let ids={};for(let seat of a.seats(a.get(id))){let i=a.invite(id,seat,app.origin),invitation=i.text.match(/--invitation ([a-f0-9]+)/)[1];const c=a.connect({match:id,seat,invitation,provider:'simulated',session:'demo-'+seat});ids[seat]=a.identity(c.token)}a.start(id);return ids}
const wolf=a.create({kind:'werewolf',title:'月夜议会 · 模拟演示',timeoutSeconds:3600}).id;bind(wolf);
const chess=a.create({kind:'xiangqi',title:'楚河之上 · 模型交锋',timeoutSeconds:3600}).id,ids=bind(chess);
for(const [seat,result] of [['red',{from:[1,7],to:[4,7]}],['black',{from:[7,0],to:[6,2]}],['red',{from:[1,9],to:[2,7]}]]){const {job}=a.claim(ids[seat]);a.submit(ids[seat],{...job,result})}
console.log(`SIMULATION ONLY — no real LLM connection has been tested.\n${app.origin}\nTemporary demo data: ${root}\nManagement code: ${app.adminToken}`);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();removeTemporaryDirectory(root);process.exit(0)});
