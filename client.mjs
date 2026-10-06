import fs from 'node:fs';
import path from 'node:path';
import {providerName} from './lib/wake/common.mjs';

const [command, ...args] = process.argv.slice(2), opts = {};
for (let i = 0; i < args.length; i += 2) {
 if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw Error('Expected --key value');
 opts[args[i].slice(2)] = args[i + 1];
}

async function send(url, body, token) {
 const base = new URL(url);
 if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw Error('Only loopback HTTP supported; do not expose credentials remotely');
 const response = await fetch(base, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json; charset=utf-8', ...(token ? {Authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body), signal: AbortSignal.timeout(25000)});
 const out = await response.json();
 if (!response.ok) throw Error(out.error || `HTTP ${response.status}`);
 return out;
}

try {
 if (command === 'connect') {
  if (!opts.out) throw Error('--out credential path required');
  const credentialPath = path.resolve(opts.out);
  if (fs.existsSync(credentialPath)) throw Error('Credential file exists; use it rather than overwrite');
  const provider = providerName(opts.provider);
  const session = opts.session || (provider === 'codex' ? process.env.CODEX_THREAD_ID : undefined);
  const out = await send(opts.url + '/api/connect', {match: opts.match, seat: opts.seat, invitation: opts.invitation, provider, session, credentialPath, ...(opts['turn-id'] ? {turnId: opts['turn-id']} : {}), ...(opts.model ? {model: opts.model} : {})});
  fs.mkdirSync(path.dirname(credentialPath), {recursive: true, mode: 0o700});
  const {token, clientId, match, seat, continuationMode, ...next} = out;
  fs.writeFileSync(credentialPath, JSON.stringify({token, clientId, match, seat, continuationMode, url: opts.url}, null, 2), {encoding: 'utf8', flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({connected: true, seat, credential: credentialPath, continuationMode, ...next}, null, 2));
 } else {
  if (!['claim', 'resume', 'submit', 'status', 'park', 'wake-bind'].includes(command)) throw Error('Commands: connect, claim, resume, submit, status, park, wake-bind. See README.');
  const credentialPath = path.resolve(opts.credential), credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  const body = {action: command, credentialPath, ...(opts.provider ? {provider: opts.provider} : {}), ...(opts.model ? {model: opts.model} : {}), ...(opts['turn-id'] ? {turnId: opts['turn-id']} : {})};
  if (command === 'submit') Object.assign(body, {taskId: opts.task, attemptId: opts.attempt, result: JSON.parse(fs.readFileSync(opts.file, 'utf8'))});
  let out;
  const until = Date.now() + 60000;
  do {
   out = await send(credential.url + '/desktop', body, credential.token);
   if (command !== 'resume' || out.job || out.completed || out.parked || out.continuationMode === 'wake') break;
   await new Promise(resolve => setTimeout(resolve, 1500));
  } while (Date.now() < until);
  console.log(JSON.stringify(out, null, 2));
 }
} catch (error) { console.error(error.message); process.exitCode = 1; }
