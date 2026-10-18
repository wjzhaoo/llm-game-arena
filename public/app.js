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
let selectedRun=initialUrl.searchParams.get('run'),activeMatch=null,roomList=[],refreshRequested=false,restartTarget=null,deleteTarget=null;
let exportTarget=null,exporting=false;
const historical=()=>!!match?.readOnly;
const chatKey=()=>current+':'+(match?.runId||'first');
const folds=new Map();let foldContext='';
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
const chatHistory=new Map(),chatDrafts=new Map();let chatProfileTarget=null;
if(current&&new URLSearchParams(initialUrl.hash.slice(1)).has('join')){
 save('arenaJoin:'+current,new URLSearchParams(initialUrl.hash.slice(1)).get('join'));
 history.replaceState(null,'',initialUrl.pathname+initialUrl.search);
}
const seatTitle=seat=>seat==='red'?'红方选手':seat==='black'?'黑方选手':seat.replace(/^p/,'')+' 号选手';
const kinds={xiangqi:'中国象棋',blind:'覆棋盲棋',werewolf:'六人狼人杀',groupchat:'自由群聊'};
function credential(){try{return JSON.parse(stored('arenaPlayer:'+current)||'null')}catch{return null}}
function updateAddress(){
 const url=new URL(location.href);if(current)url.searchParams.set('room',current);else url.searchParams.delete('room');
 if(selectedRun)url.searchParams.set('run',selectedRun);else url.searchParams.delete('run');url.hash='';
 history.replaceState(null,'',url.pathname+url.search);
}
function resetView(){replay=null;playerData=null;humanJob=null;selectedCell=null;panelContext='';boardContext='';$('reveal').checked=false}
function selectRoom(id){
 if(match?.kind==='groupchat')rememberChatDraft();
 if($('exportDialog').open)$('exportDialog').close();exportTarget=null;
 current=id;selectedRun=null;match=null;activeMatch=null;resetView();updateAddress();
}
async function selectRun(id){
 if(match?.kind==='groupchat')rememberChatDraft();
 if($('exportDialog').open)$('exportDialog').close();exportTarget=null;
 selectedRun=id===activeMatch?.runId?null:id;resetView();updateAddress();await refresh();
}
function forgetRoom(id){
 for(const prefix of ['arenaPlayer:','arenaJoin:'])save(prefix+id,null);
 roomInvites.delete(id);
 for(const map of [chatHistory,chatDrafts,folds])for(const key of map.keys())if(key===id||key.startsWith(id+':'))map.delete(key);
 invitationRequest++;
 for(const name of ['inviteDialog','joinDialog','chatProfileDialog','restartDialog'])if($(name).open)$(name).close();
}
function renderEmpty(){
 if(chessStage){chessStage.destroy();chessStage=null}if(ww.player)ww.player.reset();ww.room=null;
 resetView();$('title').textContent='棋逢对手，思想成局';$('subtitle').textContent='创建房间，邀请选手，开启一场新的相遇';$('status').textContent='等待开局';
 $('phase').textContent='选择或创建一个房间';$('board').className='empty';delete $('board').dataset.chatHtml;
 $('board').innerHTML='<div class="hero-mark">弈</div><h2>一场比赛，多种智慧</h2><p>创建房间，邀请真人或 AI 会话加入</p>';
 for(const id of ['startButton','pauseButton','endButton','restartButton','exportButton','shareRoom','reveal','replay','backLive'])$(id).disabled=true;
 for(const id of ['runNavigation','playerControls','chatAdminTools','adminTasks'])$(id).hidden=true;
 $('players').innerHTML='';$('count').textContent='0 / 0';$('events').innerHTML='<p class="muted">尚无比赛记录</p>';$('replayLabel').textContent='尚无记录';$('live').textContent='';
}
function renderRooms(){
 const html=roomList.slice().reverse().map(m=>'<div class="room-row '+(current===m.id?'active':'')+'"><button class="room '+(current===m.id?'active':'')+'" data-id="'+esc(m.id)+'"><strong>'+esc(m.title)+'</strong><small>'+kinds[m.kind]+' · '+(m.status==='finished'?'已结束':m.started?'进行中':'待接入')+'</small></button>'+(admin?'<button class="room-delete" data-delete-id="'+esc(m.id)+'" title="删除房间" aria-label="删除房间 '+esc(m.title)+'"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>':'')+'</div>').join('');
 if($('matches').innerHTML!==html)$('matches').innerHTML=html;
}
function shareBase(){return $('shareAddress').value||network.lanOrigins[0]||network.localOrigin}
function notify(value){
 const messages={'Admin authorization required':'管理码无效，请在管理入口重新输入本次管理码','All players must connect first':'请等待全部选手接入后再开始比赛','Unauthorized':'席位凭据已失效，请重新加入','Binding revoked':'连接已被房主撤销，请重新加入','Stale attempt or foreign session':'棋局或任务已更新，请刷新后重试','Match paused; administrator must resume':'比赛已暂停，请等待房主继续','Conflicting durable receipt':'该行动已提交其他结果，请刷新当前对局'};
 const message=messages[value]||value;
 $('notice').textContent=message;
 for(const notice of document.querySelectorAll('dialog [data-notice]'))notice.textContent=notice.closest('dialog').open?message:'';
}
async function api(path,body,auth=false,token){
 if(body&&match?.runId&&(body.match===current||path==='/api/player'&&!['status','join'].includes(body.action)))body={...body,expectedRunId:body.expectedRunId??match.runId};
 const bearer=token||(auth?admin:'');
 if(bearer&&!validAuthToken(bearer)){
  const error=Error(auth?adminFormatMessage:'席位凭据格式无效，请重新加入');error.status=401;throw error;
 }
 const response=await fetch(path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const out=await response.json();
 if(!response.ok){const error=Error(out.error);error.status=response.status;throw error}
 return out;
}
async function safe(fn){try{await fn()}catch(error){notify(error.message);if(error.status===409)await refresh()}}
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
 const chat=match?.kind==='groupchat';$('humanSeatField').hidden=chat;$('chatJoinFields').hidden=!chat;
 $('joinTitle').textContent=chat?'加入自由群聊':'真人加入对局';$('joinInstructions').textContent=chat?'填写昵称即可加入，性格和初始观点可留空。运行中新加入的成员从下一轮参与。身份仅保留在当前页面。':'选择空闲真人席位。全部选手接入后，由房主开始比赛。身份仅在当前页面有效；刷新或关闭后，需让房主撤销旧席位再加入。';$('joinHuman').textContent=chat?'加入群聊':'加入席位';
 if(chat){$('joinHuman').disabled=match.game.status==='finished';return}
 const chosen=$('humanSeat').value;
 const seats=(match?.participants||[]).filter(p=>p.type==='human'&&!p.connected);
 $('humanSeat').innerHTML=seats.map(p=>'<option value="'+esc(p.seat)+'">'+seatTitle(p.seat)+'</option>').join('');
 if(seats.some(p=>p.seat===chosen))$('humanSeat').value=chosen;
 $('joinHuman').disabled=!seats.length;
}
async function openJoin(){
 if(!current||!match)throw Error('请先选择房间');
 if(historical())throw Error('历史记录只读，请先回到当前对局');
 if(credential())throw Error('你已在本房间入座，请使用下方真人操作区');
 if(!stored('arenaJoin:'+current)){
  const invitation=await getRoomInvite();
  save('arenaJoin:'+current,new URL(invitation.url).hash.slice('#join='.length));
 }
 joinOptions();$('joinDialog').showModal();
 if(match.kind!=='groupchat'&&!$('humanSeat').options.length)notify('暂无空闲真人席位，请让房主在开局前设置选手类型');
}
function invitationPrompt(invitation){
 if(invitation.seat!==invitationSeat||!(match?.kind==='groupchat'?match.participants.some(p=>p.seat===invitation.seat):['red','black','p1','p2','p3','p4','p5','p6'].includes(invitation.seat)))throw Error('邀请返回了不同的席位');
 return (invitation.nickname?'选手昵称：'+invitation.nickname+'\n':'')+'本邀请仅供'+seatTitle(invitation.seat)+'（'+invitation.seat+'）使用。\n'+invitation.text;
}
async function loadInvitation(){
 const request=++invitationRequest,room=current,seat=invitationSeat;
 $('inviteText').value='';$('copyInvite').disabled=true;$('copyInvite').textContent='复制邀请';notify('');
 const runId=match?.runId,invitation=await api('/api/invite',{match:room,seat,nickname:$('inviteNickname').value,wakeTransport:$('inviteTransport').value,base:shareBase()},true);
 if(request!==invitationRequest||current!==room||match?.runId!==runId||!$('inviteDialog').open)return;
 $('inviteText').value=invitationPrompt(invitation);$('copyInvite').disabled=false;
}
async function participantAction(button){
 if(historical())throw Error('历史记录只读，请先回到当前对局');
 const seat=button.dataset.seat,p=match.participants.find(p=>p.seat===seat);
 if(p.connected||match.kind==='groupchat'&&button.dataset.removeChat){
  manage();if(!confirm('撤销此选手连接？旧凭据与在途回传将失效，行动期限不延长。'))return;
  await api('/api/revoke',{match:current,seat},true);await refresh();return;
 }
 if(p.type==='human'){await openJoin();$('humanSeat').value=seat;return}
 manage();invitationSeat=seat;
 $('inviteTitle').textContent=seatTitle(seat)+' · AI 接入邀请';
 $('inviteTarget').textContent='仅发送给此席位的模型会话。局域网模板在 AI 自己的电脑核验并唤醒原会话。';
 $('inviteNickname').value=p.nickname||'';$('copyInvite').textContent='复制邀请';$('copyInvite').disabled=true;$('inviteText').value='';$('inviteDialog').showModal();
 if(match.kind==='groupchat')await loadInvitation();else notify('可填写 AI 昵称，再点击「生成邀请」');
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
$('kind').onchange=()=>{$('chatTopicField').hidden=$('kind').value!=='groupchat'};
$('chatAddAI').onclick=()=>safe(async()=>{manage();openChatProfile('add-ai')});
$('chatJoin').onclick=()=>safe(openJoin);
$('chatRestart').onclick=()=>safe(async()=>{manage();await api('/api/control',{match:current,action:'chat-restart'},true);await refresh()});
$('saveChatProfile').onclick=()=>safe(async()=>{
 const button=$('saveChatProfile'),room=current,target=chatProfileTarget,profile={personality:$('chatPersonality').value,initialOpinion:$('chatOpinion').value};button.disabled=true;
 try{
  let result;
  if(target==='self')result=await api('/api/player',{action:'profile',profile},false,credential().token);
  else result=await api('/api/chat-members',{match:room,action:target==='add-ai'?'add-ai':'profile',...(target==='add-ai'?{nickname:$('chatNickname').value}:{seat:target}),profile},true);
  $('chatProfileDialog').close();notify('设定已保存，运行中从下一轮生效');await refresh();
  if(target==='add-ai'&&current===room)await participantAction({dataset:{seat:result.seat}});
 }finally{button.disabled=false}
});
$('create').onclick=()=>safe(async()=>{
 const button=$('create');button.disabled=true;
 try{
  const room=await api('/api/matches',{kind:$('kind').value,title:$('roomTitle').value,timeoutSeconds:Number($('timeout').value),...($('kind').value==='groupchat'?{topic:$('chatTopic').value}:{})},true);
  selectRoom(room.id);replay=null;playerData=null;humanJob=null;autoJoin=false;$('createDialog').close();
  notify(room.kind==='groupchat'?'群聊已创建，可添加 AI 或邀请真人加入':'房间已创建，请在选手旁选择真人或 AI，并分别邀请接入');await refresh();
 }finally{button.disabled=false}
});
$('startButton').onclick=()=>safe(async()=>{manage();await api('/api/start',{match:current},true);notify('比赛已开始');await refresh()});
$('pauseButton').onclick=()=>safe(async()=>{manage();await api('/api/control',{match:current,action:match.paused?'resume':'pause'},true);await refresh()});
$('endButton').onclick=()=>safe(async()=>{manage();if(!confirm('结束本场比赛？记录会保留，未完成行动会取消。'))return;await api('/api/control',{match:current,action:'end'},true);await refresh()});
$('exportButton').onclick=()=>{
 if(!match||exporting)return;
 exportTarget={room:current,runId:match.runId};$('exportScope').value='run';$('exportNotice').textContent='';
 $('exportDescription').textContent=match.title+' · '+(match.kind==='groupchat'?'话题 '+match.runNumber+'：'+match.game.topic:'第 '+match.runNumber+' 局');
 $('exportDialog').showModal();
};
$('confirmExport').onclick=()=>safe(async()=>{
 const target=exportTarget,scope=$('exportScope').value,button=$('confirmExport');if(!target||exporting)return;
 exporting=true;button.disabled=true;button.textContent='生成中…';$('exportScope').disabled=true;$('exportButton').disabled=true;$('exportNotice').textContent='';
 let objectUrl,link,errorMessage='导出失败，请检查网络后重试';
 try{
  const query=new URLSearchParams({scope,...(scope==='run'?{runId:target.runId}:{})});
  const response=await fetch('/api/matches/'+encodeURIComponent(target.room)+'/export?'+query,{method:'GET',headers:{}});
  if(!response.ok){
   const out=await response.json().catch(()=>null);
   errorMessage=response.status===404?'房间或对局已不存在，请刷新后重试':out?.error||'导出失败，请重试';throw Error(errorMessage);
  }
  const blob=await response.blob(),header=response.headers.get('Content-Disposition')||'',encoded=/filename\*=UTF-8''([^;]+)/i.exec(header);
  let filename='游戏记录.md';if(encoded){try{filename=decodeURIComponent(encoded[1])}catch{}}
  objectUrl=URL.createObjectURL(blob);link=document.createElement('a');link.href=objectUrl;link.download=filename;
  document.body.append(link);link.click();$('exportDialog').close();notify('记录已导出为 Markdown');
 }catch{notify(errorMessage)}
 finally{
  link?.remove();if(objectUrl)setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
  exporting=false;button.disabled=false;button.textContent='下载 Markdown';$('exportScope').disabled=false;$('exportButton').disabled=!match;
 }
});
$('restartButton').onclick=()=>safe(async()=>{
 manage();if(!match||historical())return;
 restartTarget={room:current,runId:match.runId};const chat=match.kind==='groupchat';
 $('restartTitle').textContent=chat?'开启新话题':'重新开局';$('restartTopicField').hidden=!chat;$('restartTopic').value='';
 $('restartDescription').textContent=(match.game.status==='finished'?'本局已结束。':'当前'+(chat?'话题':'对局')+'将结束并归档。')+(chat?'成员性格继续沿用，初始观点会清空，可在开始前重新编辑。':'新一局将重新初始化棋盘或身份。');
 $('confirmRestart').textContent=chat?'创建新话题':'确认重开';$('restartDialog').showModal();
});
$('confirmRestart').onclick=()=>safe(async()=>{
 const target=restartTarget,button=$('confirmRestart');if(!target||button.disabled)return;
 const topic=$('restartTopic').value.trim();if(!$('restartTopicField').hidden&&!topic)throw Error('请输入新话题');button.disabled=true;
 try{await api('/api/control',{match:target.room,action:'restart',expectedRunId:target.runId,...(!$('restartTopicField').hidden?{topic}:{})},true);$('restartDialog').close();roomInvites.delete(target.room);save('arenaJoin:'+target.room,null);if(current===target.room){selectedRun=null;resetView();updateAddress()}notify('新一局已准备好，确认成员设定后点击开始');await refresh()}finally{button.disabled=false}
});
$('confirmDelete').onclick=()=>safe(async()=>{
 const target=deleteTarget,button=$('confirmDelete');if(!target||button.disabled)return;button.disabled=true;
 try{await api('/api/control',{match:target.id,action:'delete',expectedRunId:target.runId},true);$('deleteDialog').close();forgetRoom(target.id);if(current===target.id)selectRoom(null);notify('房间及全部历史记录已删除');await refresh()}finally{button.disabled=false}
});
$('topicTabs').onclick=event=>safe(async()=>{const button=event.target.closest('[data-run-id]');if(button)await selectRun(button.dataset.runId)});
$('topicTabs').onkeydown=event=>{
 if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 const buttons=[...$('topicTabs').querySelectorAll('[data-run-id]')],index=buttons.indexOf(event.target);if(index<0)return;
 event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();buttons[next].click();
};
$('runSelect').onchange=event=>safe(()=>selectRun(event.target.value));
$('returnCurrent').onclick=()=>safe(()=>selectRun(activeMatch?.runId));
$('reveal').onchange=()=>safe(async()=>{if($('reveal').checked&&!admin){$('reveal').checked=false;manage()}replay=null;await refresh()});
$('inviteTransport').onchange=()=>safe(loadInvitation);
$('generateInvite').onclick=()=>safe(loadInvitation);
$('inviteNickname').oninput=()=>{invitationRequest++;$('inviteText').value='';$('copyInvite').disabled=true;$('copyInvite').textContent='复制邀请'};
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
  const room=current,out=await api('/api/player',{action:'join',match:room,seat:$('humanSeat').value,nickname:$('nickname').value,invitation:stored('arenaJoin:'+room),...(match.kind==='groupchat'?{profile:{personality:$('joinPersonality').value,initialOpinion:$('joinOpinion').value}}:{})});
  save('arenaPlayer:'+room,JSON.stringify(out));$('joinDialog').close();$('reveal').checked=false;replay=null;humanJob=null;notify(match.kind==='groupchat'?'已加入群聊'+(match.started?'，从下一轮开始参与':'，等待房主开始讨论'):'已加入 '+seatTitle(out.seat)+'，等待全员接入后开局');await refresh();
 }finally{joinOptions()}
});
$('replay').oninput=()=>{replay=Number($('replay').value);render()};
$('backLive').onclick=()=>{replay=null;render()};
$('players').onchange=event=>safe(async()=>{
 const seat=event.target.dataset.participantType;if(!seat)return;
 manage();await api('/api/participant-type',{match:current,seat,type:event.target.value},true);await refresh();
});
$('players').onclick=event=>safe(async()=>{
 const profile=event.target.closest('[data-profile-seat]');if(profile){openChatProfile(profile.dataset.profileSeat);return}
 const participant=event.target.closest('[data-seat]');if(participant)return participantAction(participant);
 const button=event.target.closest('[data-wake-seat]');if(!button)return;
 manage();const room=current,seat=button.dataset.wakeSeat,key=room+':'+seat,connection=(match.connections||[]).find(c=>c.seat===seat);
 if(wakeRequests.has(key)||!connection?.canWake)return;
 wakeRequests.add(key);render();
 try{const result=await api('/api/wake-check',{match:room,seat,bindingId:connection.bindingId,attemptId:connection.attemptId},true);notify(result.message)}finally{wakeRequests.delete(key);await refresh()}
});
$('matches').onclick=event=>safe(async()=>{
 const remove=event.target.closest('[data-delete-id]');if(remove){manage();deleteTarget=roomList.find(m=>m.id===remove.dataset.deleteId);if(!deleteTarget)return;$('deleteDescription').textContent='确认删除「'+deleteTarget.title+'」？'+(deleteTarget.started&&deleteTarget.status!=='finished'?'进行中的任务也会立即取消。':'');$('deleteDialog').showModal();return}
 const button=event.target.closest('[data-id]');if(!button)return;
 selectRoom(button.dataset.id);replay=null;playerData=null;humanJob=null;autoJoin=false;$('reveal').checked=false;await refresh();
});
$('taskList').onclick=event=>safe(async()=>{
 const button=event.target.closest('[data-retry-task]');if(!button)return;
 manage();button.disabled=true;try{await api('/api/control',{match:current,action:'retry',taskId:button.dataset.retryTask},true)}finally{await refresh()}
});
$('board').onclick=event=>safe(async()=>{
 if(event.target.closest('[data-chat-history]')){await loadChatHistory();return}
 const button=event.target.closest('[data-cell],[data-target]');if(!button)return;
 await chessSquare((button.dataset.cell||button.dataset.target).split(',').map(Number),!!button.dataset.target);
});
async function chessSquare(cell,target=false){
 const g=replay===null?match.game:match.history[replay]?.game;if(!['xiangqi','blind'].includes(match.kind)||!g||!ArenaUI.cell(cell))return;
 if(!target){
  if(playerData&&replay===null&&!historical()){
   const p=g.board[cell[1]][cell[0]],side=typeof p==='string'?(p[0]==='r'?'red':'black'):p?.side;
   if(side!==playerData.seat)return;
  }
  selectedCell=selectedCell?.join(',')===cell.join(',')?null:cell;render();return;
 }
 if(!playerData||replay!==null||historical()){const instruction=$('boardInstruction');if(instruction)instruction.textContent='目标 '+cell+'：仅预览，不提交棋步';return}
 if(!humanJob||humanJob.kind==='undo-response'||match.undoRequest||submitting||match.paused)return;
 await submitHuman({from:selectedCell,to:cell});
}
$('board').onkeydown=event=>{if(event.key==='Escape'){selectedCell=null;render()}};
$('playerControls').onsubmit=event=>{event.preventDefault();safe(async()=>{
 if(match?.kind==='groupchat'){const result=humanJob?.kind==='chat-bid'?{type:'bid',score:Number($('chatScore').value)}:{type:'speak',text:$('speechText').value,...($('chatSpeechEmote').value?{emote:{id:$('chatSpeechEmote').value,targetSeat:$('chatEmoteTarget').value||null}}:{})};await submitHuman(result);return}
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
 if(match?.kind==='groupchat'&&await chatPlayerAction(event))return;
 const button=event.target.closest('[data-resign],[data-undo],[data-undo-answer],[data-emote]');
 if(!button||button.disabled||interactionBusy||submitting||replay!==null||historical()||match.paused)return;
 if(button.hasAttribute('data-undo-answer')){await submitHuman({type:'undo-response',requestId:match.undoRequest.id,accept:button.dataset.undoAnswer==='true'});return}
 if(button.hasAttribute('data-resign')&&!confirm('确认认输？本局将立即结束。'))return;
 const me=credential();if(!me)return;const room=current;interactionBusy=true;button.disabled=true;
 try{
  const body=button.hasAttribute('data-resign')?{action:'resign'}:button.hasAttribute('data-undo')?{action:'undo-request',boardRevision:match.boardRevision}:{action:'emote',emote:button.dataset.emote,...(match.kind==='groupchat'?{targetSeat:$('chatEmoteTarget').value||null}:{})};
  await api('/api/player',body,false,me.token);selectedCell=null;
 }finally{interactionBusy=false;panelContext='';if(current===room)await refresh()}
});
async function submitHuman(result){
 if(submitting||replay!==null||historical()||!humanJob||!playerData||match.paused)return;
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
 if(refreshing){refreshRequested=true;return}
 refreshing=true;
 try{
  const rooms=await api('/api/matches');
  roomList=rooms;
  if(current&&!rooms.some(m=>m.id===current)){const removed=current;forgetRoom(removed);selectRoom(null);notify('当前房间已被删除')}
  if(!current&&rooms.length)selectRoom(rooms.at(-1).id);
  renderRooms();
  if(!current){renderEmpty();return}
  const room=current,selection=selectedRun,me=credential();
  if(me)$('reveal').checked=false;
  const data=await api('/api/matches/'+encodeURIComponent(room)+($('reveal').checked?'?reveal=1':''),null,$('reveal').checked);
  if(current!==room||selectedRun!==selection)return;
  if(activeMatch?.runId&&activeMatch.runId!==data.runId){roomInvites.delete(room);save('arenaJoin:'+room,null);invitationRequest++;for(const id of ['inviteDialog','joinDialog','chatProfileDialog','restartDialog'])if($(id).open)$(id).close();if(!selectedRun)resetView()}
  activeMatch=data;
  if(selectedRun&&(selectedRun===data.runId||!data.runs?.some(r=>r.runId===selectedRun))){selectedRun=null;updateAddress()}
  if(selectedRun){
   const runId=selectedRun,archived=await api('/api/matches/'+encodeURIComponent(room)+'/runs/'+encodeURIComponent(runId));
   if(current!==room||selectedRun!==runId)return;
   match=archived;match.connections=[];match.admin=null;playerData=null;humanJob=null;render();return;
  }
  const stillCurrent=()=>current===room&&!selectedRun;
  match=data;playerData=null;if(Number.isFinite(data.serverNow))clockOffset=data.serverNow-Date.now();
  if(me){
   try{
    const status=await api('/api/player',{action:'status'},false,me.token);
    if(!stillCurrent())return;
    if(status.match.id!==room)throw Error('席位凭据与当前房间不匹配');
    if(match.runId!==status.match.runId){resetView();invitationRequest++}
    match=status.match;playerData=status;clockOffset=status.serverNow-Date.now();
    if(status.task&&(!humanJob||humanJob.taskId!==status.task.taskId||humanJob.attemptId!==status.task.attemptId)){
     const claimed=await api('/api/player',{action:'claim'},false,me.token);
     if(!stillCurrent())return;
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
  if(!stillCurrent())return;
  activeMatch=match;
  render();if($('joinDialog').open)joinOptions();
  if(autoJoin&&stored('arenaJoin:'+room)&&!credential()){autoJoin=false;await openJoin()}
 }catch(error){if(error.status===404){refreshRequested=true}else throw error}
 finally{refreshing=false;if(refreshRequested){refreshRequested=false;Promise.resolve().then(()=>safe(refresh))}}
}
for(const id of ['connectionsPanel','adminTasks','resolvedTasks','transcriptPanel'])$(id).addEventListener('toggle',()=>{if(foldContext)folds.set(foldContext+':'+id,$(id).open)});
function renderNavigation(){
 const runs=match.runs||[],liveId=activeMatch?.runId||match.runId,chosen=match.runId;
 $('runNavigation').hidden=runs.length<2;$('topicTabs').hidden=match.kind!=='groupchat';$('runSelectField').hidden=match.kind==='groupchat';
 const tabs=runs.map(r=>'<button role="tab" aria-controls="board" aria-selected="'+(r.runId===chosen)+'" tabindex="'+(r.runId===chosen?'0':'-1')+'" class="topic-tab '+(r.runId===chosen?'selected':'')+'" data-run-id="'+esc(r.runId)+'" title="'+esc(r.topic)+'"><span>话题 '+r.runNumber+'</span><strong>'+esc(r.topic)+'</strong><small>'+(r.runId===liveId?'当前':'历史 · 只读')+'</small></button>').join('');
 if($('topicTabs').innerHTML!==tabs)$('topicTabs').innerHTML=tabs;
 const options=runs.map(r=>'<option value="'+esc(r.runId)+'">第 '+r.runNumber+' 局 · '+(r.runId===liveId?'当前':r.status==='finished'?'历史 · 已结束':'历史')+'</option>').join('');
 if($('runSelect').innerHTML!==options)$('runSelect').innerHTML=options;$('runSelect').value=chosen;
 $('runReadOnly').hidden=!historical();$('backLive').textContent=historical()?'查看本局终局':'回到实时';
}
function renderFolds(pending){
 const context=chatKey();
 if(context!==foldContext){foldContext=context;for(const [id,defaultOpen]of [['connectionsPanel',true],['adminTasks',pending>0],['resolvedTasks',false],['transcriptPanel',false]])$(id).open=folds.get(context+':'+id)??defaultOpen}
 else if(pending&&!folds.has(context+':adminTasks'))$('adminTasks').open=true;
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
 $('title').textContent=match.title;$('subtitle').textContent=kinds[match.kind]+(match.kind==='groupchat'?' · 自由讨论 · 意愿决定发言':' · 真人与 AI 同席 · 规则引擎校验');
 $('status').textContent=historical()?'历史记录 · 只读':match.kind==='groupchat'?(g.status==='finished'?'聊天已结束':match.paused?'房主已暂停':match.started?'讨论中':'等待成员'):match.paused?'房主已暂停':g.status==='finished'?'已结束 · '+(g.winner||'平局'):match.started?'正在进行':'等待选手';
 renderNavigation();
 $('gameKind').textContent=match.kind.toUpperCase();
 $('protocolHint').textContent=match.kind==='groupchat'?'报分决定发言 · 表情随时互动 · 设定仅本人和房主可见':'规则引擎裁定合法性，管理员处理异常';$('transcriptHint').textContent=match.kind==='groupchat'?'公开聊天与表情 · 不包含成员私有设定':'公开信息流 · 私有夜间行动不在此显示';
 const frame=replay===null?match:match.history[replay],chessPhase=g.status==='finished'?'本局已结束':frame?.paused?'比赛已暂停':frame?.undoRequest?'等待'+seatTitle(frame.undoRequest.responder)+'确认悔棋':!(frame?.started??match.started)?'等待开局':(g.turn==='red'?'红方':'黑方')+'行棋';
 $('phase').textContent=match.kind==='groupchat'?'第 '+g.round+' 轮 · '+({bid:'征集意愿',speak:'成员发言',idle:'等待讨论',finished:'已结束'})[g.phase]:match.kind==='werewolf'?'第 '+g.round+' 轮 · '+({night:'夜间行动',wolf:'狼人行动',seer:'预言家行动',witch:'女巫行动',discuss:'白天讨论',vote:'放逐投票',finished:'已结束'})[g.phase]:chessPhase+' · 第 '+(g.ply||0)+' 手';
 $('live').textContent=historical()?'◷ ARCHIVE':replay===null?'● LIVE':'◷ REPLAY';
 const viewingHistory=historical()||replay!==null;
 $('exportButton').disabled=exporting;
 $('startButton').disabled=viewingHistory||!admin||match.started||finished||(match.kind==='groupchat'?match.participants.filter(p=>p.connected).length<2:match.participants.some(p=>!p.connected));
 $('pauseButton').disabled=viewingHistory||!admin||!match.started||finished;$('pauseButton').textContent=match.paused?'继续比赛':'暂停比赛';
 $('endButton').disabled=viewingHistory||!admin||finished;$('shareRoom').disabled=viewingHistory||!admin||finished;
 $('restartButton').disabled=viewingHistory||!admin||!match.started&&!finished;$('restartButton').textContent=match.kind==='groupchat'?'开启新话题':'重新开局';
 $('reveal').disabled=historical()||!!credential();$('replay').disabled=false;$('backLive').disabled=false;
 $('replay').max=Math.max(0,match.history.length-1);$('replay').value=replay===null?Math.max(0,match.history.length-1):replay;
 $('replayLabel').textContent=replay===null?(historical()?'第 '+match.runNumber+' 局终局 · ':'实时 · ')+match.history.length+' 条历史记录':'回放 '+(replay+1)+'/'+match.history.length+' · '+(match.history[replay]?.text||'');
 if(match.kind!=='groupchat'&&$('board').className==='chat-board'){$('board').className='';delete $('board').dataset.chatHtml}
 if(match.kind==='groupchat'){
  if(chessStage){chessStage.destroy();chessStage=null}if(ww.room){wwPlayer().reset();ww.room=null}
  renderChatStage(g);
 }else if(match.kind!=='werewolf'){
  if(ww.room){wwPlayer().reset();ww.room=null;ww.seen=null;ww.prevPhase=null;ww.poppedId=null}
  const context=chatKey()+':'+replay+':'+g.ply+':'+match.boardRevision+':'+(match.undoRequest?.id||'');
  if(context!==boardContext){selectedCell=null;boardContext=context}
  const interactive=!!playerData&&replay===null&&!historical(),canAct=interactive&&!!humanJob&&humanJob.kind!=='undo-response'&&!match.undoRequest&&!submitting&&!match.paused;
  const snapshot=replay===null?match:match.history[replay];
  const boardOptions={room:chatKey(),interactive,canAct,side:playerData?.seat,started:snapshot?.started??match.started,paused:snapshot?.paused??false,undoRequest:snapshot?.undoRequest||null,replay:viewingHistory,replayIndex:replay,events:replay===null?match.events:snapshot?.type==='emote'?[snapshot]:[],now:Date.now()+clockOffset};
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
  if(replay===null&&!historical()){
   if(ww.room!==chatKey()||!ww.seen){
    ww.room=chatKey();ww.seen=new Set(events.map(ArenaWerewolf.eventKey));ww.prevPhase=g.phase;ww.poppedId=null;wwPlayer().reset();
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
 $('chatAdminTools').hidden=match.kind!=='groupchat'||viewingHistory;if(match.kind==='groupchat'){$('chatAddAI').hidden=!admin;$('chatAddAI').disabled=finished||viewingHistory;$('chatJoin').hidden=!!credential();$('chatJoin').disabled=finished||viewingHistory||(!admin&&!stored('arenaJoin:'+current));$('chatRestart').hidden=!admin;$('chatRestart').disabled=finished||match.paused||!match.started||match.game.phase!=='idle'||match.participants.filter(p=>p.connected).length<2}
 const participants=match.kind==='groupchat'&&replay!==null?g.members:match.participants;
 $('count').textContent=participants.filter(p=>p.connected).length+(match.kind==='groupchat'?' 位成员':' / '+participants.length);
 $('players').innerHTML=participants.map(p=>{
  if(match.kind==='groupchat')return chatMemberCard(p,finished,g);
  const d=viewingHistory?null:match.connections?.find(c=>c.seat===p.seat),control=ArenaUI.wakeControl(d,wakeRequests.has(current+':'+p.seat));
  const frame=replay===null?match:match.history[replay],chess=['xiangqi','blind'].includes(match.kind),active=chess&&g.status!=='finished'&&(frame?.started??match.started)&&!frame?.paused&&!frame?.undoRequest&&g.turn===p.seat,confirming=chess&&frame?.undoRequest?.responder===p.seat;
  const tag=active?(replay!==null?'回放行棋方':playerData?.seat===p.seat?'轮到你':'正在行棋'):confirming?'等待确认悔棋':'';
  return '<div class="player'+(active?' chess-active':'')+(confirming?' chess-confirming':'')+'">'+(p.type==='human'?'<span class="provider-avatar human-avatar">真人</span>':ArenaUI.avatar(p.provider,avatarManifest))+'<div class="player-meta"><strong>'+esc(p.nickname||seatTitle(p.seat))+'</strong>'+(p.nickname?'<small>'+seatTitle(p.seat)+'</small>':'')+(tag?'<span class="seat-turn-tag">'+tag+'</span>':'')+'<small>'+esc(viewingHistory?'历史选手 · 只读记录':connectionText(p))+'</small>'+(d?.error?'<small>'+esc(d.error)+'</small>':'')+'</div>'+(viewingHistory?'':'<div class="participant-actions"><select class="participant-type" data-participant-type="'+p.seat+'" aria-label="'+seatTitle(p.seat)+'类型" '+(!admin||match.started||p.connected||finished?'disabled':'')+'><option value="ai" '+(p.type==='ai'?'selected':'')+'>AI</option><option value="human" '+(p.type==='human'?'selected':'')+'>真人</option></select>'+(control?'<button class="wake-button" data-wake-seat="'+p.seat+'" '+(control.disabled?'disabled':'')+' title="'+esc(control.reason)+'">'+esc(control.label)+'</button>':'')+'<button data-seat="'+p.seat+'" '+((p.connected||p.type==='ai')&&!admin||p.type==='human'&&!p.connected&&!!credential()||finished?'disabled':'')+'>'+(p.connected?'撤销':p.type==='human'?'加入'+(p.seat==='red'?'红方':p.seat==='black'?'黑方':p.seat.slice(1)+' 号席位'):'邀请 AI')+'</button></div>')+'</div>';
 }).join('');
 $('adminTasks').hidden=!match.admin||viewingHistory;const tasks=match.admin?.tasks||[],pending=tasks.filter(t=>t.status==='pending'),resolved=tasks.filter(t=>t.status!=='pending');
 const taskHtml=t=>'<div class="admin-task"><span>'+esc(t.details||t.message||'系统异常')+'<small>'+esc(({pending:'待处理',retried:'已允许重试',resolved:'已解决',closed:'已关闭'})[t.status])+(t.resolution?' · '+esc(t.resolution):'')+'</small></span>'+(t.canRetry&&!viewingHistory?'<button data-retry-task="'+esc(t.id)+'">允许一次重试</button>':'')+'</div>';
 $('taskList').innerHTML=pending.length?pending.map(taskHtml).join(''):'<p class="muted">暂无待处理异常</p>';
 $('taskCount').textContent=pending.length?'待处理 '+pending.length:'暂无待处理';$('resolvedTasks').hidden=!resolved.length;$('resolvedTaskSummary').textContent='已处理记录（'+resolved.length+'）';$('resolvedTaskList').innerHTML=resolved.slice().reverse().map(taskHtml).join('');renderFolds(pending.length);
 const events=replay===null?match.events:match.history.slice(0,replay+1);
 $('events').innerHTML=events.slice().reverse().map(e=>'<div class="event '+esc(e.type)+'"><time>'+new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false})+'</time><span>'+esc(e.text)+'</span></div>').join('');
 renderPlayerPanel();
}
function renderPlayerPanel(){
 const panel=$('playerControls');panel.hidden=!playerData||replay!==null||historical();
 if(panel.hidden){if(panel.dataset.chatDraftKey)rememberChatDraft();panel.innerHTML='';delete panel.dataset.chatDraftKey;delete panel.dataset.chatSharedKey;panelContext='';return}
 if(match.kind==='groupchat'){renderChatPanel();return}
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
function openChatProfile(target){
 if(match?.kind!=='groupchat')return;
 if(historical())throw Error('历史记录只读，请先回到当前话题');
 if(target!=='self')manage();
 chatProfileTarget=target;const profile=target==='self'?playerData?.privateView.self.savedProfile:match.admin?.profiles?.find(p=>p.seat===target)?.profile;
 $('chatProfileTitle').textContent=target==='add-ai'?'添加 AI 成员':target==='self'?'我的私有设定':seatTitle(target)+' · 私有设定';
 $('chatNicknameField').hidden=target!=='add-ai';$('chatNickname').value='';
 $('chatPersonality').value=profile?.personality||'';$('chatOpinion').value=profile?.initialOpinion||'';
 $('chatProfileDialog').showModal();
}
function chatMemberCard(p,finished,g){
 const live=replay===null&&!historical(),manager=admin&&live,d=live?match.connections?.find(c=>c.seat===p.seat):null,control=ArenaUI.wakeControl(d,wakeRequests.has(current+':'+p.seat));
 const speaker=!finished&&g.phase==='speak'&&g.speaker===p.seat,bidding=!finished&&g.phase==='bid'&&g.roster.includes(p.seat),waiting=bidding&&g.pendingSeats?.includes(p.seat);
 return '<div class="player'+(speaker||waiting?' chess-active':'')+'"><div>'+(p.type==='human'?'<span class="provider-avatar human-avatar">真人</span>':ArenaUI.avatar(p.provider,avatarManifest))+'</div><div class="player-meta"><strong>'+esc(p.nickname||seatTitle(p.seat))+'</strong>'+(speaker?'<span class="seat-turn-tag">等待发言</span>':waiting?'<span class="seat-turn-tag">等待提交意愿</span>':bidding?'<small>'+(g.pendingSeats?'已提交意愿':'本轮征集意愿')+'</small>':'')+'<small>'+esc(live?connectionText(p):'历史成员 · 只读回放')+'</small></div><div class="participant-actions">'+(manager?'<button data-profile-seat="'+p.seat+'" '+(finished?'disabled':'')+'>设定</button>':'')+(control?'<button data-wake-seat="'+p.seat+'" '+(control.disabled?'disabled':'')+'>'+esc(control.label)+'</button>':'')+(!p.connected&&manager?'<button data-seat="'+p.seat+'" '+(finished?'disabled':'')+'>邀请 AI</button>':'')+(manager?'<button data-seat="'+p.seat+'" data-remove-chat="1" '+(finished?'disabled':'')+'>移出</button>':'')+'</div></div>';
}
function renderChatStage(g){
 const frame=replay===null?match:match.history[replay],events=replay===null?match.events:match.history.slice(0,replay+1);
 const all=events.filter(e=>e.type==='chat-message').map(e=>e.message),cache=chatHistory.get(chatKey());
 let messages=all;
 if(replay===null){const recent=all.slice(-50),merged=new Map([...(cache?.messages||[]),...recent].map(m=>[m.seq,m]));messages=[...merged.values()].sort((a,b)=>a.seq-b.seq)}
 ArenaGroupchat.render($('board'),g,{context:chatKey()+':'+replay,messages,hasMore:replay===null&&messages.length>0&&messages[0].seq>1,started:frame?.started??match.started,paused:frame?.paused??match.paused,replay:replay!==null||historical(),allowHistory:replay===null,manifest:avatarManifest,prepending:!!cache?.prepending});
 if(cache)cache.prepending=false;
}
async function loadChatHistory(){
 if(match?.kind!=='groupchat'||replay!==null)return;
 const room=current,runId=match.runId,key=chatKey(),all=match.events.filter(e=>e.type==='chat-message').map(e=>e.message),cache=chatHistory.get(key)||{messages:[]},before=Math.min(...[...cache.messages,...all.slice(-50)].map(m=>m.seq));
 if(!Number.isFinite(before)||before<=1)return;
 const page=await api('/api/matches/'+encodeURIComponent(room)+'/messages?before='+before+'&limit=50&runId='+encodeURIComponent(runId));
 cache.messages=[...page.messages,...cache.messages];cache.prepending=true;chatHistory.set(key,cache);if(current===room&&match?.runId===runId)render();
}
function renderChatPanel(){
 const panel=$('playerControls'),view=playerData.privateView,draftKey=chatKey()+':'+(humanJob?.taskId||'waiting');
 const key=JSON.stringify([draftKey,humanJob?.attemptId,match.started,match.paused,match.game.status,view.phase,view.self?.score,view.members]);
 if(key===panelContext){updateClock();return}
 if(panel.dataset.chatDraftKey)rememberChatDraft();
 panel.innerHTML=ArenaGroupchat.actions(view,humanJob,playerData.interactions,{paused:match.paused,started:match.started,finished:match.game.status==='finished',now:Date.now()+clockOffset});
 panel.dataset.chatDraftKey=draftKey;panel.dataset.chatSharedKey=chatKey()+':shared';panelContext=key;
 const draft=chatDrafts.get(draftKey)||chatDrafts.get(chatKey()+':shared')||{};
 for(const [id,value]of Object.entries(draft)){const el=$(id);if(el&&panel.contains(el))el.value=value}
 updateClock();
}
function rememberChatDraft(){
 const panel=$('playerControls'),key=panel.dataset.chatDraftKey;if(!key)return;
 const draft={};for(const el of panel.querySelectorAll('input[id],textarea[id],select[id]'))draft[el.id]=el.value;
 chatDrafts.set(key,draft);chatDrafts.set(panel.dataset.chatSharedKey||chatKey()+':shared',{chatEmoteTarget:draft.chatEmoteTarget||''});
}
$('playerControls').oninput=()=>{if(match?.kind==='groupchat')rememberChatDraft()};
async function chatPlayerAction(event){
 const button=event.target.closest('[data-chat-profile],[data-chat-restart],[data-chat-abstain]');if(!button)return false;
 if(button.disabled||replay!==null||historical())return true;
 if(button.hasAttribute('data-chat-profile')){openChatProfile('self');return true}
 if(button.hasAttribute('data-chat-abstain')){await submitHuman({type:'bid',score:0});return true}
 if(button.hasAttribute('data-chat-restart')){await api('/api/player',{action:'chat-restart'},false,credential().token);await refresh();return true}
 return false;
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
