// Run: node tests/test_preview_candidate_fallback.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const moduleSource=await readFile(new URL("../web/td_preview_candidate_buffer.js",import.meta.url),"utf8");
const mod=await import("data:text/javascript;base64,"+
 Buffer.from(moduleSource).toString("base64"));
const src=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
assert.doesNotThrow(()=>new Function(
 src.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const preview=(step,payload,total=3)=>({
 step,total,mime:"video/mp4",image:Buffer.from(payload).toString("base64"),
});
const job={checkpointId:"a".repeat(32),preview_type:"sampling",duration_seconds:15};
mod.rememberSamplingPreview(job,preview(1,"valid-1"));
mod.rememberSamplingPreview(job,preview(2,"valid-2"));
mod.rememberSamplingPreview(job,preview(3,"invalid-final"));
assert.equal(job.preview.step,3);
assert.deepEqual(mod.finalSamplingCandidates(job).map(x=>x.step),[3,2,1]);
assert.equal(mod.previewFallbackWarning(mod.finalSamplingCandidates(job)[1],
  mod.finalSamplingCandidates(job)),
  "最后一轮采样预览视频编码异常，已回退保存第 2 / 3 步的可播放预览");
assert.equal(mod.rememberSamplingPreview(job,preview(1,"too-late")),false);
for(let i=4;i<=10;i++)mod.rememberSamplingPreview(job,preview(i,"ok"+i,10));
assert.deepEqual(mod.finalSamplingCandidates(job).map(x=>x.step),[10,9,8,1],
  "Keep the first preview as fallback when all recent KJ H.264 packets are corrupt");
assert.ok(job.previewCandidates.length<=mod.MAX_PREVIEW_CANDIDATES);

const source=src.slice(src.indexOf("async function persistPreview(job) {"),
  src.indexOf("async function saveLegacyLifecycle(",src.indexOf("async function persistPreview(job) {")));
assert.ok(source.includes("recordPreviewSaveResult(job,p,"));
assert.ok(source.includes("const candidates=finalSamplingCandidates(job)"));
assert.ok(source.includes("for(const p of candidates)"));
const sent=[];
const response=ok=>({ok,status:ok?200:400,json:async()=>({
 error:"Invalid NAL unit size in H.264 bitstream",
})});
const api={fetchApi:async (url,init)=>{
 const bytes=Buffer.from(init.body).toString("utf8");
 sent.push({url,bytes});
 return response(bytes!=="invalid-final");
}};
let meta={workflow_name:"Test",pause_node_id:"13"};
const requests=[];
const request=async (path,opts)=>{
 if(!opts)return meta;
 requests.push({path,body:JSON.parse(opts.body)});
 meta=JSON.parse(opts.body);
 return {ok:true};
};
const messages=[];
const persist=new Function("api","URL_BASE","atob","request","console",
 "finalSamplingCandidates","previewFallbackWarning","samplingPreviewEnabled",
 source+"return persistPreview;")(
 api,"/terrydirector/api/selflift",globalThis.atob,request,
 {warn:(...args)=>messages.push(args),error:(...args)=>messages.push(args)},
 mod.finalSamplingCandidates,mod.previewFallbackWarning,
 value=>typeof value?.sampling_preview_enabled==="boolean"?value.sampling_preview_enabled:value?.preview_type!=="decoded");
const task={checkpointId:"a".repeat(32),preview_type:"sampling",
 duration_seconds:15};
for(let i=1;i<=3;i++)mod.rememberSamplingPreview(task,preview(i,
 i===3?"invalid-final":"valid-"+i));
assert.equal(await persist(task),true);
assert.equal(task.uploadedStep,2);
assert.equal(task.previewSaved,true);
assert.equal(sent.length,2);
assert.deepEqual(sent.map(x=>x.bytes),["invalid-final","valid-2"]);
assert.equal(requests.length,1);
assert.equal(meta.preview_saved_step,2);
assert.equal(meta.preview_total_steps,3);
assert.equal(meta.preview_error,null);
assert.match(meta.preview_warning,/第 2 \/ 3 步/);
assert.equal(await persist(task),false,"Already saved jobs cannot upload again");

const complete={checkpointId:"b".repeat(32),preview_type:"sampling",duration_seconds:15};
mod.rememberSamplingPreview(complete,preview(3,"valid-3"));
sent.length=0; requests.length=0;
assert.equal(await persist(complete),true);
assert.equal(sent.length,1);
assert.equal(complete.uploadedStep,3);
assert.equal(complete.previewSaveWarning,null);
assert.equal(meta.preview_warning,null);

const bad={checkpointId:"c".repeat(32),preview_type:"sampling",duration_seconds:15};
mod.rememberSamplingPreview(bad,preview(2,"invalid-final",3));
const failedApi={fetchApi:async ()=>response(false)};
const failPersist=new Function("api","URL_BASE","atob","request","console",
 "finalSamplingCandidates","previewFallbackWarning","samplingPreviewEnabled",
 source+"return persistPreview;")(
 failedApi,"/terrydirector/api/selflift",globalThis.atob,request,
 {warn:()=>{},error:()=>{}},
 mod.finalSamplingCandidates,mod.previewFallbackWarning,
 value=>typeof value?.sampling_preview_enabled==="boolean"?value.sampling_preview_enabled:value?.preview_type!=="decoded");
assert.equal(await failPersist(bad),false);
assert.equal(bad.previewSaved,undefined);
assert.match(bad.previewSaveError,/已尝试 1 轮/);
console.log("KJ preview candidate buffer: final-step failure recovers prior decoded video: PASS");
