import {randomInt} from 'node:crypto';

export const clone = value => structuredClone(value);
export function shuffle(items) {
 const result=items.slice();
 for(let i=result.length-1;i>0;i--){const j=randomInt(i+1);[result[i],result[j]]=[result[j],result[i]]}
 return result;
}
export function countPlayers(value,fallback,min,max) {
 const count=value??fallback;
 if(!Number.isInteger(count)||count<min||count>max)throw Error(`选手人数须为 ${min}–${max} 人`);
 return count;
}
export const roster=count=>Array.from({length:count},(_,i)=>({id:'p'+(i+1),alive:true}));
export const living=g=>g.players.filter(p=>p.alive);
export function action(input,type,keys=[]) {
 if(!input||typeof input!=='object'||Array.isArray(input)||input.type!==type||Object.keys(input).some(k=>!['type',...keys].includes(k)))throw Error('请按当前行动格式提交');
}
export function text(value,max=300) {
 if(typeof value!=='string'||!value.trim()||Array.from(value).length>max||/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/g,'')))throw Error(`请填写 1–${max} 字的有效文本`);
 return value.trim();
}
export function target(g,value,seat,{abstain=true}={}) {
 if(value===null&&abstain)return null;
 if(!g.players.some(p=>p.id===value&&p.alive&&p.id!==seat))throw Error('请选择其他有效选手');
 return value;
}
export function emit(g,message,detail={}) {
 const event={round:g.round,...detail,text:message};
 g.log.push(event);g.updates.push(event);
}
export function finish(g,winner,reason) {
 g.status='finished';g.phase='finished';g.winner=winner;g.reason=reason;
}
export function baseView(g) {
 return {game:g.game,status:g.status,winner:g.winner,reason:g.reason,phase:g.phase,round:g.round,log:clone(g.log.slice(-50))};
}
