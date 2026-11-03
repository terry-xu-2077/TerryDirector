// Run: node tests/test_preview_job_compiler.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../web/td_preview_job_compiler.js",import.meta.url),"utf8");
const parameterSource=await readFile(new URL("../web/td_preview_task_parameters.js",import.meta.url),"utf8");
const parameterUrl="data:text/javascript;base64,"+Buffer.from(parameterSource).toString("base64");

const compiler = await import("data:text/javascript;base64,"+Buffer.from(source.replace('"./td_preview_task_parameters.js"',JSON.stringify(parameterUrl))).toString("base64"));
const {resolvePreviewSeedBounds,validatePreviewSeed,randomPreviewSeed,
  compilePreviewTargets,buildPreviewJob,applyPreviewInputs,normalizePreviewOptions,
  RGTHREE_MAX_SEED,sanitizeTaskFilename} = compiler;
const W={
 nodes:[
  {id:77,type:"SeedNode",inputs:[{name:"seed",link:null}],outputs:[{name:"seed",links:[1]}]},
  {id:11,type:"SamplerCustom",inputs:[{name:"noise_seed",link:1}],outputs:[{name:"denoised_output",links:[]} ]},
  {id:13,type:"TerryDirectorPauseResume",inputs:[
    {name:"latent",link:2}],outputs:[{name:"out",links:[3]}]},
  {id:22,type:"SaveVideo",inputs:[{name:"video",link:3}],outputs:[]},
 ],
 links:[[1,77,0,11,0,"INT"],[2,11,0,13,0,"LATENT"],[3,13,0,22,0,"VIDEO"]],
};
const api={
 "77":{class_type:"SeedNode",inputs:{seed:8}},
 "11":{class_type:"SamplerCustom",inputs:{noise_seed:["77",0]}},
 "13":{class_type:"TerryDirectorPauseResume",inputs:{
   latent:["11",0],mode:"暂停并保存",checkpoint_id:"",name:"Test"}},
 "22":{class_type:"SaveVideo",inputs:{video:["13",0],filename_prefix:"video/TerryDirector/old"}},
};
const defs={
 SeedNode:{input:{required:{seed:["INT",{min:0,max:1125899906842624}]}}},
 SamplerCustom:{input:{required:{noise_seed:["INT",{min:0,max:999999}]}}},
 TerryDirectorPauseResume:{input:{required:{}}},
};
const binding={node_id:77,widget_name:"seed"};
const bounds=resolvePreviewSeedBounds(W,binding,api,defs);
assert.equal(bounds.min,0);
assert.equal(bounds.max,999999);
assert.equal(bounds.consumers.length,2);
assert.equal(validatePreviewSeed("500000",{seed_min:bounds.min,seed_max:bounds.max}),500000);
assert.throws(()=>validatePreviewSeed("1000000",{seed_min:0,seed_max:bounds.max}),/范围内/);
assert.throws(()=>validatePreviewSeed("2937562916928535",{seed_min:0,seed_max:bounds.max}),/范围内/);
const mockedRandom=randomPreviewSeed({seed_min:0,seed_max:500000},
 arr=>{arr[0]=0xffffffff;arr[1]=0xffffffff});
