// CPU-only orchestration tests; no ComfyUI queue or user results are touched.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const code=await readFile(new URL("../web/td_preview_task_manager.js",import.meta.url),"utf8");
const section=(start,end)=>code.slice(code.indexOf(start),code.indexOf(end,code.indexOf(start)));
const events=[];
const state={busy:false,jobs:new Map(),selected:new Set(),focused:null,taskDurationCache:new Map()};
const rows=[
  {id:"two",kind:"draft",status:"low_complete",checkpoint_id:"b".repeat(32),name:"批次02"},
  {id:"one",kind:"draft",status:"high_complete",checkpoint_id:"a".repeat(32),name:"批次01"},
];
const snapshots=new Map(rows.map(row=>[row.id,{seed:"5",seed_min:0,seed_max:9,duration_seconds:14}]));
let compileError=false,submitError=false;
const request=async(path,options)=>{
  if(path.startsWith("/drafts/"))return {...snapshots.get(path.split("/")[2])};
  events.push(["reset",path,JSON.parse(options.body)]);
  return {id:path.split("/")[2]};
};
const esc=value=>String(value??"").replaceAll("<","&lt;");
const functions=new Function("state","request","randomPreviewSeed","validatePreviewSeed",
  "buildPreviewJob","draftOverrides","normalizeTaskPreviewOptions","refresh","runDraft",
  "selectedTaskRows","render","toast","esc",
  section("function canRerunLow(","function batchActionInfo(")+
  section("function freshLowRerunSeed(","async function batchSelected(")+
  "return {canRerunLow,freshLowRerunSeed,openLowRerun,executeLowRerun,confirmLowRerun,batchRerunLow,lowRerunMarkup};"
)(state,request,()=>"5",(value,draft)=>{
  if(!/^\d+$/.test(String(value))||Number(value)>draft.seed_max)throw Error("invalid seed");
  return Number(value);
},()=>{events.push(["compile"]);if(compileError)throw Error("broken workflow");},
  ()=>[],value=>value,async()=>events.push(["refresh"]),async id=>{
    events.push(["queue",id]);if(submitError)throw Error("queue unavailable");
  },()=>[rows[1],rows[0]],()=>{},(...args)=>events.push(["toast",...args]),esc);

assert.equal(functions.canRerunLow(rows[0]),true);
assert.equal(functions.canRerunLow({...rows[0],queued_stage:"high"}),false);
assert.equal(functions.canRerunLow({...rows[0],status:"low_running"}),false);
assert.equal(functions.canRerunLow({...rows[0],checkpoint_id:null}),false);
assert.equal(functions.freshLowRerunSeed(snapshots.get("one")),"6");
assert.equal(functions.freshLowRerunSeed({seed:"5",seed_min:2,seed_max:5}),"2");

await functions.openLowRerun(rows[0]);
assert.equal(state.rerunning.seed,"6");
assert.equal(events.length,0,"opening the modal must neither reset nor queue");
const markup=functions.lowRerunMarkup();
assert.match(markup,/inputmode="numeric"/);
assert.match(markup,/data-action="rerun-random-seed"/);
assert.match(markup,/role="dialog"/);
state.rerunning.seed="invalid";
await functions.confirmLowRerun();
assert.match(state.rerunning.error,/invalid seed/);
assert.equal(events.length,0);
assert.equal(state.busy,false);

compileError=true;
await functions.confirmLowRerun(); // seed is still invalid; reset must stay untouched.
state.rerunning.seed="7";
await functions.confirmLowRerun();
assert.match(state.rerunning.error,/broken workflow/);
assert.equal(events.some(event=>event[0]==="reset"),false);
compileError=false;events.length=0;
state.jobs.set("old-job",{draftId:"two",checkpointId:rows[0].checkpoint_id});
state.jobs.set("other-job",{draftId:"unrelated"});
state.selected.add("two");state.focused="two";
await functions.confirmLowRerun();
assert.deepEqual(events.map(event=>event[0]),["compile","reset","refresh","queue"]);
assert.equal(events[1][2].seed,"7");
assert.equal(state.rerunning,null);
assert.equal(state.jobs.has("old-job"),false);
assert.equal(state.jobs.has("other-job"),true);
assert.equal(state.busy,false);

events.length=0;
await functions.batchRerunLow();
assert.deepEqual(events.filter(event=>event[0]==="queue").map(event=>event[1]),["one","two"]);
assert.deepEqual(events.filter(event=>event[0]==="reset").map(event=>event[2].seed),["6","6"]);
assert.equal(state.rerunning,null,"batch rerun must not open a seed dialog");

events.length=0;submitError=true;
await functions.batchRerunLow();
assert.equal(events.filter(event=>event[0]==="queue").length,2,"a failed submission must not stop later batches");
assert.match(events.at(-1)[1],/失败 2 个/);
assert.equal(state.busy,false);
assert.ok(code.indexOf('data-action="rerun"')<code.indexOf('data-action="highres"'));
assert.match(code,/tdm-detail-heading[\s\S]*?justify-content:space-between/);
console.log("Preview low-res rerun: seed modal, preflight, cleanup, batch order and failures PASS");
