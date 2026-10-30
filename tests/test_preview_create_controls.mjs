// Run: node tests/test_preview_create_controls.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const parameters=await readFile(new URL("../web/td_preview_task_parameters.js",import.meta.url),"utf8");
const mod=await import("data:text/javascript;base64,"+Buffer.from(parameters).toString("base64"));
assert.doesNotThrow(()=>new Function(source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const begin=source.indexOf("function createMarkup() {"),end=source.indexOf("function installCreatePromptEditor()",begin);
assert.ok(begin>=0 && end>begin);
const resolutionStart=source.indexOf("function resolutionOptionsMarkup(");
const resolutionEnd=source.indexOf("function createMarkup()",resolutionStart);
const resolutionOptionsMarkup=new Function("PREVIEW_RESOLUTION_OPTIONS","taskResolutionInfo","esc",
  source.slice(resolutionStart,resolutionEnd)+";return resolutionOptionsMarkup;")(
    mod.PREVIEW_RESOLUTION_OPTIONS,mod.taskResolutionInfo,x=>String(x));
const create=new Function("state","esc","assetCard","PREVIEW_RESOLUTION_OPTIONS",
  "taskAspectRatio","taskResolutionInfo","resolutionOptionsMarkup",
  source.slice(begin,end)+";return createMarkup;");
assert.equal(mod.PREVIEW_RESOLUTION_DEFAULT,2.0);
const normalizeSettingsStart=source.indexOf("function normalizePreviewSettings(value) {");
const normalizeSettingsEnd=source.indexOf("function readPreviewSettings()",normalizeSettingsStart);
assert.ok(normalizeSettingsStart>=0&&normalizeSettingsEnd>normalizeSettingsStart);
const normalizeSettings=new Function("PREVIEW_RESOLUTION_OPTIONS","PREVIEW_RESOLUTION_DEFAULT",
  source.slice(normalizeSettingsStart,normalizeSettingsEnd)+";return normalizePreviewSettings;")(
    mod.PREVIEW_RESOLUTION_OPTIONS,mod.PREVIEW_RESOLUTION_DEFAULT);
const defaultSettings=normalizeSettings(null);
assert.deepEqual(defaultSettings,{
  highres_megapixels:2.0,default_preview_mode:"decoded",
});
const defaultOptionsStart=source.indexOf("function defaultPreviewOptions(settings) {");
const defaultOptionsEnd=source.indexOf("function normalizeTaskPreviewOptions",defaultOptionsStart);
assert.ok(defaultOptionsStart>=0&&defaultOptionsEnd>defaultOptionsStart);
const defaultOptions=new Function("state",source.slice(defaultOptionsStart,defaultOptionsEnd)+
  ";return defaultPreviewOptions;")({previewSettings:defaultSettings});
assert.deepEqual(defaultOptions(),{
  sampling_preview_enabled:false,vae_decode_enabled:true,
});
const state={template:{workflow_name:"预演工作流"},tasks:[],
 createDraft:{source:"template",name:"S1_E1",seed:"42",prompt:"",previewType:"decoded",
 sampling_preview_enabled:false,vae_decode_enabled:true,decoded_target:"100",
 duration_seconds:15,highres_megapixels:2.0,assets:[],api_prompt:{}}};
const html=()=>create(state,x=>String(x),()=>"<asset/>",mod.PREVIEW_RESOLUTION_OPTIONS,
 mod.taskAspectRatio,mod.taskResolutionInfo,resolutionOptionsMarkup)();
let rendered=html();
assert.ok(rendered.indexOf("新建任务名称")<rendered.indexOf("基于"));
assert.ok(rendered.includes('id="tdm-new-task-name"'));
assert.equal((rendered.match(/tdm-inline-field/g)||[]).length,6);
assert.equal((rendered.match(/type="radio"/g)||[]).length,0);
assert.equal((rendered.match(/type="checkbox"/g)||[]).length,2);
assert.match(rendered,/data-field="vae_decode_enabled" checked/);
assert.ok(!rendered.match(/data-field="sampling_preview_enabled" checked/));
assert.ok(rendered.includes('id="tdm-new-task-duration"') || rendered.includes('id="tdm-task-duration"'));
assert.ok(rendered.includes('min="4" max="20" step="1"'));
assert.ok(rendered.includes('value="15"'));
assert.ok(rendered.includes('data-action="task-resolution"'));
assert.ok(rendered.includes("0.50 MP 低清"));
assert.ok(rendered.indexOf("预览输出")>rendered.indexOf("高清分辨率"));
state.createDraft.sampling_preview_enabled=true;
state.createDraft.vae_decode_enabled=false;
rendered=html();
assert.match(rendered,/data-field="sampling_preview_enabled" checked/);
assert.ok(!rendered.match(/data-field="vae_decode_enabled" checked/));
assert.ok(rendered.includes('data-action="random-seed"'));
assert.ok(source.includes('data-action="batch-create"'));
assert.ok(source.includes('data-action="batch-submit"'));
assert.ok(source.includes("function batchImportMarkup()"));
assert.ok(source.includes("matchingAssets(state.template.workflow,state.template.h3_node_id)"));
const matcherStart=source.indexOf("const H3_REFERENCE_CLASS =");
const matcherEnd=source.indexOf("const bindingKey",matcherStart);
assert.ok(matcherStart>=0&&matcherEnd>matcherStart);
const matchingAssets=new Function(source.slice(matcherStart,matcherEnd)+";return matchingAssets;")();
const mediaSlots=matchingAssets({nodes:[
  {id:1,type:"LoadImage",widgets_values_named:{image:"person.png"}},
  {id:2,type:"LoadAudio",widgets_values_named:{audio:"dialogue.wav"}},
  {id:3,type:"VHS_LoadVideoPath",widgets_values_named:{video:"motion.mp4"}},
  {id:4,type:"SaveVideo",widgets_values_named:{filename_prefix:"out"}},
]});
assert.deepEqual(mediaSlots.map(x=>x.kind),["image","audio","video"]);
assert.deepEqual(mediaSlots.map(x=>x.value),["person.png","dialogue.wav","motion.mp4"]);
const h3Slots=matchingAssets({nodes:[
 {id:6,type:"MiniMaxH3ReferenceToVideo",inputs:[
  {name:"ref_images.ref_image_0",type:"IMAGE",label:"ref_image_0"},
  {name:"ref_videos.ref_video_0",type:"IMAGE",label:"ref_video_0"},
  {name:"ref_video_audios.ref_video_audio_0",type:"AUDIO",label:"ref_video_audio_0"},
  {name:"ref_audios.ref_audio_0",type:"AUDIO",label:"ref_audio_0"},
 ]},
 {id:1,type:"LoadImage",widgets_values_named:{image:"ignored.png"}},
]},6);
assert.equal(h3Slots.length,15);
assert.deepEqual(h3Slots.filter(x=>x.kind==="image").map(x=>x.widget_name),
 Array.from({length:9},(_,i)=>"ref_images.ref_image_"+i));
assert.deepEqual(h3Slots.filter(x=>x.kind==="video").map(x=>x.widget_name),
 Array.from({length:3},(_,i)=>"ref_videos.ref_video_"+i));
assert.deepEqual(h3Slots.filter(x=>x.kind==="audio").map(x=>x.widget_name),
 Array.from({length:3},(_,i)=>"ref_audios.ref_audio_"+i));
assert.deepEqual(h3Slots.map(x=>x.kind),
 [...Array(9).fill("image"),...Array(3).fill("video"),...Array(3).fill("audio")]);
assert.ok(h3Slots.every(x=>x.h3_media&&x.value===""));
assert.ok(h3Slots.every(x=>x.node_id===6));
assert.ok(source.includes('<span class="tdm-noimg"><span>＋</span><small>添加图片</small></span>'));
assert.ok(source.includes(".tdm-create .tdm-asset .tdm-media-icon small{font-size:12px"));
assert.ok(source.includes(".tdm-create .tdm-asset .tdm-noimg small{font-size:12px"));
assert.ok(source.includes("tdm-asset-index"));
assert.ok(!source.includes("tdm-asset-status"));
assert.ok(source.includes("data-kind=") && source.includes("esc(kind)"));
assert.ok(source.includes('.tdm-create .tdm-asset[data-kind="image"]{border-color:'));
assert.ok(source.includes('.tdm-create .tdm-asset[data-kind="video"]{border-color:'));
assert.ok(source.includes('.tdm-create .tdm-asset[data-kind="audio"]{border-color:'));
assert.ok(source.includes("false,asset.kind||\"image\",false,true"));
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
const cardStart=source.indexOf("function assetCard(");
const cardEnd=source.indexOf("function resolutionOptionsMarkup(",cardStart);
const renderCard=new Function("state","esc","mediaPreviewMarkup","assetUrl",
  source.slice(cardStart,cardEnd)+";return assetCard;")(
    {inputFiles:[]},value=>String(value),mediaHelpers.mediaPreviewMarkup,path=>path);
for(const [kind,title,expected] of [
  ["image","参考图片 1 · 未设置","图片 1"],
  ["video","参考视频 2 · 未设置","视频 2"],
  ["audio","独立音频 3 · 未设置","音频 3"],
]){
 const markup=renderCard("",title,'data-action="replace"',false,kind,false,true);
 assert.ok(markup.includes('class="tdm-asset-index">'+expected+'</span>'));
 assert.ok(!markup.includes("未设置"));
 assert.ok(!markup.includes("参考"));
 assert.ok(!markup.includes("独立"));
}
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
    template:{decoded_target:"100",api_prompt:{},workflow:{}},highres_megapixels:2.0,
    sampling_preview_enabled:false,vae_decode_enabled:true,
    preamble:"全局风格规则",includePreamble:true,
    batches:[{name:"批次01｜场景一",body:"导演说明\n分镜",duration_seconds:15,
      references:[{name:"特瑞.jpg",kind:"image",path:"特瑞.jpg"}],generatedAssets:[]}],
    assetSlots:[{kind:"image"}],activeIndex:0,selectedRefIndex:0,search:"",saving:false,uploading:false,
  },
  inputFiles:[{kind:"image",name:"特瑞.jpg",path:"特瑞.jpg"}],
};
const createBatchRenderers=new Function("state","esc","assetCard","mediaKindLabel","mediaPreviewMarkup","PREVIEW_RESOLUTION_OPTIONS",
  "taskAspectRatio","taskResolutionInfo","resolutionOptionsMarkup",
  source.slice(batchStart,batchEnd)+";return {batchImportMarkup,batchPromptImportMarkup};");
