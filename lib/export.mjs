import {ANIMALS} from './presentation.mjs';
const games = {xiangqi:'中国象棋',blind:'覆棋盲棋',werewolf:'六人狼人杀',groupchat:'自由群聊',undercover:'谁是卧底',liarsdice:'骗子骰子',codenames:'行动代号',spyfall:'谍报危机'};
const roles = {wolf:'狼人',seer:'预言家',witch:'女巫',villager:'村民',civilian:'平民',undercover:'卧底',spymaster:'队长',operative:'猜词者'};
const reasons = {
 'admin-ended':'房主结束','restarted':'重新开局','timeout-or-invalid':'超时或连续无效行动',
 'resigned':'认输','general-captured':'将帅被吃','checkmate':'将死','stalemate':'困毙',
 'no-legal-move':'无合法走法','threefold-repetition':'三次重复局面','quiet-120':'连续 120 手未吃子且未揭子',
 'ply-cap':'达到手数上限','no-survivors':'无人存活','all-wolves-eliminated':'狼人全部出局',
 'wolf-parity':'狼人存活人数不少于好人','round-cap':'达到轮数上限',
};
const eventTypes = {
 'participant-state':'公开状态','participant-appearance':'动物头像',created:'创建',started:'开始',action:'行动',emote:'表情',paused:'暂停',resumed:'继续',ended:'结束',result:'结算',
 dawn:'黎明',vote:'公开投票',connected:'接入',revoked:'撤销连接',resigned:'认输',
 timeout:'超时处理',referral:'行动异常','admin-retry':'允许重试','participant-type':'选手类型',
 'undo-request':'申请悔棋','undo-accepted':'同意悔棋',
 'undo-rejected':'拒绝悔棋','undo-rollback':'悔棋回退','chat-message':'聊天消息',
 'chat-selection':'发言意愿结算','chat-member':'成员变更','chat-profile':'设定更新',
 'chat-round':'讨论轮次','chat-idle':'等待讨论','chat-restart':'发起讨论','chat-skip':'跳过发言',
 'party-event':'游戏事件','chat-ready':'成员就绪','chat-emote':'发送表情',
};
const timeFormat = new Intl.DateTimeFormat('en-GB',{
 timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
 hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
});

