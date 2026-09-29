const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('../src/core.js');
const window = { TDCore:C };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/timeline.js'),'utf8'), {window, console});
function timeline() {
 const t=Object.create(window.TDTimeline.prototype);
 Object.assign(t,{clips:[{id:'a',start:0,end:240},{id:'b',start:192,end:432},{id:'c',start:384,end:624}],selected:'b',hover:null,drag:null,inset:70,ruler:32,width:1280,height:179,ppf:1.8,scroll:0});
 return t;
}
const ctx={font:'',measureText:text=>({width:text.length*7})};
test('all clips share one row and reserve annotation space',()=>{
 const t=timeline();assert.equal(t.y(0),t.y(1));
 assert.ok(t.y()+t.trackHeight+3+t.overlapLeaderGap+23<t.height);
});
test('overlap body hits the later clip, not a standalone overlap object',()=>{
 const t=timeline();assert.equal(t.hitTest({x:t.x(210),y:t.y()+25}).id,'b');
 assert.equal(t.hitTest({x:t.x(210),y:t.y()+t.trackHeight+28}),undefined);
});
test('selected earlier clip exposes its real tail trim handle',()=>{
 const t=timeline();t.selected='a';
 const p={x:t.x(240)-2,y:t.y()+25};
 assert.equal(t.hitTest(p).id,'a');assert.equal(t.edgeAt(t.clips[0],p),'right');
});
test('every shown callout has a separate leader gap, including narrow viewports',()=>{
 for(const width of [320,768,1280])for(const height of [144,153,179,246]){
  const t=timeline();t.width=width;t.height=height;t.ppf=.3;
  const labels=t.overlapCallouts(ctx);
  assert.ok(labels.length>0);
  labels.forEach((l,i)=>{assert.equal(l.y-l.bottom,8);assert.ok(l.y+l.height<height);assert.ok(l.x>=t.inset);assert.ok(l.x+l.width<=width);labels.slice(i+1).forEach(r=>assert.ok(l.x+l.width+8<=r.x||r.x+r.width+8<=l.x));});
 }
});
test('moving clear of the other clip removes the corresponding label',()=>{
 const t=timeline();t.clips=C.editClip(t.clips,'b','move',241);
 assert.equal(t.overlapCallouts(ctx).some(o=>o.a==='a'&&o.b==='b'),false);
});

// Capture only the 4px bright trim bars from the real renderer.
function paintedHandles(t) {
 const bars=[];
 t.clips.forEach(c=>c.name=c.id);
 t.options={};t.theme={text:'handle-ink'};t.image=()=>null;
 t.ctx=new Proxy({measureText:text=>({width:text.length*7}),createLinearGradient:()=>({addColorStop(){}})},
   {get:(object,key)=>key in object?object[key]:()=>{}});
 t.rect=(context,x,y,w,h,r,fill)=>{if(w===4&&fill==='handle-ink')bars.push(x);};
 t.drawContent();return bars;
}
test('hovering an unselected clip never paints its white trim bars',()=>{
 const t=timeline();t.hover='c';
 assert.deepEqual(paintedHandles(t),[t.x(192)+2,t.x(432)-6]);
});
test('hover alone paints no handles; selection exposes its own pair',()=>{
 const t=timeline();t.selected=null;t.hover='c';assert.deepEqual(paintedHandles(t),[]);
 t.selected='c';assert.deepEqual(paintedHandles(t),[t.x(384)+2,t.x(624)-6]);
});

// A 200px panel leaves 144px for Canvas after its toolbar and scrollbar.
test('compact timeline retains readable status and unclipped overlap labels',()=>{
 const t=timeline();t.height=144;
 assert.equal(t.trackHeight,54);
 assert.ok((t.trackHeight-19)-21.5>=12);
 for(const label of t.overlapCallouts(ctx)){
  assert.equal(label.y-label.bottom,8);
  assert.ok(label.y+label.height<=t.height-4);
 }
});

// The short leader changes only annotation placement, not the clip or hit area.
test('short leaders stay outside overlap and do not grow with zoom or height',()=>{
 for(const ppf of [.3,1.8,8])for(const height of [144,179,300]){
  const t=timeline();t.ppf=ppf;t.height=height;
  for(const label of t.overlapCallouts(ctx)){
   assert.equal(label.bottom,t.y()+t.trackHeight+3);
   assert.equal(label.y-label.bottom,8);
   assert.equal(label.height,23);
   assert.equal(t.hitTest({x:label.anchor,y:label.y+1}),undefined);
  }
 }
});
