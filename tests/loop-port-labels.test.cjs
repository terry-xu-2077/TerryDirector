const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "web", "terry_director.js"), "utf8"
);
const match = source.match(/function syncLoopSocketLabels\(node\) \{[\s\S]*?\n\}\n\n/);
if (!match) throw Error("No loop socket name sync function");
const normalize = new Function(
  "LOOP_INFO_NODE_CLASS", "LOOP_END_NODE_CLASS",
  match[0] + "\nreturn syncLoopSocketLabels;"
)("TerryDirectorLoopInfo", "TerryDirectorLoopEnd");

test("loop info legacy sample-frame text becomes model-neutral without link changes", () => {
  const node = {
    comfyClass: "TerryDirectorLoopInfo",
    outputs: [{name:"提示词"}, {name:"H3帧数",links:[9,19]}, {name:"Seed"}],
    changes: 0, setDirtyCanvas() {this.changes++;}
  };
  normalize(node);
  assert.equal(node.outputs[1].name, "采样帧数");
  assert.equal(node.outputs[1].localized_name, "采样帧数");
  assert.deepEqual(node.outputs[1].links, [9,19]);
  assert.equal(node.changes, 1);
});

test("loop end sampling input retains backend samples ID and connected wire", () => {
  const node = {
    comfyClass: "TerryDirectorLoopEnd",
    inputs: [
      {name:"samples", localized_name:"H3采样结果",label:"H3采样结果",link:34},
      {name:"vae",link:35},
    ],
    changes:0,setDirtyCanvas() {this.changes++;}
  };
  normalize(node);
  assert.equal(node.inputs[0].name, "samples");
  assert.equal(node.inputs[0].localized_name,"采样结果");
  assert.equal(node.inputs[0].label,"采样结果");
  assert.equal(node.inputs[0].link,34);
  assert.equal(node.changes,1);
});

test("new labels are idempotent and no operation on other director nodes", () => {
  const node = {
    comfyClass:"TerryDirectorLoopInfo",
    outputs:[{name:"提示词"}, {name:"采样帧数",localized_name:"采样帧数"}],
    changes:0,setDirtyCanvas() {this.changes++;}
  };
  normalize(node);
  normalize(node);
  assert.equal(node.outputs[1].name,"采样帧数");
  assert.equal(node.outputs[1].localized_name,"采样帧数");
  const unrelated = {
    comfyClass:"TerryDirectorAdvanced",
    changes:0,setDirtyCanvas() {this.changes++;}
  };
  normalize(unrelated);
  assert.equal(unrelated.changes,0);
});

test("user-customized labels remain user-controlled", () => {
  const info = {
    comfyClass:"TerryDirectorLoopInfo",
    outputs:[{name:"提示词"},{name:"H3帧数",label:"Custom Frame Count"}],
    setDirtyCanvas() {},
  };
  normalize(info);
  assert.equal(info.outputs[1].label,"Custom Frame Count");
  const end = {
    comfyClass:"TerryDirectorLoopEnd",
    inputs:[{name:"samples",label:"My Latent",link:123}],
    setDirtyCanvas() {},
  };
  normalize(end);
  assert.equal(end.inputs[0].label,"My Latent");
});
