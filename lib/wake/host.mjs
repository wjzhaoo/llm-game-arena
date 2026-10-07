import path from 'node:path';
import fs from 'node:fs';
import {bounded,providerName,supportsWake,sameWorkspace} from './common.mjs';

export function checkHostInfo(binding, info, {requireWorkspace=false}={}) {
 if (info.session !== binding.session) throw Error('Host returned a different session');
 if(requireWorkspace&&(info.workspaceVerified===false||!sameWorkspace(binding.workspace,info.workspace)))throw Error('远端宿主未提供匹配的工作目录核验证据，请检查当地桥接；邀请保留');
 if (!(binding.provider === 'qoder' && info.workspaceVerified === false) && !sameWorkspace(binding.workspace, info.workspace)) throw Error('Host session workspace does not match the original model workspace');
}

export async function prepareHost(input, {workspace,adapters,now=Date.now,timeoutMs=15000,requireWorkspace=false}, previous) {
 const provider=providerName(input.provider||previous?.provider);
 if(!supportsWake(provider))return null;
 const session=input.session||previous?.session;
 if(typeof session!=='string'||!session.trim()||session.length>200)throw Error('Receiver must confirm real provider and session');
 const credentialPath=input.credentialPath||previous?.credentialPath;
 if(typeof credentialPath!=='string'||!path.isAbsolute(credentialPath)||/["\r\n\0]/.test(credentialPath))throw Error('Wake requires the absolute credential file path');
 workspace=path.resolve(workspace);
 const relative=path.relative(workspace,credentialPath);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!credentialPath.endsWith('.credential.json'))throw Error('Wake credential file must be inside the model workspace');
 let directory=workspace;
 for(const part of relative.split(path.sep)){
  directory=path.join(directory,part);
  if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw Error('Wake credential path cannot use directory links');
 }
 const adapter=adapters[provider];
 if(!adapter)throw Error('Wake adapter unavailable: '+provider);
 const binding={provider,session,workspace,credentialPath,...(input.turnId||previous?.turnId?{turnId:input.turnId||previous.turnId}:{}),...(input.model||previous?.model?{model:input.model||previous.model}:{})};
 if(provider==='codex'&&!binding.turnId)binding.turnId=await bounded(()=>adapter.resolveTurn(session,workspace),timeoutMs);
 if(provider==='codex'&&(typeof binding.turnId!=='string'||!binding.turnId.trim()))throw Error('Codex requires a real turn ID');
 if(binding.model&&(typeof binding.model!=='string'||!/^[^\s/]+\/\S+$/.test(binding.model)))throw Error('Model must use provider/model');
 const info=await bounded(()=>(adapter.verify||adapter.read).call(adapter,binding),timeoutMs);
 checkHostInfo(binding,info,{requireWorkspace});
 if(provider==='mimo'&&!binding.model)binding.model=info.model;
 if(provider==='mimo'&&!/^[^\s/]+\/\S+$/.test(binding.model||''))throw Error('MiMo requires a confirmed model; use --model provider/model');
 binding.verifiedAt=now();binding.workspaceVerified=info.workspaceVerified!==false;
 return binding;
}
