// Run: node tests/test_preview_sampling_progress.mjs
// Native Comfy progress -> per-task tqdm-shaped status without DOM rebuilds.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const src=await readFile(new URL("../web/td_preview_sampling_progress.js",import.meta.url),"utf8");
const m=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
const manager=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");

const low={mode:"pause",api_prompt:{"11":{class_type:"SamplerCustom",inputs:{}}},
  progressStartedAt:1000,busy:true};
const high={mode:"continue",api_prompt:{"22":{class_type:"SamplerCustomAdvanced",inputs:{}}},
  progressStartedAt:1000,busy:true};
const sample=m.progressFromEvent({node:"11",value:1,max:3},low);
assert.deepEqual(sample,{nodeId:"11",value:1,max:3});
assert.deepEqual(m.progressFromEvent({node:"22",value:1,max:3},low),null);
assert.deepEqual(m.progressFromEvent({node:"11",value:1,max:3},high),null);
const manual={mode:"pause",workflow:{nodes:[{id:44,type:"SamplerCustom"}]}};
assert.deepEqual(m.progressFromEvent({node:"44",value:1,max:3},manual),
  {nodeId:"44",value:1,max:3});
assert.deepEqual(m.progressFromEvent({node:"11",value:2,max:0},low),null);
assert.deepEqual(m.progressFromEvent({node:"11",value:5,max:3},low),null);
const first=m.recordSamplerProgress(low,sample,689330);
assert.equal(first.stage,"low");
assert.equal(m.formatSamplingProgress(first,689330),
  "33%|███▎      | 1/3 [11:28<22:56, 688.33s/it]");
assert.equal(m.recordSamplerProgress(low,{nodeId:"11",value:0,max:3},700000),null,
  "Stale/regressed progress must be ignored");
const fromState=m.progressFromState({prompt_id:"high1",nodes:{
  "loader":{node_id:"13",display_node_id:"13",state:"running",value:5,max:10},
  "sampler":{node_id:"22",display_node_id:"22",state:"running",value:2,max:3},
}},high);
assert.deepEqual(fromState,{nodeId:"22",value:2,max:3});
const highProgress=m.recordSamplerProgress(high,fromState,128000);
assert.equal(highProgress.stage,"high");
assert.match(m.formatSamplingProgress(highProgress,128000),/^67%\|/);

const start=manager.indexOf("function runningJobForTask(task) {");
const end=manager.indexOf("function thumb(task) {",start);
assert.ok(start>=0 && end>start);
const state={jobs:new Map([
  ["low-prompt",{...low,draftId:"draft_low",samplingProgress:first}],
  ["high-prompt",{...high,draftId:"draft_high",samplingProgress:highProgress}],
]),root:null};
const esc=x=>String(x);
const utils=new Function("state","esc","formatSamplingProgress",
  manager.slice(start,end)+"return {runningJobForTask,taskProgressText,progressMarkup,updateTaskProgress,handleSamplerProgress};")
 (state,esc,m.formatSamplingProgress);
const lowText=utils.taskProgressText({id:"draft_low"});
const highText=utils.taskProgressText({id:"draft_high"});
assert.ok(lowText.startsWith("33%|"));
assert.ok(highText.startsWith("67%|"));
assert.equal(utils.taskProgressText({id:"unrelated"}),"");
assert.match(utils.progressMarkup({id:"draft_low"}),/data-progress-task-id="draft_low"/);
const elLow={dataset:{progressTaskId:"draft_low"},textContent:"",title:""};
const elHigh={dataset:{progressTaskId:"draft_high"},textContent:"",title:""};
state.root={querySelectorAll:()=>[elLow,elHigh]};
utils.updateTaskProgress(state.jobs.get("low-prompt"));
assert.match(elLow.textContent,/33%\|/);
assert.equal(elHigh.textContent,"");
const handlers=[];
const original=manager.slice(manager.indexOf('api.addEventListener("progress",'),
  manager.indexOf('api.addEventListener("kj_preview_override",'));
assert.match(original,/progress_state/);
assert.ok(!original.includes("render()"),"Progress must not recreate the player");
assert.ok(manager.includes('progressMarkup(t)'));
assert.ok(manager.includes("if(!job || !job.busy || job.finalizing)return;"));
assert.ok(manager.includes("promptId!==state.activePromptId"));
console.log("Preview Stage actual sampler progress, tqdm layout, low/high and queue isolation: PASS");
