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
const promptTokenStart=source.indexOf("function batchPromptWithMediaTokens(body,references) {");
const promptTokenEnd=source.indexOf("async function createBatchTasks()",promptTokenStart);
assert.ok(promptTokenStart>=0&&promptTokenEnd>promptTokenStart);
const promptWithTokens=new Function(source.slice(promptTokenStart,promptTokenEnd)+";return batchPromptWithMediaTokens;")();
const convertedPrompt=promptWithTokens([
  "[全局参考]",
  "- 00_特瑞_Terry.jpg：特瑞面容、沙棕旧披覆外层及深灰工装",
  "- 对白.wav：角色对白",
  "- 运镜参考.mp4：动作节奏",
  "[连续性状态]",
  "00_特瑞_Terry.jpg 在这里不应被替换",
].join("\n"),[
  {name:"00_特瑞_Terry.jpg",kind:"image"},
  {name:"对白.wav",kind:"audio"},
  {name:"运镜参考.mp4",kind:"video"},
]);
assert.equal(convertedPrompt,[
  "[全局参考]",
  "<Picture 1>：特瑞面容、沙棕旧披覆外层及深灰工装",
  "<Audio 1>：角色对白",
  "<Video 1>：动作节奏",
  "[连续性状态]",
  "00_特瑞_Terry.jpg 在这里不应被替换",
].join("\n"));
assert.equal(promptWithTokens("[全局参考]\n- A.jpg：A\n- B.jpg：B",[
  {name:"A.jpg",kind:"image"},{name:"B.jpg",kind:"image"},
]),"[全局参考]\n<Picture 1>：A\n<Picture 2>：B");

const typedConverted = promptWithTokens([
  "[全局参考]",
  "<Picture 特瑞>：特瑞面容与服装",
  "<Audio 特瑞音色>：成年男性、轻沙哑",
  "<Video 穿越机参考>：赛车式飞行",
  "<Picture 菌伞峡道>：正常图片描述",
  "<Prompt 菌伞峡道>：请生成菌伞峡道母图。",
  "这里是多行生图提示词的续行。",
  "road.jpg：这是提示词里的文件名描述，不能被当成媒体引用。",
  "[连续性状态]",
  "特瑞继续驾驶。",
].join("\n"),[
  {name:"特瑞",kind:"image"},
  {name:"特瑞音色",kind:"audio"},
  {name:"穿越机参考",kind:"video"},
  {name:"菌伞峡道",kind:"image"},
]);
assert.equal(typedConverted,[
  "[全局参考]",
  "<Picture 1>：特瑞面容与服装",
  "<Audio 1>：成年男性、轻沙哑",
  "<Video 1>：赛车式飞行",
  "<Picture 2>：正常图片描述",
  "[连续性状态]",
  "特瑞继续驾驶。",
].join("\n"));
assert.ok(!typedConverted.includes("road.jpg"));


const namedRefLabelStart=source.indexOf("function batchReferenceLabel(item,index) {");
const namedRefLabelEnd=source.indexOf("function batchReferencesMarkup()",namedRefLabelStart);
const namedRefLabel=new Function("mediaKindLabel",namedRefLabelStart>=0&&namedRefLabelEnd>namedRefLabelStart?
  source.slice(namedRefLabelStart,namedRefLabelEnd)+";return batchReferenceLabel;":"")(
  kind=>kind==="audio"?"音频":kind==="video"?"视频":"图片");
assert.equal(namedRefLabel({references:[{name:"特瑞",displayName:"特瑞",kind:"image"}]},0),"图片 1 · 特瑞");

