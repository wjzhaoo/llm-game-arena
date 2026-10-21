import {shuffle,countPlayers,action,text,emit,finish,baseView,clone} from './common.mjs';

const WORDS='月亮 星星 太阳 银河 火箭 宇航员 彗星 望远镜 海洋 鲸鱼 珊瑚 帆船 港口 灯塔 沙滩 海盗 森林 松鼠 蘑菇 树叶 木屋 狐狸 猎人 蜂蜜 沙漠 骆驼 绿洲 金字塔 石头 风暴 城堡 骑士 皇冠 宝剑 盾牌 巨龙 公主 马车 图书馆 书签 钢笔 纸张 密码 地图 相机 镜子 音乐 钢琴 吉他 鼓声 舞台 电影 演员 面具 火锅 辣椒 面包 咖啡 茶杯 苹果 西瓜 奶酪 医院 医生 药片 体温 心脏 眼睛 牙齿 手套 学校 教师 黑板 粉笔 铅笔 考试 操场 足球 篮球 游泳 冰雪 山峰 云朵 雨伞 雷电 铁路 火车 地铁 飞机 机场 车站 自行车 轮胎 时钟 日历 信封 邮票 钱包 钥匙 锁链 桥梁 蝴蝶 蜜蜂 花园 玫瑰 向日葵 种子 麦田 稻草 黄金 白银 钻石 水晶 宝藏 银行 硬币 商店 弹簧 电池 磁铁 机器人 电脑 鼠标 键盘 网络'.split(' ');
export function initialCodenames({playerCount}={}) {
 countPlayers(playerCount,4,4,4);
 const players=[{id:'p1',team:'red',role:'spymaster'},{id:'p2',team:'red',role:'operative'},{id:'p3',team:'blue',role:'spymaster'},{id:'p4',team:'blue',role:'operative'}],keys=shuffle([...Array(9).fill('red'),...Array(8).fill('blue'),...Array(7).fill('neutral'),'assassin']);
 return {game:'codenames',players,playerCount:4,cards:shuffle(WORDS).slice(0,25).map((word,index)=>({index,word,team:keys[index],revealed:false})),status:'playing',winner:null,reason:null,round:1,phase:'clue',team:'red',clue:null,remainingGuesses:0,guessesMade:0,log:[],updates:[]};
}
export const pendingCodenames=g=>g.status==='finished'?[]:[g.players.find(p=>p.team===g.team&&p.role===(g.phase==='clue'?'spymaster':'operative')).id];
const remaining=(g,team)=>g.cards.filter(c=>c.team===team&&!c.revealed).length;
function nextTurn(g) {
 if(g.round>=40){finish(g,null,'round-cap');return}
 g.team=g.team==='red'?'blue':'red';g.phase='clue';g.round++;g.remainingGuesses=0;g.guessesMade=0;g.clue=null;
}
export function applyCodenames(g,seat,result) {
 if(!pendingCodenames(g).includes(seat))throw Error('当前不是你的行动');
 if(g.phase==='clue'){
  action(result,'clue',['word','count']);const word=text(result.word,12);
  if(/[\s\p{P}\p{S}\d]/u.test(word)||!Number.isInteger(result.count)||result.count<1||result.count>9)throw Error('提示须为一个词，数量须为 1–9 的整数');
  if(g.cards.some(c=>!c.revealed&&(c.word.includes(word)||word.includes(c.word))))throw Error('提示不能直接使用未翻开词牌的文字');
  g.clue={word,count:result.count,seat};g.remainingGuesses=result.count+1;g.guessesMade=0;g.phase='guess';
  emit(g,`${seat} 给出提示「${word} · ${result.count}」`,{type:'clue',seat,team:g.team,clue:clone(g.clue)});
 }else if(result?.type==='pass'){
  action(result,'pass');if(g.guessesMade<1)throw Error('每个提示至少需要猜一张词牌');emit(g,`${seat} 结束本轮猜词`,{type:'pass',seat});nextTurn(g);
 }else{
  action(result,'guess',['index']);const card=g.cards[result.index];
  if(!Number.isInteger(result.index)||!card||card.revealed)throw Error('请选择尚未翻开的词牌');
  card.revealed=true;g.guessesMade++;g.remainingGuesses--;
  emit(g,`${seat} 翻开「${card.word}」：${({red:'红队特工',blue:'蓝队特工',neutral:'路人',assassin:'刺客'})[card.team]}`,{type:'guess',seat,index:card.index,team:card.team});
  if(card.team==='assassin')finish(g,g.team==='red'?'blue':'red','assassin');
  else if(!remaining(g,'red'))finish(g,'red','agents-found');
  else if(!remaining(g,'blue'))finish(g,'blue','agents-found');
  else if(card.team!==g.team||g.remainingGuesses===0)nextTurn(g);
 }
}
export function timeoutCodenames(g,seat) {
 if(!pendingCodenames(g).includes(seat))return;
 emit(g,`${seat} 超时，本队回合结束`,{type:'skip',seat});nextTurn(g);
}
export function codenamesView(g,seat=null,reveal=false) {
 const self=g.players.find(p=>p.id===seat),all=reveal||g.status==='finished'||self?.role==='spymaster';
 return {...baseView(g),players:clone(g.players),cards:g.cards.map(c=>({index:c.index,word:c.word,revealed:c.revealed,...(all||c.revealed?{team:c.team}:{})})),team:g.team,clue:clone(g.clue),remainingGuesses:g.remainingGuesses,guessesMade:g.guessesMade,remaining:{red:remaining(g,'red'),blue:remaining(g,'blue')},pendingSeats:pendingCodenames(g),...(self?{self:clone(self)}:{})};
}
export const codenamesSchema=g=>g.phase==='clue'?{type:'clue',word:'一个不含空白、数字或标点的词，1–12 字；不能包含未翻开词牌文字',count:'1..9 的整数；提示须基于词义，不得编码坐标'}:{oneOf:[{type:'guess',index:'尚未翻开的词牌 index，整数 0..24'},{type:'pass',note:'已猜至少一次后可主动结束回合'}]};
