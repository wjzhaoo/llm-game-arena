export const names={rK:'帥',rA:'仕',rE:'相',rH:'馬',rR:'車',rC:'炮',rP:'兵',bK:'將',bA:'士',bE:'象',bH:'馬',bR:'車',bC:'砲',bP:'卒'};
export const same=(a,b)=>!!a&&!!b&&a[0]===b[0]&&a[1]===b[1];
export const toWorld=([x,y])=>({x:x-4,z:y-4.5});
export function fromWorld(x,z){
 const file=Math.round(x+4),rank=Math.round(z+4.5);
 return file>=0&&file<9&&rank>=0&&rank<10&&Math.abs(x+4-file)<=.48&&Math.abs(z+4.5-rank)<=.48?[file,rank]:null;
}
export function visiblePiece(piece){
 if(!piece)return null;
 if(typeof piece==='string')return {side:piece[0]==='r'?'red':'black',glyph:names[piece]||'?',hidden:false,hint:''};
 const code=(piece.side==='red'?'r':'b')+piece.kind;
 return {side:piece.side,glyph:piece.hidden?'暗':names[code]||'?',hidden:!!piece.hidden,hint:piece.hidden?names[code]||'?':''};
}
