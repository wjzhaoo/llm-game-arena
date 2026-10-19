// Public acting choices, deliberately independent from roles, providers and rules.
export const ANIMALS = [
 ['cat','猫'],['shiba','柴犬'],['fox','狐狸'],['rabbit','兔子'],
 ['panda','熊猫'],['bear','棕熊'],['raccoon','浣熊'],['otter','水獭'],
 ['owl','猫头鹰'],['penguin','企鹅'],['sheep','绵羊'],['capybara','水豚'],
].map(([id,label])=>({id,label}));

export const STATES = [
 ['平静','眉眼舒展，嘴角放松，姿态从容。'],
 ['老实','睁大眼睛，端正坐好，爪子规矩地放在胸前。'],
 ['真诚','目光柔和，身体微微前倾，双爪合拢。'],
 ['无辜','圆眼睛眨巴，嘴巴小小张开，一副不知情的样子。'],
 ['嚣张','下巴抬高，半眯着眼，嘴角歪斜上扬。'],
 ['得意','眼睛弯起，咧嘴偷笑，双爪叉腰。'],
 ['狡黠','眼神斜瞟，眉毛挑起，露出会心坏笑。'],
 ['挑衅','吐着舌头，挑起眉毛，用爪子招手。'],
 ['思考','爪子托住下巴，眼睛向上看，眉头微皱。'],
 ['疑惑','眉毛一高一低，嘴巴微张，脑袋稍稍偏斜。'],
 ['紧张','眼神游移，脸颊冒汗，双爪缩在胸前。'],
 ['惊讶','眼睛瞪圆，嘴巴大张，双爪突然举起。'],
 ['委屈','眼眶湿润，嘴唇撅起，耳朵或肩膀耷拉。'],
 ['沮丧','目光低垂，嘴角下弯，身体无精打采。'],
 ['愤怒','眉毛紧锁，咬紧牙齿，双爪攥紧。'],
 ['开心','眼睛笑弯，张嘴大笑，双爪欢快地举起。'],
].map(([id,description],index)=>({id,label:id,description,row:Math.floor(index/4),column:index%4}));

export const STATE_GUIDANCE = '动物头像仅用于区分角色，不暗示隐藏身份或模型品牌。状态是玩家主动选择的公开表演，可以伪装；中文表现描述仅描述外在动作，不是系统认证的真实性、性格或可信度。请结合言行、状态变化和游戏局面自行判断。每次行动在原 JSON 顶层增加 state，值必须是固定中文状态之一，不要另写状态描述。狼人夜间状态仅本人及管理员可见；秘密投票和群聊报分的状态随行动封存，公开结算时一起发布。';
const validState = state=>STATES.some(s=>s.id===state);

export function ensurePresentation(m,seats) {
 if(m.archived)return false;
 let changed=false;
 if(!m.presentation){m.presentation={version:1,animals:{},states:{},privateStates:{},sealed:{},changes:[]};changed=true}
 const p=m.presentation;
 for(const seat of seats){
  if(!ANIMALS.some(a=>a.id===p.animals[seat])){
   const counts=Object.fromEntries(ANIMALS.map(a=>[a.id,0]));
   for(const active of seats){const id=p.animals[active];if(id in counts)counts[id]++}
   p.animals[seat]=ANIMALS.reduce((best,a)=>counts[a.id]<counts[best.id]?a:best).id;changed=true;
  }
  if(!validState(p.states[seat])){p.states[seat]='平静';changed=true}
 }
 return changed;
}

export function appearance(m,seat) {
 return {animalId:m.presentation?.animals[seat]??null,state:m.presentation?.states[seat]??null};
}

export function stateAction(result,job,currentState) {
 if(!result||typeof result!=='object'||Array.isArray(result))throw Error('行动必须是 JSON 对象');
 const {state,...action}=result;
 if(state===undefined&&!job.stateProtocol)return {action,state:currentState||'平静'};
 if(!validState(state))throw Error('state 必须是固定的 16 种中文状态之一');
 return {action,state};
}