// Logical media labels can resolve to a uniquely matching filename in the shared asset pool.
const poolStart=source.indexOf("function findBatchPoolAsset(");
const poolEnd=source.indexOf("function parseBatchImportText()",poolStart);
assert.ok(poolStart>=0&&poolEnd>poolStart);
const findPoolAsset=new Function("state",source.slice(poolStart,poolEnd)+";return findBatchPoolAsset;")({
  inputFiles:[
    {kind:"image",name:"00_特瑞_Terry.jpg",path:"input/00_特瑞_Terry.jpg"},
    {kind:"audio",name:"特瑞音色.wav",path:"input/特瑞音色.wav"},
    {kind:"video",name:"穿越机参考.mp4",path:"input/穿越机参考.mp4"},
  ],
});
assert.equal(findPoolAsset("特瑞","image"),"input/00_特瑞_Terry.jpg");
assert.equal(findPoolAsset("特瑞音色","audio"),"input/特瑞音色.wav");
assert.equal(findPoolAsset("穿越机参考","video"),"input/穿越机参考.mp4");

assert.ok(source.includes("if(generated)generated.innerHTML=batchGeneratedMarkup();"));

const mediaStart=source.indexOf("function mediaKindLabel(kind) {");
const mediaEnd=source.indexOf("function assetCard(",mediaStart);
const mediaHelpers=new Function("state","esc","assetUrl",
  source.slice(mediaStart,mediaEnd)+";return {mediaKindLabel,mediaKindIcon,mediaPreviewMarkup};")(
  {},value=>String(value),path=>"/view?filename="+encodeURIComponent(path));
assert.match(mediaHelpers.mediaPreviewMarkup({kind:"image",path:"person.png"}),/<img/);
assert.match(mediaHelpers.mediaPreviewMarkup({kind:"video",path:"motion.mp4"},{controls:true}),/<video[^>]+controls/);
assert.match(mediaHelpers.mediaPreviewMarkup({kind:"audio",path:"dialogue.wav"},{controls:true}),/<audio[^>]+controls/);
assert.match(mediaHelpers.mediaPreviewMarkup({kind:"audio",path:""},{kind:"audio"}),/未绑定音频/);
const slotStart=source.indexOf("function batchSlotPreviewMarkup(ref) {");
const slotEnd=source.indexOf("function batchReferenceLabel(item,index)",slotStart);
assert.ok(slotStart>=0&&slotEnd>slotStart);
const renderSlot=new Function("state","mediaKindIcon","mediaPreviewMarkup","esc",
  source.slice(slotStart,slotEnd)+";return batchSlotPreviewMarkup;");
const slotState={inputFiles:[]};
const slotPreview=renderSlot(slotState,mediaHelpers.mediaKindIcon,mediaHelpers.mediaPreviewMarkup,
  value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])));
const unboundImage=slotPreview({kind:"image",name:"private-name.jpg",
  description:"特瑞面容、沙棕旧披覆外层及深灰工装"});
assert.ok(unboundImage.includes("特瑞面容、沙棕旧披覆外层及深灰工装"));
assert.ok(unboundImage.includes(mediaHelpers.mediaKindIcon("image")));
assert.ok(!unboundImage.includes("待绑定图片"));
assert.ok(!unboundImage.includes("从下方资产池选择或上传"));
assert.ok(!unboundImage.includes("private-name.jpg"));
const iconOnly=slotPreview({kind:"video",name:"motion.mp4",description:""});
assert.ok(iconOnly.includes(mediaHelpers.mediaKindIcon("video")));
assert.ok(!iconOnly.includes("<small"));
assert.ok(!iconOnly.includes("待绑定视频"));
const escapedDescription=slotPreview({kind:"audio",description:"对白 <环境声> & 旁白"});
assert.ok(escapedDescription.includes("对白 &lt;环境声&gt; &amp; 旁白"));
assert.ok(!escapedDescription.includes("对白 <环境声> & 旁白"));

const batchStart=source.indexOf("function findBatchPoolAsset(");
const batchEnd=source.indexOf("function installCreatePromptEditor()",batchStart);
assert.ok(batchStart>=0 && batchEnd>batchStart);
const kindLabel=kind=>kind==="video"?"视频":kind==="audio"?"音频":"图片";
const preview=(file,options={})=>'<media-preview data-kind="'+(file?.kind||options.kind||"image")+'"/>';
const assetCardStub=(path,title,attrs,selected,kind,incompatible)=>
  '<asset data-kind="'+kind+'" '+attrs+' data-incompatible="'+!!incompatible+'"/>';
