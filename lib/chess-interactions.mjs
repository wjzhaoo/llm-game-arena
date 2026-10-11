export const EMOTES = Object.freeze([
 {id:'good',emoji:'👍',label:'好棋'}, {id:'admire',emoji:'👏',label:'佩服'},
 {id:'laugh',emoji:'😄',label:'哈哈'}, {id:'lucky',emoji:'😅',label:'侥幸'},
 {id:'think',emoji:'🤔',label:'想想'}, {id:'surprised',emoji:'😱',label:'这…'},
 {id:'sad',emoji:'😭',label:'完了'}, {id:'defiant',emoji:'😤',label:'不服'},
 {id:'hurry',emoji:'🐢',label:'快点'}, {id:'handshake',emoji:'🤝',label:'承让'},
]);
export const EMOTE_COOLDOWN = 1500;
export const EMOTE_DURATION = 4000;
export const isChess = match => ['xiangqi','blind'].includes(match.kind);
export const opposite = seat => seat === 'red' ? 'black' : 'red';
export const sideName = seat => seat === 'red' ? '红方' : '黑方';

// Rollback state is server-only. Copy rule state without recursively copying
// the growing move list; that list is restored by its saved length.
export function checkpoint(game, job, now) {
 const {history,...rules} = game;
 return {game:structuredClone(rules),historyLength:history.length,
  remainingMs:Math.max(1,job.deadline-now),invalid:job.invalid||0};
}

export function undoAvailability(match, seat) {
 const unavailable = reason => ({allowed:false,reason,plies:0});
 if (!isChess(match)) return unavailable('仅棋类对局支持悔棋');
 if (!match.started) return unavailable('等待开局');
 if (match.game.status === 'finished') return unavailable('本局已结束');
 if (match.paused) return unavailable('比赛已暂停');
 if (match.undoRequest) return unavailable('等待当前悔棋请求处理');
 if (match.undoRequested?.[seat] === match.boardRevision) return unavailable('本局面已经申请过悔棋');
 const history=match.game.history, last=history.findLastIndex(move=>move.actor===seat);
 if (last<0) return unavailable('暂无自己的棋步可撤回');
 const plies=history.length-last, records=match.undoStack||[];
 const entry=records.find(record=>record.ply===last+1);
 if (!entry || plies>2) return unavailable('该棋步没有回退记录，升级后的新棋步才可悔棋');
 if (match.kind==='blind' && history.slice(last).some(move=>move.wasHidden||move.captureWasHidden))
  return unavailable('覆棋不能撤回揭子或吃掉暗子的步骤');
 return {allowed:true,reason:'',plies,targetPly:last};
}

export function publicUndo(match) {
 const request=match.undoRequest;
 return request ? {id:request.id,requester:request.requester,responder:request.responder,
  plies:request.plies,deadline:request.deadline} : null;
}
