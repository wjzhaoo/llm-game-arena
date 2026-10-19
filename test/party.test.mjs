import {submitAction} from './action-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Store} from '../lib/store.mjs';
import {Arena} from '../lib/arena.mjs';
import {initialGame} from '../lib/runs.mjs';
import {PARTY_KINDS,partyView,pendingParty,applyParty,timeoutParty} from '../lib/party.mjs';
import {validBid} from '../lib/games/liarsdice.mjs';
import {blindView,initialBlind} from '../lib/blind.mjs';
import {visiblePiece} from '../public/chess-coordinates.mjs';
import {temporaryDirectory,removeTemporaryDirectory} from '../lib/temp.mjs';
import {serve} from '../server.mjs';
import {WakeService} from '../lib/wake.mjs';
import {namedEvent} from '../lib/event-names.mjs';

test('Undercover keeps alignment unknown, seals ballots, resolves ties and reveals only at finish',()=>{
 const g=initialGame('undercover',{playerCount:4}),spy=g.players.find(p=>p.role==='undercover').id;
 for(const p of g.players){assert.equal(partyView(g,p.id).self.role,undefined);assert.equal(partyView(g,p.id).self.word,p.word)}
 assert.ok(partyView(g).players.every(p=>!p.role&&!p.word));
 assert.throws(()=>applyParty(g,'p1',{type:'describe',text:g.players[0].word}),/直接/);
 for(const p of g.players)applyParty(g,p.id,{type:'describe',text:'这个东西在生活中很常见。'});
 const votes={p1:'p2',p2:'p1',p3:'p2',p4:'p1'};
 for(const [id,to]of Object.entries(votes))applyParty(g,id,{type:'vote',target:to});
 assert.equal(g.round,2);assert.equal(g.lastVote.eliminated,null);
 for(const p of g.players)applyParty(g,p.id,{type:'describe',text:'我再补充一个特点。'});
 const first=g.players.find(p=>p.id!==spy).id;applyParty(g,first,{type:'vote',target:spy});
 assert.equal(partyView(g).ballots,undefined);assert.equal(partyView(g,null,true).ballots[first],spy);
 for(const id of pendingParty(g))applyParty(g,id,{type:'vote',target:id===spy?first:spy});
 assert.equal(g.winner,'civilians');assert.ok(partyView(g).players.every(p=>p.word&&p.role));
});

test('Liar dice enforces wild-one transitions and rerolls after a fully public challenge',()=>{
 const g=initialGame('liarsdice',{playerCount:2});g.players[0].dice=[1,2,2,3,4];g.players[1].dice=[1,2,3,4,5];
 assert.equal(partyView(g).players[0].dice,undefined);assert.deepEqual(partyView(g,'p1').self.dice,[1,2,2,3,4]);
 applyParty(g,'p1',{type:'bid',quantity:5,face:2});
 assert.equal(validBid(g,5,2),false);assert.equal(validBid(g,5,3),true);assert.equal(validBid(g,2,1),false);assert.equal(validBid(g,3,1),true);assert.equal(validBid(g,11,2),false);
 applyParty(g,'p2',{type:'challenge'});
 assert.equal(g.lastRound.actual,5);assert.equal(g.lastRound.loser,'p2');assert.equal(g.players[1].count,4);assert.equal(g.turn,'p2');
 assert.deepEqual(g.lastRound.dice[0].dice,[1,2,2,3,4]);assert.ok(partyView(g).players.every(p=>!p.dice));
 assert.equal(partyView(g,null,true).players[1].dice.length,4);
 applyParty(g,'p2',{type:'bid',quantity:3,face:1});assert.equal(validBid(g,6,2),false);assert.equal(validBid(g,7,2),true);
});

