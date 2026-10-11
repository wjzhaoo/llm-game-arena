import * as THREE from './vendor/three/three.module.js';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {same,toWorld,fromWorld,visiblePiece} from './chess-coordinates.mjs';

export function createChess3D(container,{onPick,onFailure}){
 const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
 const canvas=renderer.domElement;canvas.className='chess3d-canvas';canvas.setAttribute('aria-label','立体棋盘，拖动旋转、滚轮缩放；下方提供键盘辅助操作');
 container.append(canvas);renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(43,1,.1,100);
 const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.enablePan=false;controls.minDistance=10;controls.maxDistance=30;controls.minPolarAngle=.15;controls.maxPolarAngle=1.12;
 scene.add(new THREE.HemisphereLight(0xffffff,0x6a5540,2.3));
 const light=new THREE.DirectionalLight(0xffffff,2.6);light.position.set(-5,12,7);scene.add(light);
 const geometries=new Set(),materials=new Set(),textures=new Set(),faceCache=new Map();
 const geometry=g=>{geometries.add(g);return g}, material=m=>{materials.add(m);return m};
 const boardMaterial=material(new THREE.MeshStandardMaterial({color:0x7d522c,roughness:.75}));
 const board=new THREE.Mesh(geometry(new THREE.BoxGeometry(10.2,.42,11.2)),boardMaterial);board.position.y=-.22;scene.add(board);
 const boardCanvas=document.createElement('canvas');boardCanvas.width=1020;boardCanvas.height=1120;
 const boardTexture=new THREE.CanvasTexture(boardCanvas);boardTexture.colorSpace=THREE.SRGBColorSpace;textures.add(boardTexture);
 const surface=new THREE.Mesh(geometry(new THREE.PlaneGeometry(10.2,11.2)),material(new THREE.MeshStandardMaterial({map:boardTexture,roughness:.87})));
 surface.rotation.x=-Math.PI/2;surface.position.y=.002;scene.add(surface);
 const pieces=new THREE.Group(),markers=new THREE.Group();scene.add(pieces,markers);
 const cylinder=geometry(new THREE.CylinderGeometry(.37,.39,.28,40)),faceGeometry=geometry(new THREE.CircleGeometry(.335,40));
 const selectedGeometry=geometry(new THREE.RingGeometry(.41,.46,48)),targetGeometry=geometry(new THREE.RingGeometry(.11,.18,32)),captureGeometry=geometry(new THREE.RingGeometry(.40,.45,48)),lastGeometry=geometry(new THREE.RingGeometry(.38,.40,48));
 const markerMaterials={};for(const key of ['selected','legal','capture','history'])markerMaterials[key]=material(new THREE.MeshBasicMaterial({side:THREE.DoubleSide,transparent:true,opacity:.95,depthTest:false}));
 const barGeometry=geometry(new THREE.BoxGeometry(9.6,.035,.10)),bars={};
 for(const side of ['red','black']){
  const mat=material(new THREE.MeshStandardMaterial({color:side==='red'?0xe36e50:0x83b7ef,emissive:side==='red'?0xb93220:0x2472be,emissiveIntensity:.1}));
  const bar=new THREE.Mesh(barGeometry,mat);bar.position.set(0,.025,side==='red'?5.13:-5.13);bars[side]=bar;scene.add(bar);
 }
 let current=null,side=null,theme=null,fingerprint='',markerKey='',disposed=false,frame=0,start=null,pointers=new Set(),dragged=false;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 function reset(){camera.position.set(0,13,side==='black'?-12:12);controls.target.set(0,0,0);controls.update()}
 function resize(){if(disposed)return;const r=container.getBoundingClientRect();if(!r.width||!r.height)return;camera.aspect=r.width/r.height;camera.updateProjectionMatrix();renderer.setSize(r.width,r.height,false)}
 const observer=new ResizeObserver(resize);observer.observe(container);
 function palette(){const style=getComputedStyle(document.documentElement);return Object.fromEntries(['stage','board','board-grid','river-ink','board-frame','selected','legal','capture','history'].map(key=>[key,style.getPropertyValue('--'+key).trim()]))}
 function paintBoard(colors){
  const ctx=boardCanvas.getContext('2d');ctx.fillStyle=colors.board;ctx.fillRect(0,0,1020,1120);
  ctx.strokeStyle=colors['board-grid'];ctx.lineWidth=3;
  ctx.beginPath();for(let y=0;y<10;y++){ctx.moveTo(110,110+y*100);ctx.lineTo(910,110+y*100)}
  for(let x=0;x<9;x++){ctx.moveTo(110+x*100,110);ctx.lineTo(110+x*100,x===0||x===8?1010:510);if(x!==0&&x!==8){ctx.moveTo(110+x*100,610);ctx.lineTo(110+x*100,1010)}}
  for(const y of [0,7]){ctx.moveTo(410,110+y*100);ctx.lineTo(610,310+y*100);ctx.moveTo(610,110+y*100);ctx.lineTo(410,310+y*100)}ctx.stroke();
  ctx.fillStyle=colors['river-ink'];ctx.font='56px KaiTi, STKaiti, serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('楚 河',310,560);ctx.fillText('漢 界',710,560);
  ctx.strokeStyle=colors['board-frame'];ctx.lineWidth=12;ctx.strokeRect(22,22,976,1076);boardTexture.needsUpdate=true;
  scene.background=new THREE.Color(colors.stage);boardMaterial.color.set(colors['board-frame']);
  for(const key of Object.keys(markerMaterials))markerMaterials[key].color.set(colors[key]);
 }
 function face(info){
  const key=JSON.stringify(info);if(faceCache.has(key))return faceCache.get(key);
  const c=document.createElement('canvas');c.width=c.height=512;const ctx=c.getContext('2d');
  const background=info.hidden?'#322215':info.side==='red'?'#ffeac5':'#182d35',ink=info.hidden?'#f0d28d':info.side==='red'?'#942b20':'#f8eaca';
  ctx.fillStyle=background;ctx.fillRect(0,0,512,512);ctx.strokeStyle=ink;ctx.lineWidth=8;
  for(const radius of info.side==='red'&&!info.hidden?[218,230]:[224]){ctx.beginPath();ctx.arc(256,256,radius,0,Math.PI*2);ctx.stroke()}
  ctx.font='bold 238px KaiTi, STKaiti, serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=ink;ctx.fillText(info.glyph,256,260);
  if(info.hint){ctx.font='bold 54px KaiTi, serif';ctx.fillText('按'+info.hint+'走法',256,419)}
  const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;textures.add(tex);
  const value={face:material(new THREE.MeshBasicMaterial({map:tex})),body:material(new THREE.MeshStandardMaterial({color:background,roughness:.42}))};faceCache.set(key,value);return value;
 }
 function update(view,selection,options){
  if(disposed)return;current={view,selection,options};
  if(side!==options.side){side=options.side;reset()}
  const nextTheme=document.documentElement.dataset.theme||'light';if(theme!==nextTheme){theme=nextTheme;paintBoard(palette())}
  const key=JSON.stringify(view.board);if(key!==fingerprint){
   fingerprint=key;pieces.clear();
   for(let y=0;y<10;y++)for(let x=0;x<9;x++){
    const info=visiblePiece(view.board[y][x]);if(!info)continue;
    const mats=face(info),group=new THREE.Group(),body=new THREE.Mesh(cylinder,mats.body),top=new THREE.Mesh(faceGeometry,mats.face);
    body.position.y=.15;top.rotation.x=-Math.PI/2;top.position.y=.294;group.add(body,top);group.userData.square=[x,y];const point=toWorld([x,y]);group.position.set(point.x,0,point.z);pieces.add(group);
   }
  }
  const nextMarkers=JSON.stringify([selection,view.lastMove,view.legalMoves,options.canAct]);if(nextMarkers!==markerKey){
   markerKey=nextMarkers;markers.clear();
   const mark=(square,g,mat)=>{const point=toWorld(square),mesh=new THREE.Mesh(g,mat);mesh.rotation.x=-Math.PI/2;mesh.position.set(point.x,view.board[square[1]][square[0]] ? .31 : .016,point.z);mesh.userData.square=square;mesh.renderOrder=3;markers.add(mesh)};
   if(view.lastMove)for(const square of [view.lastMove.from,view.lastMove.to])mark(square,lastGeometry,markerMaterials.history);
   if(selection)mark(selection,selectedGeometry,markerMaterials.selected);
   for(const move of view.legalMoves||[])if(same(move.from,selection))mark(move.to,view.board[move.to[1]][move.to[0]]?captureGeometry:targetGeometry,view.board[move.to[1]][move.to[0]]?markerMaterials.capture:markerMaterials.legal);
  }
  resize();
 }
 const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),0),intersection=new THREE.Vector3();
 function down(e){pointers.add(e.pointerId);if(pointers.size>1)dragged=true;if(pointers.size===1){start={x:e.clientX,y:e.clientY,id:e.pointerId};dragged=false}}
 function move(e){if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>6)dragged=true}
 function up(e){
  const clicked=start&&start.id===e.pointerId&&!dragged&&pointers.size===1&&e.button===0;
  pointers.delete(e.pointerId);if(!pointers.size)start=null;if(!clicked||!current)return;
  const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);
  // Raised pieces must be picked at their visible surface, even after rotation.
  pieces.updateMatrixWorld(true);markers.updateMatrixWorld(true);
  const hit=raycaster.intersectObjects([...pieces.children,...markers.children],true)[0];
  const square=hit?.object.userData.square||hit?.object.parent.userData.square||(raycaster.ray.intersectPlane(plane,intersection)&&fromWorld(intersection.x,intersection.z));if(!square)return;
  const target=(current.view.legalMoves||[]).some(m=>same(m.from,current.selection)&&same(m.to,square));
  if(target||current.view.board[square[1]][square[0]])onPick(square,target);
 }
 function cancel(e){pointers.delete(e.pointerId);start=null;dragged=true}
 function lost(e){e.preventDefault();if(!disposed)onFailure(Error('3D 画面已中断，已恢复二维棋盘'))}
 for(const [event,listener] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',cancel],['webglcontextlost',lost]])canvas.addEventListener(event,listener);
 function animate(time){if(disposed)return;frame=requestAnimationFrame(animate);if(document.hidden)return;controls.enableDamping=!reduced.matches;controls.update();for(const s of ['red','black']){const active=current?.options.activeSide===s;bars[s].material.emissiveIntensity=active?(reduced.matches ? .8 : .65+.25*Math.sin(time/340)):.02;bars[s].material.opacity=active?1:.25;bars[s].material.transparent=!active}renderer.render(scene,camera)}
 reset();resize();frame=requestAnimationFrame(animate);
 return {update,reset,screenPoint(square){camera.updateMatrixWorld();const point=toWorld(square),height=current?.view.board[square[1]][square[0]] ? .294 : 0,v=new THREE.Vector3(point.x,height,point.z).project(camera),rect=canvas.getBoundingClientRect();return {x:rect.left+(v.x+1)*rect.width/2,y:rect.top+(1-v.y)*rect.height/2}},dispose(){
  if(disposed)return;disposed=true;cancelAnimationFrame(frame);observer.disconnect();controls.dispose();
  for(const [event,listener] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',cancel],['webglcontextlost',lost]])canvas.removeEventListener(event,listener);
  for(const item of geometries)item.dispose();for(const item of materials)item.dispose();for(const item of textures)item.dispose();renderer.dispose();renderer.forceContextLoss();canvas.remove();scene.clear();
 }};
}
