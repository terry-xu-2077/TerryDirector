// Run: node tests/test_preview_seed_wireless_route.mjs
// Seed validation still follows the real sampler path; dropdown selection does not.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const script=await readFile(new URL("../web/td_preview_job_compiler.js",import.meta.url),"utf8");
const {resolvePreviewSeedBounds}=await import("data:text/javascript;base64,"+
  Buffer.from(script).toString("base64"));

const labels=["宽度","高度","SEED","输出"];
const lanes=labels.map((name,index)=>({id:"lane"+index,name}));
const workflow={
 nodes:[
  {id:77,type:"Seed (rgthree)",outputs:[{name:"SEED",type:"INT",links:[150]}]},
  {id:78,type:"SetNode",widgets_values_named:{Constant:"seed"},inputs:[{name:"INT",link:150}],outputs:[{type:"INT",links:null}]},
  {id:79,type:"GetNode",widgets_values_named:{Constant:"seed"},outputs:[{type:"INT",links:[151]}]},
  {id:70,type:"TerryXuWirelessBusPack",properties:{terry_wireless_bus_channel:"分辨率",terry_wire_bus_lanes:lanes},
   inputs:labels.map((name,index)=>({name,link:index===2?151:null})),outputs:[{type:"TERRY_WIRE_BUS"}]},
  {id:72,type:"TerryXuWirelessBusUnpack",properties:{terry_wireless_bus_channel:"分辨率",terry_wire_bus_lane_ids:lanes.map(l=>l.id)},
   outputs:labels.map((name,index)=>({name,type:"INT",links:index===2?[141,142]:null}))},
  {id:11,type:"SamplerCustom",inputs:[{name:"noise_seed",link:142}]},
  {id:13,type:"TerryDirectorSelfLiftPauseResume",inputs:[{name:"seed",link:141}]},
 ],
 links:[[150,77,0,78,0,"INT"],[151,79,0,70,2,"INT"],[141,72,2,13,0,"INT"],[142,72,2,11,0,"INT"]],
};
const api={
 "77":{class_type:"Seed (rgthree)",inputs:{seed:8}},
 "11":{class_type:"SamplerCustom",inputs:{noise_seed:["72",2]}},
 "13":{class_type:"TerryDirectorSelfLiftPauseResume",inputs:{seed:["72",2]}},
};
const defs={
 "Seed (rgthree)":{input:{required:{seed:["INT",{min:0,max:1125899906842624}]}}},
 SamplerCustom:{input:{required:{noise_seed:["INT",{min:0,max:999999}]}}},
 TerryDirectorSelfLiftPauseResume:{input:{required:{seed:["INT",{min:0,max:500000}]}}},
};
const result=resolvePreviewSeedBounds(workflow,{node_id:77,widget_name:"seed"},api,defs);
assert.deepEqual([result.min,result.max],[0,500000]);
assert.deepEqual(result.consumers.map(x=>x.node_id).sort(),["11","13","77"]);
console.log("Preview Stage sampler-safe seed routing: PASS");
