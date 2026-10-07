import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';

export function privateAddress(host) {
 if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
 if (isIP(host) !== 4) return false;
 const [a,b] = host.split('.').map(Number);
 return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Game traffic can cross a LAN; authenticated host bridges retain loopbackUrl.
export function arenaUrl(value) {
 const url = new URL(value);
 if (url.protocol !== 'http:' || !privateAddress(url.hostname) || url.username || url.password || url.search || url.hash) throw Error('请使用本机或局域网 HTTP 地址');
 return url;
}

export function networkAddresses(port, host, interfaces = networkInterfaces()) {
 const ips = new Set(['127.0.0.1','localhost']);
 if (host !== '127.0.0.1') for (const entries of Object.values(interfaces)) for (const entry of entries || []) {
  if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && privateAddress(entry.address)) ips.add(entry.address);
 }
 if (isIP(host) === 4 && host !== '0.0.0.0' && privateAddress(host)) ips.add(host);
 const origin = 'http://127.0.0.1:' + port;
 return {origin, lanOrigins:[...ips].filter(ip => ip !== 'localhost' && !ip.startsWith('127.')).map(ip => 'http://' + ip + ':' + port), allowedHosts:new Set([...ips].map(ip => ip + ':' + port))};
}

export async function postArena(url, body, token, fetcher = fetch) {
 const endpoint = arenaUrl(url);
 const response = await fetcher(endpoint, {method:'POST',redirect:'error',headers:{'Content-Type':'application/json; charset=utf-8',...(token ? {Authorization:'Bearer ' + token} : {})},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const out = await response.json();
 if (!response.ok) {
  const error = Error(out.error || 'HTTP ' + response.status);
  error.status = response.status;
  throw error;
 }
 return out;
}
