/* Pure presentation helpers. All actions are submitted by the authenticated controller. */
(()=>{
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={rK:'帥',rA:'仕',rE:'相',rH:'馬',rR:'車',rC:'炮',rP:'兵',bK:'將',bA:'士',bE:'象',bH:'馬',bR:'車',bC:'砲',bP:'卒'};
 const blindNames={red:{K:'帥',R:'車',H:'馬',E:'相',A:'仕',C:'炮',P:'兵'},black:{K:'將',R:'車',H:'馬',E:'象',A:'士',C:'砲',P:'卒'}};
 const roleNames={wolf:'狼人',seer:'预言家',witch:'女巫',villager:'村民'};
 const cell=v=>Array.isArray(v)&&v.length===2&&Number.isInteger(v[0])&&Number.isInteger(v[1])&&v[0]>=0&&v[0]<9&&v[1]>=0&&v[1]<10;
 const same=(a,b)=>cell(a)&&cell(b)&&a[0]===b[0]&&a[1]===b[1];
 const position=([x,y],flipped=false)=>{if(flipped){x=8-x;y=9-y}return 'left:'+(5+x*11.25)+'%;top:'+(5+y*10)+'%'};
 function avatar(provider,manifest={}){
  const normalized=typeof provider==='string'?provider.toLowerCase().trim():'',key=Object.hasOwn(manifest.aliases||{},normalized)?manifest.aliases[normalized]:normalized;
  const info=Object.hasOwn(manifest.providers||{},key)?manifest.providers[key]:manifest.providers?.default;
  const safeSource=info&&typeof info.src==='string'&&/^\/assets\/avatars\/[a-z0-9-]+\.(?:svg|png)$/.test(info.src)?info.src:null;
  const label=info?.label||'未知平台',fallback=info?.initials||String(info?.label||'AI').slice(0,2).toUpperCase();
  return '<span class="provider-avatar" title="'+esc(label)+(info?.kind?.includes('fallback')?' · 文字占位标识':'')+'"><span class="avatar-fallback" aria-hidden="'+(safeSource?'true':'false')+'">'+esc(fallback)+'</span>'+(safeSource?'<img class="avatar-image" src="'+esc(safeSource)+'" alt="'+esc(label)+(info.kind?.includes('fallback')?'文字标识':'图标')+'" width="32" height="32" loading="lazy">':'')+'</span>';
 }
 function pieceButton({red,glyph,xy,active,flipped,covered=false,coverGlyph='',label}){
  return '<button type="button" class="piece '+(red?'red':'black')+(covered?' covered':'')+(active?' selected':'')+'" style="'+position(xy,flipped)+'" data-cell="'+xy.join(',')+'" aria-pressed="'+active+'" aria-label="'+esc(label)+'"><i class="piece-ring" aria-hidden="true"></i><span class="piece-glyph">'+glyph+'</span>'+(covered?'<span class="piece-cover" aria-hidden="true">'+coverGlyph+'</span>':'')+'</button>';
 }
 function chess(view,selected,options={}){
  const blind=view.game==='blind',flipped=options.side==='black',selection=cell(selected)?selected:null;
  const legal=(view.legalMoves||[]).filter(m=>cell(m.from)&&cell(m.to)&&same(m.from,selection));
  let pieces='',targets='',last='';
  for(let y=0;y<10;y++)for(let x=0;x<9;x++){
   const p=view.board?.[y]?.[x];if(!p)continue;
   const active=same(selection,[x,y]),xy=[x,y];
   if(typeof p==='string'){
    if(!Object.hasOwn(names,p))continue;
    const red=p[0]==='r';pieces+=pieceButton({red,glyph:names[p],xy,active,flipped,label:(red?'红方':'黑方')+' '+names[p]+'，坐标 '+xy+'，查看合法着法'});
   }else{
    const red=p.side==='red',glyph=blindNames[p.side]?.[p.kind]||'?';
    pieces+=pieceButton({red,glyph:p.hidden?'暗':glyph,xy,active,flipped,covered:!!p.hidden,coverGlyph:glyph,label:(red?'红方':'黑方')+(p.hidden?'暗棋，按'+glyph+'走法，走第一步后揭开':' '+glyph)+'，坐标 '+xy});
   }
  }
  for(const move of legal){
   const capture=!!view.board?.[move.to[1]]?.[move.to[0]];
   targets+='<button type="button" class="move-target '+(capture?'capture-target':'legal-target')+'" style="'+position(move.to,flipped)+'" data-target="'+move.to.join(',')+'" '+(options.interactive&&!options.canAct?'disabled ':'')+'aria-label="'+(capture?'可吃子':'可落子')+'位置 '+move.to.join(',')+'，'+(options.interactive?'提交棋步':'仅预览不执行')+'"><span aria-hidden="true">'+(capture?'×':'●')+'</span></button>';
  }
  if(view.lastMove)for(const [i,c] of [view.lastMove.from,view.lastMove.to].entries())if(cell(c))last+='<span class="last-move '+(i?'last-to':'last-from')+'" style="'+position(c,flipped)+'" aria-hidden="true"></span>';
  let extras='';
  if(blind){
   if(view.lastMove&&(view.lastMove.wasHidden||view.lastMove.captureWasHidden)&&view.lastMove.text)extras+='<p class="reveal-banner" role="status">⚡ 上一手揭晓 · '+esc(view.lastMove.text)+'</p>';
   const tray=side=>{const list=view.captured?.[side]||[];return '<div class="captured-side"><span class="captured-title">'+(side==='red'?'红方':'黑方')+'缴获 <b>'+list.length+'</b></span><div class="captured-chips">'+(list.length?list.map(p=>'<i class="captured-chip '+p.side+'" title="'+(p.side==='red'?'红':'黑')+(blindNames[p.side]?.[p.kind]||'')+'">'+(blindNames[p.side]?.[p.kind]||'?')+'</i>').join(''):'<small>尚未吃子</small>')+'</div></div>'};
   extras+='<div class="captured-tray">'+tray('red')+tray('black')+'</div>';
  }
  const legend='<div class="board-legend"><span><i class="legend-red">红</i> 红方 · 朱红双圈</span><span><i class="legend-black">黑</i> 黑方 · 深墨实面</span>'+(blind?'<span><i class="legend-covered">暗</i> 暗棋 · 走动后揭开</span>':'')+'</div>';
  let instruction=selection?'已选 '+selection.join(',')+' · '+legal.length+' 个合法目标；● 可落子，× 可吃子':'点击棋子查看合法着法';
  instruction+=options.interactive?(options.canAct?' · 点击合法目标落子':' · 等待开局或对方行棋'):' · 仅观战，不提交棋步';
  if(blind)instruction+=' · 暗棋走一步后揭开，异色归对方';
  if(view.check)instruction+=' · 当前行棋方被将军';
  return legend+'<div class="chess'+(blind?' blind':'')+'" role="group" aria-label="'+(blind?'覆棋盲棋棋盘，':'中国象棋棋盘，')+(options.interactive?'真人对局，':'只读观战，可选择棋子预览合法着法，')+(flipped?'黑方朝下':'红方朝下')+'"><div class="chess-grid"></div><div class="palace top"></div><div class="palace bottom"></div><div class="river"><span>楚 河</span><span>漢 界</span></div>'+last+pieces+targets+'</div><p class="board-instruction" id="boardInstruction" role="status">'+instruction+'</p>'+extras+'<div class="move-legend"><span>双框：选中</span><span>● 合法落点</span><span>× 可吃子</span><span>虚线框：上一步</span>'+(blind?'<span>暗：未揭开</span>':'')+'</div>';
 }
 function werewolfActions(view,job){
  const self=view.self;if(!self)return '';
  const prefix='<h3>你的身份：'+esc(roleNames[self.role]||self.role)+' <small>仅你可见</small></h3>';
  const findings=(self.findings||[]).map(f=>'<li>第 '+f.round+' 夜：'+esc(f.target)+' '+(f.wolf?'是狼人':'不是狼人')+'</li>').join('');
  const facts=(self.teammates?'<p>狼队友：'+esc(self.teammates.join('、'))+'</p>':'')+(findings?'<ul>'+findings+'</ul>':'');
  if(!job)return prefix+facts+'<p class="muted">'+(self.alive?'等待你的行动阶段':'你已出局，可以继续观战')+'</p>';
  const players=view.players.filter(p=>p.alive&&(view.phase!=='seer'||p.id!==self.id)&&(view.phase!=='wolf'||p.id!==self.id&&!self.teammates?.includes(p.id)));
  const targets='<label>目标<select id="actionTarget"><option value="">弃权 / 不选择</option>'+players.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.id)+' 号玩家</option>').join('')+'</select></label>';
  let controls;
  if(view.phase==='discuss')controls='<label>公开发言<textarea id="speechText" maxlength="600" placeholder="输入发言，最多 600 字符"></textarea></label>';
  else if(view.phase==='witch'){
   const save=self.potions?.save&&self.nightVictim;
   controls='<p>今晚刀口：'+esc(self.nightVictim||'当前不可见')+' · 解药'+(self.potions?.save?'可用':'已用')+' · 毒药'+(self.potions?.poison?'可用':'已用')+'</p><fieldset><legend>本夜最多使用一种药</legend><label><input type="radio" name="witchChoice" value="skip" checked>不用药</label><label><input type="radio" name="witchChoice" value="save" '+(!save?'disabled':'')+'>使用解药</label><label><input type="radio" name="witchChoice" value="poison" '+(!self.potions?.poison?'disabled':'')+'>使用毒药</label></fieldset>'+targets;
  }else controls=targets;
  return prefix+facts+'<form id="actionForm">'+controls+'<button class="primary" type="submit">提交行动</button></form>';
 }
 function wakeControl(connection,busy=false){
  if(connection?.mode!=='wake'||!connection.verified)return null;
  const disabled=busy||connection.checking||!connection.canWake;
  const label=busy||connection.checking?'核验/投递中…':connection.status==='sent'?'已送达 · 待领取':connection.status==='uncertain'?'核验送达':connection.status==='claimed'?'已领取':connection.status==='sending'?'投递中…':'唤醒';
  return {disabled,label,reason:connection.blockedReason||'向已绑定原会话发送待领取任务通知；送达不代表已响应'};
 }
 globalThis.ArenaUI={avatar,chess,werewolfActions,wakeControl,cell,roleNames};
})();
