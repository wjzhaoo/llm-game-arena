import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {RelayWorker} from './lib/relay-worker.mjs';
import {createWakeAdapters} from './lib/wake/index.mjs';
import {postArena} from './lib/network.mjs';

const script=fileURLToPath(import.meta.url);
function alive(pid){try{process.kill(pid,0);return true}catch{return false}}
export function ensureRelay(credentialPath){
 const lock=credentialPath+'.lock';
 try{const owner=JSON.parse(fs.readFileSync(lock,'utf8'));if(alive(owner.pid))return}catch{}
 const log=fs.openSync(credentialPath+'.log','a',0o600);
 try{
  const child=spawn(process.execPath,[script,'--credential',credentialPath],{detached:true,windowsHide:true,stdio:['ignore',log,log]});
  child.on('error',()=>{});child.unref();
 }finally{fs.closeSync(log)}
}

export async function runRelay(credentialPath){
 const lock=credentialPath+'.lock',owner={pid:process.pid};
 try{
  fs.writeFileSync(lock,JSON.stringify(owner),{flag:'wx',mode:0o600});
 }catch{
  const previous=JSON.parse(fs.readFileSync(lock,'utf8'));
  if(alive(previous.pid))return;
  fs.unlinkSync(lock);
  try{fs.writeFileSync(lock,JSON.stringify(owner),{flag:'wx',mode:0o600})}catch{return}
 }
 let worker;
 try{
  const local=JSON.parse(fs.readFileSync(credentialPath,'utf8')),adapters=createWakeAdapters();
  worker=new RelayWorker({config:local.config,adapter:adapters[local.config.provider],script:local.script,request:body=>postArena(local.url+'/api/relay',body,local.relayToken)});
  const stop=()=>worker.stop();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let backoff=2000;
  while(!worker.stopped){
   try{
    const refreshed=JSON.parse(fs.readFileSync(credentialPath,'utf8'));
    if(refreshed.config.provider!==worker.config.provider||refreshed.config.session!==worker.config.session)throw Error('Relay identity changed');
    worker.config=refreshed.config;
    await worker.step();backoff=2000;
   }catch(error){
    if(error.status===401){worker.stop();break}
    console.error(new Date().toISOString()+' 远端连接暂不可用，保留原身份等待重连');
    backoff=Math.min(30000,backoff*2);
   }
   if(!worker.stopped)await new Promise(resolve=>setTimeout(resolve,backoff));
  }
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
 }finally{
  try{if(JSON.parse(fs.readFileSync(lock,'utf8')).pid===owner.pid)fs.unlinkSync(lock)}catch{}
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===script){
 const i=process.argv.indexOf('--credential');
 if(i<0||!process.argv[i+1])throw Error('--credential relay file required');
 runRelay(path.resolve(process.argv[i+1])).catch(()=>{console.error('转接进程未能启动，请检查本机凭据和宿主条件');process.exitCode=1});
}
