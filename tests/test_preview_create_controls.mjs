// Run: node tests/test_preview_create_controls.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const parameters=await readFile(new URL("../web/td_preview_task_parameters.js",import.meta.url),"utf8");
const mod=await import("data:text/javascript;base64,"+Buffer.from(parameters).toString("base64"));
assert.doesNotThrow(()=>new Function(source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const begin=source.indexOf("function createMarkup() {"),end=source.indexOf("function installCreatePromptEditor()",begin);
assert.ok(begin>=0 && end>begin);
const create=new Function("state","esc","assetCard","PREVIEW_RESOLUTION_OPTIONS",
  "taskAspectRatio","taskResolutionInfo",source.slice(begin,end)+";return createMarkup;");
const state={template:{workflow_name:"预演工作流"},tasks:[],
 createDraft:{source:"template",name:"S1_E1",seed:"42",prompt:"",previewType:"sampling",
 duration_seconds:15,highres_megapixels:0.8,assets:[],api_prompt:{}}};
const html=()=>create(state,x=>String(x),()=>"<asset/>",mod.PREVIEW_RESOLUTION_OPTIONS,
 mod.taskAspectRatio,mod.taskResolutionInfo)();
let rendered=html();
assert.ok(rendered.indexOf("新建任务名称")<rendered.indexOf("基于"));
assert.ok(rendered.includes('id="tdm-new-task-name"'));
assert.equal((rendered.match(/tdm-inline-field/g)||[]).length,6);
assert.equal((rendered.match(/type="radio"/g)||[]).length,2);
assert.match(rendered,/value="sampling" checked/);
assert.ok(!rendered.includes('value="decoded" checked'));
assert.ok(rendered.includes('id="tdm-new-task-duration"') || rendered.includes('id="tdm-task-duration"'));
assert.ok(rendered.includes('min="4" max="20" step="1"'));
assert.ok(rendered.includes('value="15"'));
assert.ok(rendered.includes('data-action="task-resolution"'));
assert.ok(rendered.includes("0.20 MP 低清"));
assert.ok(rendered.indexOf("预览视频")>rendered.indexOf("高清分辨率"));
state.createDraft.previewType="decoded";
rendered=html();
assert.match(rendered,/value="decoded" checked/);
assert.ok(!rendered.includes('value="sampling" checked'));
assert.ok(rendered.includes('data-action="random-seed"'));
assert.ok(source.includes('data-action="batch-create"'));
assert.ok(source.includes('data-action="batch-submit"'));
assert.ok(source.includes("function batchImportMarkup()"));
assert.ok(source.includes("matchingAssets(state.template.workflow)"));
const matcherStart=source.indexOf("function matchingAssets(workflow) {");
const matcherEnd=source.indexOf("const bindingKey",matcherStart);
assert.ok(matcherStart>=0&&matcherEnd>matcherStart);
const matchingAssets=new Function("nodeValue",source.slice(matcherStart,matcherEnd)+";return matchingAssets;")(
  (node,name)=>node.widgets_values_named?.[name]??node.widgets_values?.[0]);
const mediaSlots=matchingAssets({nodes:[
  {id:1,type:"LoadImage",widgets_values_named:{image:"person.png"}},
  {id:2,type:"LoadAudio",widgets_values_named:{audio:"dialogue.wav"}},
  {id:3,type:"VHS_LoadVideoPath",widgets_values_named:{video:"motion.mp4"}},
  {id:4,type:"SaveVideo",widgets_values_named:{filename_prefix:"out"}},
]});
assert.deepEqual(mediaSlots.map(x=>x.kind),["image","audio","video"]);
assert.deepEqual(mediaSlots.map(x=>x.value),["person.png","dialogue.wav","motion.mp4"]);
const batchStart=source.indexOf("function findBatchPoolAsset(");
const batchEnd=source.indexOf("function installCreatePromptEditor()",batchStart);
assert.ok(batchStart>=0 && batchEnd>batchStart);
const kindLabel=kind=>kind==="video"?"视频":kind==="audio"?"音频":"图片";
const preview=(file,options={})=>'<media-preview data-kind="'+(file?.kind||options.kind||"image")+'"/>';
const renderBatch=new Function("state","esc","assetCard","mediaKindLabel","mediaPreviewMarkup",
  source.slice(batchStart,batchEnd)+";return batchImportMarkup;");
const batchMarkup=renderBatch({
    batchImport:{
      text:"# 批量提示词",preamble:"全局风格规则",includePreamble:true,
      batches:[{name:"批次01｜场景一",body:"导演说明\n分镜",duration_seconds:15,
        references:[{name:"特瑞.jpg",kind:"image",path:"特瑞.jpg"}],generatedAssets:[]}],
      assetSlots:[{kind:"image"}],activeIndex:0,selectedRefIndex:0,search:"",saving:false,uploading:false,
    },
    inputFiles:[{kind:"image",name:"特瑞.jpg",path:"特瑞.jpg"}],
  },value=>String(value),()=>"<asset/>",kindLabel,preview)();
assert.ok(batchMarkup.includes("批量添加任务"));
assert.ok(batchMarkup.includes("批次01｜场景一"));
assert.ok(batchMarkup.includes('data-action="batch-upload-assets"'));
assert.ok(batchMarkup.includes('data-action="batch-submit"'));
assert.ok(batchMarkup.includes("将批次标题之前的说明附加到每个任务"));
assert.ok(batchMarkup.includes('class="tdm-batch-ref-card active"'));
assert.ok(batchMarkup.includes('data-kind="image"'));
const typedBatchMarkup=renderBatch({
  batchImport:{
    text:"多媒体",preamble:"",includePreamble:false,
    batches:[{name:"批次02",body:"多媒体正文",duration_seconds:15,references:[
      {name:"角色.jpg",kind:"image",path:"角色.jpg"},
      {name:"对白.wav",kind:"audio",path:"对白.wav"},
      {name:"动作.mp4",kind:"video",path:"动作.mp4"},
    ],generatedAssets:[]}],
    assetSlots:[{kind:"image"},{kind:"audio"},{kind:"video"}],
    activeIndex:0,selectedRefIndex:0,search:"",saving:false,uploading:false,
  },
  inputFiles:[
    {kind:"image",name:"角色.jpg",path:"角色.jpg"},
    {kind:"audio",name:"对白.wav",path:"对白.wav"},
    {kind:"video",name:"动作.mp4",path:"动作.mp4"},
  ],
},value=>String(value),()=>" <asset/>",kindLabel,preview)();
assert.ok(typedBatchMarkup.includes('data-kind="image"'));
assert.ok(typedBatchMarkup.includes('data-kind="audio"'));
assert.ok(typedBatchMarkup.includes('data-kind="video"'));
assert.ok(typedBatchMarkup.includes("工作流媒体槽位：图片 1 / 音频 1 / 视频 1"));
assert.ok(typedBatchMarkup.includes("当前批次引用资产"));
assert.ok(rendered.includes('aria-label="生成随机种子"'));
assert.ok(source.includes('state.createDraft.duration_seconds=seconds;'));
assert.ok(source.includes('state.createDraft.highres_megapixels=Number(control.value);'));
console.log("Preview Stage inline create controls, duration/resolution and preview selection: PASS");