const batchMarkupState={
  batchImport:{
    text:"# 批量提示词",importText:"",importFileName:"",importError:"",promptImportOpen:false,
    preamble:"全局风格规则",includePreamble:true,
    batches:[{name:"批次01｜场景一",body:"导演说明\n分镜",duration_seconds:15,
      references:[{name:"特瑞.jpg",kind:"image",path:"特瑞.jpg"}],generatedAssets:[]}],
    assetSlots:[{kind:"image"}],activeIndex:0,selectedRefIndex:0,search:"",saving:false,uploading:false,
  },
  inputFiles:[{kind:"image",name:"特瑞.jpg",path:"特瑞.jpg"}],
};
const batchRenderers=new Function("state","esc","assetCard","mediaKindLabel","mediaPreviewMarkup",
  source.slice(batchStart,batchEnd)+";return {batchImportMarkup,batchPromptImportMarkup};")(
    batchMarkupState,value=>String(value),assetCardStub,kindLabel,preview);
const batchMarkup=batchRenderers.batchImportMarkup();
assert.ok(batchMarkup.includes("批量添加任务"));
assert.ok(batchMarkup.includes("当前批次提示词原文"));
assert.ok(batchMarkup.includes("&lt;Picture 名字&gt;"));
assert.ok(batchMarkup.includes("&lt;Audio 名字&gt;"));
assert.ok(batchMarkup.includes("&lt;Video 名字&gt;"));
assert.ok(batchMarkup.includes("&lt;Prompt 名字&gt;"));
assert.ok(batchMarkup.includes("导演说明\n分镜"));
assert.ok(!batchMarkup.includes("# 批量提示词"));
assert.ok(!batchMarkup.includes('data-action="batch-text"'));
assert.ok(!batchMarkup.includes("导入提示词"));
assert.ok(!batchMarkup.includes('data-action="batch-import-prompt"'));
assert.ok(batchMarkup.includes('data-action="batch-cancel"'));
batchMarkupState.batchImport.promptImportOpen=true;
batchMarkupState.batchImport.importText="批次01｜测试\n[分镜脚本]\n镜头";
batchMarkupState.batchImport.importFileName="test.md";
const firstStageMarkup=batchRenderers.batchImportMarkup();
assert.ok(firstStageMarkup.includes("导入多批次提示词"));
assert.ok(!firstStageMarkup.includes("批量添加任务"));
const importMarkup=batchRenderers.batchPromptImportMarkup();
assert.ok(importMarkup.includes("导入多批次提示词"));
assert.ok(importMarkup.includes('data-action="batch-import-text"'));
assert.ok(importMarkup.includes('data-batch-prompt-dropzone'));
assert.ok(importMarkup.includes('data-action="batch-import-browse">浏览文件</button>'));
assert.ok(importMarkup.includes('data-action="batch-import-apply">确定</button>'));
assert.ok(importMarkup.includes("已读取：test.md"));
assert.ok(source.includes('addEventListener("dragover"'));
assert.ok(source.includes('addEventListener("drop"'));
assert.ok(source.includes("function applyBatchPromptImport() {"));
assert.match(source,/action === "batch-import-text"[\s\S]*?state\.batchImport\.importText=control\.value/);
assert.match(source,/const editor=state\.root\?\.querySelector\('\[data-action="batch-import-text"\]'\)/);
assert.ok(source.includes("if(batch.promptImportOpen)return batchPromptImportMarkup();"));
assert.ok(source.includes('if (action === "batch-import-cancel") {\n      state.batchImport=null;'));
assert.ok(batchMarkup.includes("批次01｜场景一"));
assert.ok(batchMarkup.includes('data-action="batch-upload-assets"'));
assert.ok(batchMarkup.includes('data-action="batch-submit"'));
assert.ok(batchMarkup.includes("将批次标题之前的说明附加到每个任务"));
assert.ok(batchMarkup.includes('class="tdm-batch-ref-card active"'));
assert.ok(batchMarkup.includes('data-action="batch-sync-asset"'));
assert.ok(batchMarkup.includes("图片 1"));
assert.ok(source.includes("function syncBatchAssetToOtherBatches(index) {"));
const refStart=source.indexOf("function batchReferenceLabel(item,index) {");
const refEnd=source.indexOf("function batchGeneratedMarkup()",refStart);
const renderRefs=new Function("state","esc","mediaKindLabel","batchSlotPreviewMarkup",
  source.slice(refStart,refEnd)+";return batchReferencesMarkup;");