test('Codenames keys are captain-only, neutral cards end turns, and assassin loses immediately',()=>{
 const g=initialGame('codenames');assert.equal(g.cards.length,25);assert.equal(g.cards.filter(c=>c.team==='red').length,9);
 assert.ok(partyView(g).cards.every(c=>!c.team));assert.ok(partyView(g,'p2').cards.every(c=>!c.team));assert.ok(partyView(g,'p1').cards.every(c=>c.team));
 assert.throws(()=>applyParty(g,'p1',{type:'clue',word:g.cards[0].word,count:2}),/提示不能/);
 applyParty(g,'p1',{type:'clue',word:'神秘事物',count:2});
 assert.throws(()=>applyParty(g,'p2',{type:'pass'}),/至少/);
 const neutral=g.cards.find(c=>c.team==='neutral');applyParty(g,'p2',{type:'guess',index:neutral.index});
 assert.equal(g.team,'blue');assert.equal(g.phase,'clue');assert.equal(partyView(g).cards[neutral.index].team,'neutral');
 applyParty(g,'p3',{type:'clue',word:'另一个世界',count:1});applyParty(g,'p4',{type:'guess',index:g.cards.find(c=>c.team==='assassin').index});
 assert.equal(g.winner,'red');assert.ok(partyView(g).cards.every(c=>c.team));
});

test('Codenames guessing an enemy final agent awards that enemy team the win',()=>{
 const g=initialGame('codenames');const blue=g.cards.filter(c=>c.team==='blue');for(const c of blue.slice(1))c.revealed=true;
 applyParty(g,'p1',{type:'clue',word:'奇妙空间',count:1});applyParty(g,'p2',{type:'guess',index:blue[0].index});assert.equal(g.winner,'blue');
});

test('Spyfall hides location and occupations, supports guessing, and requires unanimous others',()=>{
 const g=initialGame('spyfall',{playerCount:3}),spy=g.players.find(p=>p.spy).id;
 assert.equal(partyView(g).location,undefined);assert.ok(partyView(g).players.every(p=>p.spy===undefined&&!p.occupation));assert.equal(partyView(g,spy).self.location,undefined);
 for(const p of g.players.filter(p=>!p.spy))assert.equal(partyView(g,p.id).self.location,g.location);
 while(g.phase!=='vote'){
  const id=pendingParty(g)[0];applyParty(g,id,g.phase==='question'?{type:'question',target:g.players.find(p=>p.id!==id).id,text:'这里平时热闹吗？'}:{type:'answer',text:'要看来的时间。'});
 }
 for(const p of g.players)applyParty(g,p.id,{type:'vote',target:p.spy?null:spy});assert.equal(g.winner,'agents');assert.equal(partyView(g).location,g.location);
 const other=initialGame('spyfall',{playerCount:3}),id=other.players.find(p=>p.spy).id;other.turn=id;applyParty(other,id,{type:'guess-location',location:other.location});assert.equal(other.winner,'spy');
});

for(const kind of PARTY_KINDS)test(kind+' always terminates under repeated timeout and rejects late actions',()=>{
 const g=initialGame(kind,{playerCount:kind==='codenames'?4:undefined});let steps=0;
 while(g.status!=='finished'&&steps++<600){const seats=pendingParty(g);assert.ok(seats.length);timeoutParty(g,seats[0])}
 assert.equal(g.status,'finished');assert.ok(steps<600);assert.equal(pendingParty(g).length,0);assert.throws(()=>applyParty(g,'p1',{type:'vote',target:null}));
});

function fixture(t){const root=temporaryDirectory('party-test-'),store=new Store(root),clock={now:10000},a=new Arena(store,{now:()=>clock.now});t.after(()=>{store.close();removeTemporaryDirectory(root)});return {root,store,a,clock}}
function connect(a,id){const identities={};for(const [i,seat] of a.seats(a.get(id)).entries()){
 if(i%2===0){a.setParticipantType(id,seat,'human');const invitation=new URL(a.roomInvite(id,'http://127.0.0.1:4318').url).hash.slice(6),out=a.joinHuman({match:id,seat,nickname:'真人'+seat,invitation});identities[seat]=a.identity(out.token)}
 else{const invite=a.invite(id,seat,'http://127.0.0.1:4318'),out=a.connect({match:id,seat,provider:'simulated',session:'party-'+seat,invitation:invite.text.match(/--invitation ([a-f0-9]+)/)[1]});identities[seat]=a.identity(out.token)}
 }return identities}