assert.ok(Number(mockedRandom)>=0 && Number(mockedRandom)<=500000);
const fallback=resolvePreviewSeedBounds(W,binding,api,{});
assert.equal(fallback.max,RGTHREE_MAX_SEED);
assert.equal(compilePreviewTargets(W,api,13).highres_target,"22");
const template={
 schema:2,workflow:W,api_prompt:api,pause_node_id:13,
 pause_target:"13",highres_target:"22",decoded_target:null,
 seed_min:bounds.min,seed_max:bounds.max,
};
const job=buildPreviewJob(template,[{node_id:77,widget_name:"seed",value:1234}],"pause");
assert.deepEqual(job.targets,["13"]);
assert.equal(job.output["77"].inputs.seed,1234);
assert.equal(api["77"].inputs.seed,8); // input node never mutated
assert.equal(job.output["22"].inputs.filename_prefix,"video/TerryDirector/Test");
const named=buildPreviewJob(template,[
 {node_id:13,widget_name:"name",value:"批次01｜测试/镜头: A"},
],"continue","a".repeat(32));
assert.equal(named.output["22"].inputs.filename_prefix,"video/TerryDirector/批次01_测试_镜头_A");
assert.equal(sanitizeTaskFilename("CON"),"_CON");
assert.equal(sanitizeTaskFilename("  "), "TerryDirector");
assert.equal(sanitizeTaskFilename("/batch/"), "batch");
assert.equal(job.output["11"].inputs.noise_seed[0],"77"); // sampler still linked
assert.throws(()=>applyPreviewInputs(job.output,[{node_id:11,widget_name:"noise_seed",value:7}]),/不能覆盖连线终点/);
assert.deepEqual(buildPreviewJob(template,[],"continue","a".repeat(32)).targets,["22"]);
// Independent preview switches: either path can run alone or both can run together.
assert.deepEqual(normalizePreviewOptions({
  sampling_preview_enabled:true,vae_decode_enabled:true,
}),{sampling_preview_enabled:true,vae_decode_enabled:true});
assert.deepEqual(normalizePreviewOptions({
  sampling_preview_enabled:false,vae_decode_enabled:true,
}),{sampling_preview_enabled:false,vae_decode_enabled:true});

