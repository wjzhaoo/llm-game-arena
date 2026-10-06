import {CodexWake} from './codex.mjs';
import {MimoWake} from './mimo.mjs';
import {QoderWake} from './qoder.mjs';
import {CodeArtsWake} from './codearts.mjs';
import {OpenCodeWake} from './opencode.mjs';

export function createWakeAdapters(options = {}) {
 return {codex: new CodexWake(options.codex), mimo: new MimoWake(options.mimo), qoder: new QoderWake(options.qoder), codearts: new CodeArtsWake(options.codearts), opencode: new OpenCodeWake(options.opencode)};
}