for(const kind of PARTY_KINDS)test(kind+' mixed arena supports claims, receipts, pause, replacement, restart and disk recovery',t=>{
 const {a,clock,store,root}=fixture(t),id=a.create({kind,timeoutSeconds:10}).id,ids=connect(a,id);a.start(id);
 const m=a.get(id),seat=a.pending(m)[0],job=a.claim(ids[seat]).job,g=m.game;
 assert.ok(job.view.rules.sections.length);assert.ok(job.actionSchema);
 const result=kind==='undercover'?{type:'describe',text:'它有独特的特点。'}:kind==='liarsdice'?{type:'bid',quantity:1,face:2}:kind==='codenames'?{type:'clue',word:'奇幻意象',count:2}:{type:'question',target:'p2',text:'这里常见什么声音？'};
 assert.equal(submitAction(a,ids[seat],{...job,result}).ok,true);assert.equal(submitAction(a,ids[seat],{...job,result}).duplicate,true);
 const next=a.pending(a.get(id))[0],nextJob=a.claim(ids[next]).job;a.pause(id);clock.now+=2000;a.resume(id);assert.equal(a.get(id).jobs.find(j=>j.taskId===nextJob.taskId).deadline,nextJob.deadline+2000);
 a.revoke(id,next);assert.throws(()=>a.claim(ids[next]),/revoked/);assert.equal(a.get(id).jobs.find(j=>j.taskId===nextJob.taskId).deadline,nextJob.deadline+2000);
 const invite=a.invite(id,next,'http://127.0.0.1:4318'),connection=a.connect({match:id,seat:next,provider:'simulated',session:'replacement-'+kind,invitation:invite.text.match(/--invitation ([a-f0-9]+)/)[1]}),identity=a.identity(connection.token),replacement=a.claim(identity).job;
 assert.equal(replacement.deadline,nextJob.deadline+2000);assert.notEqual(replacement.attemptId,nextJob.attemptId);
 const aiAction=kind==='undercover'?{type:'describe',text:'这是一段新的描述。'}:kind==='liarsdice'?{type:'challenge'}:kind==='codenames'?{type:'guess',index:a.get(id).game.cards.find(c=>c.team==='red').index}:{type:'answer',text:'人多的时候会比较热闹。'};
 assert.equal(submitAction(a,identity,{...replacement,result:aiAction}).ok,true);assert.equal(submitAction(a,identity,{...replacement,result:aiAction}).duplicate,true);
 const history=JSON.stringify(a.public(a.get(id)).history);assert.ok(!history.includes('tokenHash'));assert.ok(!history.includes('"ballots"'));
 if(kind==='undercover')assert.ok(a.public(a.get(id)).history.every(h=>h.game.players.every(p=>!p.word)));
 if(kind==='liarsdice')assert.ok(a.public(a.get(id)).history.every(h=>h.game.players.every(p=>!p.dice)));
 if(kind==='codenames')assert.ok(a.public(a.get(id)).history.every(h=>h.game.cards.every(c=>c.revealed||!c.team)));
 if(kind==='spyfall')assert.ok(a.public(a.get(id)).history.every(h=>!h.game.location));
 const runId=a.get(id).runId,count=a.seats(a.get(id)).length;a.restart(id,{expectedRunId:runId});assert.equal(a.seats(a.get(id)).length,count);assert.equal(a.get(id).archivedRuns.length,1);assert.equal(a.publicRun(id,runId).readOnly,true);assert.equal(a.get(id).game.round,1);
 assert.ok(a.exportRecords(id,{scope:'room'}).content.includes('第 1 局'));
 store.close();const restored=new Store(root);assert.equal(restored.state.matches[id].kind,kind);assert.equal(restored.state.matches[id].game.players.length,count);assert.equal(restored.state.matches[id].participantTypes.red,undefined);restored.close();
});