const compactRefs=renderRefs({
  batchImport:{activeIndex:0,selectedRefIndex:0,batches:[{references:[
    {name:"logical-reference.jpg",description:"人物说明不应显示",kind:"image",path:"physical-file-name.jpg"}
  ]}]},
  inputFiles:[{kind:"image",path:"physical-file-name.jpg",name:"physical-file-name.jpg"}],
},value=>String(value),kindLabel,()=>" <img src='preview'/>")();
assert.ok(compactRefs.includes("图片 1"));
assert.ok(compactRefs.includes('data-action="batch-sync-asset"'));
assert.ok(!compactRefs.includes("logical-reference.jpg"));
assert.ok(!compactRefs.includes("人物说明不应显示"));
assert.ok(!compactRefs.includes("physical-file-name.jpg"));

const syncStart=source.indexOf("function syncBatchAssetToOtherBatches(index) {");
const syncEnd=source.indexOf("async function importBatchPrompt()",syncStart);
const syncState={batchImport:{activeIndex:0,batches:[
  {references:[{name:"蚂蚱载具.jpg",kind:"image",path:"/input/new-vehicle.png"}]},
  {references:[
    {name:"蚂蚱载具.jpg",kind:"image",path:"/input/old-vehicle.jpg"},
    {name:"蚂蚱载具.jpg",kind:"audio",path:"/input/sound.wav"},
    {name:"荒星地貌.jpg",kind:"image",path:"/input/landscape.jpg"},
  ]},
  {references:[{name:"蚂蚱载具.jpg",kind:"image",path:""}]},
]}};
const syncMessages=[];
const sync=new Function("state","toast",source.slice(syncStart,syncEnd)+";return syncBatchAssetToOtherBatches;")(
  syncState,(message,severity)=>syncMessages.push({message,severity}));
sync(0);
assert.equal(syncState.batchImport.batches[1].references[0].path,"/input/new-vehicle.png");
assert.equal(syncState.batchImport.batches[1].references[1].path,"/input/sound.wav");
assert.equal(syncState.batchImport.batches[1].references[2].path,"/input/landscape.jpg");
assert.equal(syncState.batchImport.batches[2].references[0].path,"/input/new-vehicle.png");
assert.equal(syncMessages[0].severity,"success");
assert.ok(source.includes('action === "batch-sync-asset"'));
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
},value=>String(value),assetCardStub,kindLabel,preview)();
assert.ok(typedBatchMarkup.includes('data-kind="image"'));
assert.ok(typedBatchMarkup.includes('data-kind="audio"'));
assert.ok(typedBatchMarkup.includes('data-kind="video"'));
assert.ok(typedBatchMarkup.includes("工作流媒体槽位：图片 1 / 音频 1 / 视频 1"));
assert.ok(typedBatchMarkup.includes("当前批次引用资产"));
assert.match(typedBatchMarkup,/data-kind="video"[^>]+disabled title="当前槽位需要图片，不能绑定视频"/);
const overflowMarkup=renderBatch({
  batchImport:{
    text:"多媒体",preamble:"",includePreamble:false,
    batches:[{name:"批次03",body:"正文",duration_seconds:15,references:[
      {name:"A.jpg",kind:"image",path:"A.jpg"},{name:"B.jpg",kind:"image",path:"B.jpg"},
      {name:"C.wav",kind:"audio",path:"C.wav"},{name:"D.mp4",kind:"video",path:"D.mp4"},
    ],generatedAssets:[]}],
    assetSlots:[{kind:"image"},{kind:"audio"},{kind:"video"}],
    activeIndex:0,selectedRefIndex:0,search:"",saving:false,uploading:false,
  },
  inputFiles:[
    {kind:"image",name:"A.jpg",path:"A.jpg"},{kind:"image",name:"B.jpg",path:"B.jpg"},
    {kind:"audio",name:"C.wav",path:"C.wav"},{kind:"video",name:"D.mp4",path:"D.mp4"},
  ],
},value=>String(value),assetCardStub,kindLabel,preview)();
assert.ok(overflowMarkup.includes("工作流媒体输入槽位不足：图片 2/1"));
assert.ok(overflowMarkup.includes("1 个批次超出容量，不会创建"));

