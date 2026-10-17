/* 狼人杀舞台：纯渲染函数 + 事件驱动演出播放器。模块顶层不访问 DOM，可用 vm 单测。 */
(()=>{
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const NIGHT=['night','wolf','seer','witch'];
 const nightPhase=phase=>NIGHT.includes(phase);
 const cut=(text,n)=>{text=String(text??'');return text.length>n?text.slice(0,n-1)+'…':text};
 const eventKey=e=>e&&e.id?String(e.id):(e?.at||'')+'|'+(e?.type||'')+'|'+(e?.text||'');
 // 公开发言：优先结构化字段（seat+speech），旧数据回退解析 "pN：" 文本前缀
 function speechOf(e){
  if(!e||e.type!=='action')return null;
  if(typeof e.seat==='string'&&typeof e.speech==='string'&&e.speech)return {seat:e.seat,text:e.speech};
  const m=/^(p\d)：([\s\S]*)$/.exec(String(e.text||''));
  return m?{seat:m[1],text:m[2]}:null;
 }
 function seatPosition(index,total=6){
  const angle=(-90+index*(360/(total||6)))*Math.PI/180;
  return 'left:'+(50+38*Math.cos(angle)).toFixed(2)+'%;top:'+(50+36*Math.sin(angle)).toFixed(2)+'%';
 }
 // 当前发言人：白天阶段（讨论/投票）内、本轮最后一条公开发言
 function deriveSpeech(events,game){
  if(!game||!['discuss','vote'].includes(game.phase))return {speaking:null,lastSpeech:null};
  let last=null;
  for(const e of events||[]){
   const s=speechOf(e);
   if(!s)continue;
   if(typeof e.round==='number'&&typeof game.round==='number'&&e.round!==game.round)continue;
   last={id:eventKey(e),seat:s.seat,text:s.text};
  }
  return last?{speaking:last.seat,lastSpeech:last}:{speaking:null,lastSpeech:null};
 }
 function stage(game,participants,manifest,options={}){
  const night=nightPhase(game?.phase),players=game?.players||[];
  const {speaking=null,lastSpeech=null,poppedId=null}=options;
  const roleName=role=>globalThis.ArenaUI?.roleNames?.[role]||role;
  const seats=players.map((p,i)=>{
   const participant=(participants||[]).find(item=>item.seat===p.id);
   const avatar=participant?.type==='human'?'<span class="provider-avatar human-avatar">真人</span>':(globalThis.ArenaUI?.avatar?.(participant?.provider,manifest)||'<span class="provider-avatar"><span class="avatar-fallback">AI</span></span>');
   return '<div class="ww-seat'+(p.alive?'':' dead')+(speaking===p.id?' speaking':'')+'" data-seat="'+esc(p.id)+'" style="'+seatPosition(i,players.length)+'" aria-label="'+esc(p.id)+' 号玩家，'+esc(p.role?roleName(p.role):'身份隐藏')+'，'+(p.alive?'存活':'已出局')+'"><div class="seat-avatar">'+avatar+'</div><strong>'+esc(participant?.nickname||p.id+' 号玩家')+'</strong><small>'+esc(p.id)+' 号 · '+esc(p.role?roleName(p.role):'身份隐藏')+' · '+(p.alive?'存活':'已出局')+'</small></div>';
  }).join('');
  const bubble=lastSpeech?'<div class="ww-bubble'+(lastSpeech.id!==poppedId?' pop':'')+'" title="'+esc(lastSpeech.text)+'"><b>'+esc(lastSpeech.seat)+' 发言</b><span>'+esc(cut(lastSpeech.text,140))+'</span></div>':'';
  return '<div class="ww-stage'+(night?' ww-night':'')+'"><div class="ww-banner'+(night?' night':'')+'">'+(night?'天黑请闭眼 · 私有行动仅对应角色可见':'天亮了 · 请根据公开线索讨论与投票')+'<small>普通观战不显示隐藏角色、夜间目标或验人结果</small></div><div class="ww-arena"><div class="ww-table" aria-hidden="true"></div>'+seats+'<div class="ww-spotlight">'+bubble+'</div></div></div>';
 }
 function freshEvents(seen,events){return (events||[]).filter(e=>!(seen&&typeof seen.has==='function'&&seen.has(eventKey(e))))}
 // 新事件 → 演出指令；昼夜切换指令置于最前
 function directives(fresh,prevPhase,nextPhase){
  const out=[];
  if(prevPhase&&nextPhase&&nightPhase(prevPhase)!==nightPhase(nextPhase))out.push({kind:'phase',to:nightPhase(nextPhase)?'night':'day'});
  for(const e of fresh||[]){
   const s=speechOf(e);
   if(s){out.push({kind:'speak',seat:s.seat,text:s.text});continue}
   if(e.type==='dawn')out.push({kind:'dawn',text:String(e.text||''),deaths:Array.isArray(e.deaths)?e.deaths.slice():[],round:typeof e.round==='number'?e.round:null});
   else if(e.type==='vote')out.push({kind:'vote',text:String(e.text||''),seat:typeof e.seat==='string'?e.seat:null});
   else if(e.type==='result')out.push({kind:'result',text:String(e.text||'')});
  }
  return out;
 }
 // 演出播放器：串行队列；一次性动效全部落在 #fx 覆盖层（render 不触碰），积压自动快进
 function createPlayer({fx,board,reducedMotion=false,duration=1}={}){
  let queue=[],timers=[],active=false;
  const later=(fn,ms)=>{const t=setTimeout(()=>{timers=timers.filter(x=>x!==t);fn()},ms);timers.push(t)};
  const make=(cls,html)=>{const d=document.createElement('div');d.className=cls;d.innerHTML=html;fx.append(d);return d};
  const seatPoint=seat=>{
   const node=board?.querySelector('[data-seat="'+seat+'"]');
   if(!node||!fx)return null;
   const r=node.getBoundingClientRect(),base=fx.getBoundingClientRect();
   return {left:r.left-base.left+r.width/2,top:r.top-base.top};
  };
  const clearAll=selector=>{for(const node of fx.querySelectorAll(selector))node.remove()};
  function play(){
   if(active)return;
   const d=queue.shift();
   if(!d)return;
   active=true;
   const speed=(queue.length>4?0.45:1)*duration;
   const done=ms=>later(()=>{active=false;play()},Math.max(120*duration,ms*speed));
   if(reducedMotion){
    if(d.kind==='result'&&fx)make('fx-finale','<b>比赛结束</b><span>'+esc(cut(d.text,160))+'</span>');
    active=false;play();return;
   }
   if(!fx||!board){active=false;play();return}
   if(d.kind==='speak'){
    const p=seatPoint(d.seat);
    if(p){
     const b=make('fx-bubble','<b>'+esc(d.seat)+'</b><span>'+esc(cut(d.text,120))+'</span>');
     b.style.left=p.left+'px';b.style.top=p.top+'px';
     later(()=>b.classList.add('out'),1900*speed);later(()=>b.remove(),2300*speed);
    }
    done(2300);
   }else if(d.kind==='dawn'){
    const title=d.round?'第 '+d.round+' 天黎明':'天亮了';
    const sub=d.deaths.length?d.deaths.map(esc).join('、')+' 出局':(d.round?'平安夜':cut(d.text,80));
    make('fx-banner dawn','<b>'+esc(title)+'</b><span>'+sub+'</span>');
    for(const seat of d.deaths){
     const p=seatPoint(seat);
     if(p){const g=make('fx-ghost','出局');g.style.left=p.left+'px';g.style.top=p.top+'px';later(()=>g.remove(),2700*speed)}
    }
    later(()=>clearAll('.fx-banner.dawn'),2700*speed);
    done(2900);
   }else if(d.kind==='vote'){
    make('fx-banner vote','<b>放逐投票</b><span>'+esc(cut(d.text,120))+'</span>');
    later(()=>clearAll('.fx-banner.vote'),2700*speed);
    done(2900);
   }else if(d.kind==='phase'){
    make('fx-dim '+(d.to==='night'?'night':'day'),'<span>'+(d.to==='night'?'天黑请闭眼':'天亮了')+'</span>');
    later(()=>clearAll('.fx-dim'),1400*speed);
    done(1500);
   }else if(d.kind==='result'){
    make('fx-finale','<b>比赛结束</b><span>'+esc(cut(d.text,160))+'</span>');
    done(2600);
   }else{active=false;play()}
  }
  function enqueue(list){
   if(!fx||!board||!Array.isArray(list)||!list.length)return;
   queue.push(...list);
   if(queue.length>4)queue=queue.filter((item,i,arr)=>item.kind==='speak'||item.kind==='result'||arr.findLastIndex(x=>x.kind===item.kind)===i);
   play();
  }
  function reset(){
   for(const t of timers)clearTimeout(t);
   timers=[];queue=[];active=false;
   if(fx)fx.innerHTML='';
  }
  return {enqueue,reset};
 }
 globalThis.ArenaWerewolf={seatPosition,stage,deriveSpeech,freshEvents,directives,createPlayer,eventKey,speechOf,nightPhase};
})();
