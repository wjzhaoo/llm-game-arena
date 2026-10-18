const seatName = seat=>seat==='red'?'红方':seat==='black'?'黑方':/^p\d+$/.test(seat)?seat.slice(1)+' 号':seat;
const person = p=>p.nickname?`${p.nickname}（${seatName(p.seat)}）`:seatName(p.seat);

// Only replace system-authored seat references; a player's speech remains verbatim.
export function namedEvent(event,participants=[]) {
 const people=event.eventPeople||participants;
 const rawText=event.rawText??event.text??'';
 const label=seat=>person(people.find(p=>p.seat===seat)||{seat});
 let text=rawText;
 if(event.type==='chat-message'&&event.message){
  const m=event.message;
  text=person(m.sender||{seat:m.seat})+'：'+(m.type==='emote'?m.emote.emoji+' '+m.emote.label:m.text);
 }else if(event.type==='chat-selection'&&event.selection){
  const s=event.selection;
  text=s.speaker?'本轮由 '+person(s.scores.find(p=>p.seat===s.speaker)||{seat:s.speaker})+' 发言':'本轮无人申请发言';
 }else if(event.type==='action'){
  text=rawText.replace(/^(red|black|p\d+)：/,(_,seat)=>label(seat)+'：');
 }else{
  text=rawText.replace(/\b(red|black|p\d+)\b|红方|黑方/g,token=>label(token==='红方'?'red':token==='黑方'?'black':token));
 }
 return {...event,rawText,text};
}
