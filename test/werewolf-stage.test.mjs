import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
function werewolf(globals = {}) {
 const ctx = {...globals};
 vm.runInNewContext(read('public/ui.js'), ctx);
 vm.runInNewContext(read('public/werewolf.js'), ctx);
 return ctx.ArenaWerewolf;
}
const game = (over = {}) => ({game: 'werewolf', status: 'playing', phase: 'discuss', round: 2, players: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(id => ({id, alive: id !== 'p4'})), ...over});
const participants = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(id => ({seat: id, type: id === 'p3' ? 'human' : 'ai', provider: 'kimi'}));

test('seatPosition places p1 at the top and spaces six seats around the table', () => {
 const w = werewolf();
 assert.equal(w.seatPosition(0), 'left:50.00%;top:14.00%');
 const points = new Set(Array.from({length: 6}, (_, i) => w.seatPosition(i)));
 assert.equal(points.size, 6);
 assert.equal(w.seatPosition(3), 'left:50.00%;top:86.00%');
});

test('stage renders six seats with dead/speaking state and escapes the speech bubble', () => {
 const w = werewolf(), g = game();
 let html = w.stage(g, participants, {}, {});
 assert.equal((html.match(/data-seat="p\d"/g) || []).length, 6);
 assert.ok((html.match(/ww-seat dead/g) || []).length === 1, 'only p4 is dead');
 assert.ok(!html.includes('speaking'));
 assert.ok(html.includes('真人'), 'human seat keeps the human avatar block');
 const speech = {id: 'e1', seat: 'p2', text: 'p3 是狼 <script>alert(1)</script>'};
 html = w.stage(g, participants, {}, {speaking: 'p2', lastSpeech: speech, poppedId: null});
 assert.ok(html.includes('ww-seat speaking'));
 assert.ok(html.includes('ww-bubble pop'), 'a new speech pops once');
 assert.ok(!html.includes('<script>'), 'speech text is escaped');
 assert.ok(html.includes('&lt;script&gt;'));
 html = w.stage(g, participants, {}, {speaking: 'p2', lastSpeech: speech, poppedId: 'e1'});
 assert.ok(html.includes('ww-bubble') && !html.includes('ww-bubble pop'), 'the same speech never pops twice');
 html = w.stage(game({phase: 'night'}), participants, {}, {});
 assert.ok(html.includes('ww-night') && html.includes('天黑请闭眼'));
});

test('deriveSpeech follows only current-round speeches during day phases', () => {
 const w = werewolf();
 const events = [
  {id: 'a', type: 'action', text: 'p1：旧轮发言', round: 1},
  {id: 'b', type: 'action', text: 'ignored', seat: 'p2', speech: '本轮结构化发言', round: 2},
  {id: 'c', type: 'action', text: 'p6：旧格式发言'},
 ];
 let out = w.deriveSpeech(events.slice(0, 2), game());
 assert.equal(out.speaking, 'p2');
 assert.equal(out.lastSpeech.text, '本轮结构化发言');
 out = w.deriveSpeech(events, game());
 assert.equal(out.speaking, 'p6', 'legacy entries without a round count as current and latest wins');
 out = w.deriveSpeech(events, game({phase: 'night'}));
 assert.equal(out.speaking, null);
 out = w.deriveSpeech([events[2]], game());
 assert.equal(out.lastSpeech.text, '旧格式发言', 'legacy text prefix still attributes the speaker');
 out = w.deriveSpeech([], game());
 assert.equal(out.lastSpeech, null);
});

test('freshEvents diffs by id with a content fallback for legacy entries', () => {
 const w = werewolf(), seen = new Set(['x1']);
 const events = [{id: 'x1', type: 'dawn', text: '旧'}, {id: 'x2', type: 'vote', text: '新'}, {at: 't', type: 'action', text: 'p1：无 id'}];
 assert.deepEqual(w.freshEvents(seen, events).map(e => e.id || e.text), ['x2', 'p1：无 id']);
 seen.add(w.eventKey(events[2]));
 assert.deepEqual(w.freshEvents(seen, events).map(e => e.id), ['x2']);
});

test('directives map events to stage cues and prepend day/night transitions', () => {
 const w = werewolf();
 const fresh = [
  {type: 'action', seat: 'p3', speech: '昨夜平安夜', text: 'p3：昨夜平安夜'},
  {type: 'action', text: '阶段行动已记录'},
  {type: 'dawn', text: '第 2 天黎明：p4 出局', round: 2, deaths: ['p4']},
  {type: 'vote', text: '放逐结果：p4；公开票型：p1→p4', seat: 'p4'},
  {type: 'result', text: '比赛结束：狼人阵营 (屠边)'},
  {type: 'action', text: 'p5：旧格式发言'},
 ];
 let out = w.directives(fresh, 'night', 'discuss');
 assert.equal(out.map(d => d.kind).join(','), 'phase,speak,dawn,vote,result,speak');
 assert.equal(out[0].to, 'day');
 assert.equal(out[2].deaths[0], 'p4');
 assert.equal(out.at(-1).seat, 'p5');
 assert.equal(JSON.stringify(w.directives([], 'discuss', 'night')), '[{"kind":"phase","to":"night"}]');
 assert.equal(w.directives([], 'discuss', 'vote').length, 0, 'same-side phases need no transition');
});

test('player queue fast-forwards banner backlogs and reset clears the overlay', async () => {
 const children = [];
 const document = {createElement: () => {
  const node = {className: '', innerHTML: '', style: {}, classList: {add(){}}, remove() { const i = children.indexOf(node); if (i >= 0) children.splice(i, 1); }};
  return node;
 }};
 const w = werewolf({document, setTimeout, clearTimeout});
 const fx = {append: node => children.push(node), querySelectorAll: () => [], innerHTML: ''};
 const board = {querySelector: () => null};
 const player = w.createPlayer({fx, board, duration: 0.001});
 player.enqueue([
  {kind: 'phase', to: 'night'}, {kind: 'phase', to: 'day'}, {kind: 'phase', to: 'night'},
  {kind: 'dawn', text: 'x', deaths: [], round: 1}, {kind: 'dawn', text: 'y', deaths: [], round: 2},
  {kind: 'speak', seat: 'p1', text: '发言'}, {kind: 'result', text: '结束'},
 ]);
 for (let i = 0; i < 300 && !children.some(n => n.className.includes('fx-finale')); i++) await new Promise(resolve => setTimeout(resolve, 10));
 assert.ok(children.some(n => n.className.includes('fx-finale')), 'finale still plays');
 assert.ok(children.filter(n => n.className.includes('fx-dim')).length <= 1, 'intermediate transitions are dropped');
 assert.ok(children.filter(n => n.className.includes('fx-banner')).length <= 1, 'intermediate banners are dropped');
 player.reset();
 assert.equal(fx.innerHTML, '');
 const reduced = w.createPlayer({fx, board, reducedMotion: true, duration: 0.001});
 reduced.enqueue([{kind: 'result', text: '结束'}]);
 await new Promise(resolve => setTimeout(resolve, 30));
 assert.ok(children.at(-1).className.includes('fx-finale'), 'reduced motion still lands the final state statically');
});
