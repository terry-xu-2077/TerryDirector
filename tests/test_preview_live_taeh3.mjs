// Run: node tests/test_preview_live_taeh3.mjs
// Browserless regression of per-step sampling preview display and one final upload.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const candidateSource=await readFile(new URL("../web/td_preview_candidate_buffer.js",import.meta.url),"utf8");
const candidates=await import("data:text/javascript;base64,"+
  Buffer.from(candidateSource).toString("base64"));
const between=(a,b)=>{
  const start=source.indexOf(a),end=source.indexOf(b,start);
  assert.ok(start>=0&&end>start,"Missing "+a);
  return source.slice(start,end);
};
assert.doesNotThrow(()=>new Function(
  source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const urls=[],revoked=[];
const fakeURL={
  createObjectURL(blob){const url="blob:preview-"+(urls.length+1);urls.push({url,blob});return url;},
  revokeObjectURL(url){revoked.push(url);},
};
const left={id:"draft_"+ "a".repeat(32)};
const right={id:"draft_"+ "b".repeat(32)};
const host={
  dataset:{taskId:left.id},innerHTML:"",querySelector(){return null;},
};
const state={
  focused:left.id,preview:"sampling",
  tasks:[left,right],jobs:new Map(),
  root:{style:{display:"flex"},querySelector(selector){
    return selector==="[data-live-preview-host]"?host:null;
  }},
};
const uiCode=between("function effectivePreviewKind(task) {","function details(task) {");
const tools=new Function("state","URL","Blob","atob","esc","samplingPreviewEnabled","selectedTask",
  uiCode+"return {previewJobMatchesTask,updateLivePreview,livePreviewMarkup,releasePreviewBlobUrls};")
  (state,fakeURL,Blob,globalThis.atob,esc,
    value=>typeof value?.sampling_preview_enabled==="boolean"?value.sampling_preview_enabled:value?.preview_type!=="decoded",
    ()=>state.tasks.find(t=>t.id===state.focused));
const payload=(value)=>Buffer.from(value).toString("base64");
const A={draftId:left.id,preview_type:"sampling",mode:"pause",busy:true,
  preview:{image:payload("video-step-1"),mime:"video/mp4",step:1,total:4},previewVersion:1};
const B={draftId:right.id,preview_type:"sampling",mode:"pause",busy:false,
  preview:{image:payload("video-step-1-B"),mime:"video/mp4",step:1,total:2},previewVersion:1};
state.jobs.set("prompt-A",A);state.jobs.set("prompt-B",B);
tools.updateLivePreview(A);
assert.match(host.innerHTML,/采样预览/);
assert.match(host.innerHTML,/第 1 \/ 4 步/);
const first=host.innerHTML;
tools.updateLivePreview(B);
assert.equal(host.innerHTML,first,"A's preview must not be replaced by B");
// The default auto tab must update exactly like the explicitly selected sampling tab.
state.preview="auto";
A.preview={image:payload("video-step-2"),mime:"video/mp4",step:2,total:4};
A.previewVersion++;
tools.updateLivePreview(A);
assert.match(host.innerHTML,/第 2 \/ 4 步/);
assert.notEqual(host.innerHTML,first);
assert.equal(urls.length,2,"Exactly one in-memory blob per visible iteration");
assert.equal(revoked.length,0,"Keep previous video alive while swapping");
state.preview="sampling";

state.focused=right.id;host.dataset.taskId=right.id;
tools.updateLivePreview(A);
assert.match(host.innerHTML,/第 2 \/ 4 步/,"An unrelated task cannot repaint the selected pane");
B.busy=true;tools.updateLivePreview(B);
assert.match(host.innerHTML,/第 1 \/ 2 步/);
assert.equal(urls.length,3);
tools.releasePreviewBlobUrls(A);tools.releasePreviewBlobUrls(B);
assert.equal(new Set(revoked).size,urls.length,"No object URL leak after completion");

// Preview event stores only latest media in its own running job.
const eventHandlers={};
const queueApi={addEventListener(name,fn){eventHandlers[name]=fn;}};
const onPreview=between('  const onPreviewPacket = e=>{','  api.addEventListener("executed",e=>{');
let liveUpdates=0;
new Function("api","state","updateLivePreview","rememberSamplingPreview",onPreview)
  (queueApi,state,()=>{liveUpdates++;},candidates.rememberSamplingPreview);
state.activePromptId="prompt-B";
const originalA=A.preview.image;
eventHandlers.kj_preview_override({detail:{
  prompt_id:"prompt-A",node_id:17,mime:"video/mp4",
  image:payload("another"),step:3,total:4,
}});
assert.equal(A.preview.image,originalA,"Wrong KJ node ID must be ignored");
A.preview_node_id="17";
eventHandlers.kj_preview_override({detail:{
  prompt_id:"prompt-A",node_id:17,mime:"video/mp4",
  image:payload("final-step"),step:4,total:4,
}});
assert.equal(A.preview.step,4);
assert.equal(B.preview.step,1);
assert.equal(eventHandlers.kj_preview_override,eventHandlers.terrydirector_preview,
  "Legacy and native events share the same isolated task handler");
assert.equal(liveUpdates,1);
eventHandlers.kj_preview_override({detail:{
  prompt_id:"prompt-A",node_id:17,mime:"video/mp4",
  image:payload("late-stale"),step:1,total:4,
}});
assert.equal(A.preview.step,4,"An older step cannot replace a newer preview");
assert.equal(liveUpdates,1);
assert.ok(!onPreview.includes("persistPreview(job)"),
  "A live iteration must never write a file");

// Final upload is invoked only by the execution-finish handler and only once.
const diskWrites=[];
const uploadApi={fetchApi:async (path,options)=>{
  diskWrites.push({path,body:Buffer.from(options.body).toString(),mime:options.headers["Content-Type"]});
  return {ok:true,json:async()=>({ok:true})};
}};
const persistCode=between("async function persistPreview(job) {","async function saveLegacyLifecycle(");
const persist=new Function("api","URL_BASE","atob","request","console",
  "finalSamplingCandidates","previewFallbackWarning",
  persistCode+"return persistPreview;")
  (uploadApi,"/terrydirector/api/selflift",globalThis.atob,
    async(path,opts)=>opts?{ok:true}:{workflow_name:"Test"},
    console,candidates.finalSamplingCandidates,candidates.previewFallbackWarning);
A.checkpointId="a".repeat(32);
const two=await Promise.all([persist(A),persist(A)]);
assert.deepEqual(two,[true,true]);
assert.equal(diskWrites.length,1);
assert.equal(diskWrites[0].body,"final-step");
assert.equal(diskWrites[0].mime,"video/mp4");
await persist(A);
assert.equal(diskWrites.length,1,"No second final write");
const jobMetadata=between("async function persistJob(job) {","async function persistPreview(job) {");
assert.ok(!jobMetadata.includes("await persistPreview("),
  "Checkpoint event must never save a stale intermediate iteration");
const completed=source.slice(source.indexOf('for(const event of ["execution_success"'));
assert.ok(completed.includes("await persistPreview(job);"),
  "Execution completion must perform final upload");
console.log("TerryDirector live sampling preview steps, job isolation and one final disk write: PASS");
