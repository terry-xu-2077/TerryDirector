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
