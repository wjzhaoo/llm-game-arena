/* Group chat presentation: only public messages and the authenticated member's own profile. */
(()=>{
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const label=p=>p?.nickname||p?.seat||'成员';
 const emoteText=e=>e?e.emoji+' '+e.label+(e.target?' → '+label(e.target):''):'';
 function message(m,manifest){
  return '<article class="chat-message '+(m.type==='emote'?'chat-reaction':'')+'">'+(m.sender?.type==='human'?'<span class="provider-avatar human-avatar">真人</span>':ArenaUI.avatar(m.sender?.provider,manifest))+'<div class="chat-message-body"><div class="chat-message-meta"><strong>'+esc(label(m.sender))+'</strong><time>'+esc(new Date(m.at).toLocaleTimeString('zh-CN',{hour12:false}))+'</time></div>'+(m.type==='emote'?'<p class="chat-emote-line">'+esc(emoteText(m.emote))+'</p>':'<div class="chat-bubble">'+esc(m.text)+'</div>'+(m.emote?'<span class="chat-attached-emote">'+esc(emoteText(m.emote))+'</span>':''))+'</div></article>';
 }
 function stage(g,{messages=[],hasMore=false,started=false,paused=false,replay=false,allowHistory=!replay,manifest={}}={}){
  const speaker=g.members.find(p=>p.seat===g.speaker),status=g.status==='finished'?'聊天已结束':!started?'等待至少两位成员接入':paused?'讨论已暂停':g.phase==='bid'?'征集发言意愿 · '+g.submitted+' / '+g.roster.length:g.phase==='speak'?'等待 '+label(speaker)+' 发言':g.idleReason==='members'?'等待成员加入':'全员弃权，等待主动发起下一轮';
  const selection=g.lastSelection;
  return '<div class="chat-topic"><span class="eyebrow">自由群聊'+(replay?' · 历史回放':'')+'</span><h2>'+esc(g.topic)+'</h2><p role="status">'+esc(status)+'</p></div>'+(selection?'<details class="chat-selection"><summary>第 '+selection.round+' 轮意愿分数 · '+(selection.speaker?'获选 '+esc(label(selection.scores.find(p=>p.seat===selection.speaker))):'全员弃权')+'</summary><div>'+selection.scores.map(p=>'<span class="chat-score '+(p.seat===selection.speaker?'chosen':'')+'">'+esc(label(p))+' <b>'+(p.score===null?'超时':p.score)+'</b></span>').join('')+'</div></details>':'')+'<div class="chat-messages" tabindex="0" aria-label="群聊消息">'+(hasMore&&allowHistory?'<button class="chat-load-history" data-chat-history>加载更早消息</button>':'')+(messages.length?messages.map(m=>message(m,manifest)).join(''):'<div class="chat-welcome">💬<h3>让不同的观点相遇</h3><p>成员报分表达意愿，由最高分成员发言。<br>表情随时可发，观点可以自然改变。</p></div>')+'</div>';
 }
 function render(root,g,options){
  const html=stage(g,options),sameContext=root.dataset.chatContext===options.context;if(sameContext&&root.className==='chat-board'&&root.dataset.chatHtml===html)return;
  const list=sameContext?root.querySelector('.chat-messages'):null,selection=sameContext?root.querySelector('.chat-selection'):null,selectionOpen=selection?.open||false,top=list?.scrollTop||0,height=list?.scrollHeight||0,atBottom=!list||height-top-list.clientHeight<48;
  root.className='chat-board';root.innerHTML=html;root.dataset.chatHtml=html;
  root.dataset.chatContext=options.context;const nextSelection=root.querySelector('.chat-selection');if(nextSelection)nextSelection.open=selectionOpen;
  const next=root.querySelector('.chat-messages');if(next)next.scrollTop=atBottom?next.scrollHeight:options.prepending?top+next.scrollHeight-height:top;
 }
 function actions(view,job,interactions,{paused=false,started=false,finished=false,now=Date.now()}={}){
  const disabled=paused||!started||finished,targets='<option value="">全群</option>'+view.members.filter(p=>p.connected).map(p=>'<option value="'+esc(p.seat)+'">'+esc(label(p))+'</option>').join('');
  let form='';
  if(job&&!disabled&&view.phase==='bid')form='<form id="actionForm" class="chat-action-form"><label>发言意愿（0 表示弃权）<input id="chatScore" type="number" min="0" max="100" step="1" value="50" required></label><button class="primary" type="submit">提交意愿</button><button type="button" data-chat-abstain>本轮弃权</button></form>';
  if(job&&!disabled&&view.phase==='speak')form='<form id="actionForm" class="chat-action-form"><label class="chat-compose">轮到你发言<textarea id="speechText" required placeholder="说说你的想法…"></textarea></label><label>附带表情<select id="chatSpeechEmote"><option value="">不附带</option>'+interactions.emotes.map(e=>'<option value="'+esc(e.id)+'">'+esc(e.emoji+' '+e.label)+'</option>').join('')+'</select></label><button class="primary" type="submit">发送消息</button></form>';
  if(!job&&!disabled)form='<p class="muted">'+(view.phase==='idle'?'讨论正在等待。你可以主动发起下一轮。':view.self?.score!==null&&view.phase==='bid'?'意愿已提交，等待本轮结算':'等待其他成员行动')+'</p>';
  return '<div class="turn-clock" id="turnClock"></div><div class="chat-member-tools"><strong>'+esc(label(view.members.find(p=>p.seat===view.self?.id)))+'</strong><button data-chat-profile '+(finished?'disabled':'')+'>我的私有设定</button>'+(view.phase==='idle'?'<button data-chat-restart '+(disabled||view.members.filter(p=>p.connected).length<2?'disabled':'')+'>发起下一轮</button>':'')+'</div>'+form+'<div class="chat-emote-tools"><label>表情对象<select id="chatEmoteTarget" '+(disabled?'disabled':'')+'>'+targets+'</select></label><div class="emote-picker" aria-label="群聊表情">'+interactions.emotes.map(e=>'<button type="button" data-emote="'+esc(e.id)+'" '+(disabled||interactions.emoteAvailableAt>now?'disabled':'')+' title="'+esc(e.label)+'"><span>'+e.emoji+'</span><small>'+esc(e.label)+'</small></button>').join('')+'</div></div>';
 }
 globalThis.ArenaGroupchat={stage,render,actions,message,label};
})();
