// Run: node tests/test_preview_highres_ui.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const script=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
assert.doesNotThrow(()=>new Function(
  script.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const begin=script.indexOf("function details(task) {");
const end=script.indexOf("function bindPreviewPlaybackErrors()",begin);
assert.ok(begin>=0&&end>begin);
const state={preview:"auto",mediaRevisions:new Map()};
const esc=x=>String(x??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
const helperStart=script.indexOf("function stageElapsed(task,stage) {");
const helperEnd=script.indexOf("function statusMarkup(task) {",helperStart);
const kindStart=script.indexOf("function availablePreviewKinds(task) {");
const kindEnd=script.indexOf("function previewJobMatchesTask(job,task) {",kindStart);
const make=new Function("state","esc","statusMarkup","livePreviewJobForTask",
  "livePreviewMarkup","mediaUrl","formatTime","duration",
  script.slice(helperStart,helperEnd)+script.slice(kindStart,kindEnd)+
  script.slice(begin,end)+"return {details,stageElapsed,availablePreviewKinds};");
const {details,stageElapsed,availablePreviewKinds}=make(
 state,esc,task=>'<b>'+task.status+'</b>',()=>null,()=>"",
 (id,kind)=>"/terrydirector/api/selflift/tasks/"+id+"/media/"+kind,
 x=>x||"—",()=> "0秒");
const task={id:"draft_a",checkpoint_id:"b".repeat(32),kind:"draft",name:"Scene A",
 status:"high_complete",media:{highres:"high_0001.mp4",sampling:"sampling_preview.mp4",decoded:"review.mp4"},
 seed:"1234",metadata:{workflow_name:"Test"}};
let html=details(task);
assert.match(html,/<button data-action="preview" data-kind="highres" class="on">高清视频<\/button>/);
assert.ok(html.indexOf("采样预览")<html.indexOf("低清视频"));
assert.ok(html.indexOf("低清视频")<html.indexOf("高清视频"));
assert.ok(!html.includes("播放 / 暂停"),"Native browser controls replace duplicate top playback button");
assert.ok(!html.includes("可在 ComfyUI 队列查看进度"));
assert.ok(html.includes("低清开始：") && html.includes("高清开始："));
assert.ok(!html.includes("低清生成：") && !html.includes("高清生成："));
assert.ok(html.includes('data-elapsed-stage="high"'));
assert.equal(stageElapsed({...task,low_started_at:"2026-10-30T02:00:00Z",
  low_finished_at:"2026-10-30T02:05:00Z"},"low"),"0秒");
assert.match(html,/<video class="tdm-player" data-saved-video/);
assert.ok(html.includes("/media/highres"));
assert.ok(!html.includes("暂无TAEH3预览"));
state.preview="sampling";
html=details(task);
assert.match(html,/data-kind="sampling" class="on"/);
assert.ok(html.includes("/media/sampling"));
state.preview="decoded";
html=details(task);
assert.match(html,/data-kind="decoded" class="on"/);
assert.ok(html.includes("/media/decoded"));
state.preview="auto";
const noFile={...task,media:{sampling:"sampling_preview.mp4"}};
html=details(noFile);
assert.ok(html.includes("采样预览"));
assert.ok(!html.includes("高清视频"));
assert.ok(!html.includes("低清视频"));
assert.ok(!html.includes("/media/highres"));
assert.deepEqual(availablePreviewKinds({...task,media:{}}),[]);
assert.ok(!details({...task,media:{}}).includes('data-action="preview"'));
const onlyLow=details({...task,status:"high_running",media:{decoded:"review.mp4"}});
assert.ok(onlyLow.includes("低清视频"));
assert.ok(!onlyLow.includes("高清视频"));

// Exactly one output node's SaveVideo result is attached to this prompt.
const handler=script.slice(script.indexOf('  api.addEventListener("executed"'),
 script.indexOf('  for(const event of ["execution_success"'));
assert.ok(handler.includes('String(p.node)===String(job.highres_target)'));
assert.ok(handler.includes('["images","gifs","videos"].flatMap'));
assert.ok(handler.includes("job.highresPersistPromise=request("));
assert.ok(script.includes("job.highresPersistPromise,"));
assert.ok(script.includes("state.preview=\"auto\""));
console.log("Preview Stage highres default player, tabs, and exact SaveVideo capture: PASS");
