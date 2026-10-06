import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {initialXiangqi,xiangqiView,applyXiangqi} from './xiangqi.mjs';
import {initialWerewolf,werewolfView,applyWerewolf,pendingWerewolf,timeoutWerewolf} from './werewolf.mjs';
import {providerName,supportsWake} from './wake/common.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const secret=()=>randomBytes(32).toString('hex');
const safe=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const privateNight=m=>m.kind==='werewolf'&&['wolf','seer','witch'].includes(m.game.phase);
const taskMessage=kind=>({invalid_action:'行动格式或规则校验失败，可在原期限内重试；连续两次无效由规则引擎处理',timeout:'行动超时，规则引擎已按固定规则处理',legacy_judge:'旧版裁判待办已转为管理事项；历史记录保留，规则引擎继续执行'}[kind]||'请检查连接与任务状态');

export class Arena {
 constructor(store,{now=Date.now}={}){this.store=store;this.now=now}
 get(id,state=this.store.state){const m=state.matches[id];if(!m)throw Error('Match not found');return m}
 seats(m){return m.kind==='xiangqi'?['red','black']:['p1','p2','p3','p4','p5','p6']}
 activeBinding(m,seat){return this.seats(m).includes(seat)&&m.bindings[seat]&&!m.bindings[seat].revokedAt}
 create({kind,title,timeoutSeconds=180}){
  if(!['xiangqi','werewolf'].includes(kind))throw Error('Invalid game');
  if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<10||timeoutSeconds>3600)throw Error('Timeout must be 10..3600 seconds');
  return this.store.change(s=>{const id=randomUUID(),m=s.matches[id]={id,kind,title:String(title||(kind==='xiangqi'?'楚河对弈':'月夜议会')).slice(0,80),createdAt:new Date(this.now()).toISOString(),started:false,paused:false,participantPolicy:'players-only-v1',timeoutMs:timeoutSeconds*1000,game:kind==='xiangqi'?initialXiangqi():initialWerewolf(),bindings:{},invites:{},jobs:[],adminTasks:[],receipts:{},events:[],history:[],sequence:0};this.record(m,'created','房间已创建，等待邀请选手；规则引擎负责判定');return this.public(m)})
 }
 view(m,seat=null,reveal=false){return m.kind==='xiangqi'?xiangqiView(m.game):werewolfView(m.game,seat,reveal)}
 public(m,reveal=false){return {id:m.id,kind:m.kind,title:m.title,started:m.started,paused:!!m.paused,createdAt:m.createdAt,game:this.view(m,null,reveal),participants:this.seats(m).map(seat=>({seat,connected:!!this.activeBinding(m,seat),provider:this.activeBinding(m,seat)?m.bindings[seat].provider:null,continuationMode:this.activeBinding(m,seat)&&m.bindings[seat].wake?'wake':'wait'})),events:m.events,history:m.history,sequence:m.sequence}}
 record(m,type,text){
  if(privateNight(m)&&['action','timeout','referral'].includes(type))return;
  const append=(kind,message)=>{m.events.push({id:randomUUID(),at:new Date(this.now()).toISOString(),type:kind,text:message});m.history.push({index:m.history.length,at:new Date(this.now()).toISOString(),type:kind,text:message,game:this.view(m)});m.sequence++};
  append(type,text);
  if(m.kind==='werewolf'){
   for(const e of m.game.log.slice(m.logSeen||0)){
    if(e.type==='dawn')append('dawn',`第 ${e.round} 天黎明：${e.deaths.length?e.deaths.join('、')+' 出局':'平安夜'}`);
    if(e.type==='exile')append('vote',`放逐结果：${e.seat||'无人出局'}；公开票型：${Object.entries(e.votes).map(([a,b])=>a+'→'+(b||'弃权')).join('，')}`);
    if(e.type==='finished')append('result',`比赛结束：${e.winner||'平局'} (${e.reason})`)
   }
   m.logSeen=m.game.log.length;
  }else if(m.game.status==='finished'&&!m.resultRecorded){append('result',`比赛结束：${m.game.winner||'平局'} (${m.game.reason})`);m.resultRecorded=true}
 }
 invite(id,seat,base){return this.store.change(s=>{
  const m=this.get(id,s);if(!this.seats(m).includes(seat))throw Error('Invalid seat');if(this.activeBinding(m,seat))throw Error('Seat already bound; revoke first');
  const token=secret(),invitationId=randomUUID();m.invites[seat]={invitationId,hash:hash(token),expiresAt:this.now()+1800000};
  const credential=`tmp/${invitationId}-${seat}.credential.json`,response=`tmp/${invitationId}-${seat}-response.json`;
  const command=`node client.mjs connect --url ${base} --match ${id} --seat ${seat} --invitation ${token} --provider <真实平台> --session <当前真实会话标识> --out "${credential}"`;
  return {invitationId,seat,expiresAt:m.invites[seat].expiresAt,text:`[LLM-GAME-INVITE:${invitationId}] 弈境 / LLM Game Arena：进入既有游戏，不创建开发任务。选手席位 ${seat}。先由接收端向用户确认真实平台，不猜测 provider/session，不借用其他选手凭据。支持 codex、mimo、qoder（含 qodercn）、codearts、opencode 原会话唤醒；其他明确平台使用 wait。服务只核实绑定的会话，不按标题或目录猜测会话。接入表示允许竞技场向本会话发送后续行动任务通知；模型额度和费用沿用当前平台。用户允许此连接后在本项目目录执行：\n${command}\nCodex 仅在显式选择 codex 后可使用当前 CODEX_THREAD_ID，并从本会话记录取得 turnId；无法取得时追加 --turn-id <真实当前回合ID>。MiMo 无法取得既有模型时追加 --model <已确认provider/model>。OpenCode 使用真实 ses_ 会话ID。\n然后 node client.mjs resume --credential "${credential}"。读取 job 中的私有局面与 actionSchema，严格只返回本选手行动，将 JSON 保存到 "${response}"（UTF-8 无 BOM）。提交：node client.mjs submit --credential "${credential}" --task <taskId> --attempt <attemptId> --file "${response}"。提交后继续 resume；parked:true 时结束当前回合等待唤醒，idle 时继续 resume，completed:true 才结束比赛。通知送达不代表行动已提交。不得公开凭据、夜间私信或其他隐藏信息，不向自己或其他会话转发，不修改项目源码。规则引擎执行合法性校验、阶段推进及胜负判定。邀请30分钟一次性有效。`}
 })}
 validateInvitation(v,state=this.store.state){
  const provider=providerName(v.provider);
  if(typeof v.session!=='string'||!v.session.trim()||v.session.length>200||/[\s\0]/.test(v.session))throw Error('Receiver must confirm real provider and session');
  const m=this.get(v.match,state);if(!this.seats(m).includes(v.seat))throw Error('Invalid seat');const i=m.invites[v.seat];
  if(!i||i.revokedAt||i.expiresAt<=this.now()||!safe(hash(v.invitation||''),i.hash))throw Error('Invitation expired or invalid');
  if(this.activeBinding(m,v.seat))throw Error('Seat occupied');return provider;
 }
 connect(v,{wake=null}={}){
  const provider=this.validateInvitation(v);if(supportsWake(provider)&&(!wake||wake.provider!==provider||wake.session!==v.session))throw Error('Supported wake providers require verified host binding');
  return this.store.change(s=>{
   this.validateInvitation(v,s);const m=this.get(v.match,s);
   if(wake)for(const other of Object.values(s.matches))for(const [seat,b] of Object.entries(other.bindings))if(this.activeBinding(other,seat)&&b.wake&&b.provider===provider&&b.session===v.session&&(other.game.status!=='finished'||other.jobs.some(j=>j.status==='open')))throw Error('Host session already bound to another participant');
   const token=secret(),clientId=randomUUID();m.bindings[v.seat]={clientId,tokenHash:hash(token),provider,session:v.session,continuationMode:wake?'wake':'wait',...(wake?{wake,armed:false}:{})};delete m.invites[v.seat];this.record(m,'connected',`${v.seat} 已接入`);
   return {token,clientId,match:m.id,seat:v.seat,nextAction:'resume',continuationMode:wake?'wake':'wait'};
  })
 }
 identity(token){const h=hash(token||'');for(const m of Object.values(this.store.state.matches))for(const [seat,b] of Object.entries(m.bindings))if(this.activeBinding(m,seat)&&safe(h,b.tokenHash))return {match:m.id,seat,clientId:b.clientId};throw Error('Unauthorized')}
 binding(identity,state=this.store.state){const m=this.get(identity.match,state),b=m.bindings[identity.seat];if(!this.activeBinding(m,identity.seat)||b.clientId!==identity.clientId)throw Error('Binding revoked');return b}
 revoke(id,seat){return this.store.change(s=>{const m=this.get(id,s);if(!this.seats(m).includes(seat))throw Error('Invalid seat');delete m.bindings[seat];delete m.invites[seat];for(const j of m.jobs)if(j.seat===seat&&j.status==='open'){j.clientId=null;j.attemptId=randomUUID()}this.record(m,'revoked',`${seat} 连接已撤销，旧回传失效`)})}
 start(id){return this.store.change(s=>{const m=this.get(id,s);if(m.started)throw Error('Already started');if(m.game.status==='finished')throw Error('Match already finished');if(this.seats(m).some(x=>!this.activeBinding(m,x)))throw Error('All players must connect first');m.started=true;this.record(m,'started','比赛开始；规则引擎自动判定');this.sync(m)})}
 phase(m){return m.kind==='xiangqi'?`ply:${m.game.ply}`:`round:${m.game.round}:phase:${m.game.phase}`}
 pending(m){return m.kind==='xiangqi'?(m.game.status==='playing'?[m.game.turn]:[]):pendingWerewolf(m.game)}
 schema(m,seat){if(!this.seats(m).includes(seat))throw Error('Invalid seat');if(m.kind==='xiangqi')return {from:'[x,y]',to:'[x,y]',coordinate:'x=0..8,y=0..9; black starts y=0'};return {wolf:{type:'kill',target:'p1..p6 or null'},seer:{type:'inspect',target:'p1..p6 or null'},witch:{type:'witch',save:'boolean',poison:'p1..p6 or null'},discuss:{type:'speak',text:'public text max 600'},vote:{type:'vote',target:'p1..p6 or null'}}[m.game.phase]}
 sync(m){
  if(!m.started)return;const phase=this.phase(m),finished=m.game.status==='finished';
  for(const j of m.jobs)if(j.status==='open'&&this.seats(m).includes(j.seat)&&(j.phase!==phase||finished))j.status='cancelled';
  if(finished||m.paused)return;
  for(const seat of this.pending(m))if(!m.jobs.some(j=>j.status==='open'&&j.seat===seat&&j.phase===phase))m.jobs.push({taskId:randomUUID(),attemptId:randomUUID(),seat,phase,status:'open',deadline:this.now()+m.timeoutMs,invalid:0,clientId:null});
 }
 claim(identity){return this.store.change(s=>{
  const m=this.get(identity.match,s),b=this.binding(identity,s),completed=m.game.status==='finished';
  if(m.paused&&!completed)return {job:null,idle:true,paused:true,completed:false,nextAction:'resume',continuationMode:b.wake?'wake':'wait'};
  const j=m.jobs.find(j=>j.seat===identity.seat&&j.status==='open');
  if(!j)return {job:null,idle:!completed,completed,nextAction:completed?'stop':'resume',continuationMode:b.wake?'wake':'wait'};
  if(j.clientId&&j.clientId!==identity.clientId)throw Error('Attempt belongs to another session');j.clientId=identity.clientId;j.claimedAt??=this.now();if(b.wake)b.armed=false;if(j.wakeNotice)j.wakeNotice.claimedAt??=this.now();
  return {job:{taskId:j.taskId,attemptId:j.attemptId,seat:j.seat,deadline:j.deadline,phase:j.phase,actionSchema:this.schema(m,j.seat),view:this.view(m,j.seat)},nextAction:'submit',continuationMode:b.wake?'wake':'wait'};
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
  if(m.kind==='xiangqi'){m.game.status='finished';m.game.winner=j.seat==='red'?'black':'red';m.game.reason='timeout-or-invalid'}else timeoutWerewolf(m.game,j.seat);
  this.record(m,'timeout','行动超时或连续无效，按固定规则处理');this.sync(m);
 }
 submit(identity,{taskId,attemptId,result}){return this.store.change(s=>{
  const m=this.get(identity.match,s);this.binding(identity,s);const j=m.jobs.find(j=>j.taskId===taskId);
  if(!j||j.seat!==identity.seat||j.attemptId!==attemptId||j.clientId!==identity.clientId)throw Error('Stale attempt or foreign session');
  const key=attemptId,digest=hash(result),r=m.receipts[key];
  if(m.rejections?.[key+digest])return {...m.rejections[key+digest],duplicate:true};
  if(r){if(r.digest!==digest)throw Error('Conflicting durable receipt');return {...r.reply,duplicate:true}}
  if(j.status!=='open')throw Error('Attempt no longer active');if(m.paused)throw Error('Match paused; administrator must resume');
  if(j.deadline<=this.now()){this.fault(m,j,'timeout');this.timeout(m,j);return {ok:false,error:'Deadline passed',nextAction:'resume'}}
  if(j.phase!==this.phase(m))throw Error('Stale phase');
  try{const candidate=structuredClone(m.game);if(m.kind==='xiangqi')applyXiangqi(candidate,j.seat,result);else applyWerewolf(candidate,j.seat,result);m.game=candidate}
  catch(e){j.invalid=(j.invalid||0)+1;this.fault(m,j,'invalid_action');if(j.invalid>=2)this.timeout(m,j);const rejection={ok:false,error:'Invalid action',details:m.kind==='xiangqi'?e.message:'Action does not match your current role/phase',remaining:Math.max(0,2-j.invalid),nextAction:'resume'};m.rejections??={};m.rejections[key+digest]=rejection;return rejection}
  j.status='submitted';
  for(const task of m.adminTasks||[])if(task.status==='pending'&&task.targetTask===j.taskId){task.status='resolved';task.resolvedAt=new Date(this.now()).toISOString()}
  this.record(m,'action',m.kind==='xiangqi'?`${j.seat}：${JSON.stringify(result)}`:(result.type==='speak'?`${j.seat}：${result.text}`:'阶段行动已记录'));this.sync(m);
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
 resume(id){return this.store.change(s=>{const m=this.get(id,s);if(m.game.status==='finished')throw Error('Match already finished');if(m.paused){const elapsed=Math.max(0,this.now()-m.pausedAt);for(const j of m.jobs)if(j.status==='open'&&this.seats(m).includes(j.seat))j.deadline+=elapsed;m.paused=false;delete m.pausedAt;this.record(m,'resumed','管理员已继续比赛，行动期限从暂停处恢复');this.sync(m)}return {ok:true,...this.adminView(m)}})}
 retry(id,{taskId}){return this.store.change(s=>{
  const m=this.get(id,s),task=(m.adminTasks||[]).find(t=>t.id===taskId);if(!task||!this.canRetry(m,task))throw Error('This task cannot be retried; deadline and retry limits remain authoritative');
  const j=m.jobs.find(j=>j.taskId===task.targetTask);j.priorAttempts??=[];j.priorAttempts.push({attemptId:j.attemptId,clientId:j.clientId,claimedAt:j.claimedAt,wakeNotice:j.wakeNotice});j.attemptId=randomUUID();j.clientId=null;delete j.claimedAt;delete j.wakeNotice;j.adminRetries=(j.adminRetries||0)+1;task.status='retried';task.resolvedAt=new Date(this.now()).toISOString();
  const b=m.bindings[j.seat];if(this.activeBinding(m,j.seat)&&b.wake){b.armed=true;b.armedAt=this.now()}
  this.record(m,'admin-retry','管理员已重新开放原行动任务；原期限与无效次数上限保持不变');return {ok:true,...this.adminView(m)};
 })}
 end(id){return this.store.change(s=>{
  const m=this.get(id,s);if(m.game.status!=='finished'){
   m.game.status='finished';m.game.winner=null;m.game.reason='admin-ended';m.paused=false;delete m.pausedAt;
   if(m.kind==='werewolf'){m.game.phase='finished';m.game.log.push({type:'finished',round:m.game.round,winner:null,reason:'admin-ended'})}
   for(const j of m.jobs)if(j.status==='open'&&this.seats(m).includes(j.seat))j.status='cancelled';
   for(const task of m.adminTasks||[])if(task.status==='pending'){task.status='closed';task.resolvedAt=new Date(this.now()).toISOString()}
   this.record(m,'ended','管理员已结束比赛，不指定获胜者');
  }return {ok:true,...this.adminView(m)};
 })}
 tick(){
  const due=Object.values(this.store.state.matches).some(m=>m.started&&!m.paused&&m.game.status!=='finished'&&m.jobs.some(j=>this.seats(m).includes(j.seat)&&j.status==='open'&&j.deadline<=this.now()));if(!due)return;
  this.store.change(s=>{for(const m of Object.values(s.matches)){if(!m.started||m.paused||m.game.status==='finished')continue;for(const j of [...m.jobs])if(this.seats(m).includes(j.seat)&&j.status==='open'&&j.deadline<=this.now()){this.fault(m,j,'timeout');this.timeout(m,j)}}});
 }
}
