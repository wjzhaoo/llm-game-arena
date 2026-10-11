const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const memory=new Map();
function stored(key){return memory.get(key)||null}
function save(key,value){if(value===null)memory.delete(key);else memory.set(key,value)}
// Remove only this application's legacy data; never restore browser-stored identities.
try{
 for(let i=sessionStorage.length-1;i>=0;i--){
  const key=sessionStorage.key(i);
  if(key==='arenaAdmin'||key?.startsWith('arenaPlayer:')||key?.startsWith('arenaJoin:'))sessionStorage.removeItem(key);
 }
}catch{}
const initialUrl=new URL(location.href);
let current=initialUrl.searchParams.get('room'),match=null,admin='',replay=null;
const validAuthToken=value=>typeof value==='string'&&/^[\x21-\x7e]+$/.test(value);
const adminFormatMessage='管理码格式无效，请只复制终端中的管理码，不含中文说明、全角字符或空格';
let playerData=null,humanJob=null,selectedCell=null,boardContext='',panelContext='',refreshing=false,submitting=false,clockOffset=0;
let chessStage=null,chessMode='2d',interactionBusy=false;
let ww={room:null,seen:null,prevPhase:null,poppedId:null,player:null};
function wwPlayer(){
 if(!ww.player)ww.player=ArenaWerewolf.createPlayer({fx:$('fx'),board:$('board'),reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches});
 return ww.player;
}
let invitationRequest=0,invitationSeat=null,avatarManifest={},network={localOrigin:location.origin,lanOrigins:[]},autoJoin=true;
const wakeRequests=new Set(),roomInvites=new Map();
if(current&&new URLSearchParams(initialUrl.hash.slice(1)).has('join')){
 save('arenaJoin:'+current,new URLSearchParams(initialUrl.hash.slice(1)).get('join'));
 history.replaceState(null,'',initialUrl.pathname+initialUrl.search);
}
const seatTitle=seat=>seat==='red'?'红方选手':seat==='black'?'黑方选手':seat.replace(/^p/,'')+' 号选手';
const kinds={xiangqi:'中国象棋',blind:'覆棋盲棋',werewolf:'六人狼人杀'};
function credential(){try{return JSON.parse(stored('arenaPlayer:'+current)||'null')}catch{return null}}
function selectRoom(id){
 current=id;
 const url=new URL(location.href);url.searchParams.set('room',id);url.hash='';
 history.replaceState(null,'',url.pathname+url.search);
}
function shareBase(){return $('shareAddress').value||network.lanOrigins[0]||network.localOrigin}
function notify(value){
 const messages={'Admin authorization required':'管理码无效，请在管理入口重新输入本次管理码','All players must connect first':'请等待全部选手接入后再开始比赛','Unauthorized':'席位凭据已失效，请重新加入','Binding revoked':'连接已被房主撤销，请重新加入','Stale attempt or foreign session':'棋局或任务已更新，请刷新后重试','Match paused; administrator must resume':'比赛已暂停，请等待房主继续','Conflicting durable receipt':'该行动已提交其他结果，请刷新当前对局'};
 const message=messages[value]||value;
 $('notice').textContent=message;
 for(const notice of document.querySelectorAll('dialog [data-notice]'))notice.textContent=notice.closest('dialog').open?message:'';
}
async function api(path,body,auth=false,token){
 const bearer=token||(auth?admin:'');
 if(bearer&&!validAuthToken(bearer)){
  const error=Error(auth?adminFormatMessage:'席位凭据格式无效，请重新加入');error.status=401;throw error;
 }
 const response=await fetch(path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const out=await response.json();
 if(!response.ok){const error=Error(out.error);error.status=response.status;throw error}
 return out;
}
async function safe(fn){try{await fn()}catch(error){notify(error.message)}}
function manage(){if(!admin){$('adminDialog').showModal();throw Error('请先输入启动终端中的管理码')}return true}
function selectCopyField(input){
 input.focus({preventScroll:true});input.select();input.setSelectionRange(0,input.value.length);
 return document.activeElement===input&&input.selectionStart===0&&input.selectionEnd===input.value.length;
}
async function copyText(value,source){
 if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(value);return}catch{}}
 if(source&&(!source.isConnected||source.value!==value))throw Error('内容已更新，请复制当前邀请');
 const existing=source?.isConnected&&source.value===value,input=existing?source:document.createElement('textarea');
 if(!existing){
  input.value=value;input.readOnly=true;input.style.position='fixed';input.style.top='0';input.style.opacity='0';
  const dialog=document.activeElement?.closest('dialog')||document.querySelector('dialog[open]');
  (dialog?.open?dialog:document.body).append(input);
 }
 let selected=false,copied=false;
 try{selected=selectCopyField(input);if(selected)copied=document.execCommand('copy')}catch{}
 finally{if(!existing)input.remove()}
 if(!copied)throw Error(existing&&selected?'自动复制未成功，已选中完整内容，请按 Ctrl+C（Mac 用 ⌘C）手动复制':'自动复制未成功，请点击文本，按 Ctrl+A、Ctrl+C（Mac 用 ⌘A、⌘C）手动复制');
}
async function copyField(button,input,isCurrent=()=>true){
 const text=input.value;if(!text||button.disabled)return;
 button.disabled=true;button.textContent='复制中…';
 const active=()=>isCurrent()&&input.value===text;
 try{await copyText(text,input);if(active()){button.textContent='已复制';notify('内容已复制到剪贴板')}}
 catch(error){if(active()){button.textContent='重试复制';notify(error.message)}}
 finally{if(active())button.disabled=false}
}
async function getRoomInvite(){
 manage();if(!current)throw Error('请先创建房间');
 let result=roomInvites.get(current);
 if(!result||result.expiresAt<=Date.now()){result=await api('/api/room-invite',{match:current,base:shareBase()},true);roomInvites.set(current,result)}
 const url=new URL(result.url);url.host=new URL(shareBase()).host;return {...result,url:url.href};
}
function joinOptions(){
 const chosen=$('humanSeat').value;
 const seats=(match?.participants||[]).filter(p=>p.type==='human'&&!p.connected);
 $('humanSeat').innerHTML=seats.map(p=>'<option value="'+esc(p.seat)+'">'+seatTitle(p.seat)+'</option>').join('');
 if(seats.some(p=>p.seat===chosen))$('humanSeat').value=chosen;
 $('joinHuman').disabled=!seats.length;
}
async function openJoin(){
 if(!current||!match)throw Error('请先选择房间');
 if(credential())throw Error('你已在本房间入座，请使用下方真人操作区');
 if(!stored('arenaJoin:'+current)){
  const invitation=await getRoomInvite();
  save('arenaJoin:'+current,new URL(invitation.url).hash.slice('#join='.length));
 }
 joinOptions();$('joinDialog').showModal();
 if(!$('humanSeat').options.length)notify('暂无空闲真人席位，请让房主在开局前设置选手类型');
}
function invitationPrompt(invitation){
 if(invitation.seat!==invitationSeat||!['red','black','p1','p2','p3','p4','p5','p6'].includes(invitation.seat))throw Error('邀请返回了不同的席位');
 return '本邀请仅供'+seatTitle(invitation.seat)+'（'+invitation.seat+'）使用。\n'+invitation.text;
}
async function loadInvitation(){
 const request=++invitationRequest,room=current,seat=invitationSeat;
 $('inviteText').value='';$('copyInvite').disabled=true;$('copyInvite').textContent='复制邀请';notify('');
 const invitation=await api('/api/invite',{match:room,seat,wakeTransport:$('inviteTransport').value,base:shareBase()},true);
 if(request!==invitationRequest||current!==room||!$('inviteDialog').open)return;
 $('inviteText').value=invitationPrompt(invitation);$('copyInvite').disabled=false;
}
async function participantAction(button){
 const seat=button.dataset.seat,p=match.participants.find(p=>p.seat===seat);
 if(p.connected){
  manage();if(!confirm('撤销此选手连接？旧凭据与在途回传将失效，行动期限不延长。'))return;
  await api('/api/revoke',{match:current,seat},true);await refresh();return;
 }
 if(p.type==='human'){await openJoin();$('humanSeat').value=seat;return}
 manage();invitationSeat=seat;
 $('inviteTitle').textContent=seatTitle(seat)+' · AI 接入邀请';
 $('inviteTarget').textContent='仅发送给此席位的模型会话。局域网模板在 AI 自己的电脑核验并唤醒原会话。';
 $('copyInvite').textContent='复制邀请';$('inviteDialog').showModal();await loadInvitation();
}
$('themePreference').value=ArenaTheme.preference;
$('themePreference').onchange=event=>{ArenaTheme.set(event.target.value);if(match)render()};
document.addEventListener('error',event=>{if(event.target instanceof HTMLImageElement&&event.target.classList.contains('avatar-image')){event.target.hidden=true;event.target.previousElementSibling?.setAttribute('aria-hidden','false')}},true);
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>$(button.dataset.close).close();
$('adminButton').onclick=()=>$('adminDialog').showModal();
$('saveAdmin').onclick=()=>safe(async()=>{
 const button=$('saveAdmin'),value=$('adminCode').value.trim();button.disabled=true;
 try{
  if(!value)throw Error('请填写启动终端显示的本次管理码');
  if(!validAuthToken(value))throw Error(adminFormatMessage);
  await api(current?'/api/matches/'+encodeURIComponent(current)+'/admin':'/api/admin',null,true,value);
  admin=value;$('adminCode').value='';$('adminDialog').close();notify('管理码验证通过，仅当前页面有效');await refresh();
 }finally{button.disabled=false}
});
$('newButton').onclick=()=>safe(async()=>{manage();$('createDialog').showModal()});
$('create').onclick=()=>safe(async()=>{
 const button=$('create');button.disabled=true;
 try{
  const room=await api('/api/matches',{kind:$('kind').value,title:$('roomTitle').value,timeoutSeconds:Number($('timeout').value)},true);
  selectRoom(room.id);replay=null;playerData=null;humanJob=null;autoJoin=false;$('createDialog').close();
  notify('房间已创建，请在选手旁选择真人或 AI，并分别邀请接入');await refresh();
 }finally{button.disabled=false}
});
$('startButton').onclick=()=>safe(async()=>{manage();await api('/api/start',{match:current},true);notify('比赛已开始');await refresh()});
$('pauseButton').onclick=()=>safe(async()=>{manage();await api('/api/control',{match:current,action:match.paused?'resume':'pause'},true);await refresh()});
$('endButton').onclick=()=>safe(async()=>{manage();if(!confirm('结束本场比赛？记录会保留，未完成行动会取消。'))return;await api('/api/control',{match:current,action:'end'},true);await refresh()});
$('reveal').onchange=()=>safe(async()=>{if($('reveal').checked&&!admin){$('reveal').checked=false;manage()}replay=null;await refresh()});
$('inviteTransport').onchange=()=>safe(loadInvitation);
$('inviteDialog').addEventListener('close',()=>{invitationRequest++;$('inviteText').value='';$('copyInvite').disabled=true});
$('copyInvite').onclick=()=>{const request=invitationRequest;return safe(()=>copyField($('copyInvite'),$('inviteText'),()=>request===invitationRequest&&$('inviteDialog').open))};
$('shareRoom').onclick=()=>safe(async()=>{
 const result=await getRoomInvite();$('roomLink').value=result.url;
 try{await copyText(result.url);notify('房间邀请已复制，朋友打开后可选择空闲真人席位')}
 catch{$('copyRoomLink').textContent='复制链接';$('copyRoomLink').disabled=false;$('shareDialog').showModal();selectCopyField($('roomLink'));notify('自动复制未成功，已选中房间链接，请按 Ctrl+C（Mac 用 ⌘C）手动复制')}
});
$('copyRoomLink').onclick=()=>safe(()=>copyField($('copyRoomLink'),$('roomLink'),()=>$('shareDialog').open));
$('joinHuman').onclick=()=>safe(async()=>{
 const button=$('joinHuman');button.disabled=true;
 try{
  const room=current,out=await api('/api/player',{action:'join',match:room,seat:$('humanSeat').value,nickname:$('nickname').value,invitation:stored('arenaJoin:'+room)});
  save('arenaPlayer:'+room,JSON.stringify(out));$('joinDialog').close();$('reveal').checked=false;replay=null;humanJob=null;notify('已加入 '+seatTitle(out.seat)+'，等待全员接入后开局');await refresh();
 }finally{joinOptions()}
});
$('replay').oninput=()=>{replay=Number($('replay').value);render()};
$('backLive').onclick=()=>{replay=null;render()};
$('players').onchange=event=>safe(async()=>{
 const seat=event.target.dataset.participantType;if(!seat)return;
 manage();await api('/api/participant-type',{match:current,seat,type:event.target.value},true);await refresh();
});
$('players').onclick=event=>safe(async()=>{
 const participant=event.target.closest('[data-seat]');if(participant)return participantAction(participant);
 const button=event.target.closest('[data-wake-seat]');if(!button)return;
 manage();const room=current,seat=button.dataset.wakeSeat,key=room+':'+seat,connection=(match.connections||[]).find(c=>c.seat===seat);
 if(wakeRequests.has(key)||!connection?.canWake)return;
 wakeRequests.add(key);render();
 try{const result=await api('/api/wake-check',{match:room,seat,bindingId:connection.bindingId,attemptId:connection.attemptId},true);notify(result.message)}finally{wakeRequests.delete(key);await refresh()}
});
$('matches').onclick=event=>safe(async()=>{
 const button=event.target.closest('[data-id]');if(!button)return;
 selectRoom(button.dataset.id);replay=null;playerData=null;humanJob=null;autoJoin=false;$('reveal').checked=false;await refresh();
});
$('taskList').onclick=event=>safe(async()=>{
 const button=event.target.closest('[data-retry-task]');if(!button)return;
 manage();button.disabled=true;try{await api('/api/control',{match:current,action:'retry',taskId:button.dataset.retryTask},true)}finally{await refresh()}
});
$('board').onclick=event=>safe(async()=>{
 const button=event.target.closest('[data-cell],[data-target]');if(!button)return;
 await chessSquare((button.dataset.cell||button.dataset.target).split(',').map(Number),!!button.dataset.target);
});
async function chessSquare(cell,target=false){
 const g=replay===null?match.game:match.history[replay]?.game;if(!g||!ArenaUI.cell(cell))return;
 if(!target){
  if(playerData&&replay===null){
   const p=g.board[cell[1]][cell[0]],side=typeof p==='string'?(p[0]==='r'?'red':'black'):p?.side;
   if(side!==playerData.seat)return;
  }
  selectedCell=selectedCell?.join(',')===cell.join(',')?null:cell;render();return;
 }
 if(!playerData||replay!==null){$('boardInstruction').textContent='目标 '+cell+'：仅预览，不提交棋步';return}
 if(!humanJob||humanJob.kind==='undo-response'||match.undoRequest||submitting||match.paused)return;
 await submitHuman({from:selectedCell,to:cell});
}
$('board').onkeydown=event=>{if(event.key==='Escape'){selectedCell=null;render()}};
$('playerControls').onsubmit=event=>{event.preventDefault();safe(async()=>{
 const target=$('actionTarget')?.value||null,phase=playerData?.privateView.phase;
 let result;
 if(phase==='discuss')result={type:'speak',text:$('speechText').value};
 else if(phase==='witch'){
  const choice=document.querySelector('input[name="witchChoice"]:checked').value;
  if(choice==='poison'&&!target)throw Error('请选择毒药目标');
  result={type:'witch',save:choice==='save',poison:choice==='poison'?target:null};
 }else result={type:({wolf:'kill',seer:'inspect',vote:'vote'})[phase],target};
 await submitHuman(result);
})};
$('playerControls').onclick=event=>safe(async()=>{
 const button=event.target.closest('[data-resign],[data-undo],[data-undo-answer],[data-emote]');
 if(!button||button.disabled||interactionBusy||submitting||replay!==null||match.paused)return;
 if(button.hasAttribute('data-undo-answer')){await submitHuman({type:'undo-response',requestId:match.undoRequest.id,accept:button.dataset.undoAnswer==='true'});return}
 if(button.hasAttribute('data-resign')&&!confirm('确认认输？本局将立即结束。'))return;
 const me=credential();if(!me)return;const room=current;interactionBusy=true;button.disabled=true;
 try{
  const body=button.hasAttribute('data-resign')?{action:'resign'}:button.hasAttribute('data-undo')?{action:'undo-request',boardRevision:match.boardRevision}:{action:'emote',emote:button.dataset.emote};
  await api('/api/player',body,false,me.token);selectedCell=null;
 }finally{interactionBusy=false;panelContext='';if(current===room)await refresh()}
});
async function submitHuman(result){
 if(submitting||replay!==null||!humanJob||!playerData||match.paused)return;
 const room=current,me=credential(),job=humanJob;submitting=true;
 $('playerControls').querySelector('button[type="submit"]')?.setAttribute('disabled','');
 try{
  const out=await api('/api/player',{action:'submit',taskId:job.taskId,attemptId:job.attemptId,result},false,me.token);
  if(!out.ok)throw Error(out.details||out.error);
  selectedCell=null;notify('行动已提交');
 }finally{
  submitting=false;if(current===room)await refresh();
  $('playerControls').querySelector('button[type="submit"]')?.removeAttribute('disabled');
 }
}
async function refresh(){
 if(refreshing)return;
 refreshing=true;
 try{
  const rooms=await api('/api/matches');
  if(!current&&rooms.length)selectRoom(rooms.at(-1).id);
  $('matches').innerHTML=rooms.slice().reverse().map(m=>'<button class="room '+(current===m.id?'active':'')+'" data-id="'+esc(m.id)+'"><strong>'+esc(m.title)+'</strong><small>'+kinds[m.kind]+' · '+(m.status==='finished'?'已结束':m.started?'进行中':'待接入')+'</small></button>').join('');
  if(!current)return;
  const room=current,me=credential();
  if(me)$('reveal').checked=false;
  const data=await api('/api/matches/'+encodeURIComponent(room)+($('reveal').checked?'?reveal=1':''),null,$('reveal').checked);
  if(current!==room)return;
  match=data;playerData=null;if(Number.isFinite(data.serverNow))clockOffset=data.serverNow-Date.now();
  if(me){
   try{
    const status=await api('/api/player',{action:'status'},false,me.token);
    if(current!==room)return;
    if(status.match.id!==room)throw Error('席位凭据与当前房间不匹配');
    match=status.match;playerData=status;clockOffset=status.serverNow-Date.now();
    if(status.task&&(!humanJob||humanJob.taskId!==status.task.taskId||humanJob.attemptId!==status.task.attemptId)){
     const claimed=await api('/api/player',{action:'claim'},false,me.token);
     if(current!==room)return;
     humanJob=claimed.job||null;
    }else if(status.task&&humanJob)humanJob.deadline=status.task.deadline;
    else humanJob=null;
   }catch(error){
    humanJob=null;
    if(error.status===401||error.message==='Binding revoked'){save('arenaPlayer:'+room,null);notify('席位凭据已失效，请重新加入')}
    else throw error;
   }
  }else humanJob=null;
  if(admin){
   [match.connections,match.admin]=await Promise.all([api('/api/matches/'+room+'/connections',null,true).catch(()=>[]),api('/api/matches/'+room+'/admin',null,true).catch(()=>null)]);
  }else{match.connections=[];match.admin=null}
  if(current!==room)return;
  render();if($('joinDialog').open)joinOptions();
  if(autoJoin&&stored('arenaJoin:'+room)&&!credential()){autoJoin=false;await openJoin()}
 }finally{refreshing=false}
}
function connectionText(p){
 if(!p.connected)return p.type==='human'?'等待真人加入':'等待 AI 会话接入';
 if(p.type==='human')return (p.nickname||'棋友')+' · '+(p.online?'在线':'等待连接 / 暂时离线');
 const d=match.connections?.find(c=>c.seat===p.seat),labels={connected:'已连接',parked:'待命',pending:'待通知',sending:'通知中',sent:'已送达，待领取',claimed:'已领取',uncertain:'送达待核实',completed:'已结束'};
 return p.provider+' · '+(p.continuationMode==='wake'?(p.wakeTransport==='relay'?'远端唤醒':'本机唤醒'):'轮询等待')+(d?' · '+(labels[d.status]||'待连接'):'');
}
function render(){
 if(!match)return;
 const g=replay===null?match.game:(match.history[replay]?.game||match.game),finished=match.game.status==='finished';
 const focused=document.activeElement,focusCell=focused?.dataset?.cell,focusTarget=focused?.dataset?.target;
 $('title').textContent=match.title;$('subtitle').textContent=kinds[match.kind]+' · 真人与 AI 同席 · 规则引擎校验';
 $('status').textContent=match.paused?'房主已暂停':g.status==='finished'?'已结束 · '+(g.winner||'平局'):match.started?'正在进行':'等待选手';
 $('gameKind').textContent=match.kind.toUpperCase();
 const frame=replay===null?match:match.history[replay],chessPhase=g.status==='finished'?'本局已结束':frame?.paused?'比赛已暂停':frame?.undoRequest?'等待'+seatTitle(frame.undoRequest.responder)+'确认悔棋':!(frame?.started??match.started)?'等待开局':(g.turn==='red'?'红方':'黑方')+'行棋';
 $('phase').textContent=match.kind==='werewolf'?'第 '+g.round+' 轮 · '+({night:'夜间行动',wolf:'狼人行动',seer:'预言家行动',witch:'女巫行动',discuss:'白天讨论',vote:'放逐投票',finished:'已结束'})[g.phase]:chessPhase+' · 第 '+(g.ply||0)+' 手';
 $('live').textContent=replay===null?'● LIVE':'◷ REPLAY';
 $('startButton').disabled=!admin||match.started||finished||match.participants.some(p=>!p.connected);
 $('pauseButton').disabled=!admin||!match.started||finished;$('pauseButton').textContent=match.paused?'继续比赛':'暂停比赛';
 $('endButton').disabled=!admin||finished;$('shareRoom').disabled=!admin||finished;
 $('reveal').disabled=!!credential();
 $('replay').max=Math.max(0,match.history.length-1);$('replay').value=replay===null?Math.max(0,match.history.length-1):replay;
 $('replayLabel').textContent=replay===null?'实时 · '+match.history.length+' 条历史记录':'回放 '+(replay+1)+'/'+match.history.length+' · '+(match.history[replay]?.text||'');
 if(match.kind!=='werewolf'){
  if(ww.room){wwPlayer().reset();ww.room=null;ww.seen=null;ww.prevPhase=null;ww.poppedId=null}
  const context=current+':'+replay+':'+g.ply+':'+match.boardRevision+':'+(match.undoRequest?.id||'');
  if(context!==boardContext){selectedCell=null;boardContext=context}
  const interactive=!!playerData&&replay===null,canAct=interactive&&!!humanJob&&humanJob.kind!=='undo-response'&&!match.undoRequest&&!submitting&&!match.paused;
  const snapshot=replay===null?match:match.history[replay];
  const boardOptions={room:current,interactive,canAct,side:playerData?.seat,started:snapshot?.started??match.started,paused:snapshot?.paused??false,undoRequest:snapshot?.undoRequest||null,replay:replay!==null,replayIndex:replay,events:replay===null?match.events:snapshot?.type==='emote'?[snapshot]:[],now:Date.now()+clockOffset};
  if(globalThis.ArenaChess){
   if(!chessStage)chessStage=new ArenaChess.Stage($('board'),{mode:chessMode,onMode:mode=>chessMode=mode,onPick:(cell,target)=>safe(()=>chessSquare(cell,target)),onFailure:notify});
   chessStage.update(g,selectedCell,boardOptions);
  }else $('board').innerHTML=ArenaUI.chess(g,selectedCell,boardOptions);
  if(focusCell)$('board').querySelector('[data-cell="'+focusCell+'"]')?.focus({preventScroll:true});
  else if(focusTarget)$('board').querySelector('[data-target="'+focusTarget+'"]')?.focus({preventScroll:true});
 }else{
  if(chessStage){chessStage.destroy();chessStage=null}
  const warning=$('reveal').checked&&replay===null?'<div class="reveal-warning">管理全知视图 · 包含隐藏身份，勿向选手分享</div>':'';
  const events=replay===null?match.events:match.history.slice(0,replay+1);
  const {speaking,lastSpeech}=ArenaWerewolf.deriveSpeech(events,g);
  const poppedBefore=ww.poppedId;
  if(replay===null){
   if(ww.room!==current||!ww.seen){
    ww.room=current;ww.seen=new Set(events.map(ArenaWerewolf.eventKey));ww.prevPhase=g.phase;ww.poppedId=null;wwPlayer().reset();
   }else{
    const fresh=ArenaWerewolf.freshEvents(ww.seen,match.events);
    for(const e of match.events)ww.seen.add(ArenaWerewolf.eventKey(e));
    const list=ArenaWerewolf.directives(fresh,ww.prevPhase,g.phase);
    ww.prevPhase=g.phase;
    wwPlayer().enqueue(list);
   }
   if(lastSpeech)ww.poppedId=lastSpeech.id;
  }else wwPlayer().reset();
  $('board').innerHTML=warning+ArenaWerewolf.stage(g,match.participants,avatarManifest,{speaking,lastSpeech,poppedId:replay===null?poppedBefore:(lastSpeech?.id??null)});
 }
 $('count').textContent=match.participants.filter(p=>p.connected).length+' / '+match.participants.length;
 $('players').innerHTML=match.participants.map(p=>{
  const d=match.connections?.find(c=>c.seat===p.seat),control=ArenaUI.wakeControl(d,wakeRequests.has(current+':'+p.seat));
  const frame=replay===null?match:match.history[replay],chess=match.kind!=='werewolf',active=chess&&g.status!=='finished'&&(frame?.started??match.started)&&!frame?.paused&&!frame?.undoRequest&&g.turn===p.seat,confirming=chess&&frame?.undoRequest?.responder===p.seat;
  const tag=active?(replay!==null?'回放行棋方':playerData?.seat===p.seat?'轮到你':'正在行棋'):confirming?'等待确认悔棋':'';
  return '<div class="player'+(active?' chess-active':'')+(confirming?' chess-confirming':'')+'">'+(p.type==='human'?'<span class="provider-avatar human-avatar">真人</span>':ArenaUI.avatar(p.provider,avatarManifest))+'<div class="player-meta"><strong>'+seatTitle(p.seat)+'</strong>'+(tag?'<span class="seat-turn-tag">'+tag+'</span>':'')+'<small>'+esc(connectionText(p))+'</small>'+(d?.error?'<small>'+esc(d.error)+'</small>':'')+'</div><div class="participant-actions"><select class="participant-type" data-participant-type="'+p.seat+'" aria-label="'+seatTitle(p.seat)+'类型" '+(!admin||match.started||p.connected||finished?'disabled':'')+'><option value="ai" '+(p.type==='ai'?'selected':'')+'>AI</option><option value="human" '+(p.type==='human'?'selected':'')+'>真人</option></select>'+(control?'<button class="wake-button" data-wake-seat="'+p.seat+'" '+(control.disabled?'disabled':'')+' title="'+esc(control.reason)+'">'+esc(control.label)+'</button>':'')+'<button data-seat="'+p.seat+'" '+((p.connected||p.type==='ai')&&!admin||p.type==='human'&&!p.connected&&!!credential()||finished?'disabled':'')+'>'+(p.connected?'撤销':p.type==='human'?'加入'+(p.seat==='red'?'红方':p.seat==='black'?'黑方':p.seat.slice(1)+' 号席位'):'邀请 AI')+'</button></div></div>';
 }).join('');
 $('adminTasks').hidden=!match.admin;const tasks=match.admin?.tasks||[];
 $('taskList').innerHTML=tasks.length?tasks.map(t=>'<div class="admin-task"><span>'+esc(t.message||'系统异常')+'<small>'+esc(({pending:'待处理',retried:'已允许重试',resolved:'已解决',closed:'已关闭'})[t.status])+'</small></span>'+(t.canRetry?'<button data-retry-task="'+esc(t.id)+'">允许一次重试</button>':'')+'</div>').join(''):'<p class="muted">暂无系统异常待办</p>';
 const events=replay===null?match.events:match.history.slice(0,replay+1);
 $('events').innerHTML=events.slice().reverse().map(e=>'<div class="event '+esc(e.type)+'"><time>'+new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false})+'</time><span>'+esc(e.text)+'</span></div>').join('');
 renderPlayerPanel();
}
function renderPlayerPanel(){
 const panel=$('playerControls');panel.hidden=!playerData||replay!==null;
 if(panel.hidden){panel.innerHTML='';panelContext='';return}
 const key=JSON.stringify([current,humanJob?.taskId,humanJob?.attemptId,playerData.privateView.self,match.paused,match.started,match.game.status,playerData.interactions?.undo,playerData.interactions?.emoteAvailableAt,match.undoRequest?.id]);
 if(key!==panelContext){
  panelContext=key;
  const status=match.paused?'比赛已暂停':!match.started?'等待房主开始比赛':match.game.status==='finished'?'本局已结束':match.undoRequest?'等待悔棋确认':humanJob?'轮到你行动':'等待其他选手行动';
  const response=humanJob?.kind==='undo-response'?'<div class="undo-response"><p>对方请求撤回 '+match.undoRequest.plies+' 手，是否同意？</p><div class="actions"><button data-undo-answer="true" '+(match.paused?'disabled':'')+'>同意悔棋</button><button data-undo-answer="false" '+(match.paused?'disabled':'')+'>拒绝悔棋</button></div></div>':'';
  const chessControls=globalThis.ArenaChess?ArenaChess.controls(playerData.interactions,match.paused||!match.started||match.game.status==='finished',Date.now()+clockOffset):'<button data-resign '+(match.paused?'disabled':'')+'>认输</button>';
  panel.innerHTML='<div class="turn-clock" id="turnClock"></div><p>'+seatTitle(playerData.seat)+' · '+status+'</p>'+(match.kind==='werewolf'?ArenaUI.werewolfActions(playerData.privateView,match.paused?null:humanJob):(!match.undoRequest&&humanJob&&!match.paused?'<h3>你执'+(playerData.seat==='red'?'红方':'黑方')+'，点击棋子和合法目标完成落子</h3>':'')+response+chessControls);
 }
 updateClock();
}
function updateClock(){
 const clock=$('turnClock');if(!clock)return;
 const request=match?.undoRequest,deadline=request?.deadline||humanJob?.deadline;
 clock.textContent=match?.paused?'计时已冻结':deadline?(request?'悔棋确认剩余 ':'本次行动剩余 ')+Math.max(0,Math.ceil((deadline-Date.now()-clockOffset)/1000))+' 秒'+(request?' · 走棋计时冻结':''):'';
 if(playerData?.interactions&&match?.started&&!match.paused&&match.game.status!=='finished')for(const button of $('playerControls').querySelectorAll?.('[data-emote]')||[])button.disabled=interactionBusy||playerData.interactions.emoteAvailableAt>Date.now()+clockOffset;
}
safe(async()=>{
 [network,avatarManifest]=await Promise.all([api('/api/network'),api('/assets/avatars/manifest.json').catch(()=>({}))]);
 $('shareAddress').innerHTML=[...network.lanOrigins,network.localOrigin].map(url=>'<option value="'+esc(url)+'">'+esc(url)+(url===network.localOrigin?'（仅本机）':'')+'</option>').join('');
 $('networkHint').textContent=network.lanOrigins.length?'真人通过房间链接加入；AI 请在选手旁邀请':'未发现局域网地址，请检查网络连接';
 await refresh();
});
setInterval(()=>safe(refresh),2000);setInterval(updateClock,1000);
