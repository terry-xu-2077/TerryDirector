// Run: node tests/test_preview_filter_batch_random.mjs
// Preview Stage: seed on new/duplicate only; filter-scoped selection and
// stage-aware explicit bulk queueing. No ComfyUI installation required.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const code=await readFile(new URL("../web/td_preview_task_manager.js",import.meta.url),"utf8");
const compiler=await readFile(new URL("../web/td_preview_job_compiler.js",import.meta.url),"utf8");
const section=(from,to)=>{
  const i=code.indexOf(from),j=code.indexOf(to,i);
  assert.ok(i>=0 && j>i, "Missing "+from);
  return code.slice(i,j);
};
assert.doesNotThrow(()=>new Function(
  code.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const {randomPreviewSeed,validatePreviewSeed}=await import("../web/td_preview_job_compiler.js");

const state={tasks:[],statusFilter:"all",selected:new Set(),busy:false,focused:null};
const fns=new Function("state","randomPreviewSeed",
  section("const STATUS_NAMES=","const formatTime=")+
  ";return {STATUS_NAMES,STATUS_ICONS,STATUS_FILTER_OPTIONS,visibleTasks,groupedTasks,selectedTaskRows,batchActionInfo,randomizeNewTaskSeed};")
 (state,randomPreviewSeed);

const rows=[
 {id:"a",kind:"draft",status:"low_pending"},
 {id:"b",kind:"draft",status:"low_pending"},
 {id:"c",kind:"draft",status:"low_complete",checkpoint_id:"c".repeat(32)},
 {id:"d",kind:"checkpoint",status:"low_complete"},
 {id:"e",kind:"draft",status:"high_pending",queued_stage:"high"},
 {id:"f",kind:"draft",status:"low_running"},
 {id:"g",kind:"draft",status:"high_running"},
 {id:"h",kind:"draft",status:"high_complete"},
];
state.tasks=rows;
assert.equal(fns.visibleTasks().length,8);
for(const [machine,label] of Object.entries({
 low_pending:"低清待生成",low_running:"低清生成中",
 low_complete:"低清完成",high_pending:"高清待生成",
 high_running:"高清生成中",high_complete:"高清完成",
})){
 assert.equal(fns.STATUS_NAMES[machine],label);
 assert.ok(fns.STATUS_ICONS[machine],machine+" should have an icon");

}
assert.deepEqual(fns.STATUS_FILTER_OPTIONS.map(x=>x.value),["all","low","high"]);
state.statusFilter="low";
assert.deepEqual(fns.visibleTasks().map(x=>x.id),["a","b","c","d","f"]);
state.statusFilter="high";
assert.deepEqual(fns.visibleTasks().map(x=>x.id),["e","g","h"]);
state.statusFilter="all";
const grouped=fns.groupedTasks([
 {id:"10",name:"批次10",batch_group_id:"episode",batch_group_name:"第一集",batch_index:10},
 {id:"2",name:"批次2",batch_group_id:"episode",batch_group_name:"第一集",batch_index:2},
 {id:"1",name:"批次01",batch_group_id:"episode",batch_group_name:"第一集",batch_index:1},
 {id:"normal",name:"独立镜头"},
]);
const episode=grouped.find(row=>row.id==="episode");
assert.equal(episode.id,"episode");
assert.equal(episode.name,"第一集");
assert.deepEqual(episode.tasks.map(t=>t.id),["1","2","10"]);
assert.equal(grouped.find(row=>row.task)?.task.id,"normal");
state.selected=new Set(["a","b"]);
let info=fns.batchActionInfo();
assert.deepEqual([info.label,info.disabled,info.action],["批量开始预演 · 2",false,"low"]);
state.selected=new Set(["c","d"]);
info=fns.batchActionInfo();
assert.deepEqual([info.label,info.disabled,info.action],["批量高清续采 · 2",false,"high"]);
state.selected=new Set(["a","c"]);
info=fns.batchActionInfo();
assert.equal(info.label,"状态不一致 · 2");
assert.equal(info.disabled,true);
state.selected=new Set(["e"]);
assert.equal(fns.batchActionInfo().disabled,true);
state.selected=new Set(["f"]);
assert.match(fns.batchActionInfo().label,/低清生成中/);
state.selected=new Set(["g"]);
assert.match(fns.batchActionInfo().label,/高清生成中/);
state.selected=new Set(["h"]);
assert.match(fns.batchActionInfo().label,/高清已完成/);
state.selected=new Set(["a"]);rows[0].queued_stage="low";
assert.equal(fns.batchActionInfo().disabled,true);
rows[0].queued_stage=null;
state.busy=true;
assert.equal(fns.batchActionInfo().disabled,true);
state.busy=false;

const first={seed:"12345",seed_min:100,seed_max:1000};
const next=fns.randomizeNewTaskSeed(first);
assert.equal(next,first);
assert.ok(Number(first.seed)>=100 && Number(first.seed)<=1000);
assert.equal(validatePreviewSeed(first.seed,first),Number(first.seed));
assert.ok(code.includes("randomizeNewTaskSeed(buildDraft(state.template))"));
assert.ok(code.includes("randomizeNewTaskSeed(state.createDraft);"));
const edit=section("async function editDraft(id) {","async function draftTransition(");
assert.ok(edit.includes("state.createDraft.seed=row.seed;"));
assert.ok(!edit.includes("randomizeNewTaskSeed("));
assert.ok(code.includes('new Set(visibleTasks().map(t => t.id))'));
assert.ok(code.includes('data-action="status-filter"'));
assert.ok(code.includes('esc(option.icon+\'  \'+option.label)'));
assert.ok(code.includes('class="tdm-status-icon"'));
assert.equal(new Set(Object.values(fns.STATUS_ICONS)).size,6);

const jobs=[];
let refreshes=0;
const output=[];
const batchCode=section("async function batchSelected() {","async function persistJob(job) {");
const batchSelected=new Function(
 "state","batchActionInfo","selectedTaskRows","runDraft","queueFromCheckpoint",
 "refresh","render","toast", batchCode+"return batchSelected;"
)(state,fns.batchActionInfo,fns.selectedTaskRows,
 async (id,mode)=>{jobs.push([id,mode]);},
 async (id,mode)=>{jobs.push([id,mode]);},
 async()=>{refreshes++;},()=>{},x=>output.push(x));

rows[0].name="批次10";rows[1].name="批次02";
state.selected=new Set(["a","b"]);
await batchSelected();
assert.deepEqual(jobs,[["b","pause"],["a","pause"]]);
assert.equal(state.busy,false);
jobs.length=0;
state.selected=new Set(["c","d"]);
await batchSelected();
assert.deepEqual(jobs,[["c","continue"],["d","continue"]]);
jobs.length=0;
state.selected=new Set(["a","c"]);
await batchSelected();
assert.deepEqual(jobs,[]);
assert.equal(refreshes,2);
console.log("Preview Stage random seeds, resolution type filters, scoped selection and dynamic batch: PASS");
