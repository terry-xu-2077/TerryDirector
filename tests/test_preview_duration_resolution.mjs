// Run: node tests/test_preview_duration_resolution.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const src=await readFile(new URL("../web/td_preview_task_parameters.js",import.meta.url),"utf8");
const manager=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const compilerSrc=await readFile(new URL("../web/td_preview_job_compiler.js",import.meta.url),"utf8");
const mod=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
const {taskVideoFrameCount,taskResolutionInfo,applyTaskVideoParameters}=mod;
assert.equal(mod.PREVIEW_DURATION_DEFAULT,15);
assert.equal(mod.PREVIEW_RESOLUTION_DEFAULT,2.0);
assert.deepEqual([mod.PREVIEW_DURATION_MIN,mod.PREVIEW_DURATION_MAX],[4,20]);
assert.equal(taskVideoFrameCount(15),362);
assert.ok(taskVideoFrameCount(4)<taskVideoFrameCount(15));
assert.ok(taskVideoFrameCount(20)>taskVideoFrameCount(15));
for(const bad of [3,21,8.5,NaN])assert.throws(()=>taskVideoFrameCount(bad));
const dim=taskResolutionInfo(.8,"16:9 (Widescreen)");
assert.deepEqual(dim.low,{width:608,height:352});
assert.deepEqual(dim.high,{width:1216,height:672});
assert.equal(dim.lowMp,.2);
const inputs={
  "6":{class_type:"MiniMaxH3ReferenceToVideo",inputs:{length:["29",1]}},
  "12":{class_type:"EmptyMiniMaxH3LatentAV",inputs:{length:["29",1]}},
  "36":{class_type:"TerryDirectorDualSamplingResolutionSelector",
        inputs:{aspect_ratio:"16:9 (Widescreen)",highres_megapixels:["28",0]}},
};
const original=structuredClone(inputs);
const result=applyTaskVideoParameters(inputs,{duration_seconds:15,highres_megapixels:.8});
assert.equal(result.frames,362);
assert.equal(inputs["6"].inputs.length,362);
assert.equal(inputs["12"].inputs.length,362);
assert.equal(inputs["36"].inputs.highres_megapixels,.8);
assert.deepEqual(original["6"].inputs.length,["29",1]);
assert.deepEqual(original["36"].inputs.highres_megapixels,["28",0]);
const comp=new Function("applyTaskVideoParameters",compilerSrc.replace(/^import[^\n]*\n/gm,"").replace(/\bexport\s+/gm,"")+
 ";return buildPreviewJob;")(applyTaskVideoParameters);
const config={
  schema:2,api_prompt:{
    ...original,
    "13":{class_type:"TerryDirectorSelfLiftPauseResume",inputs:{mode:"暂停并保存",checkpoint_id:"",name:"test"}},
  },
  workflow:{nodes:[]},pause_node_id:"13",pause_target:"13",highres_target:"22",
  duration_seconds:15,highres_megapixels:.8,
};
const job=comp(config,[],"pause","","sampling");
assert.equal(job.output["6"].inputs.length,362);
assert.equal(job.output["12"].inputs.length,362);
assert.equal(job.output["36"].inputs.highres_megapixels,.8);
assert.deepEqual(config.api_prompt["36"].inputs.highres_megapixels,["28",0]);
assert.deepEqual(config.api_prompt["6"].inputs.length,["29",1]);
const prefix=manager.slice(manager.indexOf("function createMarkup() {"),
 manager.indexOf("function installCreatePromptEditor()"));
const create=new Function("state","esc","assetCard","PREVIEW_RESOLUTION_OPTIONS",
 "taskAspectRatio","taskResolutionInfo",prefix+";return createMarkup;")(
 {createDraft:{source:"template",name:"S01",seed:"42",prompt:"",previewType:"sampling",
   duration_seconds:15,highres_megapixels:2.0,assets:[],api_prompt:original},
  template:{workflow_name:"Default"},tasks:[],editDraftId:null},
 x=>String(x),()=>"<asset/>",mod.PREVIEW_RESOLUTION_OPTIONS,
 mod.taskAspectRatio,taskResolutionInfo);
const html=create();
assert.match(html,/type="range" id="tdm-task-duration" min="4" max="20" step="1"/);
assert.match(html,/value="15"/);
assert.ok(html.includes('data-action="task-resolution"'));
assert.ok(html.includes("2.00 MP 高清 (1888×1088)"));
assert.ok(html.includes("0.50 MP 低清 (960×544)"));
assert.ok(html.indexOf("预览输出")>html.indexOf("高清分辨率"));
assert.equal((html.match(/tdm-inline-field/g)||[]).length,6);
assert.ok(manager.includes("state.createDraft.duration_seconds=seconds;"));
assert.ok(manager.includes("state.createDraft.highres_megapixels=Number(control.value);"));
assert.ok(manager.includes("duration_seconds:draft.duration_seconds"));
assert.ok(manager.includes("highres_megapixels:draft.highres_megapixels"));
assert.ok(manager.includes("?duration="));
console.log("Preview Stage 4–20s/15s default, ratio-aware dual MP and task overrides: PASS");