const batchRendererArgs=[value=>String(value),assetCardStub,kindLabel,preview,[0.4,0.6,0.8,1,1.2,1.5,2,3,4],
  mod.taskAspectRatio,mod.taskResolutionInfo,resolutionOptionsMarkup];
const batchRenderers=createBatchRenderers(batchMarkupState,...batchRendererArgs);
const renderBatch=batchState=>createBatchRenderers(batchState,...batchRendererArgs).batchImportMarkup;
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
assert.ok(batchMarkup.includes('data-action="batch-resolution"'));
assert.ok(batchMarkup.includes('data-field="sampling_preview_enabled"'));
assert.ok(batchMarkup.includes('data-field="vae_decode_enabled"'));
assert.ok(batchMarkup.includes("对本次创建的所有批次生效"));
assert.match(batchMarkup,/value="2" selected/);
assert.match(batchMarkup,/data-field="vae_decode_enabled" checked/);
assert.ok(!batchMarkup.match(/data-field="sampling_preview_enabled" checked/));
const settingsStart=source.indexOf("function settingsMarkup() {");
const settingsEnd=source.indexOf("function configMarkup()",settingsStart);
assert.ok(settingsStart>=0&&settingsEnd>settingsStart);
const settingsHtml=new Function("state","PREVIEW_RESOLUTION_OPTIONS",
  source.slice(settingsStart,settingsEnd)+";return settingsMarkup;")({
    settingsDraft:{highres_megapixels:2.0,default_preview_mode:"decoded"},
  },[0.4,0.6,0.8,1,1.2,1.5,2,3,4])();
