const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('../src/core.js');
const clips = [
  {id:'a',start:0,end:240,prompt:'A'},
  {id:'b',start:192,end:432,prompt:'B'},
  {id:'c',start:384,end:624,prompt:'C'},
  {id:'d',start:576,end:816,prompt:'D'},
];
const positions = list => list.map(({start,end})=>[start,end]);
function assertRigid(before, after, index) {
  const delta=after[index].start-before[index].start;
  before.forEach((clip,i)=>{
    assert.equal(after[i].start,clip.start+(i<index?0:delta));
    assert.equal(after[i].end,clip.end+(i<index?0:delta));
    assert.equal(after[i].prompt,clip.prompt);
    if(i>index)assert.equal(after[i].start-after[i-1].end,clip.start-before[i-1].end);
  });
}
test('chain head moves all following clips without changing their lengths or overlaps',()=>{
  const moved=C.moveFollowing(clips,'a',1200);
  assert.equal(moved[0].start,1200);assertRigid(clips,moved,0);
  assert.equal(clips[0].start,0);
});
test('a middle clip moves only its suffix, including clips separated by gaps',()=>{
  const original=clips.map(c=>c.id==='d'?{...c,start:700,end:1000}:c);
  const moved=C.moveFollowing(original,'b',300);
  assert.equal(moved[0],original[0]);assert.equal(moved[1].start,300);
  assertRigid(original,moved,1);
});
test('last clip follows the same constraints as existing single-clip movement',()=>{
  for(const frame of [-100,500,1000])assert.deepEqual(C.moveFollowing(clips,'d',frame),C.editClip(clips,'d','move',frame));
});
test('clamp the whole chain at zero without compressing its overlap',()=>{
  const moved=C.moveFollowing(clips,'a',-200);assertRigid(clips,moved,0);assert.equal(moved[0].start,0);
});
test('left clamp prevents the first follower overlapping the fixed predecessor',()=>{
  const original=[{id:'a',start:0,end:240},{id:'b',start:200,end:500},{id:'c',start:300,end:600}];
  const moved=C.moveFollowing(original,'b',-500);
  assert.equal(moved[1].start,140);assert.equal(moved[2].start,240);
  assert.equal(C.intersection(moved[0],moved[2]).frames,0);assertRigid(original,moved,1);
});
test('large chain moves keep chronological order and prevent triple overlaps',()=>{
  for(const id of clips.map(c=>c.id))for(const frame of [-10000,1,300,650,30000]){
    const moved=C.moveFollowing(clips,id,frame);assertRigid(clips,moved,clips.findIndex(c=>c.id===id));
    moved.forEach((c,i)=>{assert.ok(c.start>=0);if(i){assert.ok(c.start>moved[i-1].start);assert.ok(c.end>moved[i-1].end);}if(i>1)assert.equal(C.intersection(moved[i-2],c).frames,0);});
  }
});
test('nonfinite, unknown and no-op moves do not create edits',()=>{
  for(const frame of [NaN,Infinity,-Infinity])assert.equal(C.moveFollowing(clips,'a',frame),clips);
  assert.equal(C.moveFollowing(clips,'missing',100),clips);
  assert.equal(C.moveFollowing(clips,'b',192),clips);
  assert.equal(C.moveFollowing(clips,'b',210.6)[1].start,211);
});
test('the entire chain is restored with one undo and one redo',()=>{
  const history=new C.History(),before={clips},after={clips:C.moveFollowing(clips,'b',300)};
  history.push(before,after);assert.equal(history.undoItems.length,1);
  assert.deepEqual(history.undo(after),before);assert.deepEqual(history.redo(before),after);
});
const window={TDCore:C};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/timeline.js'),'utf8'),{window,console});
function drag(id,mode,frame,follow){
  const c=clips.find(c=>c.id===id),start=mode==='right'?c.end:c.start;
  const t=Object.create(window.TDTimeline.prototype);
  Object.assign(t,{clips,ppf:1,frame:10000,snapEnabled:true,options:{},invalidate(){},drag:{id,mode,follow,original:C.copy(clips),start:c.start,end:c.end,origin:{x:0},last:{x:frame-start}}});
  t.updateDrag();return t;
}
test('chain snapping ignores old edges of every moving follower',()=>{
  const t=drag('a','move',190,true);assert.equal(t.clips[0].start,190);assert.equal(t.snapFrame,null);
});
test('chain snapping still uses stationary predecessor edges and respects Alt',()=>{
  const t=drag('b','move',238,true);assert.equal(t.clips[1].start,240);assert.equal(t.snapFrame,240);
  t.updateDrag(true);assert.equal(t.clips[1].start,238);assert.equal(t.snapFrame,null);
});
test('unlinked body movement and edge trims preserve existing single-clip behavior',()=>{
  for(const [mode,frame] of [['move',300],['left',210],['right',460]]){
    const t=drag('b',mode,frame,false);t.updateDrag(true);
    assert.deepEqual(positions(t.clips),positions(C.editClip(clips,'b',mode,frame)));
  }
});
test('cancel restores the whole moving chain without committing',()=>{
  const t=drag('b','move',300,true);let committed=false;t.options.onCommit=()=>committed=true;t.overlay={style:{}};
  t.cancel();assert.deepEqual(positions(t.clips),positions(clips));assert.equal(t.drag,null);assert.equal(committed,false);
});

