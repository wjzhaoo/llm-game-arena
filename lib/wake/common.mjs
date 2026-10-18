import path from 'node:path';

export const WAKE_PROVIDERS = Object.freeze(['codex', 'mimo', 'qoder', 'codearts', 'opencode', 'dsh']);
const aliases = {qodercn: 'qoder', 'qoder-cn': 'qoder', codeartsdoer: 'codearts', 'open-code': 'opencode'};

export function providerName(value) {
 if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(value) || value.toLowerCase() === 'auto') {
  throw Error('Receiver must confirm real provider and session');
 }
 const name = value.toLowerCase();
 return aliases[name] || name;
}

export const supportsWake = provider => WAKE_PROVIDERS.includes(providerName(provider));
export const sameWorkspace = (a, b) => typeof a === 'string' && typeof b === 'string' && path.isAbsolute(a) && path.isAbsolute(b) && path.relative(path.resolve(a), path.resolve(b)) === '';
export const markerFor = attemptId => `LLM-GAME-WAKE:${attemptId}`;
export const hasMarker = (info, marker) => (info.messages || []).some(message => message.role === 'user' && typeof message.text === 'string' && message.text.includes(`[${marker}]`));
export const messagesFromParts = messages => messages.map(m => ({role: m.info?.role || m.role, text: (m.parts || []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')}));

export function retryable(message) {
 const error = Error(message);
 error.safeToRetry = true;
 return error;
}

export function assertCanSend(binding) {
 if (binding.canSend && !binding.canSend()) throw retryable('The binding or pending attempt changed before delivery');
}

export async function bounded(work, timeoutMs) {
 let timer;
 try {
  return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
   timer = setTimeout(() => reject(Error('Host operation timed out; delivery must be checked before retry')), timeoutMs);
  })]);
 } finally { clearTimeout(timer); }
}

export function loopbackUrl(value) {
 const url = new URL(value);
 if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw Error('Host bridge must use a loopback HTTP origin');
 }
 return url;
}

export async function confirmMessage(adapter, binding, marker, {attempts = 4, delayMs = 250} = {}) {
 for (let i = 0; i < attempts; i++) {
  if (i) await new Promise(resolve => setTimeout(resolve, delayMs));
  try { if (hasMarker(await adapter.read(binding), marker)) return {delivered: true}; } catch {}
 }
 throw Error('Host accepted the request but the wake message has not been verified');
}