assert.match(settingsHtml,/value="2" selected/);
assert.match(settingsHtml,/value="decoded" checked/);
assert.match(settingsHtml,/value="sampling"/);
assert.ok(source.includes("PREVIEW_SETTINGS_KEY"));
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
assert.ok(source.includes('if (action === "batch-import-cancel") {\n      state.batchImport=null;state.assetPicker=null;'));
assert.ok(batchMarkup.includes("批次01｜场景一"));
assert.ok(batchMarkup.includes('data-action="batch-open-assets"'));
assert.ok(!batchMarkup.includes('data-action="batch-upload-assets"'));
assert.ok(!batchMarkup.includes('data-action="batch-search"'));
assert.ok(!batchMarkup.includes("资产池"));
assert.ok(batchMarkup.includes("2.00 MP 高清 ("));
assert.ok(batchMarkup.includes("0.50 MP 低清 ("));
assert.ok(batchMarkup.includes("1888×1088"));
assert.ok(batchMarkup.includes("960×544"));
assert.ok(batchMarkup.includes('data-action="batch-submit"'));
assert.ok(!batchMarkup.includes('data-action="batch-preamble"'));
assert.ok(!batchMarkup.includes("将批次标题之前的说明附加到每个任务"));
assert.ok(!source.includes('action === "batch-preamble"'));
assert.ok(!source.includes("includePreamble"));
assert.ok(batchMarkup.includes('class="tdm-batch-ref-card active"'));
assert.ok(source.includes("function syncBatchAssetToOtherBatches(index) {"));
assert.ok(source.includes('action === "batch-open-assets"'));
assert.ok(source.includes('action === "batch-remove-asset"'));
assert.ok(source.includes("function removeBatchAsset(index) {"));
assert.ok(source.includes(".tdm-batch-ref-sync{width:100%;margin-top:auto;"));
assert.ok(source.includes(".tdm-batch-ref-preview{display:flex;flex:1;"));
assert.ok(source.includes("min-height:110px;max-height:none;overflow:hidden"));
assert.ok(source.includes("height:100%;max-height:100%;object-fit:contain"));
assert.ok(source.includes(".tdm-batch-ref-empty{display:flex;flex:1;"));
assert.ok(source.includes("min-height:0;max-height:none;width:100%"));
assert.ok(source.includes('control.classList.contains("tdm-batch-ref-preview")'));
assert.ok(source.includes("batchReferenceIndex"));
assert.ok(!source.includes("function batchAssetPoolMarkup()"));
assert.ok(!source.includes("function renderBatchAssetPool()"));
assert.ok(!source.includes("function assignBatchAsset(path)"));
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
assert.ok(compactRefs.includes('data-action="batch-open-assets"'));
assert.ok(compactRefs.includes('class="tdm-batch-ref-preview" data-action="batch-open-assets"'));
assert.ok(compactRefs.includes('data-action="batch-remove-asset"'));
assert.ok(compactRefs.includes('aria-label="清除当前绑定"'));
assert.ok(!compactRefs.includes("tdm-batch-ref-replace"));
assert.ok(!compactRefs.includes(">替换</button>"));
assert.ok(compactRefs.includes('data-kind="image"'));
assert.ok(compactRefs.includes('class="tdm-batch-ref-index">图片 1</span>'));
assert.ok(!compactRefs.includes("logical-reference.jpg"));
assert.ok(!compactRefs.includes("人物说明不应显示"));
assert.ok(!compactRefs.includes("physical-file-name.jpg"));

