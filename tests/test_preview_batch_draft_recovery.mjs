// Run: node tests/test_preview_batch_draft_recovery.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
assert.doesNotThrow(()=>new Function(source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));

const helperStart=source.indexOf("const BATCH_IMPORT_DRAFT_KEY =");
const helperEnd=source.indexOf("function defaultPreviewOptions(",helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart);
const values=new Map();
const localStorage={
  getItem:key=>values.has(key)?values.get(key):null,
  setItem:(key,value)=>values.set(key,String(value)),
  removeItem:key=>values.delete(key),
};
const helpers=new Function("localStorage","console","Date",
  source.slice(helperStart,helperEnd)+
  ";return {BATCH_IMPORT_DRAFT_KEY,readBatchImportDraft,clearBatchImportDraft,saveBatchImportDraft,batchDraftDateLabel};")(
    localStorage,{warn(){}},Date);

const batch={
  promptImportOpen:false,text:"# 本次批量任务",importText:"# 本次批量任务",
  importFileName:"第一集.md",preamble:"全局规则",error:"",
  batches:[{
    name:"批次01｜菌伞峡道",body:"镜头正文",sourceBody:"原始镜头正文",
    duration_seconds:15,references:[
      {name:"特瑞",kind:"image",path:"/input/terry.jpg",description:"人物外观"},
      {name:"环境声",kind:"audio",path:"/input/missing.wav",description:"声音参考"},
    ],generatedAssets:[{type:"image",name:"峡道母图",prompt:"生成峡道母图"}],
  }],
  activeIndex:0,selectedRefIndex:1,highres_megapixels:2.0,
  sampling_preview_enabled:true,vae_decode_enabled:false,
};
assert.equal(helpers.saveBatchImportDraft(batch),true);
const saved=helpers.readBatchImportDraft();
assert.equal(saved.version,1);
assert.equal(saved.phase,"config");
assert.equal(saved.importFileName,"第一集.md");
assert.equal(saved.preamble,"全局规则");
assert.equal(saved.batches[0].references[0].path,"/input/terry.jpg");
assert.equal(saved.batches[0].generatedAssets[0].name,"峡道母图");
assert.equal(saved.selectedRefIndex,1);
assert.equal(saved.highres_megapixels,2.0);
assert.equal(saved.sampling_preview_enabled,true);
assert.equal(saved.vae_decode_enabled,false);
assert.ok(helpers.batchDraftDateLabel(saved.savedAt));
assert.equal(helpers.saveBatchImportDraft({...batch,saving:true}),false);
assert.equal(helpers.saveBatchImportDraft({text:"",importText:"",batches:[]}),false);
assert.equal(helpers.readBatchImportDraft().text,"# 本次批量任务",
  "an empty new import must not erase an existing recovery draft");

const restoreStart=source.indexOf("function restoreBatchImportDraft(draft) {");
const restoreEnd=source.indexOf("function wireMediaFallback(holder)",restoreStart);
assert.ok(restoreStart>=0&&restoreEnd>restoreStart);
const restoreState={
  template:{workflow:{id:7},h3_node_id:12,decoded_target:"video"},
  inputFiles:[{kind:"image",path:"/input/terry.jpg"}],
  previewSettings:{highres_megapixels:1.5},
};
const restore=new Function("state","structuredClone","matchingAssets","PREVIEW_RESOLUTION_OPTIONS",
  "defaultPreviewOptions","normalizeTaskPreviewOptions",
  source.slice(restoreStart,restoreEnd)+";return restoreBatchImportDraft;")(
    restoreState,structuredClone,()=>[{kind:"image",slot:1}],[1.0,2.0],
    ()=>({sampling_preview_enabled:false,vae_decode_enabled:true}),
    (value,fallback)=>({
      sampling_preview_enabled:typeof value?.sampling_preview_enabled==="boolean"?
        value.sampling_preview_enabled:fallback.sampling_preview_enabled,
      vae_decode_enabled:typeof value?.vae_decode_enabled==="boolean"?
        value.vae_decode_enabled:fallback.vae_decode_enabled,
    }));
assert.equal(restore(saved),true);
assert.equal(restoreState.batchImport.promptImportOpen,false);
assert.equal(restoreState.batchImport.template.workflow.id,7);
assert.deepEqual(restoreState.batchImport.assetSlots,[{kind:"image",slot:1}]);
assert.equal(restoreState.batchImport.batches[0].references[0].path,"/input/terry.jpg");
assert.equal(restoreState.batchImport.batches[0].references[1].path,"",
  "missing media files must be unbound instead of becoming invalid live paths");
assert.equal(restoreState.batchImport.selectedRefIndex,1);
assert.equal(restoreState.batchImport.highres_megapixels,2.0);
assert.equal(restoreState.batchImport.sampling_preview_enabled,true);
assert.equal(restoreState.batchImport.vae_decode_enabled,false);

assert.equal(helpers.saveBatchImportDraft({
  promptImportOpen:true,importText:"# 尚未解析的提示词",text:"",batches:[],
  highres_megapixels:2.0,sampling_preview_enabled:false,vae_decode_enabled:true,
}),true);
const importDraft=helpers.readBatchImportDraft();
assert.equal(importDraft.phase,"import");
assert.equal(restore(importDraft),true);
assert.equal(restoreState.batchImport.promptImportOpen,true);
assert.equal(restoreState.batchImport.importText,"# 尚未解析的提示词");