// H3 overrides retain upstream text processing and clone changed media paths.
const h3Workflow={nodes:[
 {id:6,type:"MiniMaxH3ReferenceToVideo",inputs:[
  {name:"ref_images.ref_image_0",type:"IMAGE",link:41},
  {name:"ref_videos.ref_video_0",type:"IMAGE",link:null},
  {name:"ref_video_audios.ref_video_audio_0",type:"AUDIO",link:null},
  {name:"ref_audios.ref_audio_0",type:"AUDIO",link:null},
  {name:"prompt",type:"STRING",widget:{name:"prompt"},link:42},
 ]},
 {id:32,type:"LoadImage",inputs:[],widgets_values_named:{image:"old-reference.png"}},
 {id:63,type:"TerryXuH3PromptEditor",inputs:[],widgets_values_named:{prompt:"old prompt"}},
]};
const h3Api={
 "6":{class_type:"MiniMaxH3ReferenceToVideo",inputs:{
  "ref_images.ref_image_0":["32",0],
  "ref_videos.ref_video_0":null,
  "ref_video_audios.ref_video_audio_0":null,
  "ref_audios.ref_audio_0":null,
  prompt:["63",0],width:960,height:544,length:124,
 }},
 "13":{class_type:"TerryDirectorPauseResume",inputs:{
  mode:"暂停并保存",checkpoint_id:"",name:"H3 direct test",
 }},
 "22":{class_type:"SaveVideo",inputs:{video:["13",0],filename_prefix:"TerryDirector"}},
 "32":{class_type:"LoadImage",inputs:{image:"old-reference.png"}},
 "63":{class_type:"TerryXuH3PromptEditor",inputs:{prompt:"old prompt"}},
};
const h3Template={
 schema:2,workflow:h3Workflow,api_prompt:h3Api,h3_node_id:6,
 h3_media_bindings:[
  ...Array.from({length:9},(_,i)=>"ref_images.ref_image_"+i),
  ...Array.from({length:3},(_,i)=>"ref_videos.ref_video_"+i),
  ...Array.from({length:3},(_,i)=>"ref_video_audios.ref_video_audio_"+i),
  ...Array.from({length:3},(_,i)=>"ref_audios.ref_audio_"+i),
 ],
 pause_node_id:13,pause_target:"13",highres_target:"22",decoded_target:null,
};
const h3Job=buildPreviewJob(h3Template,[
 {node_id:6,widget_name:"prompt",value:"new H3 prompt",role:"h3_prompt"},
 {node_id:6,widget_name:"ref_images.ref_image_0",value:"new-reference.png",role:"h3_media",kind:"image"},
 {node_id:6,widget_name:"ref_videos.ref_video_0",value:"motion.mp4",role:"h3_media",kind:"video"},
 {node_id:6,widget_name:"ref_audios.ref_audio_0",value:"voice.wav",role:"h3_media",kind:"audio"},
 {node_id:6,widget_name:"ref_images.ref_image_8",value:"ninth-reference.png",role:"h3_media",kind:"image"},
 {node_id:6,widget_name:"ref_videos.ref_video_2",value:"third-motion.mp4",role:"h3_media",kind:"video"},
 {node_id:6,widget_name:"ref_audios.ref_audio_2",value:"third-voice.wav",role:"h3_media",kind:"audio"},
],"pause","",{sampling_preview_enabled:true,vae_decode_enabled:false});
const h3Inputs=h3Job.output["6"].inputs;
assert.deepEqual(h3Inputs.prompt,["63",0]);
assert.equal(h3Job.output["63"].inputs.prompt,"new H3 prompt");
assert.deepEqual(h3Inputs["ref_images.ref_image_0"],["64",0]);
assert.deepEqual(h3Inputs["ref_videos.ref_video_0"],["66",0]);
assert.deepEqual(h3Inputs["ref_video_audios.ref_video_audio_0"],["66",1]);
assert.deepEqual(h3Inputs["ref_audios.ref_audio_0"],["67",0]);
assert.deepEqual(h3Inputs["ref_images.ref_image_8"],["68",0]);
assert.deepEqual(h3Inputs["ref_videos.ref_video_2"],["70",0]);
assert.deepEqual(h3Inputs["ref_video_audios.ref_video_audio_2"],["70",1]);
assert.deepEqual(h3Inputs["ref_audios.ref_audio_2"],["71",0]);
assert.equal(h3Job.output["64"].class_type,"LoadImage");
assert.equal(h3Job.output["64"].inputs.image,"new-reference.png");
assert.equal(h3Job.output["65"].class_type,"LoadVideo");
assert.equal(h3Job.output["65"].inputs.file,"motion.mp4");
assert.equal(h3Job.output["66"].class_type,"GetVideoComponents");
assert.deepEqual(h3Job.output["66"].inputs.video,["65",0]);
assert.equal(h3Job.output["67"].class_type,"LoadAudio");
assert.equal(h3Job.output["67"].inputs.audio,"voice.wav");
assert.deepEqual(h3Api["6"].inputs["ref_images.ref_image_0"],["32",0]);
assert.deepEqual(h3Api["6"].inputs.prompt,["63",0]);
assert.deepEqual(h3Job.targets,["13"]);
assert.throws(()=>buildPreviewJob(h3Template,[
 {node_id:6,widget_name:"ref_images.ref_image_9",value:"too-many.png",role:"h3_media",kind:"image"},
],"pause","",{sampling_preview_enabled:true,vae_decode_enabled:false}),/H3 参考资产输入端无效/);
console.log("Preview Stage seed/sampler cap, independent preview options, H3 direct bindings and immutable compilation: PASS");

assert.equal(buildPreviewJob(template,[],"continue","a".repeat(32)).output["13"].inputs.mode,"继续执行");
assert.deepEqual(Object.keys(job.output["13"].inputs).sort(),["checkpoint_id","latent","mode","name"]);

// Direct seed bindings must work without requiring an extra integer node.
const direct=resolvePreviewSeedBounds(W,{node_id:11,widget_name:"noise_seed"},
  {...api,"11":{class_type:"SamplerCustom",inputs:{noise_seed:8}}},defs);
assert.equal(direct.max,999999);
const customWorkflow={nodes:[{id:90,type:"CustomDenoise",inputs:[{name:"seed"},{name:"cfg"}],outputs:[{type:"LATENT"}]}],links:[]};
const custom=resolvePreviewSeedBounds(customWorkflow,{node_id:90,widget_name:"seed"},
 {"90":{class_type:"CustomDenoise",inputs:{seed:8,cfg:1}}},
 {CustomDenoise:{input:{required:{seed:["INT",{min:0,max:12345}]}}}});
assert.equal(custom.max,12345);
const noise=resolvePreviewSeedBounds({nodes:[{id:91,type:"RandomNoise",inputs:[{name:"noise_seed"}],outputs:[{type:"NOISE"}]}],links:[]},
 {node_id:91,widget_name:"noise_seed"},{"91":{class_type:"RandomNoise",inputs:{noise_seed:8}}},{});
