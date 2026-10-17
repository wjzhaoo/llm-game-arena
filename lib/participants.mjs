export function nickname(value='',fallback='') {
 if(typeof value!=='string')throw Error('昵称必须是文本');
 return Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu,'').trim()).slice(0,16).join('')||fallback;
}
