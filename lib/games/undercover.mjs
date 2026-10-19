import {shuffle,countPlayers,roster,living,action,text,target,emit,finish,baseView,clone} from './common.mjs';

// Original word pairs; they are server-owned and never sent in ordinary views.
const PAIRS=[['咖啡','奶茶'],['月亮','太阳'],['火锅','烧烤'],['雨伞','雨衣'],['沙漠','海滩'],['钢琴','吉他'],['电梯','扶梯'],['饺子','馄饨'],['图书馆','书店'],['地铁','高铁'],['蛋糕','面包'],['电影','电视剧'],['雪糕','冰淇淋'],['围巾','口罩'],['萤火虫','星星'],['相机','望远镜'],['露营','野餐'],['瀑布','喷泉'],['信封','明信片'],['闹钟','秒表'],['蜜蜂','蝴蝶'],['古堡','宫殿'],['温泉','澡堂'],['船长','飞行员']];
export function initialUndercover({playerCount}={}) {
 const players=roster(countPlayers(playerCount,6,4,10)),pair=shuffle(PAIRS)[0],spies=players.length>=8?2:1,ids=new Set(shuffle(players).slice(0,spies).map(p=>p.id));
 for(const p of players){p.role=ids.has(p.id)?'undercover':'civilian';p.word=pair[p.role==='undercover'?1:0]}
 return {game:'undercover',players,playerCount:players.length,status:'playing',winner:null,reason:null,round:1,phase:'describe',speaker:players[0].id,spoken:[],votes:{},lastVote:null,log:[],updates:[]};
}
export function pendingUndercover(g) {
 return g.status==='finished'?[]:g.phase==='describe'?[g.speaker]:living(g).filter(p=>!Object.hasOwn(g.votes,p.id)).map(p=>p.id);
}
function settle(g) {
 const counts={};for(const vote of Object.values(g.votes))if(vote)counts[vote]=(counts[vote]||0)+1;
 const high=Math.max(0,...Object.values(counts)),leaders=Object.keys(counts).filter(id=>counts[id]===high),out=high&&leaders.length===1?leaders[0]:null;
 if(out)g.players.find(p=>p.id===out).alive=false;
 g.lastVote={round:g.round,votes:clone(g.votes),eliminated:out};
 emit(g,out?`${out} 被投票出局，身份为${g.players.find(p=>p.id===out).role==='undercover'?'卧底':'平民'}`:'票数并列或全员弃权，本轮无人出局',{type:'vote',...g.lastVote});
 const alive=living(g),spies=alive.filter(p=>p.role==='undercover').length;
 if(!spies)finish(g,'civilians','all-undercover-eliminated');
 else if(alive.length<=3||spies>=alive.length-spies)finish(g,'undercover','undercover-survives');
 else if(g.round>=12)finish(g,null,'round-cap');
 else{g.round++;g.phase='describe';g.spoken=[];g.votes={};g.speaker=alive[0].id}
}
export function applyUndercover(g,seat,result) {
 if(!pendingUndercover(g).includes(seat))throw Error('当前不是你的行动');
 if(g.phase==='describe'){
  action(result,'describe',['text']);const speech=text(result.text),self=g.players.find(p=>p.id===seat);
  if(speech.includes(self.word))throw Error('描述不能直接包含你拿到的词语');
  emit(g,`${seat}：${speech}`,{type:'speech',seat});g.spoken.push(seat);
  const next=living(g).find(p=>!g.spoken.includes(p.id));
  if(next)g.speaker=next.id;else{g.phase='vote';g.speaker=null}
 }else{action(result,'vote',['target']);g.votes[seat]=target(g,result.target,seat);if(!pendingUndercover(g).length)settle(g)}
}
export function timeoutUndercover(g,seat) {
 if(!pendingUndercover(g).includes(seat))return;
 if(g.phase==='vote')applyUndercover(g,seat,{type:'vote',target:null});
 else{
  emit(g,`${seat} 超时，跳过描述`,{type:'skip',seat});g.spoken.push(seat);
  const next=living(g).find(p=>!g.spoken.includes(p.id));if(next)g.speaker=next.id;else{g.phase='vote';g.speaker=null}
 }
}
export function undercoverView(g,seat=null,reveal=false) {
 const all=reveal||g.status==='finished',self=g.players.find(p=>p.id===seat);
 return {...baseView(g),players:g.players.map(p=>({id:p.id,alive:p.alive,...(all||!p.alive?{role:p.role}:{}),...(all?{word:p.word}:{})})),speaker:g.speaker,spoken:g.spoken.slice(),submitted:Object.keys(g.votes).length,...(g.phase!=='vote'||reveal?{pendingSeats:pendingUndercover(g)}:{}),lastVote:clone(g.lastVote),...(reveal?{ballots:clone(g.votes)}:{}),...(self?{self:{id:seat,alive:self.alive,word:self.word}}:{})};
}
export const undercoverSchema=g=>g.phase==='describe'?{type:'describe',text:'1–300 字，不得直接包含自己的词语；你不知道自己阵营'}:{type:'vote',target:'其他存活席位 pN，或 null 弃权'};
