/* node --test tests/test_timeline_reorder.cjs */
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const C=require('../src/core.js');
const sandbox={window:{TDCore:C}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/timeline.js'),'utf8'),sandbox);
const Timeline=sandbox.window.TDTimeline;
const samples=[
{id:'a',start:240,end:528,seed:'18446744073709551615',prompt:'A'},
{id:'b',start:624,end:864,seed:'42',aiSeed:'800',refs:['asset-3'],prompt:'B'},
{id:'c',start:864,end:1104,seed:'87',prompt:'C'}];
function drag(id,start,end,to,follow=true,solo=false){
 const tl=Object.create(Timeline.prototype);tl.ppf=1;tl.frame=0;tl.snapEnabled=false;
 tl.clips=C.copy(samples);tl.invalidate=()=>{};tl.options={onPreview(){}};
 tl.drag={mode:'move',id,origin:{x:0},last:{x:to-start},start,end,original:C.copy(samples),follow};
 tl.updateDrag(false,solo);return tl;
}
test('cross heads left: reorder and retain identity, seeds, assets',()=>{
 const tl=drag('b',624,864,224);
 assert.deepEqual(tl.clips.map(c=>c.id),['b','a','c']);
 assert.equal(tl.clips[0].start,224);assert.equal(tl.clips[0].seed,'42');
 assert.equal(tl.clips[0].aiSeed,'800');assert.deepEqual(tl.clips[0].refs,['asset-3']);
 assert.equal(tl.clips[0].prompt,'B');
});
test('cross heads right even when chaining is on',()=>{
 assert.deepEqual(drag('a',240,528,700).clips.map(c=>c.id),['b','a','c']);
});
test('incremental drag crosses a moving follower without chasing it',()=>{
 const tl=drag('a',240,528,600);
 assert.equal(tl.clips.find(c=>c.id==='b').start,984);
 tl.drag.last={x:625-240};tl.updateDrag(false,false);
 assert.deepEqual(tl.clips.map(c=>c.id),['b','a','c']);
 assert.equal(tl.clips.find(c=>c.id==='b').start,624);
 assert.equal(tl.drag.reordering,true);
 tl.drag.last={x:700-240};tl.updateDrag(false,false);
 assert.equal(tl.clips.find(c=>c.id==='b').start,624);
 const reverse=drag('b',624,864,300);
 reverse.drag.last={x:239-624};reverse.updateDrag(false,false);
 assert.equal(reverse.clips[0].id,'b');
 assert.equal(reverse.clips.find(c=>c.id==='c').start,864);
});
test('shift solo bypasses chain and normal movement still follows',()=>{
 assert.equal(drag('a',240,528,700,true,true).clips.find(c=>c.id==='b').start,624);
 assert.equal(drag('b',624,864,600).clips.find(c=>c.id==='c').start,840);
});
test('head trim reorders and frame-zero tie enables swapping the first clip',()=>{
 assert.equal(C.editClip(samples,'b','left',220)[0].id,'b');
 const atZero=[{id:'a',start:0,end:288},{id:'b',start:300,end:540}];
 assert.equal(C.editClip(atZero,'b','move',0)[0].id,'b');
 assert.deepEqual(C.editClip(samples,'b','move',800).map(c=>c.id),['a','b','c']);
});
test('drop settlement preserves execution order and valid overlaps',()=>{
 const result=C.settleClips(C.editClip(samples,'b','move',10),'b');
 assert.deepEqual(result.map(c=>c.id),['b','a','c']);
 for(let i=1;i<result.length;i++){
  assert.ok(result[i].start>result[i-1].start&&result[i].end>result[i-1].end);
  if(i>1)assert.ok(result[i].start>=result[i-2].end);
 }
 assert.equal(result[0].end-result[0].start,240);
});
test('right trim retains original bounds',()=>{
 assert.equal(C.editClip(samples,'b','right',900).find(c=>c.id==='b').end,900);
});
