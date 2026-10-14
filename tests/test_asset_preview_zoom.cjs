/* Run: node --test tests/test_asset_preview_zoom.cjs */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
class FakeNode{
 constructor(tag='div'){
  this.tagName=tag.toUpperCase();this.style={};this.listeners={};this.children=[];
  this.disabled=false;this.className='';this.textContent='';
  this.classList={classes:new Set(),toggle:(s,v)=>v?this.classList.classes.add(s):this.classList.classes.delete(s)};
 }
 addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);}
 append(...children){this.children.push(...children);}
 send(type,extra={}){
  for(const fn of this.listeners[type]||[])fn({
   button:0,pointerId:1,target:{closest:()=>null},
   preventDefault(){this.defaultPrevented=true;},
   clientX:400,clientY:200,deltaY:0,...extra
  });
 }
 getBoundingClientRect(){return {left:0,top:0,width:800,height:400};}
 setPointerCapture(id){this.capture=id;}
 hasPointerCapture(id){return this.capture===id;}
 releasePointerCapture(){this.capture=null;}
}
class FakeResizeObserver{
 constructor(fn){this.fn=fn;}
 observe(viewport){this.viewport=viewport;}
 disconnect(){this.disconnected=true;}
}
function imageZoom(width=1600,height=1200){
 const from=app.indexOf('  function attachAssetImageZoom(');
 const to=app.indexOf('  function stopDialogMedia(){',from);
 assert.ok(from>=0&&to>from);
 const fn=new Function('document','ResizeObserver','AbortController',
   app.slice(from,to)+'return attachAssetImageZoom;')(
    {createElement:tag=>new FakeNode(tag)},FakeResizeObserver,AbortController
   );
 const viewport=new FakeNode(),image=new FakeNode('img');
 image.naturalWidth=width;image.naturalHeight=height;
 const stop=fn(viewport,image);
 const position=()=>{
  const match=image.style.transform.match(/translate3d\(([-\d.]+)px,([-\d.]+)px,0\) scale\(([\d.]+)\)/);
  assert.ok(match,'CSS transform should be valid');
  return {x:Number(match[1]),y:Number(match[2]),scale:Number(match[3])};
 };
 return {viewport,image,stop,position};
}
test('initial fit displays full image regardless of source aspect ratio',()=>{
 for(const [w,h] of [[1600,900],[800,1600],[1200,1200]]){
  const fixture=imageZoom(w,h);
  assert.deepEqual(fixture.position(),{x:0,y:0,scale:1});
  fixture.stop();
 }
});
test('mouse wheel zooms about cursor and limits pan to visible bounds',()=>{
 const fixture=imageZoom(),{viewport,position}=fixture;
 viewport.send('wheel',{deltaY:-Math.log(2)/0.0016});
 assert.ok(Math.abs(position().scale-2)<1e-8);
 viewport.send('pointerdown');
 viewport.send('pointermove',{clientX:700});
 const maxX=(1600*(400/1200)*2-800)/2;
 assert.ok(Math.abs(position().x-maxX)<1e-6);
 viewport.send('pointerup');
 viewport.send('dblclick');
 assert.deepEqual(position(),{x:0,y:0,scale:1});
 fixture.stop();
});
test('portrait zoom only pans along the overfull axis',()=>{
 const fixture=imageZoom(800,1600),{viewport,position}=fixture;
 viewport.send('wheel',{deltaY:-Math.log(2)/0.0016});
 viewport.send('pointerdown');
 viewport.send('pointermove',{clientX:700,clientY:400});
 assert.equal(position().x,0);
 assert.equal(position().y,200);
 fixture.stop();
});
test('zoom clamps between fit and 1200% and has a visible reset control',()=>{
 const fixture=imageZoom(),{viewport,position}=fixture;
 viewport.send('wheel',{deltaY:-40000});
 assert.equal(position().scale,12);
 viewport.send('wheel',{deltaY:40000});
 assert.deepEqual(position(),{x:0,y:0,scale:1});
 const tools=viewport.children.find(n=>n.className==='asset-zoom-tools');
 assert.ok(tools);
 assert.ok(tools.children.some(n=>n.textContent==='适应'));
 fixture.stop();
});
