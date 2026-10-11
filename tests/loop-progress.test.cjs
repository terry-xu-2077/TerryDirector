const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "web", "td_loop_progress.js"), "utf8"
);
const load = import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));

const graph = {
  _nodes: [
    { id: 10, comfyClass: "TerryDirectorLooper" },
    { id: 11, comfyClass: "TerryDirectorLooper" },
    { id: 12, comfyClass: "TerryDirectorAdvanced" },
    { id: 90, comfyClass: "SamplerCustomAdvanced" },
    { id: 91, comfyClass: "KSampler" },
    { id: 92, comfyClass: "KSamplerSelect" },
    { id: 93, comfyClass: "BasicScheduler" },
    { id: 94, comfyClass: "TerryDirectorSelfLiftSampler" },
    { id: 95, comfyClass: "CustomDiffusionSampler" },
  ],
};

function state(id, {
  owner = "10",
  display = "90",
  value = 2,
  max = 4,
  phase = "running",
  parent,
} = {}) {
  return {
    node_id: id,
    display_node_id: display,
    real_node_id: owner,
    parent_node_id: parent,
    state: phase,
    value,
    max,
  };
}

test("0-based active iteration is parsed from ComfyUI GraphBuilder node IDs", async () => {
  const { collectLoopSamplerProgress } = await load;
  const id = "10.0.0.1_90";
  assert.deepEqual(collectLoopSamplerProgress({
    prompt_id: "test-prompt",
    nodes: { [id]: state(id) },
  }, graph), [{
    loopId: "10",
    iteration: 1,
    sourceId: "90",
    step: 2,
    totalSteps: 4,
    fraction: 0.5,
  }]);
});

test("partial step uses exact native value/max and clamps bad callback range", async () => {
  const { collectLoopSamplerProgress } = await load;
  const nodes = {
    "10.0.0.0_90": state("10.0.0.0_90", { value: 1, max: 6 }),
    "10.0.0.2_91": state("10.0.0.2_91", { display: "91", value: 20, max: 8 }),
  };
  const updates = collectLoopSamplerProgress({prompt_id:"x",nodes},graph);
  assert.equal(updates[0].fraction, 1 / 6);
  assert.equal(updates[0].totalSteps, 6);
  assert.equal(updates[1].step, 8);
  assert.equal(updates[1].fraction, 1);
});

test("only active samples inside the correct loop are eligible", async () => {
  const { collectLoopSamplerProgress } = await load;
  const nodes = {
    "10.0.0.0_90": state("10.0.0.0_90"),
    "11.0.0.1_91": state("11.0.0.1_91", {owner:"11",display:"91",value:1,max:3}),
    "12.0.0.0_90": state("12.0.0.0_90", {owner:"12"}),
    "10.0.0.1_92": state("10.0.0.1_92", {display:"92"}),
    "10.0.0.1_93": state("10.0.0.1_93", {display:"93"}),
    "10.0.0.0_94": state("10.0.0.0_94", {display:"94", phase:"finished"}),
  };
  const result = collectLoopSamplerProgress({prompt_id:"x",nodes}, graph);
  assert.deepEqual(result.map(x=>[x.loopId,x.iteration,x.sourceId]),[
    ["10",0,"90"], ["11",1,"91"],
  ]);
});

test("does not use stale completed samplers or default node progress as generation", async () => {
  const { collectLoopSamplerProgress } = await load;
  const nodes = {
    "10.0.0.0_90": state("10.0.0.0_90",{phase:"finished",value:4}),
    "10.0.0.1_92": state("10.0.0.1_92",{display:"92",max:1,value:0}),
    "10.0.0.2_95": state("10.0.0.2_95",{display:"95",max:1,value:0}),
  };
  assert.deepEqual(collectLoopSamplerProgress({prompt_id:"x",nodes},graph),[]);
});

test("supports custom and SelfLift samplers with native progress", async () => {
  const { collectLoopSamplerProgress } = await load;
  const nodes = {
    "10.0.0.0_94": state("10.0.0.0_94",{display:"94",max:5,value:3}),
    "11.0.0.0_95": state("11.0.0.0_95",{owner:"11",display:"95",max:6,value:2}),
  };
  const result = collectLoopSamplerProgress({prompt_id:"x",nodes}, graph);
  assert.deepEqual(result.map(x=>x.fraction),[0.6,2/6]);
});

test("suspended clips do not consume native loop iteration indices", async () => {
  const { activeLoopClip } = await load;
  const clips=[
    {id:"clip-1",suspended:false},
    {id:"clip-2",suspended:true},
    {id:"clip-3",suspended:false},
    {id:"clip-4",suspended:true},
    {id:"clip-5",suspended:false},
  ];
  assert.equal(activeLoopClip(clips,0).id,"clip-1");
  assert.equal(activeLoopClip(clips,1).id,"clip-3");
  assert.equal(activeLoopClip(clips,2).id,"clip-5");
  assert.equal(activeLoopClip(clips,3),null);
  assert.equal(activeLoopClip(null,0),null);
  assert.equal(activeLoopClip(clips,-1),null);
});

test("ignores events with no reliable loop ownership or iteration", async () => {
  const { collectLoopSamplerProgress } = await load;
  const ids=[
    "0_90",
    "10.0.0.helper",
    "10.0.0.0",
    "10.0.0.3_",
  ];
  const nodes=Object.fromEntries(ids.map(id=>[id,state(id)]));
  nodes["0_90"].real_node_id = "something-other-than-loop";
  assert.deepEqual(collectLoopSamplerProgress({prompt_id:"x",nodes},graph),[]);
  assert.deepEqual(collectLoopSamplerProgress({nodes},graph),[]);
  assert.deepEqual(collectLoopSamplerProgress(null,graph),[]);
});

test("falls back to direct parent when older progress payload omits real_node_id", async () => {
  const { collectLoopSamplerProgress } = await load;
  const record=state("10.0.0.0_90",{parent:"10"});
  delete record.real_node_id;
  const result=collectLoopSamplerProgress({
    prompt_id:"x",nodes:{"10.0.0.0_90":record},
  },graph);
  assert.equal(result.length,1);
  assert.equal(result[0].loopId,"10");
});