export function withStateSchema(schema,required=true) {
 const field=required?STATES.map(s=>s.id):{optional:true,values:STATES.map(s=>s.id),default:'沿用原公开状态（旧任务兼容）'};
 return schema?.oneOf?{oneOf:schema.oneOf.map(s=>({...s,state:field}))}:{...schema,state:field};
}

export function stateVisibility(m,action) {
 const g=m.game;
 if(m.kind==='werewolf'&&['wolf','seer','witch'].includes(g.phase))return {private:true};
 if(g.phase==='vote'&&['werewolf','undercover','spyfall'].includes(m.kind)&&action.type==='vote')return {sealed:`${m.kind}:${g.round}:vote`,round:g.round};
 if(m.kind==='groupchat'&&g.phase==='bid')return {sealed:`groupchat:${g.round}:bid`,round:g.round};
 return {};
}

// No time, submission order or private choice is included in any public projection.
export function acceptState(m,seat,state,visibility) {
 const p=m.presentation;
 if(visibility.private){p.privateStates[seat]=state;return []}
 if(visibility.sealed){
  p.sealed[visibility.sealed]??={round:visibility.round,states:{}};
  p.sealed[visibility.sealed].states[seat]=state;return [];
 }
 delete p.privateStates[seat];
 return [{seat,state}];
}

export function settledStates(m) {
 const p=m.presentation,result=[];
 if(!p)return result;
 for(const [key,cohort] of Object.entries(p.sealed)){
  const g=m.game,round=cohort.round;
  const published=m.kind==='groupchat'?g.lastSelection?.round===round:
   m.kind==='werewolf'?g.log.some(e=>e.type==='exile'&&e.round===round):
   m.kind==='undercover'?g.lastVote?.round===round:
   m.kind==='spyfall'?!!g.lastVote:false;
  if(published){
   for(const seat of Object.keys(cohort.states).sort())if(p.states[seat]!==undefined&&(m.kind!=='groupchat'||g.lastSelection.scores.some(person=>person.seat===seat)))result.push({seat,state:cohort.states[seat]});
   delete p.sealed[key];
  }else if(g.status==='finished'||g.round>round||m.kind==='groupchat'&&g.phase==='idle')delete p.sealed[key];
 }
 return result;
}

export function publishStates(m,choices,people,now) {
 const changes=[],p=m.presentation;
 for(const {seat,state} of choices){
  if(p.states[seat]===state)continue;
  changes.push({seat,nickname:people.find(person=>person.seat===seat)?.nickname||null,animalId:p.animals[seat],from:p.states[seat],state,at:new Date(now).toISOString()});
  p.states[seat]=state;
 }
 p.changes.push(...changes);p.changes=p.changes.slice(-12);
 return changes;
}

export function presentationContext(m,participants,{seat=null,reveal=false}={}) {
 const p=m.presentation;
 return {participants:structuredClone(participants),stateCatalog:STATES,stateGuidance:STATE_GUIDANCE,recentStateChanges:structuredClone(p?.changes||[]),
  ...(seat?{ownPresentation:{...appearance(m,seat),privateState:p?.privateStates[seat]??null,sealedState:Object.values(p?.sealed||{}).find(c=>Object.hasOwn(c.states,seat))?.states[seat]??null}}:{}),
  ...(reveal?{privatePresentation:{night:structuredClone(p?.privateStates||{}),sealed:structuredClone(p?.sealed||{})}}:{})};
}

export function migratePresentation(state) {
 let changed=false;
 for(const m of Object.values(state.matches)){
  const seats=m.kind==='groupchat'?m.game.members.filter(p=>!p.removed).map(p=>p.id):m.game.players?m.game.players.map(p=>p.id):['red','black'];
  if(ensurePresentation(m,seats))changed=true;
  // Existing jobs intentionally retain their missing protocol marker.
 }
 return changed;
}