test('Player counts are validated and party wake instructions never suggest chess commands or reveal secrets',()=>{
 assert.throws(()=>initialGame('undercover',{playerCount:3}));assert.throws(()=>initialGame('spyfall',{playerCount:9}));assert.throws(()=>initialGame('liarsdice',{playerCount:7}));assert.throws(()=>initialGame('codenames',{playerCount:6}));
 for(const kind of PARTY_KINDS){const g=initialGame(kind),prompt=WakeService.prototype.prompt({kind,game:g},{attemptId:'fixture'},{wake:{credentialPath:'tmp/fixture.credential.json'}});assert.ok(prompt.includes('job.view.rules'));assert.ok(!prompt.includes('undo-response'));assert.ok(!prompt.includes('job.interactions'));}
 const event=namedEvent({type:'party-event',text:'p1 问 p2：你觉得 p1 怎么样？'},[{seat:'p1',nickname:'甲'},{seat:'p2',nickname:'乙'}]);assert.equal(event.text,'甲（1 号） 问 乙（2 号）：你觉得 p1 怎么样？');
});

test('Blind omniscience preserves cover movement and renders real identity in 2D/3D without changing state',()=>{
 const g=initialBlind({seed:42}),before=structuredClone(g),publicView=blindView(g),god=blindView(g,true);
 assert.ok(publicView.board.flat().filter(Boolean).every(p=>!p.truth));assert.equal(god.board.flat().filter(p=>p?.truth).length,30);assert.deepEqual(g,before);assert.deepEqual(god.legalMoves,publicView.legalMoves);
 const p=god.board.flat().find(p=>p?.truth),render=visiblePiece(p);assert.equal(render.side,p.truth.side);assert.notEqual(render.glyph,'暗');assert.equal(render.omniscient,true);assert.ok(render.hint);assert.notEqual(render.hint,'真身');
});

test('HTTP rulebook and assets are local, god projections require admin, and historical export stays public',async t=>{
 const root=temporaryDirectory('party-http-'),app=await serve({root,port:0,adminToken:'party-http-admin',autoTick:false});t.after(async()=>{await app.close();removeTemporaryDirectory(root)});
 const rules=await(await fetch(app.origin+'/api/rules')).json();assert.equal(Object.keys(rules).length,8);
 for(const kind of PARTY_KINDS){const id=app.arena.create({kind}).id,url=app.origin+'/api/matches/'+id;
  assert.equal((await fetch(url+'?reveal=1')).status,401);const god=await(await fetch(url+'?reveal=1',{headers:{Authorization:'Bearer party-http-admin'}})).json();assert.equal(god.reveal,true);
  assert.equal((await fetch(app.origin+'/assets/games/'+kind+'.svg')).status,200);
 }
 const id=app.arena.create({kind:'blind'}).id;const god=await(await fetch(app.origin+'/api/matches/'+id+'?reveal=1',{headers:{Authorization:'Bearer party-http-admin'}})).json();assert.ok(god.game.board.flat().some(p=>p?.truth));
 const exported=await(await fetch(app.origin+'/api/matches/'+id+'/export?reveal=1')).text();assert.ok(!exported.includes('truth'));
});

test('Party presentation escapes text, uses server-only keys and offers complete human forms and rulebooks',()=>{
 const ctx={};vm.runInNewContext(fs.readFileSync(new URL('../public/party.js',import.meta.url),'utf8'),ctx);const ui=ctx.ArenaParty;
 for(const kind of PARTY_KINDS){const g=initialGame(kind),seat=pendingParty(g)[0],view=partyView(g,seat);view.log=[{round:1,text:'<script>恶意</script>'}];
  const html=ui.stage(view,[],{started:true,canAct:true});assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('/assets/games/'+kind+'.svg'));
  assert.ok(ui.actions(view,{taskId:'fixture'},[],{started:true}).includes('<form'));assert.ok(!ui.actions(view,{taskId:'fixture'},[],{started:true,paused:true}).includes('<form'));assert.ok(ui.rulebook(view.rules).includes('全知视图'));
 }
});