function time(value) {
 const date = new Date(value);
 if (!Number.isFinite(date.getTime())) return '时间未知';
 const p = Object.fromEntries(timeFormat.formatToParts(date).map(part=>[part.type,part.value]));
 return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function markdown(value) {
 return String(value??'').replace(/\r\n?/g,'\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/[\\`*_[\]{}()#+.!|~-]/g,'\\$&');
}
const inline = value=>markdown(value).replace(/\n/g,' ');
const quote = value=>markdown(value).split('\n').map(line=>'> '+line).join('\n');
const seatName = seat=>seat==='red'?'红方':seat==='black'?'黑方':/^p\d+$/.test(seat||'')?seat.slice(1)+' 号':seat||'未知席位';
const person = p=>p?.nickname?`${p.nickname}（${seatName(p.seat)}）`:seatName(p?.seat);
const appearanceText = p=>`${ANIMALS.find(a=>a.id===p?.animalId)?.label||'未记录'} · ${p?.state||'未记录'}`;

function status(run) {
 return run.game.status==='finished'?'已结束':run.paused?'已暂停':run.started?'进行中':'未开局';
}

function result(run) {
 if (run.game.status!=='finished') return '尚未结束';
 if (run.kind==='groupchat') return '聊天已结束（不设胜负）';
 if (['undercover','liarsdice','codenames','spyfall'].includes(run.kind)&&run.game.winner) return ({civilians:'平民阵营获胜',undercover:'卧底阵营获胜',red:'红队获胜',blue:'蓝队获胜',spy:'间谍获胜',agents:'普通玩家获胜'})[run.game.winner]||person(run.participants.find(p=>p.seat===run.game.winner)||{seat:run.game.winner})+' 获胜';
 if (run.game.winner) return ({red:'红方获胜',black:'黑方获胜',wolves:'狼人阵营获胜',good:'好人阵营获胜'})[run.game.winner]||run.game.winner;
 return ['admin-ended','restarted'].includes(run.game.reason)?'未判定胜负':'平局';
}

function participants(run) {
 const people = new Map((run.participants||[]).map(p=>[p.seat,p]));
 // Public snapshots retain silent members who left before the export.
 if (run.kind==='groupchat') for (let i=(run.history||[]).length-1;i>=0;i--) {
  for (const p of run.history[i].game?.members||[]) if (!people.has(p.seat)) people.set(p.seat,p);
 }
 // Message snapshots also retain members who have since left the topic.
 for (const e of run.events||[]) for (const p of [e.message?.sender,e.message?.emote?.target,...(e.selection?.scores||[])]) {
  if (p?.seat&&!people.has(p.seat)) people.set(p.seat,p);
 }
 return [...people.values()];
}

function eventBody(event,run,people) {
 people=event.eventPeople||people;
 const message = event.type==='chat-message'?event.message:null;
 if (message) {
  const lines = [`${person(message.sender||{seat:message.seat})}（${appearanceText(message.sender)}）：`];
  if (message.text) lines.push(message.text);
  if (message.emote) {
   const e = message.emote,target = e.target||(e.targetSeat?people.find(p=>p.seat===e.targetSeat):null);
   lines.push(`表情：${e.emoji||''} ${e.label||e.id||''}${e.targetSeat?' → '+person(target||{seat:e.targetSeat}):''}`);
  }
  return lines.join('\n');
 }
 if (event.type==='chat-selection'&&event.selection) {
  const s = event.selection;
  return `${event.text}\n公开分数：${(s.scores||[]).map(p=>person(p)+'：'+(p.score===null?'超时弃权':p.score)).join('；')}`;
 }
 if (event.type==='action'&&run.kind==='werewolf'&&typeof event.speech==='string') {
  const author=people.find(p=>p.seat===event.seat)||{seat:event.seat};
  return `${person(author)}（${appearanceText(author)}）：\n${event.speech}`;
 }
 if (event.type==='action'&&run.kind==='xiangqi') {
  const match = /^(red|black)：(\{.*\})$/.exec(event.rawText||event.text||'');
  if (match) {
   try {
    const move = JSON.parse(match[2]);
    if ([move.from,move.to].every(cell=>Array.isArray(cell)&&cell.length===2&&cell.every(Number.isInteger))) {
     return `${person(people.find(p=>p.seat===match[1])||{seat:match[1]})}：从 [${move.from.join(',')}] 到 [${move.to.join(',')}]`;
    }
   } catch {} // Older event text remains readable even when it is not a move JSON.
  }
 }
 return event.text||'（无正文）';
}

function runSection(run) {
 const people = participants(run),g = run.game,heading = run.kind==='groupchat'?`话题 ${run.runNumber}：${g.topic}`:`第 ${run.runNumber} 局`;
 const lines = [`## ${inline(heading)}`,'',`- 创建时间：${time(run.runCreatedAt||run.createdAt)}`,
  `- 状态：${status(run)}`,`- 结果：${inline(result(run))}`];
 if (g.status==='finished'&&g.reason) lines.push(`- 结束原因：${inline(reasons[g.reason]||g.reason)}`);
 lines.push('','### 参与者','','| 席位 | 昵称 | 类型 | 平台 | 公开身份 | 动物与公开状态 |','| --- | --- | --- | --- | --- | --- |');
 for (const p of people) {
  const role = g.players?.find(player=>player.id===p.seat)?.role;
  lines.push(`| ${inline(seatName(p.seat))} | ${inline(p.nickname||'未命名')} | ${p.type==='human'?'真人':'AI'} | ${inline(p.type==='human'?'浏览器':p.provider||'未接入')} | ${inline(role?(roles[role]||role):'—')} | ${inline(appearanceText(p))} |`);
 }
 if (!people.length) lines.push('| — | 暂无参与者 | — | — | — |');
 lines.push('','### 公开记录','');
 const events = (run.events||[]).map((event,index)=>({event,index})).sort((a,b)=>
  ((Date.parse(a.event.at)||0)-(Date.parse(b.event.at)||0))||a.index-b.index);
 for (const {event} of events) {
  lines.push(`#### ${time(event.at)} · ${eventTypes[event.type]||'公开事件'}`,'',quote(eventBody(event,run,people)),'');
  if(event.eventPeople)lines.push('当时公开形象：'+event.eventPeople.map(p=>inline(person(p)+'（'+appearanceText(p)+'）')).join('；'),'');
 }
 if (!events.length) lines.push('暂无公开记录。','');
 return lines.join('\n');
}

function filename(title,scope,run,exportedAt) {
 const safe = Array.from(String(title||'游戏记录').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}\uD800-\uDFFF]/gu,'_').trim().replace(/[. ]+$/g,''))
  .slice(0,48).join('')||'游戏记录';
 const label = scope==='room'?'全部记录':`第${run.runNumber}局`;
 return `${safe}_${label}_${time(exportedAt).replace(/[-:]/g,'').replace(' ','-')}.md`;
}

// Only public projections reach this formatter; never serialize a room's raw save.
export function markdownExport({title,kind,scope,runs,exportedAt}) {
 const ordered = runs.slice().sort((a,b)=>a.runNumber-b.runNumber);
 const content = [`# ${inline(title)} · 游戏记录`,'',`- 游戏：${games[kind]||inline(kind)}`,
  `- 导出范围：${scope==='room'?'房间全部记录':'当前所选局／话题'}`,`- 导出时间：${time(exportedAt)}`,
  '- 时区：Asia/Shanghai（UTC+08:00）','',
  '> 本文仅包含公开信息。进行中的对局记录截至导出时刻，所选局的记录不受页面回放进度影响。','',
  ...ordered.map(runSection)].join('\n');
 return {filename:filename(title,scope,ordered[0],exportedAt),content:content.endsWith('\n')?content:content+'\n'};
}

export function markdownDisposition(filename) {
 const encoded = encodeURIComponent(filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 return `attachment; filename="arena-records.md"; filename*=UTF-8''${encoded}`;
}
