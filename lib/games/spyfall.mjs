import {shuffle,countPlayers,roster,action,text,target,emit,finish,baseView,clone} from './common.mjs';
// Original location/occupation set for the turn-based arena variant.
const PLACES=[['医院',['医生','护士','病人','药剂师']],['学校',['老师','学生','校长','图书管理员']],['机场',['飞行员','空乘','旅客','安检员']],['餐厅',['厨师','服务员','食客','店长']],['海盗船',['船长','水手','舵手','俘虏']],['太空站',['宇航员','工程师','指挥官','科学家']],['电影院',['放映员','观众','售票员','保洁员']],['动物园',['饲养员','游客','兽医','导游']],['火车',['列车长','乘客','乘务员','检票员']],['博物馆',['馆长','讲解员','游客','保安']],['游乐园',['游客','售票员','玩偶演员','维修员']],['酒店',['前台','住客','经理','客房服务员']],['露营地',['领队','摄影师','营员','向导']],['图书馆',['管理员','读者','志愿者','修复师']],['剧院',['演员','导演','观众','灯光师']],['潜水艇',['艇长','声呐员','机械师','厨师']]];
export function initialSpyfall({playerCount}={}) {
 const players=roster(countPlayers(playerCount,6,3,8)),[location,roles]=shuffle(PLACES)[0],spy=shuffle(players)[0].id;
 for(const [i,p] of players.entries()){p.spy=p.id===spy;p.occupation=p.spy?null:roles[i%roles.length]}
 return {game:'spyfall',players,playerCount:players.length,location,status:'playing',winner:null,reason:null,round:1,phase:'question',turn:players[0].id,question:null,questions:0,votes:{},lastVote:null,log:[],updates:[]};
}
export const pendingSpyfall=g=>g.status==='finished'?[]:g.phase==='question'?[g.turn]:g.phase==='answer'?[g.question.target]:g.players.filter(p=>!Object.hasOwn(g.votes,p.id)).map(p=>p.id);
function nextQuestion(g) {
 g.questions++;g.round=Math.min(2,Math.floor(g.questions/g.players.length)+1);
 if(g.questions>=g.players.length*2){g.phase='vote';g.turn=null}
 else{g.phase='question';g.turn=g.players[g.questions%g.players.length].id}
}
export function applySpyfall(g,seat,result) {
 if(!pendingSpyfall(g).includes(seat))throw Error('当前不是你的行动');
 const self=g.players.find(p=>p.id===seat);
 if(result?.type==='guess-location'){
  action(result,'guess-location',['location']);if(!self.spy)throw Error('仅间谍可以猜地点');
  const guess=text(result.location,30);if(!PLACES.some(([name])=>name===guess))throw Error('请从公开地点列表中选择');
  emit(g,`${seat} 摊牌猜地点「${guess}」`,{type:'location-guess',seat,location:guess});finish(g,guess===g.location?'spy':'agents',guess===g.location?'location-guessed':'wrong-location');return;
 }
 if(g.phase==='question'){
  action(result,'question',['target','text']);const to=target(g,result.target,seat,{abstain:false}),speech=text(result.text);
  g.question={seat,target:to,text:speech};g.phase='answer';emit(g,`${seat} 问 ${to}：${speech}`,{type:'question',...clone(g.question),speech});
 }else if(g.phase==='answer'){
  action(result,'answer',['text']);const speech=text(result.text);emit(g,`${seat} 回答：${speech}`,{type:'answer',seat,speech});nextQuestion(g);
 }else{
  action(result,'vote',['target']);g.votes[seat]=target(g,result.target,seat);
  if(!pendingSpyfall(g).length){
   const counts={};for(const vote of Object.values(g.votes))if(vote)counts[vote]=(counts[vote]||0)+1;
   const accused=Object.keys(counts).find(id=>counts[id]>=g.players.length-1)||null;
   g.lastVote={votes:clone(g.votes),accused};emit(g,accused?`除被指控者外全员一致指认 ${accused}`:'未形成一致指认，间谍成功脱身',{type:'vote',...clone(g.lastVote)});
   finish(g,accused&&g.players.find(p=>p.id===accused).spy?'agents':'spy',accused?'spy-vote':'no-consensus');
  }
 }
}
export function timeoutSpyfall(g,seat) {
 if(!pendingSpyfall(g).includes(seat))return;
 if(g.phase==='vote')applySpyfall(g,seat,{type:'vote',target:null});
 else{emit(g,`${seat} 超时，跳过本次${g.phase==='question'?'提问':'回答'}`,{type:'skip',seat});nextQuestion(g)}
}
export function spyfallView(g,seat=null,reveal=false) {
 const all=reveal||g.status==='finished',self=g.players.find(p=>p.id===seat);
 return {...baseView(g),players:g.players.map(p=>({id:p.id,alive:true,...(all?{spy:p.spy,occupation:p.occupation}:{})})),locations:PLACES.map(([name])=>name),...(all?{location:g.location}:{}),turn:g.turn,question:clone(g.question),questions:g.questions,maxQuestions:g.players.length*2,submitted:Object.keys(g.votes).length,lastVote:clone(g.lastVote),...(g.phase!=='vote'||reveal?{pendingSeats:pendingSpyfall(g)}:{}),...(reveal?{ballots:clone(g.votes)}:{}),...(self?{self:{id:seat,spy:self.spy,...(!self.spy?{location:g.location,occupation:self.occupation}:{})}}:{})};
}
export function spyfallSchema(g,seat) {
 const normal=g.phase==='question'?{type:'question',target:'其他席位 pN',text:'1–300 字公开问题，尽量不暴露地点'}:g.phase==='answer'?{type:'answer',text:'1–300 字公开回答'}:{type:'vote',target:'其他席位 pN 或 null 弃权；除被指控者外须全员一致才抓捕成功'};
 return g.players.find(p=>p.id===seat)?.spy?{oneOf:[normal,{type:'guess-location',location:'公开地点列表中的一个完整地点名；猜错立即失败'}]}:normal;
}