const pickerStart=source.indexOf("function assetPickerMarkup() {");
const pickerEnd=source.indexOf("function renderAssetChoices()",pickerStart);
const renderPicker=new Function("state","esc","mediaKindLabel",
  source.slice(pickerStart,pickerEnd)+";return assetPickerMarkup;")(
    {assetPicker:{index:1,batchReferenceIndex:1,kind:"video",search:"motion"}},
    value=>String(value),kind=>kind);
const pickerMarkup=renderPicker();
assert.ok(pickerMarkup.includes("选择video资产"));
assert.ok(pickerMarkup.includes('data-action="upload-asset"'));
assert.ok(pickerMarkup.includes('data-action="asset-search"'));

const chooseStart=source.indexOf("function chooseAsset(data) {");
const chooseEnd=source.indexOf("async function uploadAsset(index)",chooseStart);
const chooseState={assetPicker:{index:0,batchReferenceIndex:1,kind:"video"},
  batchImport:{activeIndex:0,selectedRefIndex:0,batches:[{references:[
    {kind:"image",path:"old.jpg"},{kind:"video",path:"old.mp4"}
  ]}]},inputFiles:[{kind:"video",path:"new.mp4"}]};
let chooseRenders=0;
const choose=new Function("state","mediaKindLabel","render",
  source.slice(chooseStart,chooseEnd)+";return chooseAsset;")(
    chooseState,kind=>kind,()=>chooseRenders++);
