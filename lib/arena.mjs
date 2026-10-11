import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {initialXiangqi,xiangqiView,applyXiangqi} from './xiangqi.mjs';
import {initialBlind,blindView,applyBlind} from './blind.mjs';
import {initialWerewolf,werewolfView,applyWerewolf,pendingWerewolf,timeoutWerewolf} from './werewolf.mjs';
import {providerName,supportsWake} from './wake/common.mjs';
import {localInvitation} from './invitation.mjs';
import {EMOTES,EMOTE_COOLDOWN,isChess,opposite,sideName,checkpoint,undoAvailability,publicUndo} from './chess-interactions.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const secret=()=>randomBytes(32).toString('hex');
const safe=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const privateNight=m=>m.kind==='werewolf'&&['wolf','seer','witch'].includes(m.game.phase);
const taskMessage=kind=>({invalid_action:'行动格式或规则校验失败，可在原期限内重试；连续两次无效由规则引擎处理',timeout:'行动超时，规则引擎已按固定规则处理',legacy_judge:'旧版裁判待办已转为管理事项；历史记录保留，规则引擎继续执行'}[kind]||'请检查连接与任务状态');

export class Arena {
 constructor(store,{now=Date.now}={}){this.store=store;this.now=now;this.presence=new Map()}
 get(id,state=this.store.state){const m=state.matches[id];if(!m)throw Error('Match not found');return m}
 seats(m){return m.kind==='werewolf'?['p1','p2','p3','p4','p5','p6']:['red','black']}
 activeBinding(m,seat){return this.seats(m).includes(seat)&&m.bindings[seat]&&!m.bindings[seat].revokedAt}
 participantType(m,seat){return m.participantTypes?.[seat]||'ai'}
 requireType(identity,type){const b=this.binding(identity);if((b.type||'ai')!==type)throw Error('Unauthorized participant type');return b}
 setParticipantType(id,seat,type){return this.store.change(s=>{
  const m=this.get(id,s);if(!this.seats(m).includes(seat)||!['human','ai'].includes(type))throw Error('Invalid participant type');
  if(m.started||m.game.status==='finished')throw Error('比赛开始后不能更改选手类型');
  if(this.activeBinding(m,seat))throw Error('请先撤销已绑定的选手');
  m.participantTypes??={};m.participantTypes[seat]=type;delete m.invites[seat];
  this.record(m,'participant-type',seat+' 已设为'+(type==='human'?'真人':'AI'));return this.public(m);
 })}
 roomInvite(id,base){return this.store.change(s=>{
  const m=this.get(id,s);if(m.game.status==='finished')throw Error('比赛已结束');
  const token=secret();m.roomInvitation={hash:hash(token),expiresAt:this.now()+1800000};
  return {match:id,expiresAt:m.roomInvitation.expiresAt,url:base+'/?room='+encodeURIComponent(id)+'#join='+token};
 })}
 joinHuman({match,seat,invitation,nickname}){return this.store.change(s=>{
  const m=this.get(match,s),i=m.roomInvitation;
  if(!i||i.expiresAt<=this.now()||!safe(hash(invitation||''),i.hash))throw Error('房间邀请已过期或无效，请向房主索取新链接');
  if(!this.seats(m).includes(seat)||this.participantType(m,seat)!=='human')throw Error('请选择真人席位');
  if(m.game.status==='finished')throw Error('比赛已结束');
  if(this.activeBinding(m,seat))throw Error('该席位已被其他玩家占用');
  if(typeof nickname!=='string')throw Error('请输入昵称');
  const name=nickname.trim().replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,16)||'棋友',token=secret(),clientId=randomUUID();
  m.bindings[seat]={type:'human',clientId,tokenHash:hash(token),nickname:name,provider:null,continuationMode:'browser'};
  this.record(m,'connected',seat+' 真人已接入');
  return {token,clientId,match,seat,nickname:name};
 })}
 playerStatus(identity){
  this.requireType(identity,'human');const m=this.get(identity.match);this.presence.set(identity.clientId,this.now());
  const job=!m.paused&&m.started?m.jobs.find(j=>j.status==='open'&&j.seat===identity.seat):null;
  return {match:this.public(m),seat:identity.seat,privateView:this.view(m,identity.seat),interactions:this.interactions(m,identity.seat),serverNow:this.now(),pausedAt:m.pausedAt||null,task:job?{taskId:job.taskId,attemptId:job.attemptId,deadline:job.deadline,phase:job.phase,kind:job.kind||'move'}:null};
 }
 resign(identity){return this.store.change(s=>{
  const m=this.get(identity.match,s);this.binding(identity,s);
  if(m.kind==='werewolf'||!m.started||m.game.status==='finished'||m.paused)throw Error('当前不能认输');
  m.game.status='finished';m.game.winner=identity.seat==='red'?'black':'red';m.game.reason='resigned';
  this.cancelChessJobs(m);delete m.undoRequest;
  this.record(m,'resigned',identity.seat+' 认输');this.sync(m);return {ok:true,completed:true};
 })}
 interactions(m,seat){
  if(!isChess(m))return null;
  return {boardRevision:m.boardRevision||0,undo:undoAvailability(m,seat),undoRequest:publicUndo(m),emotes:EMOTES,
   emoteAvailableAt:(m.lastEmoteAt?.[seat]??-EMOTE_COOLDOWN)+EMOTE_COOLDOWN,
   recentEmotes:m.events.filter(e=>e.type==='emote').slice(-10),
   commands:{emote:'emote --emote <id> --credential <file>',undo:'undo-request --revision '+(m.boardRevision||0)+' --credential <file>',resign:'resign --credential <file>'}};
 }
 requireRunningChess(m){if(!isChess(m)||!m.started||m.paused||m.game.status==='finished')throw Error('当前不能进行棋类互动')}
 emote(identity,{emote}){return this.store.change(s=>{
  const m=this.get(identity.match,s);this.binding(identity,s);this.requireRunningChess(m);
  const choice=EMOTES.find(item=>item.id===emote);if(!choice)throw Error('请选择有效的固定表情');
  if(this.now()-(m.lastEmoteAt?.[identity.seat]??-EMOTE_COOLDOWN)<EMOTE_COOLDOWN)throw Error('表情发送过快，请稍后再试');
  m.lastEmoteAt??={};m.lastEmoteAt[identity.seat]=this.now();
  this.record(m,'emote',sideName(identity.seat)+'：'+choice.emoji+' '+choice.label,{seat:identity.seat,emote:choice.id,emoji:choice.emoji,label:choice.label});
  return {ok:true,availableAt:this.now()+EMOTE_COOLDOWN};
 })}
 cancelChessJobs(m){
  for(const j of m.jobs)if(j.status==='open'){j.status='cancelled';for(const task of m.adminTasks||[])if(task.targetTask===j.taskId&&task.status==='pending')task.status='closed'}
 }
 openChessJob(m,seat,{remainingMs=m.timeoutMs,invalid=0,kind='move',deadline}={}){
  const j={taskId:randomUUID(),attemptId:randomUUID(),seat,kind,phase:this.phase(m),status:'open',deadline:deadline??(m.paused?m.pausedAt:this.now())+remainingMs,invalid,clientId:null};
  m.jobs.push(j);const b=m.bindings[seat];if(b?.wake){b.armed=true;b.armedAt=this.now()}return j;
 }
 requestUndo(identity,{boardRevision}){return this.store.change(s=>{
  const m=this.get(identity.match,s);this.binding(identity,s);this.requireRunningChess(m);
  if(!Number.isInteger(boardRevision)||boardRevision!==(m.boardRevision||0))throw Error('棋局已更新，请刷新后申请悔棋');
  const available=undoAvailability(m,identity.seat);if(!available.allowed)throw Error(available.reason);
  if(!this.activeBinding(m,opposite(identity.seat)))throw Error('对手尚未接入');
  const current=m.jobs.find(j=>j.status==='open'&&j.seat===m.game.turn);
  if(!current||current.deadline<=this.now())throw Error('当前行动已到期，请刷新');
  m.undoRequested??={};m.undoRequested[identity.seat]=boardRevision;
  m.undoRequest={id:randomUUID(),requester:identity.seat,responder:opposite(identity.seat),plies:available.plies,targetPly:available.targetPly,
   deadline:this.now()+m.timeoutMs,frozen:{seat:current.seat,remainingMs:current.deadline-this.now(),invalid:current.invalid||0}};
  this.cancelChessJobs(m);this.openChessJob(m,m.undoRequest.responder,{kind:'undo-response',deadline:m.undoRequest.deadline});
  this.record(m,'undo-request',sideName(identity.seat)+'申请悔棋 '+available.plies+' 手，等待对手确认',{request:publicUndo(m)});
  return {ok:true,undoRequest:publicUndo(m),nextAction:'resume'};
 })}
 resolveUndo(m,accept,reason){
  const request=m.undoRequest;if(!request)throw Error('悔棋请求已失效');const fromPly=m.game.ply;
  this.cancelChessJobs(m);delete m.undoRequest;
  let timer=request.frozen;
  if(accept){
   const entry=m.undoStack.find(record=>record.ply===request.targetPly+1);
   m.game={...structuredClone(entry.game),history:m.game.history.slice(0,entry.historyLength)};
   m.undoStack=m.undoStack.filter(record=>record.ply<=request.targetPly);m.boardRevision=(m.boardRevision||0)+1;
   timer={seat:request.requester,remainingMs:entry.remainingMs,invalid:entry.invalid};
  }
  this.openChessJob(m,timer.seat,timer);
  this.record(m,accept?'undo-accepted':'undo-rejected',accept?sideName(request.responder)+'同意悔棋，撤回 '+request.plies+' 手':reason||sideName(request.responder)+'拒绝悔棋',{requestId:request.id,requester:request.requester,plies:request.plies});
  if(accept)this.record(m,'undo-rollback','棋局已从第 '+fromPly+' 手回到第 '+m.game.ply+' 手，轮到'+sideName(request.requester),{requestId:request.id,fromPly,toPly:m.game.ply});
 }
 create({kind,title,timeoutSeconds=180}){
  if(!['xiangqi','blind','werewolf'].includes(kind))throw Error('Invalid game');
  if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<10||timeoutSeconds>3600)throw Error('Timeout must be 10..3600 seconds');
  const defaults={xiangqi:'楚河对弈',blind:'覆棋暗战',werewolf:'月夜议会'},games={xiangqi:initialXiangqi,blind:initialBlind,werewolf:initialWerewolf};
  return this.store.change(s=>{const id=randomUUID(),m=s.matches[id]={id,kind,title:String(title||defaults[kind]).slice(0,80),createdAt:new Date(this.now()).toISOString(),started:false,paused:false,participantPolicy:'players-only-v1',timeoutMs:timeoutSeconds*1000,game:games[kind](),bindings:{},invites:{},jobs:[],adminTasks:[],receipts:{},events:[],history:[],sequence:0,...(kind!=='werewolf'?{chessInteractionPolicy:'v1',boardRevision:0,undoStack:[],undoRequested:{},lastEmoteAt:{}}:{})};m.participantTypes=Object.fromEntries(this.seats(m).map(seat=>[seat,'ai']));this.record(m,'created','房间已创建，等待邀请选手；规则引擎负责判定');return this.public(m)})
 }
 view(m,seat=null,reveal=false){return m.kind==='xiangqi'?xiangqiView(m.game):m.kind==='blind'?blindView(m.game):werewolfView(m.game,seat,reveal)}
 public(m,reveal=false){return {id:m.id,kind:m.kind,title:m.title,started:m.started,paused:!!m.paused,serverNow:this.now(),createdAt:m.createdAt,game:this.view(m,null,reveal),...(isChess(m)?{boardRevision:m.boardRevision||0,undoRequest:publicUndo(m)}:{}),participants:this.seats(m).map(seat=>{const b=this.activeBinding(m,seat)?m.bindings[seat]:null,type=this.participantType(m,seat);return {seat,type,connected:!!b,nickname:b?.nickname||null,online:type==='human'&&!!b&&this.presence.has(b.clientId)&&this.now()-this.presence.get(b.clientId)<35000,provider:b?.provider||null,continuationMode:type==='human'?'browser':b?.wake?'wake':'wait',wakeTransport:b?.wake?.transport||'local'}}),events:m.events,history:m.history,sequence:m.sequence}}
 record(m,type,text,extra){
  const hidden=privateNight(m)&&['action','timeout','referral'].includes(type);
   const append=(kind,message,detail)=>{m.events.push({id:randomUUID(),at:new Date(this.now()).toISOString(),type:kind,text:message,...(detail||{})});m.history.push({index:m.history.length,at:new Date(this.now()).toISOString(),type:kind,text:message,...(detail||{}),game:this.view(m),...(isChess(m)?{boardRevision:m.boardRevision||0,started:m.started,paused:!!m.paused,undoRequest:publicUndo(m)}:{})});m.sequence++};
  if(!hidden)append(type,text,extra);
  if(m.kind==='werewolf'){
   for(const e of m.game.log.slice(m.logSeen||0)){
    if(e.type==='dawn')append('dawn',`第 ${e.round} 天黎明：${e.deaths.length?e.deaths.join('、')+' 出局':'平安夜'}`,{round:e.round,deaths:e.deaths});
    if(e.type==='exile')append('vote',`放逐结果：${e.seat||'无人出局'}；公开票型：${Object.entries(e.votes).map(([a,b])=>a+'→'+(b||'弃权')).join('，')}`,{round:e.round,seat:e.seat||null,votes:e.votes});
    if(e.type==='finished')append('result',`比赛结束：${e.winner||'平局'} (${e.reason})`,{winner:e.winner,reason:e.reason})
   }
   m.logSeen=m.game.log.length;
  }else if(m.game.status==='finished'&&!m.resultRecorded){append('result',`比赛结束：${m.game.winner||'平局'} (${m.game.reason})`);m.resultRecorded=true}
 }
 invite(id,seat,base){return this.store.change(s=>{
  const m=this.get(id,s);if(!this.seats(m).includes(seat))throw Error('Invalid seat');if(m.game.status==='finished')throw Error('Match already finished');if(this.participantType(m,seat)!=='ai')throw Error('该席位等待真人加入');if(this.activeBinding(m,seat))throw Error('Seat already bound; revoke first');
  const token=secret(),invitationId=randomUUID();m.invites[seat]={invitationId,hash:hash(token),expiresAt:this.now()+1800000};
  return localInvitation({invitationId,seat,expiresAt:m.invites[seat].expiresAt},base,id,token);
 })}
 validateInvitation(v,state=this.store.state){
  const provider=providerName(v.provider);
  if(typeof v.session!=='string'||!v.session.trim()||v.session.length>200||/[\s\0]/.test(v.session))throw Error('Receiver must confirm real provider and session');
  const m=this.get(v.match,state);if(!this.seats(m).includes(v.seat))throw Error('Invalid seat');if(this.participantType(m,v.seat)!=='ai')throw Error('该席位等待真人加入');if(m.game.status==='finished')throw Error('Match already finished');const i=m.invites[v.seat];
  if(!i||i.revokedAt||i.expiresAt<=this.now()||!safe(hash(v.invitation||''),i.hash))throw Error('Invitation expired or invalid');
  if(this.activeBinding(m,v.seat))throw Error('Seat occupied');return provider;
 }
 connect(v,{wake=null}={}){
  const provider=this.validateInvitation(v);if(supportsWake(provider)&&(!wake||wake.provider!==provider||wake.session!==v.session))throw Error('Supported wake providers require verified host binding');
  return this.store.change(s=>{
   this.validateInvitation(v,s);const m=this.get(v.match,s);
   if(wake)for(const other of Object.values(s.matches))for(const [seat,b] of Object.entries(other.bindings))if(this.activeBinding(other,seat)&&b.wake&&(b.wake.deviceId||'local')===(wake.deviceId||'local')&&b.provider===provider&&b.session===v.session&&(other.game.status!=='finished'||other.jobs.some(j=>j.status==='open')))throw Error('Host session already bound to another participant');
   const token=secret(),clientId=randomUUID();m.bindings[v.seat]={type:'ai',clientId,tokenHash:hash(token),provider,session:v.session,continuationMode:wake?'wake':'wait',...(wake?{wake,armed:false}:{})};delete m.invites[v.seat];this.record(m,'connected',`${v.seat} 已接入`);
   return {token,clientId,match:m.id,seat:v.seat,nextAction:'resume',continuationMode:wake?'wake':'wait'};
  })
 }
 identity(token){const h=hash(token||'');for(const m of Object.values(this.store.state.matches))for(const [seat,b] of Object.entries(m.bindings))if(this.activeBinding(m,seat)&&safe(h,b.tokenHash))return {match:m.id,seat,clientId:b.clientId};throw Error('Unauthorized')}
 binding(identity,state=this.store.state){const m=this.get(identity.match,state),b=m.bindings[identity.seat];if(!this.activeBinding(m,identity.seat)||b.clientId!==identity.clientId)throw Error('Binding revoked');return b}
 revoke(id,seat){return this.store.change(s=>{const m=this.get(id,s);if(!this.seats(m).includes(seat))throw Error('Invalid seat');if(m.undoRequest)this.resolveUndo(m,false,'席位连接已撤销，悔棋请求取消');delete m.bindings[seat];delete m.invites[seat];for(const j of m.jobs)if(j.seat===seat&&j.status==='open'){j.clientId=null;j.attemptId=randomUUID();delete j.wakeNotice}this.record(m,'revoked',`${seat} 连接已撤销，旧回传失效`)})}
 start(id){return this.store.change(s=>{const m=this.get(id,s);if(m.started)throw Error('Already started');if(m.game.status==='finished')throw Error('Match already finished');if(this.seats(m).some(x=>!this.activeBinding(m,x)))throw Error('All players must connect first');m.started=true;this.record(m,'started','比赛开始；规则引擎自动判定');this.sync(m)})}
 phase(m){return m.kind==='werewolf'?`round:${m.game.round}:phase:${m.game.phase}`:m.undoRequest?`undo:${m.undoRequest.id}`:`ply:${m.game.ply}:revision:${m.boardRevision||0}`}
 pending(m){return m.kind==='werewolf'?pendingWerewolf(m.game):(m.game.status==='playing'?[m.undoRequest?.responder||m.game.turn]:[])}
 schema(m,seat){if(!this.seats(m).includes(seat))throw Error('Invalid seat');if(m.undoRequest)return {type:'undo-response',requestId:m.undoRequest.id,accept:'boolean: true=同意，false=拒绝；超时视为拒绝'};if(m.kind==='xiangqi'||m.kind==='blind')return {from:'[x,y]',to:'[x,y]',coordinate:'x=0..8,y=0..9; black starts y=0'};return {wolf:{type:'kill',target:'p1..p6 or null'},seer:{type:'inspect',target:'p1..p6 or null'},witch:{type:'witch',save:'boolean',poison:'p1..p6 or null'},discuss:{type:'speak',text:'public text max 600'},vote:{type:'vote',target:'p1..p6 or null'}}[m.game.phase]}
 sync(m){
  if(!m.started)return;const phase=this.phase(m),finished=m.game.status==='finished';
  for(const j of m.jobs)if(j.status==='open'&&this.seats(m).includes(j.seat)&&(j.phase!==phase||finished))j.status='cancelled';
  if(finished||m.paused)return;
  for(const seat of this.pending(m))if(!m.jobs.some(j=>j.status==='open'&&j.seat===seat&&j.phase===phase)){
   if(isChess(m))this.openChessJob(m,seat,{kind:m.undoRequest?'undo-response':'move',...(m.undoRequest?{deadline:m.undoRequest.deadline}:{})});
   else m.jobs.push({taskId:randomUUID(),attemptId:randomUUID(),seat,phase,status:'open',deadline:this.now()+m.timeoutMs,invalid:0,clientId:null});
  }
 }
 claim(identity){return this.store.change(s=>{
  const m=this.get(identity.match,s),b=this.binding(identity,s),completed=m.game.status==='finished';
  if(m.paused&&!completed)return {job:null,idle:true,paused:true,completed:false,nextAction:'resume',continuationMode:b.wake?'wake':'wait'};
  const j=m.jobs.find(j=>j.seat===identity.seat&&j.status==='open');
  if(!j)return {job:null,idle:!completed,completed,nextAction:completed?'stop':'resume',continuationMode:b.wake?'wake':'wait'};
  if(j.clientId&&j.clientId!==identity.clientId)throw Error('Attempt belongs to another session');j.clientId=identity.clientId;j.claimedAt??=this.now();if(b.wake)b.armed=false;if(j.wakeNotice)j.wakeNotice.claimedAt??=this.now();
  return {job:{taskId:j.taskId,attemptId:j.attemptId,seat:j.seat,deadline:j.deadline,phase:j.phase,kind:j.kind||'move',...(isChess(m)?{boardRevision:m.boardRevision||0,interactions:this.interactions(m,j.seat)}:{}),actionSchema:this.schema(m,j.seat),view:this.view(m,j.seat)},nextAction:'submit',continuationMode:b.wake?'wake':'wait'};
 })}
 park(identity){if(!this.binding(identity).wake)throw Error('Wake is not configured; use resume for a wait provider');const reply=this.claim(identity);if(reply.job)return {...reply,parked:false};this.store.change(s=>{const b=this.binding(identity,s);b.armed=!reply.completed;b.armedAt=this.now()});if(reply.completed)return reply;return {...reply,idle:false,parked:true,nextAction:'stop-turn',nextInstruction:'结束当前模型回合；有本选手任务时服务会唤醒原会话。不要轮询或转发通知。'}}
 fault(m,j,reason){
  m.adminTasks??=[];
  let task=m.adminTasks.find(x=>x.status==='pending'&&x.targetTask===j.taskId);
  if(!task){task={id:randomUUID(),kind:reason,status:'pending',createdAt:new Date(this.now()).toISOString(),targetTask:j.taskId};m.adminTasks.push(task)}
  task.kind=reason;task.updatedAt=new Date(this.now()).toISOString();
  this.record(m,'referral','行动异常已加入管理待办；规则引擎按原期限继续处理');
  return task;
 }
 timeout(m,j){
  j.status='timedout';
  if(j.kind==='undo-response'){for(const task of m.adminTasks||[])if(task.targetTask===j.taskId&&task.status==='pending')task.status='closed';this.resolveUndo(m,false,'悔棋确认超时或连续无效，视为拒绝');return}
  if(m.kind==='xiangqi'||m.kind==='blind'){m.game.status='finished';m.game.winner=j.seat==='red'?'black':'red';m.game.reason='timeout-or-invalid'}else timeoutWerewolf(m.game,j.seat);
  this.record(m,'timeout','行动超时或连续无效，按固定规则处理');this.sync(m);
 }
 submit(identity,{taskId,attemptId,result}){return this.store.change(s=>{
  const m=this.get(identity.match,s),binding=this.binding(identity,s);const j=m.jobs.find(j=>j.taskId===taskId);
  if(!j||j.seat!==identity.seat||j.attemptId!==attemptId||j.clientId!==identity.clientId)throw Error('Stale attempt or foreign session');
  const key=attemptId,digest=hash(result),r=m.receipts[key];
  if(m.rejections?.[key+digest])return {...m.rejections[key+digest],duplicate:true};
  if(r){if(r.digest!==digest)throw Error('Conflicting durable receipt');return {...r.reply,duplicate:true}}
  if(j.status!=='open')throw Error('Attempt no longer active');if(m.paused)throw Error('Match paused; administrator must resume');
  if(j.deadline<=this.now()){if(j.kind!=='undo-response')this.fault(m,j,'timeout');this.timeout(m,j);return {ok:false,error:'Deadline passed',nextAction:'resume'}}
  if(j.phase!==this.phase(m))throw Error('Stale phase');
  try{
   if(j.kind==='undo-response'){
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='accept,requestId,type'||result.type!=='undo-response'||result.requestId!==m.undoRequest?.id||typeof result.accept!=='boolean')throw Error('Use {type:"undo-response",requestId,accept:boolean}');
    this.resolveUndo(m,result.accept);
   }else{
    const candidate=structuredClone(m.game);if(m.kind==='xiangqi')applyXiangqi(candidate,j.seat,result);else if(m.kind==='blind')applyBlind(candidate,j.seat,result);else applyWerewolf(candidate,j.seat,result);
    if(isChess(m)){m.undoStack??=[];m.undoStack.push({ply:candidate.ply,...checkpoint(m.game,j,this.now())});m.boardRevision=(m.boardRevision||0)+1}
    m.game=candidate;
   }
  }
  catch(e){const details=m.kind==='werewolf'?'行动不符合当前身份或阶段':e.message;if(binding.type==='human')return {ok:false,error:'Invalid action',details,nextAction:'resume'};j.invalid=(j.invalid||0)+1;this.fault(m,j,'invalid_action');if(j.invalid>=2)this.timeout(m,j);const rejection={ok:false,error:'Invalid action',details,remaining:Math.max(0,2-j.invalid),nextAction:'resume'};m.rejections??={};m.rejections[key+digest]=rejection;return rejection}
  j.status='submitted';
  for(const task of m.adminTasks||[])if(task.status==='pending'&&task.targetTask===j.taskId){task.status='resolved';task.resolvedAt=new Date(this.now()).toISOString()}
  if(j.kind!=='undo-response')this.record(m,'action',m.kind==='werewolf'?(result.type==='speak'?`${j.seat}：${result.text}`:'阶段行动已记录'):m.kind==='blind'?`${j.seat}：${m.game.lastMove?.text||JSON.stringify(result)}`:`${j.seat}：${JSON.stringify(result)}`,m.kind==='werewolf'?{seat:j.seat,round:m.game.round,...(result.type==='speak'?{phase:'discuss',speech:result.text}:{})}:undefined);this.sync(m);
  const reply={ok:true,receiptPersisted:true,taskId,attemptId,nextAction:'resume',completed:m.game.status==='finished'};m.receipts[key]={digest,reply};return reply;
 })}
 canRetry(m,task){const j=m.jobs.find(j=>j.taskId===task.targetTask);const at=m.paused?m.pausedAt:this.now();return task.status==='pending'&&m.game.status!=='finished'&&!!j&&this.seats(m).includes(j.seat)&&j.status==='open'&&j.phase===this.phase(m)&&j.deadline>at&&(j.invalid||0)<2&&(j.adminRetries||0)<1}
 adminView(id){const m=typeof id==='string'?this.get(id):id;return {paused:!!m.paused,started:m.started,finished:m.game.status==='finished',tasks:(m.adminTasks||[]).map(task=>({id:task.id,status:task.status,kind:task.kind,message:taskMessage(task.kind),canRetry:this.canRetry(m,task)}))}}
 control(id,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!['pause','resume','retry','end'].includes(input.action))throw Error('Invalid administrator action');
  const keys=input.action==='retry'?['action','taskId']:['action'];
  if(Object.keys(input).some(k=>!keys.includes(k))||(input.action==='retry'&&(typeof input.taskId!=='string'||!input.taskId)))throw Error('Only the action and retry task ID are accepted');
  return input.action==='retry'?this.retry(id,{taskId:input.taskId}):this[input.action](id);
 }
 pause(id){return this.store.change(s=>{const m=this.get(id,s);if(!m.started||m.game.status==='finished')throw Error('Only a running match can be paused');if(!m.paused){m.paused=true;m.pausedAt=this.now();this.record(m,'paused','管理员已暂停比赛，行动期限冻结')}return {ok:true,...this.adminView(m)}})}
 resume(id){return this.store.change(s=>{const m=this.get(id,s);if(m.game.status==='finished')throw Error('Match already finished');if(m.paused){const elapsed=Math.max(0,this.now()-m.pausedAt);for(const j of m.jobs)if(j.status==='open'&&this.seats(m).includes(j.seat))j.deadline+=elapsed;if(m.undoRequest)m.undoRequest.deadline+=elapsed;m.paused=false;delete m.pausedAt;this.record(m,'resumed','管理员已继续比赛，行动期限从暂停处恢复');this.sync(m)}return {ok:true,...this.adminView(m)}})}
 retry(id,{taskId}){return this.store.change(s=>{
  const m=this.get(id,s),task=(m.adminTasks||[]).find(t=>t.id===taskId);if(!task||!this.canRetry(m,task))throw Error('This task cannot be retried; deadline and retry limits remain authoritative');
  const j=m.jobs.find(j=>j.taskId===task.targetTask);j.priorAttempts??=[];j.priorAttempts.push({attemptId:j.attemptId,clientId:j.clientId,claimedAt:j.claimedAt,wakeNotice:j.wakeNotice});j.attemptId=randomUUID();j.clientId=null;delete j.claimedAt;delete j.wakeNotice;j.adminRetries=(j.adminRetries||0)+1;task.status='retried';task.resolvedAt=new Date(this.now()).toISOString();
  const b=m.bindings[j.seat];if(this.activeBinding(m,j.seat)&&b.wake){b.armed=true;b.armedAt=this.now()}
  this.record(m,'admin-retry','管理员已重新开放原行动任务；原期限与无效次数上限保持不变');return {ok:true,...this.adminView(m)};
 })}
 end(id){return this.store.change(s=>{
  const m=this.get(id,s);if(m.game.status!=='finished'){
   m.game.status='finished';m.game.winner=null;m.game.reason='admin-ended';m.paused=false;delete m.pausedAt;
   delete m.undoRequest;
   if(m.kind==='werewolf'){m.game.phase='finished';m.game.log.push({type:'finished',round:m.game.round,winner:null,reason:'admin-ended'})}
   for(const j of m.jobs)if(j.status==='open'&&this.seats(m).includes(j.seat))j.status='cancelled';
   for(const task of m.adminTasks||[])if(task.status==='pending'){task.status='closed';task.resolvedAt=new Date(this.now()).toISOString()}
   this.record(m,'ended','管理员已结束比赛，不指定获胜者');
  }return {ok:true,...this.adminView(m)};
 })}
 tick(){
  const due=Object.values(this.store.state.matches).some(m=>m.started&&!m.paused&&m.game.status!=='finished'&&m.jobs.some(j=>this.seats(m).includes(j.seat)&&j.status==='open'&&j.deadline<=this.now()));if(!due)return;
  this.store.change(s=>{for(const m of Object.values(s.matches)){if(!m.started||m.paused||m.game.status==='finished')continue;for(const j of [...m.jobs])if(this.seats(m).includes(j.seat)&&j.status==='open'&&j.deadline<=this.now()){if(j.kind!=='undo-response')this.fault(m,j,'timeout');this.timeout(m,j)}}});
 }
}
