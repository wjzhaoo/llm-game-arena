import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

const guarded=['win32','linux'].includes(process.platform);
function directory(t){const root=temporaryDirectory('arena-service-lock-');t.after(()=>removeTemporaryDirectory(root));return root}
async function childService(t,root){
 const source=`import {serve} from ${JSON.stringify(new URL('../server.mjs',import.meta.url).href)};const app=await serve({root:process.argv[1],port:0,autoTick:false});app.arena.create({kind:'xiangqi',title:'持久化验收'});process.send({ready:true});process.on('message',async message=>{if(message==='close'){await app.close();process.exit(0)}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,root],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe','ipc']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}});
 await Promise.race([once(child,'message',{signal:AbortSignal.timeout(10000)}),exited.then(()=>{throw Error('Test service exited: '+stderr)})]);
 return {child,exited};
}

test('Service close removes only its own lock and permits an immediate restart',async t=>{
 const root=directory(t),app=await serve({root,port:0,autoTick:false});
 assert.ok(fs.existsSync(path.join(root,'service.lock')));await Promise.all([app.close(),app.close()]);assert.equal(fs.existsSync(path.join(root,'service.lock')),false);
 const next=await serve({root,port:0,autoTick:false});await next.close();
});
test('Graceful child shutdown releases the service guard and file lock',async t=>{
 const root=directory(t),{child,exited}=await childService(t,root);child.send('close');await exited;
 assert.equal(fs.existsSync(path.join(root,'service.lock')),false);const app=await serve({root,port:0,autoTick:false});assert.equal(Object.keys(app.arena.store.state.matches).length,1);await app.close();
});
test('A forced owner exit leaves recoverable metadata without blocking persisted state',{skip:!guarded},async t=>{
 const root=directory(t),{child,exited}=await childService(t,root);child.kill('SIGKILL');await exited;
 assert.ok(fs.existsSync(path.join(root,'service.lock')));const saved=fs.readFileSync(path.join(root,'state.json'),'utf8'),rooms=fs.readdirSync(path.join(root,'xiangqi')).filter(name=>name.endsWith('.json')),roomFile=path.join(root,'xiangqi',rooms[0]),room=fs.readFileSync(roomFile,'utf8');
 const app=await serve({root,port:0,autoTick:false});try{assert.equal(Object.keys(app.arena.store.state.matches).length,1);assert.equal(fs.readFileSync(path.join(root,'state.json'),'utf8'),saved);assert.equal(fs.readFileSync(roomFile,'utf8'),room);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'service.lock'),'utf8')).pid,process.pid)}finally{await app.close()}
});
test('A live legacy owner or ambiguous metadata is never automatically unlinked',async t=>{
 const root=directory(t),file=path.join(root,'service.lock');
 for(const content of [JSON.stringify({pid:process.pid,owner:'legacy-live'}),'not-json',JSON.stringify({pid:0,owner:'ambiguous'})]){
  fs.writeFileSync(file,content);await assert.rejects(serve({root,port:0,autoTick:false}),/PID|锁/);assert.equal(fs.readFileSync(file,'utf8'),content);
 }
 fs.unlinkSync(file);const app=await serve({root,port:0,autoTick:false});await app.close();
});
test('Concurrent starts share one writer; another data directory remains independent',async t=>{
 const root=directory(t),other=directory(t),results=await Promise.allSettled([serve({root,port:0,autoTick:false}),serve({root,port:0,autoTick:false})]);
 const success=results.filter(r=>r.status==='fulfilled');assert.equal(success.length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const app=success[0].value;
 try{const independent=await serve({root:other,port:0,autoTick:false});await independent.close();await assert.rejects(serve({root:path.join(root,'.'),port:0,autoTick:false}),/PID|锁/)}finally{await app.close()}
 const restart=await serve({root,port:0,autoTick:false});await restart.close();
});
test('Port-bind and corrupt-state failures release both lock layers before retry',async t=>{
 const portRoot=directory(t),root=directory(t),portOwner=await serve({root:portRoot,port:0,autoTick:false});
 try{await assert.rejects(serve({root,port:portOwner.server.address().port,autoTick:false}),error=>error.code==='EADDRINUSE');assert.equal(fs.existsSync(path.join(root,'service.lock')),false)}finally{await portOwner.close()}
 fs.writeFileSync(path.join(root,'state.json'),JSON.stringify({version:-1,matches:{}}));await assert.rejects(serve({root,port:0,autoTick:false}),/Unsupported/);assert.equal(fs.existsSync(path.join(root,'service.lock')),false);
 fs.unlinkSync(path.join(root,'state.json'));const app=await serve({root,port:0,autoTick:false});await app.close();
});