assert.equal(noise.consumers[0].node_id,"91");
console.log("Preview seed binding: direct sampler, custom denoiser and native noise source PASS");

// An untouched task must retain all preprocessing, preview implementations and
// unassigned references, including valid text-only H3 workflows.
const unchanged=buildPreviewJob(h3Template,[],"pause","",{sampling_preview_enabled:false});
assert.deepEqual(unchanged.output["6"],h3Api["6"]);
const textOnly=structuredClone(h3Template);
for(const key of Object.keys(textOnly.api_prompt["6"].inputs))if(key.startsWith("ref_"))delete textOnly.api_prompt["6"].inputs[key];
assert.doesNotThrow(()=>buildPreviewJob(textOnly));
const instrumented=structuredClone(template);
instrumented.api_prompt["80"]={class_type:"ModelPreviewOverrideKJ",inputs:{model:["1",0],tiny_vae:"taeh3.safetensors",suppress_default_preview:true}};
instrumented.api_prompt["81"]={class_type:"TerryDirectorH3Preview",inputs:{model:["1",0],tiny_vae:"taeh3.safetensors"}};
const observed=buildPreviewJob(instrumented,[],"pause","",{sampling_preview_enabled:false});
for(const key of ["80","81"])assert.deepEqual(observed.output[key],instrumented.api_prompt[key]);
const processed=structuredClone(h3Template);
processed.api_prompt["40"]={class_type:"ImageScale",inputs:{image:["32",0],width:640,height:352,crop:"center"}};
processed.api_prompt["6"].inputs["ref_images.ref_image_0"]=["40",0];
processed.api_prompt["6"].inputs["ref_images.ref_image_1"]=["40",0];
const changed=buildPreviewJob(processed,[{node_id:6,widget_name:"ref_images.ref_image_0",value:"replacement.png",role:"h3_media",kind:"image"}]);
const resized=changed.output[String(changed.output["6"].inputs["ref_images.ref_image_0"][0])];
assert.equal(resized.class_type,"ImageScale");assert.equal(resized.inputs.crop,"center");assert.equal(resized.inputs.width,640);
assert.equal(changed.output[String(resized.inputs.image[0])].inputs.image,"replacement.png");
assert.deepEqual(changed.output["6"].inputs["ref_images.ref_image_1"],["40",0]);
assert.equal(changed.output["32"].inputs.image,"old-reference.png");
const cleared=buildPreviewJob(h3Template,[{node_id:6,widget_name:"ref_images.ref_image_0",value:"",role:"h3_media",kind:"image",remove:true}]);
assert.ok(!Object.hasOwn(cleared.output["6"].inputs,"ref_images.ref_image_0"));
console.log("Native workflow parity: unchanged graph, text-only H3, source prompt edits, preserved crops and shared assets PASS");

// Exercise the actual task submission and archive functions together. The
// persisted executable graph must be the submitted one, not the base template.
const manager=await readFile(new URL("../web/td_preview_task_manager.js",import.meta.url),"utf8");
const fragment=(start,end)=>manager.slice(manager.indexOf(start),manager.indexOf(end,manager.indexOf(start)));
let submitted;
const submit=new Function("api","buildPreviewJob","trackManagedPausePrompt",
 fragment("async function submitPreviewJob(","function draftSnapshot(")+";return submitPreviewJob;")(
 {queuePrompt:async (_position,payload)=>{submitted=payload.output;return {prompt_id:"parity-test"};}},buildPreviewJob,()=>{});
const draft={...structuredClone(h3Template),id:"draft_parity",name:"Archived shot",prompt:"Edited text",seed:"19",seed_min:0,seed_max:100,
 prompt_binding:{node_id:6,widget_name:"prompt"},seed_binding:{node_id:77,widget_name:"seed"},
 assets:[{node_id:6,widget_name:"ref_images.ref_image_0",value:"archive.png",h3_media:true,kind:"image"}],
 video_parameter_overrides:{duration:false,resolution:false},sampling_preview_enabled:false,vae_decode_enabled:false};
