/* One atlas cell per public acting choice. No hidden roles influence this renderer. */
(()=>{
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let manifest={animals:[],states:[],scenes:{}};
 const seat=id=>id==='red'?'红方':id==='black'?'黑方':/^p\d+$/.test(id||'')?id.slice(1)+' 号':id||'访客';
 const name=p=>p?.nickname||seat(p?.seat);
 function portrait(person={},options={}){
  const animal=manifest.animals.find(a=>a.id===person.animalId),state=manifest.states.find(s=>s.id===person.state);
  const label=(animal?.label||'动物')+' · '+(state?.label||'未记录'),size=options.size||'normal';
  return '<span class="animal-portrait size-'+esc(size)+'" role="img" aria-label="'+esc(label)+'"><span class="animal-fallback">'+esc(animal?.label||seat(person.seat))+'</span>'+(animal&&state?'<img class="animal-sprite" src="'+esc(animal.src)+'" alt="" decoding="async" draggable="false" style="left:-'+state.column*100+'%;top:-'+state.row*100+'%">':'')+'</span>';
 }
 const status=person=>'<span class="character-state">'+esc(person?.state||'未记录')+'</span>';
 const avatar=(person,options={})=>'<span class="character-avatar">'+portrait(person,options)+(options.label===false?'':status(person))+'</span>';
 function animalSelect(person,enabled=false){
  return '<label class="animal-select-label"><span>角色</span><select data-animal-seat="'+esc(person.seat)+'" aria-label="'+esc(name(person))+'的动物头像" '+(!enabled?'disabled':'')+'>'+manifest.animals.map(a=>'<option value="'+a.id+'" '+(a.id===person.animalId?'selected':'')+'>'+esc(a.label)+'</option>').join('')+'</select></label>';
 }
 const scenes={xiangqi:['楚河开杠','棋可以输，气势得足。'],blind:['暗棋整活','表面风平浪静，底牌全是戏。'],werewolf:['全员演技派','今晚谁在演，明早见分晓。'],groupchat:['嘴替茶话会','观点碰一碰，表情先到位。'],undercover:['词不达意局','你说得很对，但你很可疑。'],liarsdice:['吹牛不打草稿','骰子藏杯里，胆子摆桌上。'],codenames:['脑回路特工队','一个词，能不能接住我的脑洞？'],spyfall:['这里谁不对劲','大家都知道在哪，除了那一位。']};
 function sceneKey(kind,phase){return kind==='werewolf'?( ['night','wolf','seer','witch'].includes(phase)?'werewolf-night':'werewolf-day'):kind}
 function scene(kind,{phase,compact=false}={}){
  const key=sceneKey(kind,phase),copy=scenes[kind]||['动物派对','每张脸，都很有戏。'];
  return '<div class="scene-banner '+(compact?'compact':'')+'"><img class="scene-art" src="/assets/presentation/scenes/'+key+'.webp" alt="" decoding="async"><div><span class="comic-kicker">动物派对 · '+esc(manifest.gameNames?.[kind]||'开场！')+'</span><h2>'+esc(copy[0])+'</h2><p>'+esc(copy[1])+'</p></div><span class="scene-spark" aria-hidden="true">✦</span></div>';
 }
 // Expansion belongs to a room/run and an exact action, not to a DOM instance.
 let actionContext='',expandedActions=new Set();
 function setActionContext(key){if(key!==actionContext){actionContext=key;expandedActions.clear()}}
 function recentActions(events=[]){
  const result={};let latest=null;
  for(const event of events)for(const [index,action]of (event.publicActions||[]).entries()){
   const id=event.id+':'+index;
   result[action.seat]={...action,id};latest=event.id;
  }
  for(const action of Object.values(result))action.latest=action.id.startsWith(latest+':');
  const visible=new Set(Object.values(result).map(a=>a.id));
  for(const id of expandedActions)if(!visible.has(id))expandedActions.delete(id);
  return result;
 }
 function actionCard(person,{actions={},turns={},people=[]}={}){
  const a=actions[person.seat],turn=turns[person.seat];
  const summary=a?.summary.replace(/\b(p\d+|red|black)\b/g,id=>name(people.find(p=>p.seat===id)||{seat:id}));
  const when=a?(a.ply!=null?'第 '+a.ply+' 手':a.round!=null?'第 '+a.round+' 轮':'公开动态'):'';
  return '<section class="character-action'+(a?.latest?' latest':'')+'" data-action-seat="'+esc(person.seat)+'" aria-label="'+esc(name(person))+'的最近行动">'+(turn?'<span class="action-waiting">'+esc(turn.label)+'</span>':'')+(a?'<div class="action-meta"><small>'+esc(when)+'</small>'+(a.latest?'<span>最新行动</span>':'')+'</div><strong class="action-summary">'+esc(summary)+'</strong>'+(a.speech?'<details class="action-speech" data-action-id="'+esc(a.id)+'" '+(expandedActions.has(a.id)?'open':'')+'><summary><span class="action-preview">'+esc(a.speech)+'</span><span class="action-expand">展开全文</span><span class="action-collapse">收起全文</span></summary><p>'+esc(a.speech)+'</p></details>':''):'<small class="action-empty">尚无公开行动</small>')+'</section>';
 }
 document.addEventListener('toggle',event=>{
  const el=event.target,id=el.dataset?.actionId;
  if(id&&el.isConnected){if(el.open)expandedActions.add(id);else expandedActions.delete(id)}
 },true);
 function roster(people=[],{duel=false,actions={},turns={}}={}){
  return '<div class="character-roster '+(duel?'duel-roster':'')+'">'+people.map((p,i)=>'<div class="roster-person">'+avatar(p,{size:duel?'large':'small'})+'<div><strong>'+esc(name(p))+'</strong><small>'+esc(seat(p.seat))+'</small></div>'+actionCard(p,{actions,turns,people})+(duel&&i===0?'<span class="duel-vs" aria-hidden="true">VS</span>':'')+'</div>').join('')+'</div>';
 }
 function picker(person,selected,{disabled=false,notice=''}={}){
  return '<details class="state-picker" open><summary><span>这次用什么表情？</span><b>'+esc(selected)+'</b><small>随行动提交 · 可以演</small></summary><p>'+esc(notice||'状态由你主动选择，其他玩家会看到；它可以是伪装。')+'</p><div class="state-grid" role="group" aria-label="本次行动状态">'+manifest.states.map(s=>'<button type="button" class="state-choice" data-state="'+s.id+'" aria-pressed="'+(s.id===selected)+'" '+(disabled?'disabled':'')+' title="'+esc(s.description)+'">'+portrait({...person,state:s.id},{size:'small'})+'<span>'+s.label+'</span></button>').join('')+'</div></details>';
 }
 function lobby(rules={}){
  return '<div class="party-lobby"><div class="lobby-intro"><span class="comic-kicker">脑洞开桌，演技上线</span><h2>今天，谁最会演？</h2><p>八种玩法，一桌动物。和真人、AI 一起斗智、吹牛、飙演技。</p><div class="lobby-cast">'+manifest.animals.slice(0,6).map((a,i)=>avatar({animalId:a.id,state:['嚣张','无辜','狡黠','惊讶','思考','开心'][i]},{size:'large',label:false})).join('')+'</div></div><div class="lobby-games">'+Object.entries(scenes).map(([kind,copy])=>'<button class="lobby-game" data-create-kind="'+kind+'"><img src="/assets/presentation/scenes/'+sceneKey(kind)+'.webp" alt="" loading="lazy"><span><b>'+esc(rules[kind]?.name||manifest.gameNames?.[kind]||copy[0])+'</b><small>'+esc(copy[1])+'</small></span><i aria-hidden="true">↗</i></button>').join('')+'</div></div>';
 }
 document.addEventListener('error',event=>{const img=event.target;if(img instanceof HTMLImageElement&&(img.classList.contains('animal-sprite')||img.classList.contains('scene-art'))){img.hidden=true;img.parentElement.classList.add('asset-missing')}},true);
 globalThis.ArenaPresentation={configure:value=>{if(value)manifest={...manifest,...value,animals:Array.isArray(value.animals)?value.animals:[],states:Array.isArray(value.states)?value.states:[]}},get manifest(){return manifest},portrait,avatar,status,animalSelect,scene,sceneKey,roster,picker,lobby,seat,name,actionCard,recentActions,setActionContext};
})();
