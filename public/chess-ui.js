/* Shared presentation shell. Only the authenticated app controller submits actions. */
(()=>{
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const sideName=side=>side==='red'?'红方':'黑方';
 function state(view,options){
  let text,activeSide=null;
  if(view.status==='finished')text='本局已结束 · '+(view.winner?sideName(view.winner)+'获胜':'平局')+(view.reason==='resigned'?' · 认输':'');
  else if(!options.started)text='等待开局';
  else if(options.paused)text='比赛已暂停 · 计时冻结';
  else if(options.undoRequest)text='等待'+sideName(options.undoRequest.responder)+'确认悔棋 · 走棋计时冻结';
  else{activeSide=view.turn;text='轮到'+sideName(view.turn)+(options.side===view.turn&&options.interactive?' · 轮到你':'行棋')+(view.check?' · 将军':'')}
  return {text:(options.replay?'历史回放 · ':'')+text,activeSide};
 }
 function controls(interactions,disabled=false,now=Date.now()){
  if(!interactions)return '';
  const undo=interactions.undo||{allowed:false,reason:'暂无棋步可撤回'};
  return '<div class="chess-actions"><button data-undo '+(disabled||!undo.allowed?'disabled ':'')+'title="'+esc(undo.reason||'撤回自己最近一手及对方应手')+'">申请悔棋'+(undo.allowed?' · '+undo.plies+' 手':'')+'</button><button data-resign '+(disabled?'disabled':'')+'>认输</button><span class="action-hint">'+esc(undo.reason)+'</span></div><div class="emote-picker" aria-label="快捷表情">'+interactions.emotes.map(e=>'<button data-emote="'+esc(e.id)+'" aria-label="'+esc(e.label)+'" title="'+esc(e.label)+'" '+(disabled||interactions.emoteAvailableAt>now?'disabled':'')+'><span>'+esc(e.emoji)+'</span><small>'+esc(e.label)+'</small></button>').join('')+'</div>';
 }
 class Stage {
  constructor(root,{mode='2d',onMode,onPick,onFailure}){
   this.root=root;this.mode=mode;this.onMode=onMode;this.onPick=onPick;this.onFailure=onFailure;this.room=null;this.player=null;this.generation=0;this.seen=new Set();this.timers=new Set();this.disposed=false;
   this.click=e=>{const button=e.target.closest('[data-board-mode],[data-camera-reset]');if(!button)return;if(button.hasAttribute('data-camera-reset')){this.player?.reset();return}this.setMode(button.dataset.boardMode)};
   root.addEventListener('click',this.click);
  }
  shell(){
   this.root.innerHTML='<div class="chess-modebar" role="group" aria-label="棋盘展示"><button data-board-mode="2d">二维棋盘</button><button data-board-mode="3d">立体棋盘</button><button data-camera-reset hidden>视角复位</button><span class="chess-mode-note"></span></div><div class="chess-turn" role="status" aria-live="polite"></div><div class="chess-bubbles" aria-live="polite"></div><div class="chess-flat"></div><div class="chess3d-host" hidden></div><div class="chess3d-info"></div><details class="chess-keyboard" hidden><summary>键盘操作 / 二维辅助棋盘</summary><div class="chess-keyboard-board"></div></details>';
  }
  setMode(mode){if(!['2d','3d'].includes(mode)||this.disposed)return;this.mode=mode;this.onMode?.(mode);if(mode==='2d'){this.generation++;this.player?.dispose();this.player=null}if(this.current)this.update(...this.current)}
  update(view,selected,options){
   if(this.disposed)return;
   if(this.room!==options.room){this.generation++;this.player?.dispose();this.player=null;this.room=options.room;this.seen.clear();for(const timer of this.timers)clearTimeout(timer);this.timers.clear();this.shell()}
   this.current=[view,selected,options];const status=state(view,options),root=this.root;
   const eventContext=options.room+':'+(options.replay?options.replayIndex:'live');
   if(this.eventContext!==eventContext){this.eventContext=eventContext;this.seen.clear();for(const timer of this.timers)clearTimeout(timer);this.timers.clear();root.querySelector('.chess-bubbles').innerHTML=''}
   const label=root.querySelector('.chess-turn');if(label.textContent!==status.text)label.textContent=status.text;label.dataset.side=status.activeSide||'';
   for(const button of root.querySelectorAll('[data-board-mode]'))button.setAttribute('aria-pressed',String(button.dataset.boardMode===this.mode));
   const three=this.mode==='3d',flat=root.querySelector('.chess-flat'),host=root.querySelector('.chess3d-host'),info=root.querySelector('.chess3d-info'),keyboard=root.querySelector('.chess-keyboard');
   host.hidden=!three;keyboard.hidden=!three;root.querySelector('[data-camera-reset]').hidden=!three;
   const html=ArenaUI.chess(view,selected,options);
   if(!three){
    flat.innerHTML=html;info.innerHTML='';root.querySelector('.chess-keyboard-board').innerHTML='';
    const board=flat.querySelector('.chess');for(const side of ['red','black']){const edge=document.createElement('span');edge.className='turn-edge '+side+(options.side==='black'?' flipped':'')+(status.activeSide===side?' active':'');edge.textContent=sideName(side)+(status.activeSide===side?' · 行棋':'');edge.setAttribute('aria-hidden','true');board.append(edge)}
    root.querySelector('.chess-mode-note').textContent='点击棋子和合法目标落子';
   }else{
    flat.innerHTML='';const temporary=document.createElement('div');temporary.innerHTML=html;const auxiliary=temporary.querySelector('.chess');root.querySelector('.chess-keyboard-board').innerHTML=auxiliary.outerHTML;auxiliary.remove();info.innerHTML=temporary.innerHTML;
    root.querySelector('.chess-mode-note').textContent=this.player?'拖动旋转 · 滚轮/双指缩放':'正在加载立体棋盘…';
    if(this.player)this.player.update(view,selected,{...options,activeSide:status.activeSide});
    else if(!this.loading){
     const generation=this.generation;this.loading=true;
     import('/chess3d.mjs').then(({createChess3D})=>{
      if(this.disposed||this.mode!=='3d'||generation!==this.generation)return;
      this.player=createChess3D(host,{onPick:this.onPick,onFailure:error=>this.fail(error)});this.player.update(this.current[0],this.current[1],{...this.current[2],activeSide:state(this.current[0],this.current[2]).activeSide});root.querySelector('.chess-mode-note').textContent='拖动旋转 · 滚轮/双指缩放';
     }).catch(error=>{if(!this.disposed&&generation===this.generation)this.fail(error)}).finally(()=>{this.loading=false;if(!this.disposed&&this.mode==='3d'&&!this.player&&generation!==this.generation)this.update(...this.current)});
    }
   }
   for(const event of options.events||[]){
    const key=event.id||event.index+':'+event.at;if(event.type!=='emote'||this.seen.has(key))continue;this.seen.add(key);
    const remaining=4000-((options.now??Date.now())-Date.parse(event.at));if(remaining<=0&&!options.replay)continue;
    const wrap=root.querySelector('.chess-bubbles');wrap.querySelector('[data-side="'+event.seat+'"]')?.remove();
    const bubble=document.createElement('div');bubble.className='chess-emote '+event.seat;bubble.dataset.side=event.seat;bubble.textContent=sideName(event.seat)+' '+event.emoji+' '+event.label;wrap.append(bubble);
    const timer=setTimeout(()=>{bubble.remove();this.timers.delete(timer)},options.replay?4000:Math.max(1,remaining));this.timers.add(timer);
   }
  }
  fail(error){this.setMode('2d');this.onFailure?.(/[\u4e00-\u9fff]/.test(error.message)?error.message:'此设备暂不支持 3D，已恢复二维棋盘')}
  destroy(){if(this.disposed)return;this.disposed=true;this.generation++;this.player?.dispose();this.player=null;for(const timer of this.timers)clearTimeout(timer);this.timers.clear();this.root.removeEventListener('click',this.click)}
 }
 globalThis.ArenaChess={Stage,state,controls};
})();
