// Participant identity belongs to connection management, not the model's game context.
// Keep message/action types and all user-authored text unchanged.
const identityFields=new Set(['type','provider','online','continuationMode','wakeTransport']);
export function participantContext(value) {
 if(Array.isArray(value))return value.map(participantContext);
 if(!value||typeof value!=='object')return value;
 const participant=value.type==='human'||value.type==='ai';
 const result=Object.fromEntries(Object.entries(value).filter(([key])=>!participant||!identityFields.has(key)).map(([key,item])=>[key,participantContext(item)]));
 if(value.type==='connected'||value.type==='participant-type'){
  for(const key of ['text','rawText'])if(typeof result[key]==='string')result[key]=result[key].replace(/ 真人已接入/g,' 已接入').replace(/ 已设为(?:真人|AI)/g,' 的席位设置已更新');
 }
 return result;
}