const markupStart=source.indexOf("function batchPromptImportMarkup() {");
const markupEnd=source.indexOf("function bindBatchDynamicActions(holder)",markupStart);
assert.ok(markupStart>=0&&markupEnd>markupStart);
const markup=new Function("state","esc","readBatchImportDraft","batchDraftDateLabel",
  source.slice(markupStart,markupEnd)+";return batchPromptImportMarkup;")(
    {batchImport:{promptImportOpen:true,importText:""}},String,
    ()=>({savedAt:"2026-10-30T23:41:00+08:00"}),()=>"2026/10/30 23:41")();
assert.ok(markup.includes('data-action="batch-import-recover"'));
assert.ok(markup.includes("继续编辑上次的批量任务（2026/10/30 23:41）"));
const footerStart=markup.indexOf("<footer");
assert.ok(markup.indexOf('data-action="batch-import-recover"',footerStart)<
  markup.indexOf('data-action="batch-import-cancel"',footerStart));
const noDraftMarkup=new Function("state","esc","readBatchImportDraft","batchDraftDateLabel",
  source.slice(markupStart,markupEnd)+";return batchPromptImportMarkup;")(
    {batchImport:{promptImportOpen:true,importText:""}},String,()=>null,()=>"")();
assert.ok(!noDraftMarkup.includes('data-action="batch-import-recover"'));

const closeStart=source.indexOf("function close() {");
const closeEnd=source.indexOf("async function refresh()",closeStart);
assert.ok(source.slice(closeStart,closeEnd).includes("saveBatchImportDraft(state.batchImport)"));
assert.ok(source.includes('action === "batch-import-recover"'));
assert.ok(source.includes('action === "batch-import-cancel"'));
assert.ok(source.includes('action === "batch-cancel"'));
assert.ok(source.includes("请点击对应资产预览区域完成绑定"));
assert.ok(source.includes("saveBatchImportDraft(batch)"));
assert.ok(source.includes("clearBatchImportDraft()"));
const closeStartRecovery=source.indexOf("function close() {");
const closeEndRecovery=source.indexOf("async function refresh()",closeStartRecovery);
const closingBatch={text:"# 暂存",batches:[],saving:false};
const closeStateRecovery={batchImport:closingBatch,elapsedTimer:null,root:null};
let stashedBatchRecovery=null;
const closePanelRecovery=new Function("state","saveBatchImportDraft","stopPreviewPlayback",
  "closePreviewRichEditor","toast","clearInterval",
  source.slice(closeStartRecovery,closeEndRecovery)+";return close;")(
    closeStateRecovery,batch=>{stashedBatchRecovery=batch;},()=>{},()=>{},()=>{},()=>{});
closePanelRecovery();
assert.equal(stashedBatchRecovery,closingBatch);
assert.equal(closeStateRecovery.batchImport,null);
const savingStateRecovery={batchImport:{saving:true},root:{style:{display:"flex"}},elapsedTimer:null};
let blockedCloseNoticeRecovery="";
const blockedCloseRecovery=new Function("state","saveBatchImportDraft","stopPreviewPlayback",
  "closePreviewRichEditor","toast","clearInterval",
  source.slice(closeStartRecovery,closeEndRecovery)+";return close;")(
    savingStateRecovery,()=>{throw new Error("must not stash while creating");},()=>{},()=>{},
    message=>{blockedCloseNoticeRecovery=message;},()=>{});
blockedCloseRecovery();
assert.equal(savingStateRecovery.root.style.display,"flex");
assert.match(blockedCloseNoticeRecovery,/正在创建/);

const createStartRecovery=source.indexOf("async function createBatchTasks() {");
const createEndRecovery=source.indexOf("function installCreatePromptEditor()",createStartRecovery);
async function runCreateRecovery(items) {
  const state={batchImport:{
    saving:false,preamble:"",template:{},highres_megapixels:2,
    sampling_preview_enabled:false,vae_decode_enabled:true,
    activeIndex:0,selectedRefIndex:0,batches:items,
  },statusFilter:"all",focused:null};
  let savedDraft=null,cleared=0,created=0;
  const create=new Function("state","batchTaskStatus","randomizeNewTaskSeed","buildDraft",
    "PREVIEW_DURATION_DEFAULT","draftSnapshot","request","refresh","toast","render","window",
    "batchPromptWithMediaTokens","legacyPreviewType","saveBatchImportDraft","clearBatchImportDraft",
    source.slice(createStartRecovery,createEndRecovery)+";return createBatchTasks;")(
      state,item=>({valid:!!item.valid}),draft=>draft,()=>({assets:[]}),15,draft=>draft,
      async()=>({id:"created-"+(++created)}),async()=>{},()=>{},()=>{},
      {confirm:()=>true},body=>body,()=>"decoded",
      batch=>{savedDraft=JSON.parse(JSON.stringify(batch));},()=>{cleared++;});
  await create();
  return {savedDraft,cleared,created};
}
const completeCreationRecovery=await runCreateRecovery([
  {name:"已创建批次",valid:true,body:"正文",references:[]},
]);
assert.equal(completeCreationRecovery.created,1);
assert.equal(completeCreationRecovery.cleared,1);
assert.equal(completeCreationRecovery.savedDraft,null);
const partialCreationRecovery=await runCreateRecovery([
  {name:"已创建批次",valid:true,body:"正文",references:[]},
  {name:"剩余批次",valid:false,body:"",references:[]},
]);
assert.equal(partialCreationRecovery.created,1);
assert.equal(partialCreationRecovery.cleared,0);
assert.deepEqual(partialCreationRecovery.savedDraft.batches.map(item=>item.name),["剩余批次"]);

console.log("Preview Stage batch task draft save, restore, missing asset handling and recovery UI: PASS");
