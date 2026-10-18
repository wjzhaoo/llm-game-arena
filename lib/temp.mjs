import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const temporaryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp');
export function temporaryDirectory(prefix) {
 fs.mkdirSync(temporaryRoot, {recursive: true});
 return fs.mkdtempSync(path.join(temporaryRoot, prefix));
}
export function removeTemporaryDirectory(directory) {
 const resolved = fs.realpathSync(directory), root = fs.realpathSync(temporaryRoot), relative = path.relative(root, resolved);
 if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Temporary cleanup must stay inside the workspace tmp directory');
 fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
}
