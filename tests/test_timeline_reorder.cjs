/* Run: node --test tests/test_timeline_reorder.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../src/core.js');
const sandbox = { window: { TDCore:C } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/timeline.js'),'utf8'),sandbox);
const Timeline = sandbox.window.TDTimeline;
const clips = [
 {id:'a',name:'First',start:0,end:288,seed:'18446744073709551615',prompt:'A'},
 {id:'b',name:'Second',start:336,end:576,seed:'42',aiSeed:'900',refs:['asset-3'],prompt:'B',transitionMode:'tail_reference'},
 {id:'c',name:'Third',start:624,end:864,seed:'43',prompt:'C'}
];
function timeline(sortMode,input=clips){
 const events={previews:[],commits:[]},tl=Object.create(Timeline.prototype);
 Object.assign(tl,{
  clips:C.copy(input),sortMode,
  chainEnabled:true,snapEnabled:false,selected:'a',ppf:1,scroll:0,inset:70,ruler:32,
  width:1600,height:180,hand:false,playing:false,snapFrame:null,callouts:[],frame:0,
  host:{getBoundingClientRect(){return {left:0,top:0};}},
  overlay:{style:{},focus(){},setPointerCapture(){},hasPointerCapture(){return false;},releasePointerCapture(){}},
  options:{readonly(){return false;},onPreview(c){events.previews.push(C.copy(c));},
   onCommit(c,b){events.commits.push({after:C.copy(c),before:C.copy(b)});},onSelect(){},onView(){}},
  invalidate(){},clampScroll(){}
 });
 return {tl,events};
}
function start(tl,id,offset=16){
 const c=tl.clips.find(x=>x.id===id);
 const e={button:0,pointerId:17,clientX:tl.clipX(c)+offset,clientY:tl.y()+24,preventDefault(){}};
 tl.down(e);assert.ok(tl.drag);return e;
}
function move(tl,e,frame,shift=false){
 tl.move({...e,clientX:e.clientX+(frame-tl.drag.start)*tl.ppf,shiftKey:shift,altKey:false});
}
test('normal movement does not reorder despite large negative drag',()=>{
 const {tl}=timeline(false),e=start(tl,'b');assert.equal(tl.drag.mode,'move');move(tl,e,0);
 assert.deepEqual(tl.clips.map(c=>c.id),['a','b','c']);assert.ok(tl.clips[1].start>tl.clips[0].start);
});
test('normal head trim obeys original bounds',()=>{
 const c=C.editClip(clips,'b','left',0);
 assert.deepEqual(c.map(x=>x.id),['a','b','c']);assert.ok(c[1].start>0);
});
test('sort mode uses entire clip as drag handle, including its edges',()=>{
 const {tl}=timeline(true);start(tl,'b',2);assert.equal(tl.drag.mode,'sort');
});
test('second clip becomes first and keeps seed, prompt, transition and asset IDs',()=>{
 const {tl,events}=timeline(true),e=start(tl,'b');
 move(tl,e,0);assert.deepEqual(tl.clips.map(c=>c.id),['b','a','c']);
 const b=tl.clips[0];assert.equal(b.seed,'42');assert.equal(b.aiSeed,'900');
 assert.deepEqual(b.refs,['asset-3']);assert.equal(b.prompt,'B');assert.equal(b.transitionMode,'tail_reference');
 tl.up(e);assert.equal(events.commits.length,1);assert.equal(events.commits[0].after[0].id,'b');
});
test('first clip moves right past second clip to reverse pair',()=>{
 const {tl}=timeline(true),e=start(tl,'a');move(tl,e,337);
 assert.deepEqual(tl.clips.map(c=>c.id),['b','a','c']);
});
test('three-way sort updates indices live and permits returning to original slot',()=>{
 const {tl}=timeline(true),e=start(tl,'c');move(tl,e,0);
 assert.deepEqual(tl.clips.map(c=>c.id),['c','a','b']);
 move(tl,e,320);assert.deepEqual(tl.clips.map(c=>c.id),['a','c','b']);
 move(tl,e,624);assert.deepEqual(tl.clips.map(c=>c.id),['a','b','c']);
});
test('displaced clips render at their new slots immediately without springs',()=>{
 const {tl}=timeline(true),e=start(tl,'b');move(tl,e,0);
 const a=tl.clips.find(c=>c.id==='a');
 assert.equal(a.start,336);
 assert.equal(tl.clipX(a),tl.x(a.start));
 assert.equal(Timeline.prototype.advanceSortAnimation,undefined);
 assert.equal(tl.sortPositions,undefined);
 tl.up(e);
});
test('no-op sort does not write history',()=>{
 const {tl,events}=timeline(true),e=start(tl,'b');tl.up(e);assert.equal(events.commits.length,0);
});
test('pointer cancellation restores original clips',()=>{
 const {tl,events}=timeline(true),e=start(tl,'b');move(tl,e,0);tl.cancel();
 assert.deepEqual(tl.clips.map(c=>c.id),['a','b','c']);assert.equal(events.commits.length,0);
});
test('disabling sort cancels the gesture without residual animation state',()=>{
 const {tl}=timeline(true),e=start(tl,'b');move(tl,e,0);tl.setSortMode(false);
 assert.equal(tl.sortMode,false);assert.equal(tl.drag,null);
 assert.equal(tl.sortPositions,undefined);
 assert.deepEqual(tl.clips.map(c=>c.id),['a','b','c']);
});
test('all permutations preserve durations and compiler chronology',()=>{
 for(const clip of clips)for(let index=0;index<clips.length;index++){
  const changed=C.reorderClips(clips,clip.id,index);
  for(let i=1;i<changed.length;i++){
   assert.ok(changed[i].start>changed[i-1].start);
   assert.ok(changed[i].end>changed[i-1].end);
   if(i>1)assert.ok(changed[i].start>=changed[i-2].end);
  }
  for(const source of clips){
   const c=changed.find(item=>item.id===source.id);
   assert.equal(c.end-c.start,source.end-source.start);
  }
 }
});
test('unequal clip durations do not break overlaps',()=>{
 const uneven=[{id:'x',start:0,end:360},{id:'y',start:361,end:420},{id:'z',start:420,end:500}];
 const out=C.reorderClips(uneven,'z',0);
 assert.deepEqual(out.map(c=>c.id),['z','x','y']);
 for(let i=1;i<out.length;i++){
  assert.ok(out[i].start>out[i-1].start);assert.ok(out[i].end>out[i-1].end);
  if(i>1)assert.ok(out[i].start>=out[i-2].end);
 }
});
test('reordered data survives history undo and redo',()=>{
 const next=C.reorderClips(clips,'b',0),history=new C.History();
 assert.ok(history.push(clips,next));
 const undone=history.undo(next);
 assert.deepEqual(undone.map(c=>c.id),['a','b','c']);
 const redone=history.redo(undone);
 assert.deepEqual(redone.map(c=>c.id),['b','a','c']);assert.equal(redone[0].aiSeed,'900');
});
test('short floating-window layout keeps editor scrollable',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../src/app.css'),'utf8');
 assert.match(css,/@media \(max-height: 720px\)/);
 assert.match(css,/body\.td-embedded #app\s*\{\s*overflow-x:\s*hidden;\s*overflow-y:\s*auto;/);
 assert.match(css,/body\.td-embedded #app > \.workspace\s*\{\s*flex:\s*0 0 auto;\s*min-height:\s*330px;/);
});
test('narrow editor and nested prompt panel have independent breakpoints',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../src/app.css'),'utf8');
 assert.match(css,/@container td-editor-shell \(max-width: 760px\)/);
 assert.match(css,/@container td-prompt-panel \(max-width: 630px\)/);
});

test('sorting action remains present, separate from pointer and pan',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
 assert.match(app,/ib\('sort','reorder'/);
 assert.match(app,/sort:\(\)=>setSortEnabled\(!timeline\.sortMode\)/);
 assert.match(app,/sortButton\.disabled=hostReadonly/);
});
