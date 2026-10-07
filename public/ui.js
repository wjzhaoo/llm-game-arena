/* Pure presentation helpers. Never submit moves or read private game state. */
(()=>{
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={rK:'帥',rA:'仕',rE:'相',rH:'馬',rR:'車',rC:'炮',rP:'兵',bK:'將',bA:'士',bE:'象',bH:'馬',bR:'車',bC:'砲',bP:'卒'};
 const blindNames={red:{K:'帥',R:'車',H:'馬',E:'相',A:'仕',C:'炮',P:'兵'},black:{K:'將',R:'車',H:'馬',E:'象',A:'士',C:'砲',P:'卒'}};
 const cell=value=>Array.isArray(value)&&value.length===2&&Number.isInteger(value[0])&&Number.isInteger(value[1])&&value[0]>=0&&value[0]<9&&value[1]>=0&&value[1]<10;
 const same=(a,b)=>cell(a)&&cell(b)&&a[0]===b[0]&&a[1]===b[1];
 const position=([x,y])=>`left:${5+x*11.25}%;top:${5+y*10}%`;
 function avatar(provider,manifest={}){
  const normalized=typeof provider==='string'?provider.toLowerCase().trim():'',key=Object.hasOwn(manifest.aliases||{},normalized)?manifest.aliases[normalized]:normalized;
  const info=Object.hasOwn(manifest.providers||{},key)?manifest.providers[key]:manifest.providers?.default;
  const safeSource=info&&typeof info.src==='string'&&/^\/assets\/avatars\/[a-z0-9-]+\.svg$/.test(info.src)?info.src:null;
  const label=info?.label||'未知平台',fallback=info?.initials||String(info?.label||'AI').slice(0,2).toUpperCase();
  return `<span class="provider-avatar" title="${esc(label)}${info?.kind?.includes('fallback')?' · 文字占位标识':''}"><span class="avatar-fallback" aria-hidden="${safeSource?'true':'false'}">${esc(fallback)}</span>${safeSource?`<img class="avatar-image" src="${esc(safeSource)}" alt="${esc(label)}${info.kind?.includes('fallback')?'文字标识':'图标'}" width="32" height="32" loading="lazy">`:''}</span>`;
 }
 function pieceButton({red,glyph,xy,active,covered=false,coverGlyph='',label}){
  const [x,y]=xy;
  return `<button type="button" class="piece ${red?'red':'black'}${covered?' covered':''}${active?' selected':''}" style="${position(xy)}" data-cell="${x},${y}" aria-pressed="${active}" aria-label="${esc(label)}"><i class="piece-ring" aria-hidden="true"></i><span class="piece-glyph">${glyph}</span>${covered?`<span class="piece-cover" aria-hidden="true">${coverGlyph}</span>`:''}<span class="piece-side" aria-hidden="true">${red?'红':'黑'}</span></button>`;
 }
 function chess(view,selected){
  const blind=view.game==='blind';
  const selection=cell(selected)?selected:null,legal=(view.legalMoves||[]).filter(m=>cell(m.from)&&cell(m.to)&&same(m.from,selection));let pieces='',targets='',last='';
  for(let y=0;y<10;y++)for(let x=0;x<9;x++){
   const p=view.board?.[y]?.[x];if(!p)continue;const active=same(selection,[x,y]);
   if(typeof p==='string'){
    if(!Object.hasOwn(names,p))continue;const red=p[0]==='r';
    pieces+=pieceButton({red,glyph:names[p],xy:[x,y],active,label:`${red?'红方':'黑方'} ${names[p]}，坐标 ${x},${y}，查看合法着法`});
   }else{
    const red=p.side==='red';
    if(p.hidden)pieces+=pieceButton({red,glyph:'暗',coverGlyph:blindNames[p.side]?.[p.kind]||'?',xy:[x,y],active,covered:true,label:`${red?'红方':'黑方'}暗棋，按${blindNames[p.side]?.[p.kind]||'棋子'}走法，坐标 ${x},${y}，走第一步后揭开`});
    else pieces+=pieceButton({red,glyph:blindNames[p.side]?.[p.kind]||'?',xy:[x,y],active,label:`${red?'红方':'黑方'} ${blindNames[p.side]?.[p.kind]||''}，坐标 ${x},${y}，查看合法着法`});
   }
  }
  for(const move of legal){const capture=!!view.board?.[move.to[1]]?.[move.to[0]];targets+=`<button type="button" class="move-target ${capture?'capture-target':'legal-target'}" style="${position(move.to)}" data-target="${move.to.join(',')}" aria-label="${capture?'可吃子':'可落子'}位置 ${move.to.join(',')}，仅预览不执行"><span aria-hidden="true">${capture?'×':'●'}</span></button>`}
  if(view.lastMove)for(const [i,c] of [view.lastMove.from,view.lastMove.to].entries())if(cell(c))last+=`<span class="last-move ${i?'last-to':'last-from'}" style="${position(c)}" aria-hidden="true"></span>`;
  let extras='';
  if(blind){
   if(view.lastMove&&(view.lastMove.wasHidden||view.lastMove.captureWasHidden)&&view.lastMove.text)extras+=`<p class="reveal-banner" role="status">⚡ 上一手揭晓 · ${esc(view.lastMove.text)}</p>`;
   const tray=side=>{const list=view.captured?.[side]||[];return `<div class="captured-side"><span class="captured-title">${side==='red'?'红方':'黑方'}缴获 <b>${list.length}</b></span><div class="captured-chips">${list.length?list.map(p=>`<i class="captured-chip ${p.side}" title="${p.side==='red'?'红':'黑'}${blindNames[p.side]?.[p.kind]||''}">${blindNames[p.side]?.[p.kind]||'?'}</i>`).join(''):'<small>尚未吃子</small>'}</div></div>`};
   extras+=`<div class="captured-tray">${tray('red')}${tray('black')}</div>`;
  }
  const legend=blind
   ?`<div class="board-legend"><span><i class="legend-red">红</i> 红方 · 朱红双圈</span><span><i class="legend-black">黑</i> 黑方 · 深墨实面</span><span><i class="legend-covered">暗</i> 暗棋 · 走动后揭开</span></div>`
   :`<div class="board-legend"><span><i class="legend-red">红</i> 红方 · 朱红双圈</span><span><i class="legend-black">黑</i> 黑方 · 深墨实面</span></div>`;
  const instruction=blind
   ?`${selection?`已选 ${selection.join(',')} · ${legal.length} 个合法目标；● 可落子，× 可吃子（仅预览，不提交棋步）`:'点击棋子查看合法着法 · 暗棋走一步后揭开，异色归对方 · 仅观战，不提交棋步'}`
   :`${selection?`已选 ${selection.join(',')} · ${legal.length} 个合法目标；● 可落子，× 可吃子（仅预览，不提交棋步）`:'点击棋子查看合法着法 · 当前仅观战，不提交棋步'}${view.check?' · 当前行棋方被将军':''}`;
  return `${legend}<div class="chess${blind?' blind':''}" role="group" aria-label="${blind?'覆棋盲棋棋盘，暗棋面朝下，':'中国象棋棋盘，'}只读观战，可选择棋子预览合法着法"><div class="chess-grid"></div><div class="palace top"></div><div class="palace bottom"></div><div class="river"><span>楚 河</span><span>漢 界</span></div>${last}${pieces}${targets}</div><p class="board-instruction" id="boardInstruction" role="status">${instruction}</p>${extras}<div class="move-legend"><span>双框：选中</span><span>● 合法落点</span><span>× 可吃子</span><span>虚线框：上一步</span>${blind?'<span>暗：未揭开</span>':''}</div>`;
 }
 function wakeControl(connection,busy=false){
  if(connection?.mode!=='wake'||!connection.verified)return null;
  const disabled=busy||connection.checking||!connection.canWake;
  const label=busy||connection.checking?'核验/投递中…':connection.status==='sent'?'已送达 · 待领取':connection.status==='uncertain'?'核验送达':connection.status==='claimed'?'已领取':connection.status==='sending'?'投递中…':'唤醒';
  return {disabled,label,reason:connection.blockedReason||'向已绑定原会话发送待领取任务通知；送达不代表已响应'};
 }
 globalThis.ArenaUI={avatar,chess,wakeControl,cell};
})();
