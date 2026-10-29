// Run: node tests/test_preview_task_create_flow.mjs
// Contract: Creating a task persists it and never calls the ComfyUI queue.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const script=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const strip=script.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"");
assert.doesNotThrow(()=>new Function(strip));
const fragment=(from,to)=>{
 const i=script.indexOf(from),j=script.indexOf(to,i);
 assert.ok(i>=0 && j>i,from);
 return script.slice(i,j);
};
const create=fragment("function draftSnapshot(draft) {","async function loadSavedWorkflow(");
const calls=[];
const state={
 editDraftId:null,creating:true,assetPicker:null,focused:null,
 createDraft:{
   name:"Episode01",prompt:"Original shot",seed:"12",seed_min:0,seed_max:100,
   workflow_name:"Main",workflow:{nodes:[]},
   api_prompt:{"13":{class_type:"TerryDirectorSelfLiftPauseResume",inputs:{}}},
   prompt_binding:{node_id:63,widget_name:"prompt"},
   seed_binding:{node_id:77,widget_name:"seed"},
   assets:[],previewType:"sampling",pause_node_id:13,preview_node_id:5,
   pause_target:"13",highres_target:"22",decoded_target:null,
 },
};
const compiler=new Function("state","request","refresh","toast","validatePreviewSeed",
  "structuredClone",create+";return {submitCreate};");
const {submitCreate}=compiler(state,async (path,options)=>{
 calls.push({path,method:options?.method,body:JSON.parse(options?.body||"{}")});
 return {id:"draft_"+ "a".repeat(32),status:"low_pending"};
},async()=>calls.push({refresh:true}),()=>{},v=>Number(v),structuredClone);
await submitCreate();
assert.equal(calls[0].path,"/drafts");
assert.equal(calls[0].method,"POST");
assert.equal(calls[0].body.prompt,"Original shot");
assert.equal(calls[0].body.seed,"12");
assert.equal(state.focused,"draft_"+ "a".repeat(32));
assert.equal(state.creating,false);
assert.ok(!create.slice(0,create.indexOf("async function runDraft(")).includes("submitPreviewJob("));
for(const [machine,human] of [
 ["low_pending","低清待生成"],["low_running","低清生成中"],
 ["low_complete","低清完成"],["high_pending","高清待生成"],
 ["high_running","高清生成中"],["high_complete","高清完成"],
])assert.ok(script.includes(machine+':"'+human+'"'));
assert.ok(script.includes('task.low_started_at'));
assert.ok(script.includes('task.low_finished_at'));
assert.ok(script.includes('task.high_started_at'));
assert.ok(script.includes('task.high_finished_at'));
assert.ok(script.includes('data-action="run-draft"'));
assert.ok(script.includes('data-action="edit-draft"'));
assert.ok(script.includes("task.kind===\"draft\""));
console.log("Preview Stage: create-only, manual execution, six statuses and times PASS");
