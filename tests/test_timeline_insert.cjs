/* Run: node --test tests/test_timeline_insert.cjs */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const C=require('../src/core.js');
const clips=[
 {id:'a',name:'A',start:0,end:240,prompt:'first',seed:'12'},
 {id:'b',name:'B',start:240,end:480,prompt:'second',seed:'18446744073709551615',transitionMode:'tail_reference'},
 {id:'c',name:'C',start:480,end:720,prompt:'third',suspended:true}
];
const added={id:'new',name:'New',start:0,end:120,prompt:'',transitionMode:'tail_reference'};
const positions=items=>items.map(c=>[c.id,c.start,c.end]);

test('playhead at a seam inserts without overlap, pushing every later clip',()=>{
 const out=C.insertClipAtFrame(clips,added,240);
 assert.deepEqual(positions(out),[
  ['a',0,240],['new',240,360],['b',360,600],['c',600,840]
 ]);
 assert.equal(out[2].seed,'18446744073709551615');
 assert.equal(out[2].transitionMode,'tail_reference');
 assert.equal(out[3].suspended,true);
});

test('playhead inside a clip pushes that whole clip and preserves existing data',()=>{
 const out=C.insertClipAtFrame(clips,added,360);
 assert.deepEqual(positions(out),[
  ['a',0,240],['new',360,480],['b',480,720],['c',720,960]
 ]);
 assert.equal(out[2].prompt,'second');
 assert.deepEqual(positions(clips),[['a',0,240],['b',240,480],['c',480,720]]);
});

test('playhead at zero inserts first; the timeline end appends',()=>{
 const atStart=C.insertClipAtFrame(clips,added,0);
 assert.deepEqual(positions(atStart),[
  ['new',0,120],['a',120,360],['b',360,600],['c',600,840]
 ]);
 const atEnd=C.insertClipAtFrame(clips,added,720);
 assert.deepEqual(positions(atEnd),[
  ['a',0,240],['b',240,480],['c',480,720],['new',720,840]
 ]);
});

test('ripple keeps authored gaps after the inserted clip',()=>{
 const withGap=[clips[0],{...clips[1],start:360,end:600}];
 const out=C.insertClipAtFrame(withGap,added,300);
 assert.deepEqual(positions(out),[
  ['a',0,240],['new',300,420],['b',420,660]
 ]);
});

test('enough empty space leaves later clips at their original positions',()=>{
 const withGap=[clips[0],{...clips[1],start:600,end:840}];
 const out=C.insertClipAtFrame(withGap,added,300);
 assert.deepEqual(positions(out),[
  ['a',0,240],['new',300,420],['b',600,840]
 ]);
});
test('a partial gap only pushes later clips by the shortfall',()=>{
 const withGap=[clips[0],{...clips[1],start:450,end:690}];
 const out=C.insertClipAtFrame(withGap,added,400);
 assert.deepEqual(positions(out),[
  ['a',0,240],['new',400,520],['b',520,760]
 ]);
});
test('ripple preserves suffix overlap and never clips an existing segment',()=>{
 const withOverlap=[
  {id:'a',start:0,end:240}, {id:'b',start:200,end:440}, {id:'c',start:400,end:640}
 ];
 const out=C.insertClipAtFrame(withOverlap,added,240);
 assert.deepEqual(positions(out),[
  ['a',0,240],['new',240,360],['b',360,600],['c',560,800]
 ]);
 assert.equal(C.seams(out)[2].frames,40);
 assert.equal(C.seams(out)[2].kind,'overlap');
});

test('new clip at empty timeline uses the playhead, with unchanged metadata',()=>{
 const out=C.insertClipAtFrame([],{...added,end:240},96);
 assert.deepEqual(positions(out),[['new',96,336]]);
 assert.equal(out[0].transitionMode,'tail_reference');
});

test('ripple insertion supports undo/redo without modifying the input',()=>{
 const out=C.insertClipAtFrame(clips,added,240),history=new C.History();
 assert.ok(history.push(clips,out));
 assert.deepEqual(history.undo(out),clips);
 assert.deepEqual(history.redo(clips),out);
});

test('editor creates at playhead but duplicate still appends',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
 assert.match(app,/function newClip\(\)\{appendClip\('新的片段',null,\{atPlayhead:true\}\);\}/);
 assert.match(app,/C\.insertClipAtFrame\(state\.clips,c,insertionFrame\)/);
 assert.match(app,/duplicate:\(\)=>\{if\(current\(\)\)appendClip\(current\(\)\.name\+' · 副本',current\(\)\);\}/);
});
