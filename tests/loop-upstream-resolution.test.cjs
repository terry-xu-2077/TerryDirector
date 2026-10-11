const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "td_loop_memory.js"), "utf8");
const load = import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));

function node(id, comfyClass, inputs = [], widgetValues = {}) {
  return {
    id, comfyClass,
    inputs: inputs.map(name => ({name, link: null})),
    widgets: Object.entries(widgetValues).map(([name, value]) => ({name, value})),
    sources: {},
  };
}
function connect(from, to, input, outputIndex = 0) {
  to.sources[input] = {node: from, outputIndex};
  const slot = to.inputs.find(x => x.name === input);
  if (!slot) throw new Error("No input: " + input);
  slot.link = from.id * 10 + outputIndex;
}
const sourceOf = (n, input) => n?.sources?.[input] || null;
const selector = () => node(1, "ResolutionSelector",
  ["aspect_ratio", "megapixels", "multiple"],
  {aspect_ratio: "16:9 (Widescreen)", megapixels: 0.5, multiple: 32});
const h3 = () => node(2, "MiniMaxH3ReferenceToVideo", ["width", "height"],
  {width: 608, height: 352});

test("direct H3 widget dimensions remain readable", async () => {
  const { readH3Resolution } = await load;
  assert.deepEqual(readH3Resolution(h3()), {width: 608, height: 352});
});

test("official ResolutionSelector overrides stale H3 608x352 with actual 960x544", async () => {
  const { readH3Resolution } = await load;
  const parent = selector(), model = h3();
  connect(parent, model, "width", 0);
  connect(parent, model, "height", 1);
  assert.deepEqual(readH3Resolution(model, sourceOf), {
    width: 960, height: 544, source: "upstream",
  });
});

test("upstream selector parameter changes refresh the calculated dimensions", async () => {
  const { readH3Resolution } = await load;
  const parent = selector(), model = h3();
  connect(parent, model, "width", 0);
  connect(parent, model, "height", 1);
  parent.widgets.find(w => w.name === "megapixels").value = 1.0;
  assert.deepEqual(readH3Resolution(model, sourceOf), {
    width: 1376, height: 768, source: "upstream",
  });
  parent.widgets.find(w => w.name === "aspect_ratio").value = "9:16 (Portrait Widescreen)";
  assert.deepEqual(readH3Resolution(model, sourceOf), {
    width: 768, height: 1376, source: "upstream",
  });
});

test("direct width and connected height may use independent values", async () => {
  const { readH3Resolution } = await load;
  const parent = selector(), model = h3();
  connect(parent, model, "height", 1);
  assert.deepEqual(readH3Resolution(model, sourceOf), {
    width: 608, height: 544, source: "upstream",
  });
});

test("selector inputs can themselves use fixed upstream PrimitiveFloat/Int", async () => {
  const { readH3Resolution } = await load;
  const parent = selector(), model = h3();
  const mp = node(3, "PrimitiveFloat", ["value"], {value: 0.5});
  const multiple = node(4, "PrimitiveInt", ["value"], {value: 32});
  connect(mp, parent, "megapixels");
  connect(multiple, parent, "multiple");
  connect(parent, model, "width", 0);
  connect(parent, model, "height", 1);
  assert.deepEqual(readH3Resolution(model, sourceOf), {
    width: 960, height: 544, source: "upstream",
  });
});

test("plain reroute preserves a statically known resolution", async () => {
  const { readH3Resolution } = await load;
  const parent = selector(), model = h3();
  const reroute = node(5, "Reroute", ["input"]);
  connect(parent, reroute, "input", 0);
  connect(reroute, model, "width", 0);
  connect(parent, model, "height", 1);
  assert.deepEqual(readH3Resolution(model, sourceOf), {
    width: 960, height: 544, source: "upstream",
  });
});

test("unknown dynamic upstream must not fall back to stale H3 widgets", async () => {
  const { readH3Resolution } = await load;
  const model = h3(), random = node(7, "RandomInt");
  connect(random, model, "width");
  assert.equal(readH3Resolution(model, sourceOf), null);
});

test("unknown selector setting must not yield a fabricated estimate", async () => {
  const { readH3Resolution } = await load;
  const parent = selector(), model = h3(), random = node(8, "RandomFloat");
  parent.widgets.find(w => w.name === "megapixels").value = 0.5;
  connect(random, parent, "megapixels");
  connect(parent, model, "width", 0);
  connect(parent, model, "height", 1);
  assert.equal(readH3Resolution(model, sourceOf), null);
});

test("invalid output slots and missing link metadata are not interpreted as constants", async () => {
  const { readH3Resolution } = await load;
  const parent = selector(), model = h3();
  connect(parent, model, "width", 4);
  connect(parent, model, "height", 1);
  assert.equal(readH3Resolution(model, sourceOf), null);
  const missing = h3();
  missing.inputs[0].link = 1234;
  assert.equal(readH3Resolution(missing, sourceOf), null);
});
