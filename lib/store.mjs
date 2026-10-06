import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import upstream from '../vendor/task-dispatch/storage.cjs';
export class Store {
 constructor(root){this.root=path.resolve(root);fs.mkdirSync(this.root,{recursive:true,mode:0o700});this.file=path.join(this.root,'state.json');this.lock=path.join(this.root,'service.lock');this.owner=randomUUID();fs.writeFileSync(this.lock,JSON.stringify({pid:process.pid,owner:this.owner}),{flag:'wx',mode:0o600});try{this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,matches:{},revision:0};if(this.state.version!==1)throw Error('Unsupported data version');}catch(e){this.close();throw e}}
 change(fn){let next=structuredClone(this.state);let result=fn(next);next.revision++;upstream.atomic(this.file,next);this.state=next;return result}
 close(){if(fs.existsSync(this.lock)&&JSON.parse(fs.readFileSync(this.lock,'utf8')).owner===this.owner)fs.unlinkSync(this.lock)}
}
