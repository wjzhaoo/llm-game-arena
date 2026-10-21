// Called only for published events. Never consume private views or pending submissions.
export function publicActions(type, detail, game) {
 const actions=[];
 const add=(seat,summary,speech='',round=detail.round,ply)=>{if(seat)actions.push({seat,summary,speech,...(round!=null?{round}:{}),...(ply!=null?{ply}:{})})};
 if(type==='party-event'){
  const p=detail.party;
  const summaries={speech:'描述词语',bid:p.bid?`叫 ${p.bid.quantity} 个 ${p.bid.face} 点`:'叫点',reveal:p.bid?`质疑开骰 · 实际 ${p.actual} 个 ${p.bid.face} 点`:'质疑开骰',clue:p.clue?`给出线索「${p.clue.word} · ${p.clue.count}」`:'给出线索',guess:`翻开「${game.cards?.[p.index]?.word||''}」`,pass:'结束本轮猜词',question:`向 ${p.target} 提问`,answer:'回答问题','location-guess':`摊牌猜地点「${p.location}」`,skip:'超时，跳过行动'};
  if(summaries[p.type])add(p.seat,summaries[p.type],p.speech||'',p.round);
  if(p.type==='vote')for(const [seat,target]of Object.entries(p.votes||{}))add(seat,target?`投票给 ${target}`:'弃权','',p.round);
 }else if(type==='vote'){
  for(const [seat,target]of Object.entries(detail.votes||{}))add(seat,target?`投票给 ${target}`:'弃权');
 }else if(type==='action'&&detail.speech){add(detail.seat,'公开发言',detail.speech)}
 else if(type==='action'&&detail.move){
  const m=detail.move;
  add(detail.seat,m.text||`行棋（${m.from.join(',')}）→（${m.to.join(',')}）`,'',undefined,detail.ply);
 }else if(type==='chat-message'){
  const m=detail.message;
  add(m.seat,m.type==='emote'?`${m.emote.emoji} ${m.emote.label}`:'公开发言',m.type==='emote'?'':m.text,m.round);
 }else if(type==='chat-skip'){add(detail.seat,'跳过发言')}
 else if(type==='emote'){add(detail.seat,`${detail.emoji} ${detail.label}`,'',undefined,game.ply)}
 else if(type==='resigned'){add(detail.seat,'认输','',undefined,game.ply)}
 else if(type==='undo-request'){add(detail.request.requester,`申请悔棋 ${detail.request.plies} 手`,'',undefined,game.ply)}
 else if(['undo-accepted','undo-rejected'].includes(type)&&!detail.automatic){add(detail.seat,type==='undo-accepted'?`同意悔棋，撤回 ${detail.plies} 手`:'拒绝悔棋','',undefined,game.ply)}
 return actions;
}
