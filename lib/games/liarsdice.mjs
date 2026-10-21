import {randomInt} from 'node:crypto';
import {countPlayers,roster,living,action,text,emit,finish,baseView,clone} from './common.mjs';
const roll=g=>{for(const p of g.players)p.dice=Array.from({length:p.count},()=>randomInt(1,7))};
const next=(g,id)=>{const index=g.players.findIndex(p=>p.id===id);for(let i=1;i<=g.players.length;i++){const p=g.players[(index+i)%g.players.length];if(p.alive)return p.id}};
export function initialLiarsdice({playerCount}={}) {
 const players=roster(countPlayers(playerCount,4,2,6));for(const p of players)p.count=5;
 const g={game:'liarsdice',players,playerCount:players.length,status:'playing',winner:null,reason:null,round:1,phase:'bid',turn:'p1',bid:null,lastRound:null,log:[],updates:[]};roll(g);return g;
}
export const pendingLiarsdice=g=>g.status==='finished'?[]:[g.turn];
export function validBid(g,quantity,face) {
 const total=living(g).reduce((n,p)=>n+p.count,0),old=g.bid;
 if(!Number.isInteger(quantity)||quantity<1||quantity>total||!Number.isInteger(face)||face<1||face>6)return false;
 if(!old)return true;
 if(old.face===1&&face!==1)return quantity>=old.quantity*2+1;
 if(old.face!==1&&face===1)return quantity>=Math.ceil(old.quantity/2);
 return quantity>old.quantity||quantity===old.quantity&&face>old.face;
}
export function applyLiarsdice(g,seat,result) {
 if(!pendingLiarsdice(g).includes(seat))throw Error('当前不是你的行动');
 if(result?.type==='bid'){
  action(result,'bid',['quantity','face','text']);if(!validBid(g,result.quantity,result.face))throw Error('叫点必须提高上一口，且不能超过总骰数；1 点转换见规则');
  const speech=result.text===undefined?'':text(result.text,120);g.bid={seat,quantity:result.quantity,face:result.face};
  emit(g,`${seat} 叫 ${result.quantity} 个 ${result.face} 点${speech?'：'+speech:''}`,{type:'bid',seat,speech,bid:clone(g.bid)});g.turn=next(g,seat);
 }else{
  action(result,'challenge',['text']);if(!g.bid)throw Error('首位选手必须先叫点');
  const speech=result.text===undefined?'':text(result.text,120),bid=clone(g.bid),dice=g.players.map(p=>({id:p.id,dice:p.dice.slice()})),actual=dice.flatMap(p=>p.dice).filter(v=>v===bid.face||bid.face!==1&&v===1).length,loser=actual>=bid.quantity?seat:bid.seat,p=g.players.find(p=>p.id===loser);
  p.count--;p.alive=p.count>0;if(!p.alive)p.dice=[];g.lastRound={round:g.round,bid,challenger:seat,actual,loser,dice};
  emit(g,`${seat} 质疑${speech?'：'+speech:''}；开骰共有 ${actual} 个 ${bid.face} 点，${loser} 失去一枚骰子`,{type:'reveal',seat,speech,...clone(g.lastRound)});
  const alive=living(g);if(alive.length===1){finish(g,alive[0].id,'last-player');return}
  g.round++;g.bid=null;g.turn=p.alive?loser:next(g,loser);roll(g);
 }
}
export function timeoutLiarsdice(g,seat) {if(pendingLiarsdice(g).includes(seat))applyLiarsdice(g,seat,g.bid?{type:'challenge'}:{type:'bid',quantity:1,face:2})}
export function liarsdiceRuleCheck(g,seat) {
 const self=g.players.find(p=>p.id===seat),total=living(g).reduce((n,p)=>n+p.count,0);
 const minimumBids=[];
 for(let face=1;face<=6;face++)for(let quantity=1;quantity<=total;quantity++)if(validBid(g,quantity,face)){minimumBids.push({face,quantity});break}
 const bid=g.bid,known=bid&&self?self.dice.filter(v=>v===bid.face||bid.face!==1&&v===1).length:null;
 return {minimumBids,canChallenge:!!bid,
  guidance:'行动前核对万能点、本人已知骰子和合法叫点。1 点计入其他点数；叫 1 时只数 1。期望不是保证，也不是质疑胜率；公开喊话可能是诈唬。minimumBids 列出每种点数的最小合法数量，超过总骰数的选项不列出。',
  ...(bid&&self?{currentBid:{knownMatches:known,unknownDice:total-self.dice.length,unknownMatchProbability:bid.face===1?1/6:1/3,expectedTotal:known+(total-self.dice.length)*(bid.face===1?1/6:1/3)}}:{})};
}
export function liarsdiceView(g,seat=null,reveal=false) {
 const all=reveal||g.status==='finished',self=g.players.find(p=>p.id===seat);
 return {...baseView(g),ruleCheck:liarsdiceRuleCheck(g,seat),players:g.players.map(p=>({id:p.id,alive:p.alive,count:p.count,...(all?{dice:p.dice.slice()}:{})})),turn:g.turn,bid:clone(g.bid),totalDice:living(g).reduce((n,p)=>n+p.count,0),lastRound:clone(g.lastRound),pendingSeats:pendingLiarsdice(g),...(self?{self:{id:seat,alive:self.alive,dice:self.dice.slice()}}:{})};
}
export const liarsdiceSchema={oneOf:[{type:'bid',quantity:'1..总骰数的整数，必须按规则提高上一口',face:'1..6 的整数',text:'可选，1–120 字公开喊话'},{type:'challenge',text:'可选，1–120 字公开喊话；已有叫点时才可质疑'}]};