draft.api_prompt["77"]={class_type:"SeedNode",inputs:{seed:8}};
const state={jobs:new Map()};
const run=new Function("state","request","draftTransition","normalizeTaskPreviewOptions","validatePreviewSeed","submitPreviewJob","saveLegacyLifecycle","refresh","toast","legacyPreviewType",
 fragment("function draftOverrides(","async function loadSavedWorkflow(")+";return runDraft;")(
 state,async()=>draft,async()=>{},normalizePreviewOptions,validatePreviewSeed,submit,async()=>{},async()=>{},()=>{},()=>"sampling");
await run(draft.id);
const archivedJob=state.jobs.get("parity-test");assert.deepEqual(archivedJob.api_prompt,submitted);
assert.equal(archivedJob.api_prompt["63"].inputs.prompt,"Edited text");assert.equal(draft.api_prompt["63"].inputs.prompt,"old prompt");
let archived;
const persist=new Function("request","samplingPreviewEnabled","detectLowresReviewSink","refresh","toast",
 fragment("async function persistJob(","async function persistPreview(")+";return persistJob;")(
 async (_url,options)=>{archived=JSON.parse(options.body);},()=>false,()=>null,()=>{},()=>{});
archivedJob.checkpointId="a".repeat(32);await persist(archivedJob);
assert.deepEqual(archived.api_prompt,submitted);assert.deepEqual(archived.video_parameter_overrides,{duration:false,resolution:false});
console.log("Task execution archive preserves the exact submitted graph and parameter ownership PASS");

// Loading a task back into ComfyUI must restore the actual task inputs, rather
// than an original template that would silently run with different values.
let restored;
const loadTask=new Function("request","app","window","buildPreviewJob","normalizeTaskPreviewOptions","state","selectedTask","toast",
 fragment("async function loadSavedWorkflow(","async function queueFromCheckpoint(")+";return loadSavedWorkflow;")(
 async path=>path.endsWith("/metadata")?archived:{workflow:archived.workflow,api_prompt:archived.api_prompt,overrides:archived.overrides,
 pause_target:archived.pause_target,highres_target:archived.highres_target,decoded_target:null},
 {loadApiJson:async output=>{restored=output;}},{confirm:()=>true},buildPreviewJob,normalizePreviewOptions,{},()=>null,()=>{});
await loadTask("a".repeat(32));
assert.deepEqual(restored,submitted,"Native task restore must preserve the submitted inputs and links");
console.log("Task restore loads its executed graph through ComfyUI's native API workflow importer PASS");

const busTemplate=structuredClone(h3Template);
busTemplate.api_prompt["6"].inputs["ref_images.ref_image_0"]=["101:media:a",0];
busTemplate.api_prompt["101"]={class_type:"TerryXuMediaLoader",inputs:{assets_json:JSON.stringify({image:[{id:"a",path:"old.png",source:"input"},{id:"b",path:"other.png",source:"input"}],video:[],audio:[]})}};
busTemplate.api_prompt["101:media:a"]={class_type:"TerryXuMediaBusItem",inputs:{bus:["101",0],asset_id:"a"}};
const busSource=compiler.resolvePreviewMediaSource(busTemplate.api_prompt,["101:media:a",0],"image");
assert.equal(busSource.value,"old.png");
const busJob=buildPreviewJob(busTemplate,[{node_id:6,widget_name:"ref_images.ref_image_0",value:"new.png",role:"h3_media",kind:"image"}]);
const item=busJob.output[String(busJob.output["6"].inputs["ref_images.ref_image_0"][0])];assert.equal(item.class_type,"TerryXuMediaBusItem");
const loader=busJob.output[String(item.inputs.bus[0])];const assets=JSON.parse(loader.inputs.assets_json);
assert.equal(assets.image[0].path,"new.png");assert.equal(assets.image[1].path,"other.png");
assert.equal(JSON.parse(busJob.output["101"].inputs.assets_json).image[0].path,"old.png");
console.log("Reference asset overrides preserve TerryXu's compiled media bus adapters PASS");
