// [AI-added] 2026-09-12 11:00
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const id = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function readableName(value, fallback = 'project') {
  const name = Array.from(path.basename(path.resolve(value)).normalize('NFKC')).map(character => {
    if (/[a-zA-Z0-9]/.test(character)) return character.toLowerCase();
    if (/^[\p{Letter}\p{Number}]$/u.test(character)) return `-u${character.codePointAt(0).toString(16)}-`;
    return '-';
  }).join('').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return name || fallback;
}
function workspaceKey(workspace) {
  const dir = path.resolve(workspace);
  return `${readableName(dir)}-${sha(dir.toLowerCase()).slice(0, 8)}`;
}
function desktopProjectId(workspace) { return `desktop-${workspaceKey(workspace)}`; }
// [AI-added] 2026-09-22 09:20: Only rename contention is automatically retryable.
class StorageWriteError extends Error {
  constructor(cause,file,tmp,retryable){super(cause.message,{cause});this.name='StorageWriteError';this.code=cause.code;this.file=file;this.temporaryFile=tmp;this.retryable=retryable;}
}
function atomic(file, value, options = {}) {
  const io=options.io||fs,wait=options.wait||(ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms));
  const tmp = `${file}.${id()}.tmp`;let phase='write',complete=false;
  try {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const fd = io.openSync(tmp, 'wx', 0o600);
    try { io.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    complete=true;phase='rename';
    const delays=[20,60,120];
    for(let n=0;;n++){
      try{io.renameSync(tmp,file);return;}
      catch(e){if(!['EPERM','EBUSY'].includes(e.code)||n===delays.length)throw e;wait(delays[n]);}
    }
  }catch(e){
    // A complete failed replacement is retained for diagnosis; never remove the target.
    if(!complete){try{io.unlinkSync(tmp);}catch{}}
    throw new StorageWriteError(e,file,tmp,phase==='rename'&&['EPERM','EBUSY'].includes(e.code));
  }
}
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function overlaps(a, b) {
  const inside = (x, y) => { const r = path.relative(x, y); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
  return inside(a, b) || inside(b, a);
}
function plainDirectory(dir) {
  const abs = path.resolve(dir);
  for (let p = abs; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('Symlink/junction directory is not supported: ' + p);
    if (p === path.dirname(p)) break;
  }
  if (!fs.statSync(abs).isDirectory()) throw Error('Not a directory: ' + abs);
  return fs.realpathSync(abs);
}
class Store {
  constructor(root) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = plainDirectory(root);
    this.lock = path.join(this.root, 'service.lock');
    this.file = path.join(this.root, 'state.json');
    this.owner = id();
    try { fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, owner: this.owner }), { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw Error('Service lock exists. Use unlock only after its process has exited.');
    }
    try {
      this.state = fs.existsSync(this.file) ? read(this.file) : { version: 2, revision: 0, projects: {}, events: [] };
      if (this.state.version !== 2 || !this.state.projects || !Array.isArray(this.state.events)) throw Error('Unsupported/corrupt state: 1.0 requires new version-2 service data; legacy queues are not migrated');
      require('./attempts.cjs').migrate(this.state);
      if (!fs.existsSync(this.file)) atomic(this.file, this.state);
    } catch (e) { this.close(); throw e; }
  }
  change(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    require('./attempts.cjs').migrate(next);
    next.revision++;
    atomic(this.file, next);
    this.state = next;
    // [AI-added] 2026-09-16: Observers run after durable commit and cannot fail business writes.
    try { this.onCommit?.(next); } catch (e) { this.observationError = e.message; }
    return result;
  }
  event(state, type, data = {}) { state.events.push({ id: id(), at: new Date().toISOString(), type, ...data }); }
  close() {
    if (fs.existsSync(this.lock) && read(this.lock).owner === this.owner) fs.unlinkSync(this.lock);
  }
  static unlock(root) {
    const file = path.join(root, 'service.lock');
    const lock = read(file);
    if (!Number.isInteger(lock.pid) || alive(lock.pid)) throw Error('Owner is alive or lock is ambiguous; do not unlock');
    fs.unlinkSync(file);
  }
}
module.exports = { Store, atomic, StorageWriteError, read, id, sha, readableName, workspaceKey, desktopProjectId, overlaps, plainDirectory, alive };
