// Standalone downloader: only writes the selected workspace's tmp directory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const opts={};
for(let i=2;i<process.argv.length;i+=2){
 if(!process.argv[i].startsWith('--')||process.argv[i+1]===undefined)throw Error('Expected --key value');
 opts[process.argv[i].slice(2)]=process.argv[i+1];
}
const origin=new URL(opts.url),host=origin.hostname.replace(/^\[|\]$/g,'');
const octets=host.split('.').map(Number);
const privateHost=host==='localhost'||host==='::1'||(/^\d+\.\d+\.\d+\.\d+$/.test(host)&&octets.every(n=>n>=0&&n<=255)&&(octets[0]===127||octets[0]===10||octets[0]===172&&octets[1]>=16&&octets[1]<=31||octets[0]===192&&octets[1]===168||octets[0]===169&&octets[1]===254));
if(origin.protocol!=='http:'||!privateHost||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Use the invitation LAN HTTP origin');
const workspace=fs.realpathSync(path.resolve(opts.workspace||process.cwd()));
function ensureDirectory(parts){
 let directory=workspace;
 for(const part of parts){
  const next=path.join(directory,part);
  if(fs.existsSync(next)){
   if(fs.lstatSync(next).isSymbolicLink()||!fs.statSync(next).isDirectory())throw Error('Client directory must remain inside workspace without directory links');
  }else fs.mkdirSync(next,{mode:0o700});
  directory=next;
 }
 return directory;
}
const fetchFile=async name=>{
 const r=await fetch(new URL(name,origin),{redirect:'error',signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Error('客户端下载失败：'+name);
 return Buffer.from(await r.arrayBuffer());
};
const manifest=JSON.parse((await fetchFile('/api/client-manifest')).toString('utf8'));
if(!Array.isArray(manifest.files)||manifest.files.length>30)throw Error('Invalid manifest');
for(const item of manifest.files){
 if(typeof item.path!=='string'||!/^[a-zA-Z0-9._/-]+$/.test(item.path)||item.path.split('/').some(p=>!p||p==='..'||p==='.')||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid client path');
 const bytes=await fetchFile('/downloads/'+item.path);
 if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('客户端校验失败：'+item.path);
 const parts=['tmp','arena-client',...item.path.split('/')],name=parts.pop(),directory=ensureDirectory(parts),target=path.join(directory,name);
 if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Client file cannot use a link');
 const pending=target+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(pending,bytes,{flag:'wx',mode:0o600});fs.renameSync(pending,target)}
 finally{if(fs.existsSync(pending))fs.unlinkSync(pending)}
}
console.log('客户端准备完成：'+path.join(workspace,'tmp','arena-client','client.mjs')+'\n请继续执行邀请中的 connect 命令。CodeArts 需已加载项目认证桥接，Qoder 需已加载 App Plugin。');
