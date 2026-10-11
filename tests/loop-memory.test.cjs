const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "web", "td_loop_memory.js"), "utf8"
);
const load = import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));

function node(id, comfyClass, inputNames = [], widgetValues = {}) {
  return {
    id, comfyClass,
    inputs: inputNames.map(name => ({ name, link: null })),
    widgets: Object.entries(widgetValues).map(([name, value]) => ({ name, value })),
    sources: {},
  };
}
function connect(source, target, slot) {
  target.sources[slot] = source;
  const input = target.inputs.find(item => item.name === slot);
  if (input) input.link = source.id;
}
const follow = (node, slot) => node?.sources?.[slot] || null;

function example() {
  const looper = node(1, "TerryDirectorLooper");
  const info = node(2, "TerryDirectorLoopInfo", ["loop_context"]);
  const h3 = node(3, "MiniMaxH3ReferenceToVideo",
    ["clip", "vae", "audio_vae", "width", "height", "prompt", "length"],
    { width: 608, height: 352 }
  );
  const condition = node(4, "TerryDirectorLoopCondition", ["positive", "latent"]);
  const guider = node(5, "BasicGuider", ["model", "conditioning"]);
  const sampler = node(6, "SamplerCustomAdvanced", ["noise", "guider", "sigmas", "latent_image"]);
  const end = node(7, "TerryDirectorLoopEnd", ["samples", "segment_data"]);
  connect(looper, info, "loop_context");
  connect(info, end, "segment_data");
  connect(sampler, end, "samples");
  connect(guider, sampler, "guider");
  connect(condition, guider, "conditioning");
  connect(h3, condition, "positive");
  connect(h3, sampler, "latent_image");
  return {looper, info, h3, condition, guider, sampler, end};
}

test("loop end resolves its own looper through segment data, not model connections", async () => {
  const { findLoopMemorySources, readH3Resolution } = await load;
  const value = example();
  const result = findLoopMemorySources(value.end, follow);
  assert.equal(result.looper, value.looper);
  assert.equal(result.h3, value.h3);
  assert.deepEqual(readH3Resolution(result.h3), {width:608,height:352});
});

test("never guess resolution when native H3 width or height is wired", async () => {
  const { readH3Resolution } = await load;
  const value = example();
  value.h3.inputs.find(x=>x.name==="width").link = 123;
  assert.equal(readH3Resolution(value.h3), null);
  value.h3.inputs.find(x=>x.name==="width").link = null;
  value.h3.inputs.find(x=>x.name==="height").link = 124;
  assert.equal(readH3Resolution(value.h3), null);
});

test("missing or invalid resolution is pending rather than invented", async () => {
  const { readH3Resolution } = await load;
  const { h3 } = example();
  h3.widgets.find(w=>w.name==="height").value = 0;
  assert.equal(readH3Resolution(h3), null);
  h3.widgets.find(w=>w.name==="height").value = "unknown";
  assert.equal(readH3Resolution(h3), null);
  h3.widgets.find(w=>w.name==="height").value = 352;
  h3.widgets.find(w=>w.name==="width").value = 608.5;
  assert.equal(readH3Resolution(h3), null);
});

test("multiple H3 conditioners return unknown instead of arbitrarily picking one", async () => {
  const { findLoopMemorySources } = await load;
  const value = example();
  const second = node(8, "MiniMaxH3ReferenceToVideo", ["width","height"],{width:1024,height:576});
  connect(second,value.guider,"model");
  const result = findLoopMemorySources(value.end, follow);
  assert.equal(result.looper,value.looper);
  assert.equal(result.h3,null);
});

test("disconnected or miswired segment data cannot attribute another loop", async () => {
  const { findLoopMemorySources } = await load;
  const value = example();
  delete value.end.sources.segment_data;
  assert.equal(findLoopMemorySources(value.end,follow).looper,null);
  connect(node(12,"TerryDirectorLooper"),value.end,"segment_data");
  assert.equal(findLoopMemorySources(value.end,follow).looper,null);
});

test("finds H3 conditioner through native guider and image conditioning graph", async () => {
  const { findLoopMemorySources } = await load;
  const value = example();
  connect(value.condition,value.sampler,"guider"); // additional path
  assert.equal(findLoopMemorySources(value.end,follow).h3,value.h3);
});
