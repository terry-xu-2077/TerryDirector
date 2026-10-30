// Run: node tests/test_preview_auto_vae.mjs
// Mirrors a real H3 workflow where SamplerCustom #11 low_clean fans out to
// checkpoint #13 and VAE video/audio -> VHS_VideoCombine #100.
// The independent high-res video ends at VHS_VideoCombine #42.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const src=await readFile(new URL("../web/td_preview_job_compiler.js",import.meta.url),"utf8");
const params=await readFile(new URL("../web/td_preview_task_parameters.js",import.meta.url),"utf8");
const url="data:text/javascript;base64,"+Buffer.from(params).toString("base64");
const mod=await import("data:text/javascript;base64,"+Buffer.from(
  src.replace('"./td_preview_task_parameters.js"',JSON.stringify(url))
).toString("base64"));
const {detectLowresReviewSink,compilePreviewTargets,buildPreviewJob}=mod;

const node=(id,type,inputs=[],outs=[])=>({
  id,type,inputs:inputs.map(([name,link])=>({name,link})),
  outputs:outs.map(links=>({links}))
});
const workflow={nodes:[
  node(11,"SamplerCustom",[],[[],[15,193,194]]),
  node(13,"TerryDirectorSelfLiftPauseResume",[["low_clean",15]],[[98],[]]),
  node(99,"VAEDecode",[["samples",193]],[[195]]),
  node(98,"VAEDecodeAudio",[["samples",194]],[[196]]),
  node(100,"VHS_VideoCombine",[["images",195],["audio",196]],[[]]),
  node(18,"TerryDirectorSelfLiftHighres",[["checkpoint",98]],[[94]]),
  node(19,"VAEDecode",[["samples",92]],[[59]]),
  node(20,"VAEDecodeAudio",[["samples",93]],[[60]]),
  node(42,"VHS_VideoCombine",[["images",59],["audio",60]],[[]]),
],links:[
  [15,11,1,13,1,"LATENT"],
  [193,11,1,99,0,"LATENT"],[194,11,1,98,0,"LATENT"],
  [195,99,0,100,0,"IMAGE"],[196,98,0,100,1,"AUDIO"],
  [98,13,0,18,0,"CHECKPOINT"],[94,18,0,19,0,"LATENT"],
  [92,18,0,19,0,"LATENT"],[93,18,0,20,0,"LATENT"],
  [59,19,0,42,0,"IMAGE"],[60,20,0,42,1,"AUDIO"],
]};
const api=Object.fromEntries(workflow.nodes.map(n=>[String(n.id),{
  class_type:n.type,inputs:{}
}]));
const link=(target,name,origin,slot)=>{api[String(target)].inputs[name]=[String(origin),slot];};
link(13,"low_clean",11,1);
link(99,"samples",11,1);link(98,"samples",11,1);
link(100,"images",99,0);link(100,"audio",98,0);
link(18,"checkpoint",13,0);
link(19,"samples",18,0);link(20,"samples",18,0);
link(42,"images",19,0);link(42,"audio",20,0);
api["13"].inputs.mode="暂停并保存";
api["13"].inputs.checkpoint_id="";

// The user can see the detected sink even before saving/import compilation.
assert.deepEqual(detectLowresReviewSink(workflow,{},13),
  {id:"100",type:"VHS_VideoCombine"});
const detected=compilePreviewTargets(workflow,api,13);
assert.equal(detected.decoded_target,"100");
assert.equal(detected.highres_target,"42");
const template={
  schema:2,workflow,api_prompt:api,pause_node_id:13,
  pause_target:"13",highres_target:"42",decoded_target:null,
};
// Old templates/drafts with decoded_target=null are automatically repaired.
const low=buildPreviewJob(template,[],"pause","","decoded");
assert.deepEqual(low.targets,["13","100"]);
assert.equal(low.output["100"].class_type,"TerryDirectorLowresReviewSave");
assert.deepEqual(low.output["100"].inputs,{
  checkpoint_id:["13",1],images:["99",0],audio:["98",0],
});
assert.equal(low.output["42"].class_type,"VHS_VideoCombine");
assert.equal(low.output["13"].inputs.preview_tiny_vae,"none");
assert.equal(api["100"].class_type,"VHS_VideoCombine",
  "Conversion must never edit saved template or canvas");

// Sampling preview must not run a full VAE decode by accident.
const fast=buildPreviewJob(template,[],"pause","","sampling");
assert.deepEqual(fast.targets,["13"]);
assert.equal(fast.output["100"].class_type,"VHS_VideoCombine");

// High-resolution continuation must keep the high-res video output unchanged.
const high=buildPreviewJob(template,[],"continue","a".repeat(32),"decoded");
assert.deepEqual(high.targets,["42"]);
assert.equal(high.output["100"].class_type,"VHS_VideoCombine");

// Reject a VHS branch that contains only video or is not from low_clean.
const noAudio=structuredClone(workflow),noAudioApi=structuredClone(api);
noAudioApi["100"].inputs.audio=["20",0];
assert.equal(detectLowresReviewSink(noAudio,noAudioApi,13),null);
const brokenTemplate={...template,api_prompt:noAudioApi};
assert.throws(()=>buildPreviewJob(brokenTemplate,[],"pause","","decoded"),
  /未识别到低清 VAE 审片线路/);
console.log("Preview Stage auto low-res VAE detection, checkpoint capture and isolation: PASS");
