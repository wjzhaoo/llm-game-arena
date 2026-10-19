/* Tabletop presentation and human forms. All secrets come from server projections. */
(()=>{
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const kinds=['undercover','liarsdice','codenames','spyfall'];
 const names={undercover:'谁是卧底',liarsdice:'骗子骰子',codenames:'行动代号',spyfall:'谍报危机'};
 const teams={red:'红队',blue:'蓝队',neutral:'路人',assassin:'刺客'};
 const role=player=>player.role==='spymaster'?'队长':player.role==='operative'?'猜词者':player.role==='undercover'?'卧底':player.role==='civilian'?'平民':player.spy===true?'间谍':player.spy===false?'普通玩家':null;
 const label=(id,people=[])=>people.find(p=>p.seat===id)?.nickname||id?.replace(/^p(\d+)$/,'$1 号')||'—';
 const die=value=>'<span class="party-die '+(value?'face-'+value:'dice-covered')+'" role="img" aria-label="'+(value?value+' 点':'未开骰')+'">'+(value?Array.from({length:9},(_,i)=>'<i class="pip pip-'+(i+1)+'"></i>').join(''):'<span>?</span>')+'</span>';
 const strip=values=>'<span class="dice-strip">'+values.map(die).join('')+'</span>';
 const textLog=(g,people=[])=>'<div class="party-log" aria-label="最近游戏动态">'+(g.log.length?g.log.slice(-5).map(e=>'<p>'+(e.seat&&globalThis.ArenaPresentation?ArenaPresentation.avatar(e.author||{seat:e.seat},{size:'tiny'}):'')+'<small>第 '+e.round+' 轮</small>'+esc((()=>{const at=e.text.indexOf('：'),head=at<0?e.text:e.text.slice(0,at),tail=at<0?'':e.text.slice(at);return head.replace(/\bp\d+\b/g,id=>label(id,people))+tail})())+'</p>').join(''):'<p class="muted">桌面已经备好，秘密即将发出。</p>')+'</div>';
 const face=(p,people)=>(globalThis.ArenaPresentation?.avatar(people.find(x=>x.seat===p.id)||{seat:p.id})||'<span class="seat-medallion">'+esc(p.id.replace('p',''))+'</span>')+'<strong>'+esc(label(p.id,people))+'</strong>';
 function phase(g,started=true){
  if(!started)return '等待全员入座';if(g.status==='finished')return '本局已结束';
  return {describe:'轮流描述',vote:'秘密投票',bid:'叫点 / 质疑',clue:'队长给出提示',guess:'队员猜词',question:'提出问题',answer:'回答问题'}[g.phase]||g.phase;
 }
 function result(g,people){
  if(g.status!=='finished')return '';
  const winners={civilians:'平民阵营获胜',undercover:'卧底阵营获胜',red:'红队获胜',blue:'蓝队获胜',spy:'间谍获胜',agents:'普通玩家获胜'};
  return '<div class="party-result" role="status"><span>对局结算</span><strong>'+esc(g.winner?(winners[g.winner]||label(g.winner,people)+' 获胜'):'本局结束 · 未分胜负')+'</strong></div>';
 }
 function players(g,people,render){return '<div class="party-seats">'+g.players.map(p=>'<article class="party-seat '+(p.alive===false?'eliminated ':'')+(g.pendingSeats?.includes(p.id)?'pending':'')+'">'+face(p,people)+render(p)+(p.alive===false?'<small>已出局</small>':'')+'</article>').join('')+'</div>'}
 function undercover(g,people){
  return '<div class="party-callout"><span class="table-label">词语迷局</span><h2>说得足够像，藏得足够深。</h2><p>'+esc(g.phase==='describe'?'等待 '+label(g.speaker,people)+' 描述自己的词':g.phase==='vote'?'选票封存中 · 已提交 '+g.submitted+' / '+g.players.filter(p=>p.alive).length:'词语与身份已揭晓')+'</p></div>'+players(g,people,p=>'<div class="secret-card '+(p.role==='undercover'?'spy-card':'')+'"><span>'+esc(role(p)||'秘密词语')+'</span><b>'+esc(p.word||'密')+'</b><small>'+esc(p.word?'已揭晓':'身份尚未公开')+'</small></div>')+textLog(g,people);
 }
 function liarsdice(g,people){
  const bid=g.bid;
  return '<div class="dice-pot"><span class="table-label">全桌 '+g.totalDice+' 枚骰子 · 1 点万能</span><div class="current-bid">'+(bid?'<span>上一口 · '+esc(label(bid.seat,people))+'</span><strong>'+bid.quantity+' <small>个</small> '+die(bid.face)+'</strong>':'<span>新一轮，重新掷骰</span><strong>谁先开口？</strong>')+'</div><p>等待 '+esc(label(g.turn,people))+' '+(bid?'提高叫点或开骰质疑':'叫出第一口')+'</p></div>'+players(g,people,p=>strip(p.dice||Array(p.count).fill(null)))+(g.lastRound?'<details class="last-reveal"><summary>上一轮开骰 · '+esc(label(g.lastRound.loser,people))+' 失去一骰 · 共 '+g.lastRound.actual+' 个 '+g.lastRound.bid.face+' 点</summary>'+g.lastRound.dice.filter(p=>p.dice.length).map(p=>'<div><span>'+esc(label(p.id,people))+'</span>'+strip(p.dice)+'</div>').join('')+'</details>':'')+textLog(g,people);
 }
 function codenames(g,people,options){
  const interactive=options.canAct&&g.self?.role==='operative'&&g.phase==='guess';
  return '<div class="code-score"><div class="team-score red"><span>红队特工</span><b>'+g.remaining.red+'</b><small>尚未联络</small></div><div class="code-clue"><span>'+esc(g.phase==='clue'?'等待'+teams[g.team]+'队长提示':'当前线索')+'</span><strong>'+esc(g.clue?.word||'等待密语')+(g.clue?' <b>'+g.clue.count+'</b>':'')+'</strong><small>'+esc(g.phase==='guess'?'还可猜 '+g.remainingGuesses+' 次':'一词一数，连接彼此的思路')+'</small></div><div class="team-score blue"><span>蓝队特工</span><b>'+g.remaining.blue+'</b><small>尚未联络</small></div></div><div class="code-grid" aria-label="25 张代号词牌">'+g.cards.map(c=>'<button class="code-card '+(c.team||'unknown')+(c.revealed?' is-revealed':'')+'" data-code-index="'+c.index+'" '+(!interactive||c.revealed?'disabled ':'')+'aria-label="'+esc(c.word+'，'+(c.revealed?'已翻开，':c.team?'身份可见，':'未翻开，')+(teams[c.team]||'身份未知'))+'"><span class="card-number">'+String(c.index+1).padStart(2,'0')+'</span><strong>'+esc(c.word)+'</strong><small>'+esc(c.revealed?'已联络 · '+teams[c.team]:c.team?teams[c.team]:'待解密')+'</small></button>').join('')+'</div><p class="party-hint">'+(g.self?.role==='spymaster'?'你是队长，身份颜色仅你和另一位队长可见。':interactive?'点击词牌提交选择，也可使用下方表单。':'找到己方全部特工，避开刺客。')+'</p>'+textLog(g,people);
 }
 function spyfall(g,people){
  const question=g.question;
  return '<div class="spy-dossier"><div class="dossier-stamp">机密档案</div><span class="table-label">地点编号 · 严格保密</span><h2>'+esc(g.location||'我们在哪里？')+'</h2><p>'+esc(g.phase==='answer'?label(question?.seat,people)+' 问 '+label(question?.target,people)+'：'+question?.text:g.phase==='vote'?'问答结束，请秘密指认间谍。':'留心每一句回答，也留心每一次回避。')+'</p><div class="mission-progress"><span style="width:'+Math.min(100,g.questions/g.maxQuestions*100)+'%"></span></div><small>已完成 '+g.questions+' / '+g.maxQuestions+' 次问答</small></div>'+players(g,people,p=>'<span class="identity-tag '+(p.spy?'spy-tag':'')+'">'+esc(role(p)||'身份保密')+'</span><small>'+esc(p.occupation||'')+'</small>')+'<details class="location-list"><summary>查看 '+g.locations.length+' 个候选地点</summary><div>'+g.locations.map(place=>'<span>'+esc(place)+'</span>').join('')+'</div></details>'+textLog(g,people);
 }
 function stage(g,people=[],options={}){
  const render={undercover,liarsdice,codenames,spyfall}[g.game];if(!render)return '';
  return '<div class="party-scene '+g.game+'"><div class="party-heading"><img src="/assets/games/'+g.game+'.svg" alt="" width="52" height="52"><div><span class="table-label">'+esc(g.rules?.tagline||'真人与 AI 同席')+'</span><h2>'+names[g.game]+'</h2></div><span class="party-phase">'+esc(phase(g,options.started))+'</span></div>'+result(g,people)+render(g,people,options)+(g.ballots?'<details class="omniscient-ballots"><summary>全知 · 当前秘密选票</summary><p>'+esc(Object.entries(g.ballots).map(([id,to])=>label(id,people)+' → '+(to?label(to,people):'弃权')).join('；')||'暂无选票')+'</p></details>':'')+'</div>';
 }
 const select=(id,choices,placeholder='请选择')=>'<select id="'+id+'" required><option value="">'+placeholder+'</option>'+choices.map(([value,name])=>'<option value="'+esc(value)+'">'+esc(name)+'</option>').join('')+'</select>';
 const speech=(id='partyText',max=300,placeholder='写下你的发言…')=>'<label>公开发言<textarea id="'+id+'" maxlength="'+max+'" required placeholder="'+placeholder+'"></textarea></label>';
 function actions(g,job,people=[],options={}){
  const self=g.self;if(!self)return '';
  let privateHtml='<div class="private-heading"><span>仅你可见</span><strong>我的秘密</strong></div>';
  if(g.game==='undercover')privateHtml+='<div class="private-word">'+esc(self.word)+'</div><p class="muted">你不知道自己的阵营。描述时不要直接说出这个词。</p>';
  if(g.game==='liarsdice')privateHtml+=strip(self.dice)+'<p class="muted">当前手牌仅你可见；每次开骰结算后会重新掷骰。</p>';
  if(g.game==='codenames')privateHtml+='<h3>'+teams[self.team]+' · '+role(self)+'</h3><p class="muted">'+(self.role==='spymaster'?'桌面显示完整身份分布，请用词义提示，勿泄露身份钥匙。':'根据队长提示选择词牌，避开刺客。')+'</p>';
  if(g.game==='spyfall')privateHtml+='<div class="private-word">'+esc(self.spy?'你是间谍':self.location)+'</div><p>'+esc(self.spy?'你不知道地点。试着套出信息，也可以在自己的行动中猜地点。':'你的职业：'+self.occupation+'。回答要可信，也要避免泄露地点。')+'</p>';
  if(!options.started||options.paused||g.status==='finished'||!job||self.alive===false)return privateHtml+'<p class="muted">'+(g.status==='finished'?'本局已结束':options.paused?'计时已暂停':!options.started?'等待房主开始比赛':self.alive===false?'你已出局，可继续观战':'等待其他选手行动')+'</p>';
  const targets=g.players.filter(p=>p.id!==self.id&&p.alive!==false).map(p=>[p.id,label(p.id,people)]);let form='';
  if(g.game==='undercover')form=g.phase==='describe'?speech(): '<label>投给谁'+select('partyTarget',[["abstain","弃权"],...targets])+'</label>';
  if(g.game==='liarsdice')form='<div class="dice-bid-form"><label>数量<input id="diceQuantity" type="number" min="1" max="'+g.totalDice+'" value="'+Math.min(g.totalDice,(g.bid?.quantity||0)+1)+'" required></label><label>点数<select id="diceFace">'+[2,3,4,5,6,1].map(n=>'<option value="'+n+'">'+n+' 点'+(n===1?'（万能）':'')+'</option>').join('')+'</select></label></div><label>喊话（可选）<input id="diceText" maxlength="120" placeholder="这一口，你信吗？"></label>';
  if(g.game==='codenames')form=g.phase==='clue'?'<div class="dice-bid-form"><label>一个提示词<input id="clueWord" maxlength="12" required autocomplete="off" placeholder="例如：星空"></label><label>关联数量<input id="clueCount" type="number" min="1" max="9" value="2" required></label></div>':'<label>选择词牌'+select('codeIndex',g.cards.filter(c=>!c.revealed).map(c=>[c.index,c.word]))+'</label>';
  if(g.game==='spyfall')form=g.phase==='question'?'<label>向谁提问'+select('partyTarget',targets)+'</label>'+speech():g.phase==='answer'?speech(): '<label>指认间谍'+select('partyTarget',[["abstain","弃权"],...targets])+'</label>';
  const buttonText=g.game==='liarsdice'?'提高叫点':g.game==='codenames'?(g.phase==='clue'?'发送提示':'确认翻牌'):g.phase==='vote'?'秘密提交选票':'提交发言';
  return privateHtml+'<form id="partyActionForm">'+form+'<div class="actions"><button type="submit" class="primary">'+buttonText+'</button>'+(g.game==='liarsdice'&&g.bid?'<button type="button" data-party-command="challenge">开骰 · 我不信</button>':'')+(g.game==='codenames'&&g.phase==='guess'&&g.guessesMade>0?'<button type="button" data-party-command="pass">结束本轮</button>':'')+'</div></form>'+(g.game==='spyfall'&&self.spy?'<details class="spy-last-chance"><summary>间谍摊牌 · 猜地点</summary><p>猜对立即获胜，猜错立即失败。</p>'+select('spyLocation',g.locations.map(v=>[v,v]))+'<button type="button" data-party-command="guess-location">确认猜地点</button></details>':'');
 }
 function readAction(g,element){
  const value=id=>element(id)?.value;
  if(g.game==='undercover')return g.phase==='describe'?{type:'describe',text:value('partyText')}:{type:'vote',target:value('partyTarget')==='abstain'?null:value('partyTarget')};
  if(g.game==='liarsdice')return {type:'bid',quantity:Number(value('diceQuantity')),face:Number(value('diceFace')),...(value('diceText')?.trim()?{text:value('diceText')}: {})};
  if(g.game==='codenames')return g.phase==='clue'?{type:'clue',word:value('clueWord'),count:Number(value('clueCount'))}:{type:'guess',index:Number(value('codeIndex'))};
  if(g.phase==='question')return {type:'question',target:value('partyTarget'),text:value('partyText')};
  if(g.phase==='answer')return {type:'answer',text:value('partyText')};
  return {type:'vote',target:value('partyTarget')==='abstain'?null:value('partyTarget')};
 }
 function rulebook(rules,kind){
  return (kind&&globalThis.ArenaPresentation?ArenaPresentation.scene(kind,{compact:true}):'')+'<div class="rulebook-intro"><span class="table-label">游戏手册</span><h2>'+esc(rules.name)+'</h2><p>'+esc(rules.tagline)+'</p></div>'+rules.sections.map(([title,body],i)=>'<section class="rule-section"><span>'+String(i+1).padStart(2,'0')+'</span><div><h3>'+esc(title)+'</h3><p>'+esc(body)+'</p></div></section>').join('')+'<section class="rule-section"><span>表情</span><div><h3>脸上有戏，真假自辨</h3><p>每次行动可选择一种固定表情，持续到下一次公开行动。表情由玩家主动选择，可以伪装；请结合言行和局面判断。夜间表情仅本人及房主可见，秘密投票与报分的表情在结算时一起公布。</p></div></section>'+(rules.source?'<p class="rules-source"><a href="'+esc(rules.source)+'" target="_blank" rel="noopener noreferrer">查看原版玩法来源 ↗</a> · 本页说明本竞技场实际采用的规则</p>':'');
 }
 globalThis.ArenaParty={isParty:kind=>kinds.includes(kind),stage,actions,readAction,rulebook,phase,die,label};
})();
