import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';

function lockOwner(file) {
 try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}
}

export function lockMessage(file) {
 const owner=lockOwner(file);
 return owner?.pid?'该数据目录已有服务或待核实的进程（PID '+owner.pid+'）。请先关闭原服务。':'服务锁内容无法识别，请核实原服务已退出后检查 '+file;
}

function recoverExitedOwner(file) {
 let raw;
 try{if(fs.lstatSync(file).isSymbolicLink())throw Error('服务锁不能是符号链接');raw=fs.readFileSync(file,'utf8')}catch(error){if(error.code==='ENOENT')return;throw error}
 let owner;
 try{owner=JSON.parse(raw)}catch{throw Error(lockMessage(file))}
 if(!Number.isInteger(owner.pid)||owner.pid<1||typeof owner.owner!=='string'||!owner.owner)throw Error(lockMessage(file));
 try{process.kill(owner.pid,0)}catch(error){
  if(error.code!=='ESRCH')throw Error('无法确认原服务进程状态（PID '+owner.pid+'），保留服务锁');
  // The OS guard serializes recovery and creation, including concurrent starts.
  if(fs.readFileSync(file,'utf8')!==raw)throw Error('服务锁已变化，请重新启动');
  fs.unlinkSync(file);return;
 }
 throw Error(lockMessage(file));
}

export async function acquireServiceGuard(directory) {
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const root=fs.realpathSync(directory),lock=path.join(root,'service.lock');
 const key=createHash('sha256').update(process.platform==='win32'?root.toLowerCase():root).digest('hex');
 // Windows named pipes and Linux abstract sockets disappear with their owner.
 // Other systems retain the conservative exclusive-file behavior.
 const address=process.platform==='win32'?'\\\\.\\pipe\\llm-game-arena-'+key:process.platform==='linux'?'\0llm-game-arena-'+key:null;
 if(!address)return {root,release:async()=>{}};
 const guard=net.createServer(socket=>socket.destroy());
 try{
  await new Promise((resolve,reject)=>{guard.once('error',reject);guard.listen(address,resolve)});
 }catch(error){if(error.code==='EADDRINUSE')throw Error(lockMessage(lock));throw error}
 let releasing;
 const release=()=>releasing??=(new Promise((resolve,reject)=>guard.close(error=>error?reject(error):resolve())));
 try{recoverExitedOwner(lock)}catch(error){await release();throw error}
 return {root,release};
}
