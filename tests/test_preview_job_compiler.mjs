// Run: node tests/test_preview_job_compiler.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../web/td_preview_job_compiler.js",import.meta.url),"utf8");
const compiler = await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
const {resolvePreviewSeedBounds,validatePreviewSeed,randomPreviewSeed,
  compilePreviewTargets,buildPreviewJob,applyPreviewInputs,RGTHREE_MAX_SEED} = compiler;
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
 "22":{class_type:"SaveVideo",inputs:{video:["13",0]}},
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
assert.equal(job.output["11"].inputs.noise_seed[0],"77"); // sampler still linked
assert.throws(()=>applyPreviewInputs(job.output,[{node_id:11,widget_name:"noise_seed",value:7}]),/不能覆盖连线终点/);
assert.deepEqual(buildPreviewJob(template,[],"continue","a".repeat(32)).targets,["22"]);
console.log("Preview Stage seed/sampler cap and immutable compilation: PASS");
