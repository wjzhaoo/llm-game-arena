// Project-local SDK bridge, adapted from task-dispatch's codearts-hook.mjs.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import upstream from '../../vendor/task-dispatch/storage.cjs';

export const ArenaCodeArts = async ctx => {
 if (!['list', 'get', 'messages', 'status', 'promptAsync'].every(name => typeof ctx.client?.session?.[name] === 'function')) return {};
 if (!path.isAbsolute(ctx.directory || '')) return {};
 const directory = path.resolve(ctx.directory), root = path.join(directory, 'tmp', 'codearts-bridge');
 fs.mkdirSync(root, {recursive: true, mode: 0o700});
 const token = randomBytes(32).toString('hex');
 const json = (res, status, data) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); };
 const call = async (name, id, body) => {
  const value = await ctx.client.session[name]({query: {directory}, ...(id ? {path: {id}} : {}), ...(body ? {body} : {})});
  if (value?.error) throw Error('Host SDK request failed');
  return value?.data ?? value;
 };
 const server = http.createServer((req, res) => {
  const run = async () => {
   const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, '')), expected = Buffer.from(token);
   if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, {error: 'Unauthorized'});
   const url = new URL(req.url, 'http://127.0.0.1');
   if (req.method === 'GET' && url.pathname === '/v1/status') return json(res, 200, await call('status'));
   if (req.method === 'GET' && url.pathname === '/v1/sessions') {
    const list = await call('list');
    return json(res, 200, (Array.isArray(list) ? list : []).filter(item => item && typeof item.id === 'string' && /^[A-Za-z0-9._:-]{4,200}$/.test(item.id) && typeof item.directory === 'string' && path.resolve(item.directory) === directory).map(item => ({id: item.id, directory})));
   }
   const match = /^\/v1\/session\/([^/]+)(?:\/(messages|prompt))?$/.exec(url.pathname);
   if (!match) return json(res, 404, {error: 'Not found'});
   const id = decodeURIComponent(match[1]);
   if (req.method === 'GET' && !match[2]) return json(res, 200, await call('get', id));
   if (req.method === 'GET' && match[2] === 'messages') return json(res, 200, await call('messages', id));
   if (req.method === 'POST' && match[2] === 'prompt') {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 65536) return json(res, 413, {error: 'Body too large'}); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(body.parts) || body.parts.length !== 1 || body.parts[0]?.type !== 'text' || typeof body.parts[0].text !== 'string') throw Error('Invalid prompt body');
    await call('promptAsync', id, body);
    res.writeHead(204); return res.end();
   }
   return json(res, 405, {error: 'Method not allowed'});
  };
  run().catch(() => json(res, 400, {error: 'Host SDK request failed'}));
 });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 const bridge = {version: 2, directory, url: `http://127.0.0.1:${server.address().port}`, token};
 upstream.atomic(path.join(root, 'bridge.json'), bridge);
 const record = sessionId => {
  if (typeof sessionId === 'string' && /^[A-Za-z0-9._:-]{4,200}$/.test(sessionId)) upstream.atomic(path.join(root, createHash('sha256').update(sessionId).digest('hex') + '.json'), {...bridge, sessionId});
 };
 return {
  dispose: async () => { await new Promise(resolve => server.close(resolve)); },
  event: async ({event}) => {
   const info = event.properties || {};
   if (['session.created', 'session.updated'].includes(event.type)) { if (path.resolve(info.info?.directory || '.') === directory) record(info.info?.id); }
   else if (['session.idle', 'session.status', 'message.updated'].includes(event.type)) record(info.sessionID || info.info?.sessionID);
  }
 };
};
