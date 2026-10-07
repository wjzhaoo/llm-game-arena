import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {serve} from '../server.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';

test('HTTP serves every manifest avatar unchanged with its image MIME and blocks unrelated files',async t=>{
 const root=temporaryDirectory('avatar-http-');
 const app=await serve({port:0,host:'127.0.0.1',root,adminToken:'avatar-test-admin',autoTick:false});
 t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const manifest=await (await fetch(app.origin+'/assets/avatars/manifest.json')).json();
 for(const info of Object.values(manifest.providers)){
  const response=await fetch(app.origin+info.src);
  assert.equal(response.status,200,info.label);
  assert.equal(response.headers.get('content-type'),info.src.endsWith('.png')?'image/png':'image/svg+xml');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(new URL('../public'+info.src,import.meta.url)));
 }
 for(const url of ['/assets/avatars/manifest.png','/assets/avatars/codex.exe','/assets/avatars/licenses/qoder-MIT.txt','/assets/avatars/%2e%2e%2fmanifest.json'])assert.equal((await fetch(app.origin+url)).status,404);
});
