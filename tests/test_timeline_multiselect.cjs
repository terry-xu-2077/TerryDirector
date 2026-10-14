/* Run: node --test tests/test_timeline_multiselect.cjs
 * Timeline-only regression tests; no browser or ComfyUI runtime required.
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const C=require('../src/core.js');
const ui={window:{TDCore:C}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/timeline.js'),'utf8'),ui);
const Timeline=ui.window.TDTimeline;
const base=[
 {id:'a',name:'A',start:0,end:120,seed:'1',transitionMode:'tail_reference',suspended:false},
 {id:'b',name:'B',start:120,end:240,seed:'2',transitionMode:'tail_continuation',suspended:false},
 {id:'c',name:'C',start:240,end:360,seed:'3',transitionMode:'independent',suspended:false},
 {id:'d',name:'D',start:360,end:480,seed:'4',transitionMode:'tail_reference',suspended:false}
];
function fixture(readonly=false){
 const events={frames:[],selections:[],commits:[],previews:[]};
 const timeline=Object.create(Timeline.prototype);
 Object.assign(timeline,{
  clips:C.copy(base),selected:'a',selectedIds:new Set(['a']),
  frame:0,ppf:1,scroll:0,inset:70,ruler:32,width:1550,height:190,
  hand:false,sortMode:false,chainEnabled:true,snapEnabled:false,snapFrame:null,
  callouts:[],playing:false,
  host:{getBoundingClientRect(){return{left:0,top:0}}},
  overlay:{style:{},focus(){},setPointerCapture(){},hasPointerCapture(){return false},releasePointerCapture(){}},
  options:{readonly(){return readonly},onFrame(frame){events.frames.push(frame)},
   onSelectionChange(ids,focus){events.selections.push({ids,focus})},
   onPreview(clips){events.previews.push(C.copy(clips))},
   onCommit(clips,old){events.commits.push({after:C.copy(clips),before:C.copy(old)})},
   onView(){}},
  invalidate(){},clampScroll(){}
 });
 return {timeline,events};
}
function pointer(frame,y=70,options={}){
 return {button:0,pointerId:11,clientX:70+frame,clientY:y,preventDefault(){},...options};
}
function drag(timeline,from,to,y=70,opts={}){
 const down=pointer(from,y,opts),end=pointer(to,y,opts);
 timeline.down(down);timeline.move(end);timeline.up(end);
}
test('only ruler clicks and ruler-initiated drag position playhead',()=>{
 const {timeline,events}=fixture();
 timeline.down(pointer(180,12));assert.equal(timeline.frame,180);
 timeline.move(pointer(200,80));assert.equal(timeline.frame,200);
 timeline.up(pointer(200,80));
 const total=events.frames.length;
 drag(timeline,220,230,70);
 assert.equal(timeline.frame,200);
 timeline.down(pointer(525,70));timeline.up(pointer(525,70));
 assert.equal(timeline.frame,200);
 assert.equal(events.frames.length,total);
});
test('plain selection-only click does not commit or change playhead',()=>{
 const {timeline,events}=fixture();
 timeline.down(pointer(150));timeline.up(pointer(150));
 assert.deepEqual([...timeline.selectedIds],['b']);
 assert.equal(timeline.selected,'b');
 assert.equal(timeline.frame,0);
 assert.equal(events.commits.length,0);
});
test('marquee starts below a full row of touching clips',()=>{
 const {timeline,events}=fixture();
 const y=timeline.y()+timeline.trackHeight+18;
 drag(timeline,150,320,y);
 assert.deepEqual([...timeline.selectedIds],['b','c']);
 assert.equal(timeline.selected,'b');
 assert.equal(events.selections.length,1);
 assert.equal(events.commits.length,0);
});
test('Shift+drag starts a marquee directly over a clip',()=>{
 const {timeline}=fixture();
 drag(timeline,152,305,70,{shiftKey:true});
 assert.deepEqual([...timeline.selectedIds],['b','c']);
});
test('Ctrl or Command toggles individual clips without scrubbing',()=>{
 const {timeline}=fixture();
 timeline.down(pointer(145,70,{ctrlKey:true}));
 timeline.down(pointer(380,70,{metaKey:true}));
 assert.deepEqual([...timeline.selectedIds],['a','b','d']);
 timeline.down(pointer(145,70,{ctrlKey:true}));
 assert.deepEqual([...timeline.selectedIds],['a','d']);
 assert.equal(timeline.frame,0);
});
test('sorting drags the selected group, keeping within-group timing',()=>{
 const {timeline,events}=fixture();
 timeline.setSelection(['b','c'],'c',false);
 timeline.setSortMode(true);timeline.chainEnabled=false;
 const initialB=timeline.clips[1],initialC=timeline.clips[2];
 const start=pointer(265),release=pointer(145);
 timeline.down(start);
 assert.deepEqual(timeline.drag.ids,['b','c']);
 timeline.move(release);timeline.up(release);
 const b=timeline.clips.find(c=>c.id==='b'),c=timeline.clips.find(c=>c.id==='c');
 assert.equal(b.start,0);assert.equal(c.start,120);
 assert.equal(c.start-b.start,initialC.start-initialB.start);
 assert.equal(events.commits.length,1);
 assert.deepEqual([...timeline.selectedIds],['b','c']);
});
test('marquee with no drag preserves existing selection',()=>{
 const {timeline,events}=fixture();
 timeline.setSelection(['b','c'],'b',false);
 const y=timeline.y()+timeline.trackHeight+20;
 timeline.down(pointer(520,y));timeline.up(pointer(520,y));
 assert.deepEqual([...timeline.selectedIds],['b','c']);
 assert.equal(events.commits.length,0);
});
test('canceling marquee restores the original multi-selection',()=>{
 const {timeline}=fixture();
 timeline.setSelection(['a','d'],'d',false);
 const y=timeline.y()+timeline.trackHeight+20;
 timeline.down(pointer(140,y));timeline.move(pointer(330,y));
 timeline.cancel();
 assert.deepEqual([...timeline.selectedIds],['a','d']);
 assert.equal(timeline.selected,'d');
});
test('reordered clips keep their own continuity mode even when the predecessor changes',()=>{
 for(const ids of [['b','c'],['a','c'],['b','d'],['a','b','c']]){
  for(const frame of [0,35,240,500,770]){
   const output=C.reorderClipGroupAtFrame(base,ids,frame);
   const group=output.filter(c=>ids.includes(c.id));
   assert.equal(group[0].start,frame);
   assert.deepEqual(group.map(c=>c.transitionMode),
     base.filter(c=>ids.includes(c.id)).map(c=>c.transitionMode));
   for(const clip of base){
    const same=output.find(c=>c.id===clip.id);
    assert.equal(same.transitionMode,clip.transitionMode);
    assert.equal(same.seed,clip.seed);
    assert.equal(same.end-same.start,clip.end-clip.start);
   }
  }
 }
 const independent=base[2];
 const overlapped={...independent,start:220};
 const touching={...overlapped,start:240};
 assert.equal(C.seams([base[1],overlapped])[0].kind,'overlap');
 assert.equal(C.seams([base[1],touching])[0].kind,'touch');
 assert.equal(touching.transitionMode,'independent');
});
test('mixed-duration, non-adjacent group sorting respects chronology',()=>{
 for(let sample=0;sample<60;sample++){
  const source=[];let prev=null,prev2=null;
  for(let i=0;i<6;i++){
   const duration=48+(sample*11+i*27)%210;
   const start=i?Math.max(prev.start+1,prev.end-duration+1,prev2?prev2.end:0,prev.end+((i*13+sample)%19)-9):0;
   source.push({id:'s'+i,start,end:start+duration,transitionMode:base[i%4].transitionMode});
   prev2=prev;prev=source.at(-1);
  }
  const selected=['s1','s3','s4'];
  for(let f=0;f<=C.arrangementFrames(source)+100;f+=57){
   const moved=C.reorderClipGroupAtFrame(source,selected,f);
   assert.equal(moved.find(c=>c.id==='s1').start,f);
   assert.equal(moved.length,source.length);
   for(let i=1;i<moved.length;i++){
    assert.ok(moved[i].start>moved[i-1].start);
    assert.ok(moved[i].end>moved[i-1].end);
    if(i>1)assert.ok(moved[i].start>=moved[i-2].end);
   }
   const group=moved.filter(c=>selected.includes(c.id));
   const original=source.filter(c=>selected.includes(c.id));
   assert.deepEqual(group.map(c=>c.start-group[0].start),
     original.map(c=>c.start-original[0].start));
  }
 }
});
test('batch suspension keeps per-clip metadata and is undoable',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
 const begin=app.indexOf('    suspend:()=>{');
 const end=app.indexOf('    reset:()=>{',begin);
 assert.ok(begin>=0&&end>begin,'production batch suspension action found');
 const actionText=app.slice(begin,end);
 const state={clips:C.copy(base),selected:'b'};
 const timeline={selectedIds:new Set(['b','c'])};
 const history=new C.History();
 const mutate=fn=>{const snapshot=C.copy(state);fn();history.push(snapshot,state)};
 const suspend=new Function('state','timeline','current','mutate',
  'return ({'+actionText+'}).suspend;')(state,timeline,()=>state.clips.find(c=>c.id===state.selected),mutate);
 suspend();
 assert.deepEqual(state.clips.map(c=>!!c.suspended),[false,true,true,false]);
 for(const clip of state.clips){
  const initial=base.find(x=>x.id===clip.id);
  assert.equal(clip.transitionMode,initial.transitionMode);
  assert.equal(clip.start,initial.start);
  assert.equal(clip.seed,initial.seed);
 }
 suspend();
 assert.deepEqual(state.clips.map(c=>!!c.suspended),[false,false,false,false]);
 const previous=history.undo(state);
 assert.deepEqual(previous.clips.map(c=>!!c.suspended),[false,true,true,false]);
 const initial=history.undo(previous);
 assert.deepEqual(initial.clips,base);
});
test('editor save/load keeps the per-clip transitionMode instead of recalculating from predecessor',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
 assert.match(app,/transitionMode:normalizeTransitionMode\(clip\?\.transitionMode,'tail_continuation'\)/);
 assert.match(app,/transitionMode:normalizeTransitionMode\(transitionMode,'tail_reference'\)/);
 assert.match(app,/timeline\.select\(state\.selected,true\)/);
 assert.match(app,/onSelectionChange:\(ids,primary\)=>selectMultiple\(ids,primary\)/);
 const compile=fs.readFileSync(path.join(__dirname,'../director_compile.py'),'utf8');
 assert.match(compile,/mode = clip\.get\("transitionMode"\)/);
});