const createBatchStart=source.indexOf("async function createBatchTasks() {");
const createBatchEnd=source.indexOf("function installCreatePromptEditor()",createBatchStart);
let savedBatch=null;
const batchState={batchImport:{saving:false,includePreamble:true,preamble:"全局规则",template:{},
  batches:[{name:"多媒体批次",body:"正文",duration_seconds:15,references:[
    {name:"a.jpg",kind:"image",path:"a.jpg"},
    {name:"b.wav",kind:"audio",path:"b.wav"},
    {name:"c.mp4",kind:"video",path:"c.mp4"},
  ]}]}};
const draftWithMediaSlots=()=>({assets:[
  {kind:"image",node_id:1,widget_name:"image",value:"default-a.jpg"},
  {kind:"audio",node_id:2,widget_name:"audio",value:"default.wav"},
  {kind:"video",node_id:3,widget_name:"video",value:"default.mp4"},
  {kind:"image",node_id:4,widget_name:"image",value:"default-b.jpg"},
]});
const createBatch=new Function("state","batchTaskStatus","randomizeNewTaskSeed","buildDraft",
  "PREVIEW_DURATION_DEFAULT","draftSnapshot","request","refresh","toast","render","window","batchPromptWithMediaTokens",
  source.slice(createBatchStart,createBatchEnd)+";return createBatchTasks;")(
  batchState,()=>({valid:true}),draft=>draft,draftWithMediaSlots,15,draft=>draft,
  async(_url,options)=>{savedBatch=JSON.parse(options.body);return {id:"draft_test"};},
  async()=>{},()=>{},()=>{},{confirm:()=>true},promptWithTokens);
batchState.batchImport.batches[0].body=[
  "[全局参考]","- a.jpg：人物","- b.wav：对白","- c.mp4：动作","[分镜脚本]","正文"
].join("\n");
await createBatch();
assert.equal(savedBatch.prompt,[
  "全局规则","",
  "[全局参考]","<Picture 1>：人物","<Audio 1>：对白","<Video 1>：动作","[分镜脚本]","正文"
].join("\n"));
assert.deepEqual(savedBatch.assets.map(asset=>asset.value),[
  "a.jpg","b.wav","c.mp4","default-b.jpg"
]);
assert.equal(batchState.batchImport,null);
assert.ok(rendered.includes('aria-label="生成随机种子"'));
assert.ok(source.includes('state.createDraft.duration_seconds=seconds;'));
assert.ok(source.includes('state.createDraft.highres_megapixels=Number(control.value);'));
console.log("Preview Stage inline create controls, duration/resolution and preview selection: PASS");

assert.ok(source.includes("asset.prompt||\"尚未提供生成提示词\""));
assert.ok(source.includes("current?.sourceBody||current?.body||\"\""));
assert.ok(source.includes("item.parseErrors||[]"));
