const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/resolution.js');

// All 14 rows supplied by the user, 16:9 and multiple=32.
const rows = [
  [.2,608,352],[.3,736,416],[.4,864,480],[.5,960,544],
  [.6,1056,608],[.7,1152,640],[.8,1216,672],[.9,1280,736],
  [.98,1344,768],[1,1376,768],[1.2,1504,832],[1.5,1664,928],
  [1.8,1824,1024],[2,1920,1088]
];
test('Resolution Selector: all supplied reference-table rows match',()=>{
  for(const [megapixels,width,height] of rows)
    assert.deepEqual(R.calculate({aspect_ratio:'16:9',megapixels,multiple:32}),{width,height},`${megapixels} MP`);
});
test('Square uses 1024² pixels; portrait mirrors landscape',()=>{
  assert.deepEqual(R.calculate({aspect_ratio:'1:1',megapixels:1,multiple:32}),{width:1024,height:1024});
  assert.deepEqual(R.calculate({aspect_ratio:'9:16',megapixels:1.2,multiple:32}),{width:832,height:1504});
});
test('All eight node ratios and all valid multiple steps produce divisible dimensions',()=>{
  assert.equal(R.ASPECTS.length,8);
  for(const a of R.ASPECTS)for(let multiple=8;multiple<=128;multiple+=4){
    const result=R.calculate({aspect_ratio:a.value,megapixels:1.2,multiple});
    assert.equal(result.width%multiple,0);assert.equal(result.height%multiple,0);
    assert.ok(result.width>0&&result.height>0);
  }
});
test('Nearest multiple uses Python ties-to-even, not JS half-up',()=>{
  for(const edge of [1008,1040])
    assert.deepEqual(R.calculate({aspect_ratio:'1:1',megapixels:(edge/1024)**2,multiple:32}),{width:1024,height:1024});
});
test('Invalid inputs never become NaN/zero sizes or silent fallback presets',()=>{
  for(const megapixels of [0,-1,.09,16.01,Infinity,NaN,'1.2',null])
    assert.throws(()=>R.calculate({...R.DEFAULT,megapixels}),RangeError);
  for(const multiple of [0,7,9,30,132,NaN,32.1])
    assert.throws(()=>R.calculate({...R.DEFAULT,multiple}),RangeError);
  assert.throws(()=>R.calculate({...R.DEFAULT,aspect_ratio:'bad'}),RangeError);
});
test('Calculating does not mutate the clip settings',()=>{
  const settings={...R.DEFAULT};R.calculate(settings);
  assert.deepEqual(settings,{aspect_ratio:'16:9',megapixels:1.2,multiple:32});
});
