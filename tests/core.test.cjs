const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const clips = [
  {id:'a',start:0,end:192},
  {id:'b',start:144,end:360},
  {id:'c',start:312,end:528},
  {id:'d',start:480,end:672},
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
 const n=C.editClip([{id:'only',start:0,end:240}],'only','right',5);
 assert.equal(n[0].end-n[0].start,24);
});
test('non-adjacent clips cannot overlap in the single row',()=>{
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

test('adjacent same-row clips are allowed to overlap',()=>{
 const n=C.editClip(clips,'b','move',160);
 assert.equal(C.intersection(n[0],n[1]).frames,32);
});
test('a trim cannot hide the next clip entirely',()=>{
 const n=C.editClip(clips,'a','right',900);
 assert.ok(n[0].end<n[1].end);
 assert.equal(C.intersection(n[0],n[2]).frames,0);
});
test('large drags/trims retain chronological order and forbid triple overlaps',()=>{
 for(const c of clips)for(const mode of ['move','left','right'])for(const f of [-100,1,100,300,600,1000]){
  const n=C.editClip(clips,c.id,mode,f);
  n.forEach((x,i)=>{assert.ok(x.end-x.start>=24);if(i) {assert.ok(x.start>n[i-1].start);assert.ok(x.end>n[i-1].end);} if(i>1)assert.equal(C.intersection(x,n[i-2]).frames,0);});
 }
});
test('non-finite edits leave the sequence unchanged',()=>{
 assert.equal(C.editClip(clips,'a','move',NaN),clips);
});

test('arranged duration counts from zero without double-counting overlaps',()=>{
 assert.equal(C.arrangementFrames([]),0);
 assert.equal(C.arrangementFrames([{start:0,end:240},{start:192,end:432}]),432);
 assert.equal(C.arrangementFrames([{start:120,end:360}]),360); // Leading gap belongs to the timeline.
 assert.equal(C.arrangementFrames([{start:0,end:240},{start:360,end:480}]),480);
 assert.equal(C.arrangementFrames([{start:360,end:480},{start:0,end:240}]),480);
});
test('arranged duration follows the actual suffix end after move and tail edits',()=>{
 assert.equal(C.arrangementFrames(C.moveFollowing(clips,'b',clips[1].start+24)),clips.at(-1).end+24);
 assert.equal(C.arrangementFrames(C.trimEndFollowing(clips,'b',clips[1].end+48)),clips.at(-1).end+48);
 const short=C.trimEndFollowing(clips,'b',clips[1].end-24);
 assert.equal(C.arrangementFrames(short),short.at(-1).end);
});
