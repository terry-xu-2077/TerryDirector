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
  {id:77,type:"SeedNode",inputs:[{name:"seed",link:null}],outputs:[{name:"seed",links:[1,2]}]},
  {id:11,type:"SamplerCustom",inputs:[{name:"noise_seed",link:1}],outputs:[{name:"denoised_output",links:[]} ]},
  {id:13,type:"TerryDirectorSelfLiftPauseResume",inputs:[
    {name:"seed",link:2},{name:"low_clean",link:null}],outputs:[{name:"out",links:[3]}]},
  {id:22,type:"SaveVideo",inputs:[{name:"video",link:3}],outputs:[]},
 ],
 links:[[1,77,0,11,0,"INT"],[2,77,0,13,0,"INT"],[3,13,0,22,0,"VIDEO"]],
};
const api={
 "77":{class_type:"SeedNode",inputs:{seed:8}},
 "11":{class_type:"SamplerCustom",inputs:{noise_seed:["77",0]}},
 "13":{class_type:"TerryDirectorSelfLiftPauseResume",inputs:{
   seed:["77",0],mode:"暂停并保存",checkpoint_id:"",name:"Test"}},
 "22":{class_type:"SaveVideo",inputs:{video:["13",0],filename_prefix:"video/TerryDirector/old"}},
};
const defs={
 SeedNode:{input:{required:{seed:["INT",{min:0,max:1125899906842624}]}}},
 SamplerCustom:{input:{required:{noise_seed:["INT",{min:0,max:999999}]}}},
 TerryDirectorSelfLiftPauseResume:{input:{required:{seed:["INT",{min:0,max:500000}]}}},
};
const binding={node_id:77,widget_name:"seed"};
const bounds=resolvePreviewSeedBounds(W,binding,api,defs);
assert.equal(bounds.min,0);
assert.equal(bounds.max,500000);
assert.equal(bounds.consumers.length,3);
assert.equal(validatePreviewSeed("500000",{seed_min:bounds.min,seed_max:bounds.max}),500000);
assert.throws(()=>validatePreviewSeed("500001",{seed_min:0,seed_max:bounds.max}),/范围内/);
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

// H3 mode takes over the H3 node's own prompt and media sockets. Existing
// workflow loaders/text nodes remain in the snapshot but are no longer wired
// into the H3 condition node for this task.
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
 "13":{class_type:"TerryDirectorSelfLiftPauseResume",inputs:{
  mode:"暂停并保存",checkpoint_id:"",name:"H3 direct test",
 }},
 "22":{class_type:"SaveVideo",inputs:{video:["13",0],filename_prefix:"TerryDirector"}},
 "32":{class_type:"LoadImage",inputs:{image:"old-reference.png"}},
 "63":{class_type:"TerryXuH3PromptEditor",inputs:{prompt:"old prompt"}},
};
const h3Template={
 schema:2,workflow:h3Workflow,api_prompt:h3Api,h3_node_id:6,
 h3_media_bindings:[
  "ref_images.ref_image_0","ref_videos.ref_video_0",
  "ref_video_audios.ref_video_audio_0","ref_audios.ref_audio_0",
 ],
 pause_node_id:13,pause_target:"13",highres_target:"22",decoded_target:null,
};
const h3Job=buildPreviewJob(h3Template,[
 {node_id:6,widget_name:"prompt",value:"new H3 prompt",role:"h3_prompt"},
 {node_id:6,widget_name:"ref_images.ref_image_0",value:"new-reference.png",role:"h3_media",kind:"image"},
 {node_id:6,widget_name:"ref_videos.ref_video_0",value:"motion.mp4",role:"h3_media",kind:"video"},
 {node_id:6,widget_name:"ref_audios.ref_audio_0",value:"voice.wav",role:"h3_media",kind:"audio"},
],"pause","",{sampling_preview_enabled:true,vae_decode_enabled:false});
const h3Inputs=h3Job.output["6"].inputs;
assert.equal(h3Inputs.prompt,"new H3 prompt");
assert.deepEqual(h3Inputs["ref_images.ref_image_0"],["64",0]);
assert.deepEqual(h3Inputs["ref_videos.ref_video_0"],["66",0]);
assert.deepEqual(h3Inputs["ref_video_audios.ref_video_audio_0"],["66",1]);
assert.deepEqual(h3Inputs["ref_audios.ref_audio_0"],["67",0]);
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
console.log("Preview Stage seed/sampler cap, independent preview options, H3 direct bindings and immutable compilation: PASS");