function assertTailSeam(before, after, index) {
  const delta=after[index].end-before[index].end;
  assert.equal(after[index].start,before[index].start);
  before.forEach((clip,i)=>{
    if(i<index)assert.equal(after[i],clip);
    if(i>index){
      assert.equal(after[i].start,clip.start+delta);
      assert.equal(after[i].end,clip.end+delta);
      assert.equal(after[i].end-after[i].start,clip.end-clip.start);
      assert.equal(after[i].start-after[i-1].end,clip.start-before[i-1].end);
    }
    assert.equal(after[i].prompt,clip.prompt);
    assert.ok(after[i].start>=0);assert.ok(after[i].end-after[i].start>=C.FPS);
    if(i){assert.ok(after[i].start>after[i-1].start);assert.ok(after[i].end>after[i-1].end);}
    if(i>1)assert.equal(C.intersection(after[i-2],after[i]).frames,0);
  });
}
test('linked tail extension and shortening preserve the next overlap and all suffix timings',()=>{
  for(const frame of [480,384]){
    const changed=C.trimEndFollowing(clips,'b',frame);
    assert.equal(changed[1].end,frame);assertTailSeam(clips,changed,1);
    assert.equal(C.intersection(changed[1],changed[2]).frames,48);
  }
  assert.equal(clips[1].end,432);
});
test('linked tail edits keep positive gaps, and last tail matches an ordinary trim',()=>{
  const gapped=clips.map((c,i)=>i>=2?{...c,start:c.start+100,end:c.end+100}:c);
  for(const frame of [370,1500])assertTailSeam(gapped,C.trimEndFollowing(gapped,'b',frame),1);
  for(const frame of [-500,700,3000])assert.deepEqual(C.trimEndFollowing(clips,'d',frame),C.editClip(clips,'d','right',frame));
});
test('tail clamp uses actual change, never hides the head or creates triple overlap',()=>{
  for(const id of clips.map(c=>c.id))for(const frame of [-10000,1,300,650,30000]){
    assertTailSeam(clips,C.trimEndFollowing(clips,id,frame),clips.findIndex(c=>c.id===id));
  }
  const changed=C.trimEndFollowing(clips,'b',-10000);
  assert.equal(changed[1].end,288);assert.equal(changed[2].start,240);
  const first=C.trimEndFollowing(clips,'a',0);
  assert.equal(first[0].end,49);assert.equal(first[1].start,1);
  const single=[{id:'a',start:0,end:240}];assert.equal(C.trimEndFollowing(single,'a',0)[0].end,24);
});
test('tail edits reject invalid input, round frames and preserve no-op identity',()=>{
  for(const frame of [NaN,Infinity,-Infinity])assert.equal(C.trimEndFollowing(clips,'a',frame),clips);
  assert.equal(C.trimEndFollowing(clips,'missing',500),clips);
  assert.equal(C.trimEndFollowing(clips,'b',432),clips);
  assert.equal(C.trimEndFollowing(clips,'b',460.6)[1].end,461);
});
test('linked tail drag ignores follower snap targets but snaps to playhead and supports Alt',()=>{
  const t=drag('b','right',620,true);
  assert.equal(t.clips[1].end,620);assert.equal(t.snapFrame,null);
  t.frame=622;t.updateDrag();assert.equal(t.clips[1].end,622);assert.equal(t.snapFrame,622);
  t.updateDrag(true);assert.equal(t.clips[1].end,620);assert.equal(t.snapFrame,null);
  const clamped=drag('b','right',240,true);assert.equal(clamped.clips[1].end,288);assert.equal(clamped.snapFrame,null);
});
test('pointer-down enables tail follow only with chain on; head trim always stays independent',()=>{
  for(const chain of [false,true])for(const mode of ['left','move','right']){
    const t=Object.create(window.TDTimeline.prototype),c=clips[1];
    Object.assign(t,{clips:C.copy(clips),chainEnabled:chain,inset:70,ruler:32,options:{},
      overlay:{focus(){},setPointerCapture(){},style:{}},stop(){},point(){return{x:200,y:70};},
      hitTest(){return c;},edgeAt(){return mode;},invalidate(){}});
    t.down({button:0,pointerId:1,preventDefault(){}});
    assert.equal(t.drag.follow,chain&&mode!=='left');
  }
});
test('linked tail drag commits once, undo/redo restores the whole edit and Esc restores originals',()=>{
  const t=drag('b','right',600,true),history=new C.History();let count=0;
  const before=C.copy(clips),after=C.copy(t.clips);
  t.overlay={style:{},hasPointerCapture(){return false;}};t.clampScroll=()=>{};
  t.options.onCommit=(a,b)=>{count++;history.push(b,a);};t.up({pointerId:1});
  assert.equal(count,1);assert.deepEqual(history.undo(after),before);assert.deepEqual(history.redo(before),after);
  const cancelled=drag('b','right',600,true);cancelled.overlay={style:{}};cancelled.cancel();
  assert.deepEqual(cancelled.clips,before);assert.equal(cancelled.drag,null);
});
