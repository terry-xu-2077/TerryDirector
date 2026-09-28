const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const clips = [
  {id:'a',start:0,end:192,lane:0},
  {id:'b',start:144,end:360,lane:1},
  {id:'c',start:312,end:528,lane:0},
  {id:'d',start:480,end:672,lane:1},
];
test('half-open ranges: touching endpoints do not overlap',()=>{
 assert.equal(C.intersection({start:0,end:192},{start:192,end:400}).frames,0);
});
test('2 seconds = 48 frames; no inclusive end off-by-one',()=>{
 assert.equal(C.intersection(clips[0],clips[1]).frames,48);
});
test('moving a clip preserves length and derives overlap',()=>{
 const n=C.editClip(clips,'b','move',168);
 assert.equal(n[1].end-n[1].start,216);
 assert.equal(C.overlaps(n)[0].frames,24);
 assert.equal(clips[1].start,144);
});
test('moving past the previous end removes overlap',()=>{
 const n=C.editClip(clips,'b','move',204);
 assert.equal(C.overlaps(n).some(o=>o.a==='a'&&o.b==='b'),false);
});
test('trim changes only the requested edge',()=>{
 const n=C.editClip(clips,'b','left',168);
 assert.equal(n[1].end,360);assert.equal(n[1].start,168);
});
test('minimum duration is one second',()=>{
 const n=C.editClip(clips,'b','right',145);
 assert.equal(n[1].end-n[1].start,24);
});
test('same-lane collision is constrained',()=>{
 const n=C.editClip(clips,'b','move',460);
 assert.ok(n[1].end<=n[3].start);
});
test('invalid negative start cannot be committed',()=>{
 assert.equal(C.editClip(clips,'a','move',-50)[0].start,0);
});
test('snap uses screen-scaled threshold and matches either clip edge',()=>{
 assert.equal(C.snap(141,[0,216],[360],4).value,144);
 assert.equal(C.snap(135,[0,216],[360],4).target,null);
});
test('one drag produces one undo entry, redo preserves result',()=>{
 const h=new C.History(),b={clips},a={clips:C.editClip(clips,'b','move',168)};
 h.push(b,a);assert.equal(h.undoItems.length,1);
 assert.deepEqual(h.undo(a),b);assert.deepEqual(h.redo(b),a);
});
test('no-op commits do not dirty undo history',()=>{
 const h=new C.History();assert.equal(h.push(clips,clips),false);assert.equal(h.undoItems.length,0);
});
test('timecode and empty sequences',()=>{
 assert.equal(C.timecode(48),'00:00:02:00');assert.equal(C.timecode(49),'00:00:02:01');assert.deepEqual(C.overlaps([]),[]);
});
