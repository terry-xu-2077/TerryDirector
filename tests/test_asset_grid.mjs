// Run: node tests/test_asset_grid.mjs
import assert from "node:assert/strict";
import {assetGridRange} from "../web/td_asset_grid.js";

for(const width of [220,300,680,1280]){
  for(const count of [0,1,150,1200,10000]){
    const height=390;
    const first=assetGridRange(count,width,height,0);
    const maxRendered=(Math.ceil(height/first.stride)+5)*first.columns;
    assert.equal(first.start,0);
    assert.ok(first.end-first.start<=maxRendered);
    assert.ok(first.end===count||first.end%first.columns===0);
    const last=assetGridRange(count,width,height,Math.max(0,Math.ceil(count/first.columns)*first.stride-height));
    assert.equal(last.end,count);
    assert.equal(last.bottom,0);
    assert.ok(last.start<=last.end);
    assert.ok(last.end-last.start<=maxRendered);
    const middle=assetGridRange(count,width,height,3000);
    assert.ok(middle.start<=middle.end);
    assert.ok(middle.end<=count);
    assert.ok(middle.top>=0&&middle.bottom>=0);
  }
}
const small=assetGridRange(150,680,390,0),large=assetGridRange(10000,680,390,0);
assert.equal(small.end-small.start,large.end-large.start);
assert.ok(large.end<50);
console.log("Asset virtual grid: bounded rendered items, responsive columns and start/end boundaries PASS");
