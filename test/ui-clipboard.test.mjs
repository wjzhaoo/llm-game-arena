import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function browser({clipboard,legacy=true,unselectable=false}={}){
 const elements=new Map(),nodes=[],copyCalls=[];
 let copied='原剪贴板内容',document;
 function element(id='',tag='textarea'){
  if(id&&elements.has(id))return elements.get(id);
  const node={id,tagName:tag.toUpperCase(),value:'',textContent:'',innerHTML:'',disabled:false,open:false,dataset:{},style:{},listeners:{},isConnected:true,selectionStart:0,selectionEnd:0,options:[],children:[],
   closest(selector){let parent=this;while(parent){if(selector==='dialog'&&parent.tagName==='DIALOG')return parent;parent=parent.parentElement}return null},
   append(child){child.parentElement=this;child.isConnected=true;this.children.push(child)},
   remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this)},
   addEventListener(name,fn){this.listeners[name]=fn},
   showModal(){this.open=true;document.activeElement=this},close(){this.open=false;this.listeners.close?.()},
   focus(){if(unselectable)return;const modal=[...elements.values()].find(item=>item.tagName==='DIALOG'&&item.open);if(!modal||this.closest('dialog')===modal)document.activeElement=this},
   select(){if(document.activeElement===this){this.selectionStart=0;this.selectionEnd=this.value.length}},
   setSelectionRange(start,end){if(document.activeElement===this){this.selectionStart=start;this.selectionEnd=end}},
   querySelector(){return null}
  };
  nodes.push(node);if(id)elements.set(id,node);return node;
 }
 const body=element('body','body'),inviteDialog=element('inviteDialog','dialog'),shareDialog=element('shareDialog','dialog');
 inviteDialog.append(element('inviteText'));inviteDialog.append(element('copyInvite','button'));
 shareDialog.append(element('roomLink','input'));shareDialog.append(element('copyRoomLink','button'));
 document={body,activeElement:body,getElementById:id=>element(id),querySelectorAll:selector=>selector==='dialog[open]'?[...elements.values()].filter(node=>node.tagName==='DIALOG'&&node.open):[],
  querySelector:selector=>selector==='dialog[open]'?[...elements.values()].find(node=>node.tagName==='DIALOG'&&node.open):null,
  createElement:tag=>element('',tag),addEventListener(){},
  execCommand(command){const selected=document.activeElement;copyCalls.push({command,selected,modal:selected.closest('dialog')});if(legacy&&selected.selectionEnd>selected.selectionStart)copied=selected.value.slice(selected.selectionStart,selected.selectionEnd);return legacy}
 };
 const ctx=vm.createContext({URL,URLSearchParams,Date,Map,Set,JSON,Error,Promise,
  location:{href:'http://192.168.50.2:4318/',origin:'http://192.168.50.2:4318'},history:{replaceState(){}},
  sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},document,ArenaTheme:{preference:'system',set(){}},
  navigator:clipboard?{clipboard}: {},setInterval(){},
  fetch:async(route,options)=>({ok:true,status:200,json:async()=>route==='/api/network'?{localOrigin:'http://127.0.0.1:4318',lanOrigins:['http://192.168.50.2:4318']}:route==='/api/matches'?[]:route==='/api/invite'?{seat:JSON.parse(options.body).seat,text:'更新后的邀请提示词'}:{}})
 });
 vm.runInContext(fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),ctx);
 await new Promise(resolve=>setImmediate(resolve));
 return {ctx,document,element,nodes,copyCalls,copied:()=>copied};
}

const prompt='本邀请仅供黑方选手使用。\nnode client.mjs connect --seat black\n局域网另一台电脑 · 远端转接';

test('LAN HTTP fallback copies exactly the visible prompt inside the active modal',async()=>{
 const b=await browser();b.element('inviteText').value=prompt;b.element('inviteDialog').showModal();
 await b.element('copyInvite').onclick();
 assert.equal(b.copied(),prompt);
 assert.equal(b.copyCalls[0].selected,b.element('inviteText'));
 assert.equal(b.copyCalls[0].modal,b.element('inviteDialog'));
 assert.equal(b.element('copyInvite').textContent,'已复制');
});

