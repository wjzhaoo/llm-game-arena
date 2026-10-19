import {randomInt} from 'node:crypto';
import {nickname as normalizeName} from './participants.mjs';
import {participantContext} from './participant-context.mjs';

export const CHAT_EMOTES=Object.freeze([
 {id:'provoke',emoji:'😤',label:'挑衅'},{id:'entice',emoji:'😉',label:'诱惑'},
 {id:'mock',emoji:'🙃',label:'嘲讽'},{id:'tease',emoji:'😜',label:'调侃'},
 {id:'encourage',emoji:'💪',label:'鼓励'},{id:'agree',emoji:'👍',label:'赞同'},
 {id:'disagree',emoji:'👎',label:'反对'},{id:'think',emoji:'🤔',label:'疑惑'},
 {id:'surprised',emoji:'😮',label:'惊讶'},
]);
const clone=x=>structuredClone(x);
const member=(g,seat)=>g.members.find(p=>p.id===seat);
export const connectedChatMembers=g=>g.members.filter(p=>p.connected&&!p.removed);
const publicMember=p=>({seat:p.id,type:p.type,nickname:p.nickname,provider:p.provider,connected:p.connected});
const emit=(g,type,text,extra={})=>g.updates.push({type,text,...extra});
const name=p=>p.nickname||p.id+' 号成员';