choose({path:"new.mp4"});
assert.equal(chooseState.batchImport.batches[0].references[1].path,"new.mp4");
assert.equal(chooseState.batchImport.selectedRefIndex,1);
assert.equal(chooseState.assetPicker,null);
assert.equal(chooseRenders,1);
const removeStart=source.indexOf("function removeBatchAsset(index) {");
const removeEnd=source.indexOf("function syncBatchAssetToOtherBatches(index) {",removeStart);
const removeState={batchImport:{activeIndex:0,selectedRefIndex:0,batches:[{references:[
  {kind:"image",path:"/input/terry.jpg",name:"特瑞.jpg"},
  {kind:"video",path:"",name:"动作.mp4"}
]}]}};
const remove=new Function("state",source.slice(removeStart,removeEnd)+";return removeBatchAsset;")(removeState);
assert.equal(remove(0),true);
assert.equal(removeState.batchImport.batches[0].references[0].path,"");
assert.equal(removeState.batchImport.batches[0].references[0].name,"特瑞.jpg");
assert.equal(removeState.batchImport.selectedRefIndex,0);
assert.equal(remove(1),false);
assert.equal(removeState.batchImport.batches[0].references.length,2);
const bindStart=source.indexOf("function bindBatchDynamicActions(holder) {");
const bindEnd=source.indexOf("function renderBatchImportViews()",bindStart);
const actionCalls=[],handlers={};
const previewControl={dataset:{action:"batch-open-assets",index:"0"},
  classList:{contains:name=>name==="tdm-batch-ref-preview"},
  addEventListener:(name,handler)=>{handlers[name]=handler;}};
const bindActions=new Function("handleAction",
  source.slice(bindStart,bindEnd)+";return bindBatchDynamicActions;")(
    (action,data)=>actionCalls.push({action,index:data.index}));
bindActions({querySelectorAll:()=>[previewControl]});
const event=(target,extra={})=>({target,preventDefault(){},stopPropagation(){},...extra});
handlers.click(event({closest:()=>null}));
handlers.click(event({closest:()=>({tagName:"VIDEO",clientHeight:116})},{offsetY:20}));
handlers.click(event({closest:()=>({tagName:"VIDEO",clientHeight:116})},{offsetY:100}));
handlers.click(event({closest:()=>({tagName:"AUDIO",clientHeight:38})},{offsetY:12}));
handlers.keydown(event({closest:()=>null},{key:"Enter"}));
assert.equal(actionCalls.length,3);
assert.deepEqual(actionCalls.map(item=>item.action),[
  "batch-open-assets","batch-open-assets","batch-open-assets"
]);
assert.deepEqual(actionCalls.map(item=>item.index),["0","0","0"]);
const syncStart=source.indexOf("function syncBatchAssetToOtherBatches(index) {");
const syncEnd=source.indexOf("function isBatchPromptFile(file)",syncStart);
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
    template:{decoded_target:"100",api_prompt:{},workflow:{}},
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
assert.ok(typedBatchMarkup.includes('data-action="batch-open-assets"'));
assert.ok(typedBatchMarkup.includes('class="tdm-batch-ref-index"'));
assert.ok(!typedBatchMarkup.includes("batch-pool"));
assert.ok(!typedBatchMarkup.includes("当前槽位需要图片，不能绑定视频"));
const overflowMarkup=renderBatch({
  batchImport:{
    template:{decoded_target:"100",api_prompt:{},workflow:{}},
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
const batchState={batchImport:{saving:false,includePreamble:false,preamble:"全局规则",template:{},
  highres_megapixels:2.0,sampling_preview_enabled:false,vae_decode_enabled:true,
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
  "PREVIEW_DURATION_DEFAULT","draftSnapshot","request","refresh","toast","render","window","batchPromptWithMediaTokens","legacyPreviewType",
  source.slice(createBatchStart,createBatchEnd)+";return createBatchTasks;")(
  batchState,()=>({valid:true}),draft=>draft,draftWithMediaSlots,15,draft=>draft,
  async(_url,options)=>{savedBatch=JSON.parse(options.body);return {id:"draft_test"};},
  async()=>{},()=>{},()=>{},{confirm:()=>true},promptWithTokens,
  options=>options.vae_decode_enabled&&!options.sampling_preview_enabled?"decoded":"sampling");
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
assert.equal(savedBatch.highres_megapixels,2.0);
assert.equal(savedBatch.sampling_preview_enabled,false);
assert.equal(savedBatch.vae_decode_enabled,true);
assert.equal(savedBatch.previewType,"decoded");
assert.equal(batchState.batchImport,null);
assert.ok(rendered.includes('aria-label="生成随机种子"'));
assert.ok(source.includes('state.createDraft.duration_seconds=seconds;'));
assert.ok(source.includes('state.createDraft.highres_megapixels=Number(control.value);'));
console.log("Preview Stage inline create controls, duration/resolution and preview selection: PASS");

assert.ok(source.includes("asset.prompt||\"尚未提供生成提示词\""));
assert.ok(source.includes("current?.sourceBody||current?.body||\"\""));
assert.ok(source.includes("item.parseErrors||[]"));