test('Clipboard API rejection falls back inside the modal; successive copies replace the old prompt',async()=>{
 const b=await browser({clipboard:{writeText:async()=>{throw Error('NotAllowedError')}}});
 b.element('inviteDialog').showModal();
 for(const value of [prompt,'本邀请仅供红方选手使用。\n新邀请提示词']){
  b.element('inviteText').value=value;
  await b.element('copyInvite').onclick();
  assert.equal(b.copied(),value);
 }
 assert.equal(b.copyCalls.length,2);
});

test('Failed fallback preserves all selected text for manual copy and never shows copied',async()=>{
 const b=await browser({legacy:false});b.element('inviteText').value=prompt;b.element('inviteDialog').showModal();
 await b.element('copyInvite').onclick();
 assert.equal(b.copied(),'原剪贴板内容');
 assert.equal(b.element('inviteText').selectionStart,0);
 assert.equal(b.element('inviteText').selectionEnd,prompt.length);
 assert.equal(b.document.activeElement,b.element('inviteText'));
 assert.notEqual(b.element('copyInvite').textContent,'已复制');
 assert.match(b.element('notice').textContent,/Ctrl\+C/);
 assert.equal(b.element('copyInvite').disabled,false);
});

test('Legacy true result without a focused selection is treated as a failure',async()=>{
 const b=await browser({unselectable:true});b.element('inviteText').value=prompt;b.element('inviteDialog').showModal();
 await b.element('copyInvite').onclick();
 assert.equal(b.copied(),'原剪贴板内容');
 assert.notEqual(b.element('copyInvite').textContent,'已复制');
 assert.equal(b.copyCalls.length,0);
});

test('Modern clipboard copies the exact prompt without a fallback element',async()=>{
 const writes=[],b=await browser({clipboard:{writeText:async value=>writes.push(value)}});
 b.element('inviteText').value=prompt;b.element('inviteDialog').showModal();
 await b.element('copyInvite').onclick();
 assert.deepEqual(writes,[prompt]);assert.equal(b.copyCalls.length,0);
 assert.equal(b.element('copyInvite').textContent,'已复制');
});

test('Generic fallback uses the active modal and removes its temporary field; room links reuse their field',async()=>{
 const b=await browser();b.element('shareDialog').showModal();
 await b.ctx.copyText('临时复制内容');
 assert.equal(b.copied(),'临时复制内容');
 assert.equal(b.copyCalls[0].modal,b.element('shareDialog'));
 assert.equal(b.copyCalls[0].selected.isConnected,false);
 const link='http://192.168.50.2:4318/?room=fixture#join=fixture';
 b.element('roomLink').value=link;
 await b.element('copyRoomLink').onclick();
 assert.equal(b.copied(),link);assert.equal(b.copyCalls[1].selected,b.element('roomLink'));
});

test('Changing the invitation resets copied feedback and does not copy an outdated fallback after API denial',async()=>{
 let deny;
 const b=await browser({clipboard:{writeText:()=>new Promise((resolve,reject)=>{deny=reject})}});
 b.element('inviteDialog').showModal();b.element('inviteText').value=prompt;b.element('copyInvite').textContent='已复制';
 const copying=b.element('copyInvite').onclick();
 vm.runInContext("invitationSeat='black';current='clipboard-room'",b.ctx);
 await b.ctx.loadInvitation();
 assert.equal(b.element('copyInvite').textContent,'复制邀请');
 assert.equal(b.element('copyInvite').disabled,false);
 deny(Error('NotAllowedError'));await copying;
 assert.equal(b.copied(),'原剪贴板内容');assert.equal(b.copyCalls.length,0);
 assert.equal(b.element('copyInvite').textContent,'复制邀请');
 assert.match(b.element('inviteText').value,/更新后的邀请提示词/);
});

test('Closing the invitation while copying does not restore old text or copied feedback',async()=>{
 let deny;
 const b=await browser({clipboard:{writeText:()=>new Promise((resolve,reject)=>{deny=reject})}});
 b.element('inviteDialog').showModal();b.element('inviteText').value=prompt;
 const copying=b.element('copyInvite').onclick();
 b.element('inviteDialog').close();deny(Error('NotAllowedError'));await copying;
 assert.equal(b.element('inviteText').value,'');
 assert.notEqual(b.element('copyInvite').textContent,'已复制');
 assert.equal(b.copyCalls.length,0);
});