export function chatProfile(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['personality','initialOpinion'].includes(k)))throw Error('设定仅接受性格特点和初始观点');
 const out={};for(const key of ['personality','initialOpinion']){
  if(value[key]!==undefined&&typeof value[key]!=='string')throw Error('性格特点和初始观点必须是文本');
  out[key]=(value[key]||'').trim();
 }
 return out;
}
export function initialGroupchat({topic}={}){
 if(typeof topic!=='string'||!topic.trim())throw Error('请输入群聊话题');
 return {game:'groupchat',status:'playing',winner:null,reason:null,topic:topic.trim(),members:[],nextMember:1,
  round:0,phase:'idle',idleReason:'not-started',roster:[],bids:{},roundProfiles:{},speaker:null,
  phaseDeadline:null,lastSelection:null,messages:[],updates:[]};
}
export function addChatMember(g,{type='ai',nickname='',profile}={}){
 if(g.status==='finished')throw Error('聊天已结束');
 if(!['human','ai'].includes(type)||typeof nickname!=='string')throw Error('无效的成员信息');
 const p={id:'p'+g.nextMember++,type,nickname:normalizeName(nickname),provider:null,
  profile:chatProfile(profile),connected:false,removed:false};
 g.members.push(p);return p;
}
function idle(g,reason){
 g.phase='idle';g.idleReason=reason;g.speaker=null;g.phaseDeadline=null;g.roster=[];g.bids={};g.roundProfiles={};
 emit(g,'chat-idle',reason==='members'?'等待至少两位成员接入':'全员弃权，等待成员主动发起下一轮');
}
export function beginChatRound(g,{now,timeoutMs}){
 if(connectedChatMembers(g).length<2){idle(g,'members');return}
 g.round++;g.phase='bid';g.idleReason=null;g.speaker=null;g.bids={};
 g.roster=connectedChatMembers(g).map(p=>p.id);
 g.roundProfiles=Object.fromEntries(g.roster.map(id=>[id,clone(member(g,id).profile)]));
 g.phaseDeadline=now+timeoutMs;
 emit(g,'chat-round','第 '+g.round+' 轮：征集发言意愿',{round:g.round});
}
export function pendingGroupchat(g){
 if(g.status==='finished')return [];
 if(g.phase==='bid')return g.roster.filter(id=>!Object.hasOwn(g.bids,id));
 return g.phase==='speak'?[g.speaker]:[];
}
function settle(g,{now,timeoutMs,pick=randomInt}){
 if(pendingGroupchat(g).length)return;
 const scores=g.roster.map(id=>({...publicMember(member(g,id)),score:g.bids[id]}));
 const max=scores.reduce((n,p)=>Math.max(n,p.score??0),0),top=scores.filter(p=>max>0&&p.score===max);
 const selected=top.length?top[pick(top.length)]:null;
 g.lastSelection={round:g.round,scores,speaker:selected?.seat||null};
 emit(g,'chat-selection',selected?'本轮由 '+(selected.nickname||selected.seat)+' 发言':'本轮无人申请发言',{selection:clone(g.lastSelection)});
 if(!selected){idle(g,'abstained');return}
 g.phase='speak';g.speaker=selected.seat;g.phaseDeadline=now+timeoutMs;
}
export function removeChatMember(g,seat,options){
 const p=member(g,seat);if(!p||p.removed)throw Error('成员不存在');
 p.removed=true;p.connected=false;
 if(!g.roster.includes(seat))return;
 g.roster=g.roster.filter(id=>id!==seat);delete g.bids[seat];delete g.roundProfiles[seat];
 if(connectedChatMembers(g).length<2||g.roster.length<2){idle(g,'members');return}
 if(g.phase==='speak'&&g.speaker===seat)beginChatRound(g,options);
 else if(g.phase==='bid')settle(g,options);
}
export function validateChatEmote(g,value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['id','targetSeat'].includes(k)))throw Error('无效的表情');
 const e=CHAT_EMOTES.find(e=>e.id===value.id);if(!e)throw Error('请选择有效的固定表情');
 const target=value.targetSeat==null?null:member(g,value.targetSeat);
 if(value.targetSeat!=null&&(!target||target.removed||!target.connected))throw Error('表情目标不是当前群成员');
 return {...e,targetSeat:target?.id||null,target:target?publicMember(target):null};
}
function appendMessage(g,seat,{text='',emote=null,type='speak'},now){
 const p=member(g,seat),message={seq:g.messages.length+1,at:new Date(now).toISOString(),type,seat,sender:publicMember(p),text,emote};
 g.messages.push(message);
 emit(g,'chat-message',name(p)+'：'+(type==='emote'?emote.emoji+' '+emote.label:text),{message:clone(message),seat});
 return message;
}
export function sendChatEmote(g,seat,value,now){
 return appendMessage(g,seat,{type:'emote',emote:validateChatEmote(g,value)},now);
}
export function applyGroupchat(g,seat,action,options){
 if(g.status==='finished'||!pendingGroupchat(g).includes(seat))throw Error('当前不能提交此行动');
 if(!action||typeof action!=='object'||Array.isArray(action))throw Error('行动必须是 JSON 对象');
 // A score-only bid is unambiguous in this phase. Do not infer an action from
 // unknown fields, coerce strings, or accept an invalid score.
 if(g.phase==='bid'&&Object.keys(action).join(',')==='score'&&Number.isInteger(action.score)&&action.score>=0&&action.score<=100)action={type:'bid',score:action.score};
 if(g.phase==='bid'){
  if(Object.keys(action).sort().join(',')!=='score,type'||action.type!=='bid'||!Number.isInteger(action.score)||action.score<0||action.score>100)throw Error('请提交 {type:"bid",score:0..100整数}');
  g.bids[seat]=action.score;settle(g,options);
 }else{
  if(action.type!=='speak'||Object.keys(action).some(k=>!['type','text','emote'].includes(k))||typeof action.text!=='string'||!action.text.trim())throw Error('请提交非空文字 {type:"speak",text}');
  const emote=action.emote==null?null:validateChatEmote(g,action.emote);
  appendMessage(g,seat,{text:action.text.trim(),emote},options.now);
  beginChatRound(g,options);
 }
 return g;
}
export function timeoutGroupchat(g,seat,options){
 if(!pendingGroupchat(g).includes(seat))return;
 if(g.phase==='bid'){g.bids[seat]=null;settle(g,options)}
 else{emit(g,'chat-skip',seat+' 本次发言已跳过',{seat,round:g.round});beginChatRound(g,options)}
}
export function chatMessages(g,{before,limit=50}={}){
 if(!Number.isInteger(limit)||limit<1||limit>100||before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw Error('历史参数无效：limit 为 1..100，before 为正整数');
 const end=before===undefined?g.messages.length:Math.min(before-1,g.messages.length),start=Math.max(0,end-limit);
 return {messages:participantContext(g.messages.slice(start,end)),nextBefore:start?start+1:null,hasMore:start>0};
}
function context(g){
 const page=chatMessages(g),messages=[];let budget=20000,truncated=page.hasMore;
 for(const original of page.messages.slice().reverse()){
  if(!budget){truncated=true;break}
  const message=clone(original),chars=Array.from(message.text),cost=chars.length+(message.emote?message.emote.label.length:0);
  if(cost>budget){const keep=Math.max(0,budget-(message.emote?.label.length||0));message.text=keep?chars.slice(-keep).join(''):'';message.truncated=true;truncated=true}
  messages.unshift(message);budget-=Math.min(cost,budget);
 }
 return {messages,contextTruncated:truncated,historyBefore:messages[0]?.seq||null,
  historyInstruction:'使用 history --credential <凭据文件> --before <historyBefore> 查询更早记录；若单条消息标记 truncated，用 --before 消息seq加1 --limit 1 获取该条完整内容。'};
}
export function groupchatView(g,seat=null,{snapshot=false,reveal=false}={}){
 const view={game:g.game,status:g.status,winner:null,reason:g.reason,topic:g.topic,round:g.round,phase:g.phase,idleReason:g.idleReason,
  members:g.members.filter(p=>!p.removed).map(publicMember),roster:g.roster.slice(),submitted:g.phase==='bid'?Object.keys(g.bids).length:0,
  speaker:g.speaker,pendingSeats:pendingGroupchat(g),phaseDeadline:g.phaseDeadline,lastSelection:clone(g.lastSelection),messageCursor:g.messages.length};
 if(g.phase==='bid'&&!reveal)delete view.pendingSeats;
 if(!snapshot)Object.assign(view,context(g));
 if(reveal)view.revealed={profiles:g.members.filter(p=>!p.removed).map(p=>({id:p.id,profile:clone(p.profile)})),bids:clone(g.bids)};
 const p=member(g,seat);
 if(p&&!p.removed){view.self={id:seat,profile:clone(g.roundProfiles[seat]||p.profile),savedProfile:clone(p.profile),score:Object.hasOwn(g.bids,seat)?g.bids[seat]:null};
  view.guidance='性格和初始观点仅供本人参考，允许观点自然改变。只在 speak 任务发言；bid 提交 0..100 整数，0 为弃权。表情可用独立 emote 命令，不占发言轮次。';}
 return participantContext(view);
}
