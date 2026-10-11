import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {providerName,supportsWake} from './lib/wake/common.mjs';
import {createWakeAdapters} from './lib/wake/index.mjs';
import {prepareHost} from './lib/wake/host.mjs';
import {arenaUrl,postArena} from './lib/network.mjs';
import {ensureRelay} from './relay-client.mjs';

const [command,...args]=process.argv.slice(2),opts={};
for(let i=0;i<args.length;i+=2){
 if(!args[i]?.startsWith('--')||args[i+1]===undefined)throw Error('Expected --key value');
 opts[args[i].slice(2)]=args[i+1];
}
const script=fileURLToPath(import.meta.url);
const writeCredential=(file,value,exclusive=false)=>fs.writeFileSync(file,JSON.stringify(value,null,2),{encoding:'utf8',flag:exclusive?'wx':'w',mode:0o600});
const hostInput=(provider,session,credentialPath)=>({provider,session,credentialPath,...(opts['turn-id']?{turnId:opts['turn-id']}:{}),...(opts.model?{model:opts.model}:{})});
try{
 if(command==='connect'){
  if(!opts.out)throw Error('--out credential path required');
  const credentialPath=path.resolve(opts.out);
  if(fs.existsSync(credentialPath))throw Error('Credential file exists; use it rather than overwrite');
  const base=arenaUrl(opts.url);if(base.pathname!=='/')throw Error('Use the Arena HTTP origin');
  const provider=providerName(opts.provider);
  let session=opts.session||(provider==='codex'?process.env.CODEX_THREAD_ID:undefined);
  const transport=opts['wake-transport']||'local';
  if(!['local','relay'].includes(transport))throw Error('Invalid wake transport');
  const workspace=path.resolve(opts.workspace||process.cwd());
  let config=null;
  if(transport==='relay'&&supportsWake(provider))config=await prepareHost(hostInput(provider,session,credentialPath),{workspace,adapters:createWakeAdapters(),requireWorkspace:true});
  if(config)session=config.session;
  const relayVerification=config?{verified:true,workspaceVerified:config.workspaceVerified,deviceId:createHash('sha256').update(os.hostname()+'\0'+os.userInfo().username+'\0'+os.homedir()).digest('hex')}:undefined;
  const out=await postArena(base.origin+'/api/connect',{match:opts.match,seat:opts.seat,invitation:opts.invitation,...hostInput(provider,session,credentialPath),workspace,wakeTransport:transport,...(relayVerification?{relayVerification}:{})});
  fs.mkdirSync(path.dirname(credentialPath),{recursive:true,mode:0o700});
  const credential={token:out.token,clientId:out.clientId,match:out.match,seat:out.seat,continuationMode:out.continuationMode,url:base.origin,workspace,wakeTransport:transport};
  if(config&&out.relayToken){
   const relayCredentialPath=credentialPath.replace(/\.credential\.json$/,'.relay.credential.json');
   credential.relayCredentialPath=relayCredentialPath;
   writeCredential(relayCredentialPath,{relayToken:out.relayToken,url:base.origin,clientId:out.clientId,config,script},true);
  }
  writeCredential(credentialPath,credential,true);
  if(credential.relayCredentialPath)ensureRelay(credential.relayCredentialPath);
  // Explicit allowlist: never print either token, local bridge config, or session ID.
  console.log(JSON.stringify({connected:true,seat:out.seat,credential:credentialPath,continuationMode:out.continuationMode,nextAction:out.nextAction,parked:out.parked,idle:out.idle,completed:out.completed,...(out.job?{job:out.job}:{})},null,2));
 }else{
  if(!['claim','resume','submit','status','park','wake-bind','emote','undo-request','resign'].includes(command))throw Error('Commands: connect, claim, resume, submit, status, park, wake-bind, emote, undo-request, resign. See README.');
  const credentialPath=path.resolve(opts.credential),credential=JSON.parse(fs.readFileSync(credentialPath,'utf8'));
  if(credential.relayCredentialPath){
   if(command==='wake-bind'){
    const file=credential.relayCredentialPath,local=JSON.parse(fs.readFileSync(file,'utf8'));
    if(opts.provider&&providerName(opts.provider)!==local.config.provider)throw Error('Wake must reuse the connected provider');
    local.config=await prepareHost(hostInput(local.config.provider,local.config.session,credentialPath),{workspace:local.config.workspace,adapters:createWakeAdapters(),requireWorkspace:true},local.config);
    writeCredential(file,local);ensureRelay(file);
    console.log(JSON.stringify({ok:true,continuationMode:'wake',nextAction:'resume'},null,2));process.exit(0);
   }
   ensureRelay(credential.relayCredentialPath);
  }
  const body={action:command,credentialPath,...(opts.workspace||credential.workspace?{workspace:path.resolve(opts.workspace||credential.workspace)}:{}),...(opts.provider?{provider:opts.provider}:{}),...(opts.model?{model:opts.model}:{}),...(opts['turn-id']?{turnId:opts['turn-id']}: {})};
  if(command==='submit')Object.assign(body,{taskId:opts.task,attemptId:opts.attempt,result:JSON.parse(fs.readFileSync(opts.file,'utf8'))});
  if(command==='emote'){if(!opts.emote)throw Error('--emote fixed id required');body.emote=opts.emote}
  if(command==='undo-request'){if(!/^\d+$/.test(opts.revision||''))throw Error('--revision boardRevision required');body.boardRevision=Number(opts.revision)}
  let out;const until=Date.now()+60000;
  do{
   out=await postArena(credential.url+'/desktop',body,credential.token);
   if(command!=='resume'||out.job||out.completed||out.parked||out.continuationMode==='wake')break;
   await new Promise(resolve=>setTimeout(resolve,1500));
  }while(Date.now()<until);
  console.log(JSON.stringify(out,null,2));
 }
}catch(error){console.error(error.message);process.exitCode=1}
