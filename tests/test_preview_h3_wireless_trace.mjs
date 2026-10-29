// Run: node tests/test_preview_h3_wireless_trace.mjs
// Regression based on the wiring in TerryDirector_SelfLift_03_Pause_Continue.
// No media paths, prompts or user data are copied from the source workflow.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const load=async file=>{
  const src=await readFile(new URL(file,import.meta.url),"utf8");
  return import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
};
const {traceH3PromptInputs}=await load("../web/td_preview_prompt_trace.js");
const {resolvePreviewSeedBounds}=await load("../web/td_preview_job_compiler.js");
const lanes=["低清宽度","低清高度","高清宽度","高清高度","整数","SEED","输出"];
const ids=lanes.map((_,i)=>"channel-lane-"+i);
const link=(id,source,sourceSlot,target,targetSlot,type)=>[id,source,sourceSlot,target,targetSlot,type];
const workflow={
  nodes:[
    {id:6,type:"MiniMaxH3ReferenceToVideo",inputs:[{name:"prompt",type:"STRING",link:122}],
     outputs:[{type:"CONDITIONING",links:[]}],widgets_values_named:{prompt:"legacy"}},
    {id:69,type:"TerryXuMemoryCleanup",inputs:[{name:"anything",type:"*",link:139}],
     outputs:[{name:"output",type:"*",links:[122]}]},
    {id:71,type:"TerryXuWirelessBusUnpack",properties:{
      terry_wireless_bus_channel:"分辨率",terry_wire_bus_lane_ids:ids},
      outputs:lanes.map((name,i)=>({name,type:i===6?"STRING":"INT",
        links:i===6?[139]:null}))},
    {id:70,type:"TerryXuWirelessBusPack",properties:{
      terry_wireless_bus_channel:"分辨率",
      terry_wire_bus_lanes:lanes.map((name,i)=>({name,id:ids[i]}))},
      inputs:lanes.map((name,i)=>({name,type:i===6?"STRING":"INT",
        link:i===6?190:i===5?151:null})),
      outputs:[{name:"bus",type:"TERRY_WIRE_BUS",links:null}]},
    {id:96,type:"TerryXuBoolSwitch",inputs:[
      {name:"input_false",type:"*",link:188},
      {name:"input_true",type:"*",link:189},
      {name:"enabled",type:"BOOLEAN",link:null}],
      outputs:[{name:"output",type:"*",links:[190]}],
      widgets_values_named:{enabled:false}},
    {id:63,type:"TerryXuH3PromptEditor",inputs:[
      {name:"prompt",type:"STRING",link:null},
      {name:"source_text",type:"STRING,TEXT",link:null}],
      outputs:[{name:"H3 Prompt",type:"STRING",links:[188]}],
      widgets_values_named:{prompt:"source text",edit_mode:false}},
    {id:94,type:"TerryXuH3PromptEditor",inputs:[
      {name:"prompt",type:"STRING",link:null},
      {name:"source_text",type:"STRING,TEXT",link:186}],
      outputs:[{name:"H3 Prompt",type:"STRING",links:[189]}],
      widgets_values_named:{prompt:"enhanced text",edit_mode:true}},
    {id:5,type:"ModelPreviewOverrideKJ",inputs:[{name:"preview",type:"STRING",link:null}],
      widgets_values_named:{preview:""},outputs:[{name:"MODEL",type:"MODEL",links:[]}]},
    {id:77,type:"Seed (rgthree)",widgets_values_named:{seed:8},
      outputs:[{name:"SEED",type:"INT",links:[150]}]},
    {id:78,type:"SetNode",inputs:[{name:"INT",type:"INT",link:150}],
      outputs:[{name:"INT",type:"INT",links:null}],widgets_values_named:{Constant:"seed"}},
    {id:79,type:"GetNode",outputs:[{name:"INT",type:"INT",links:[151]}],
      widgets_values_named:{Constant:"seed"}},
    {id:72,type:"TerryXuWirelessBusUnpack",properties:{
      terry_wireless_bus_channel:"分辨率",terry_wire_bus_lane_ids:ids},
      outputs:lanes.map((name,i)=>({name,type:"INT",
        links:i===5?[141,142]:null}))},
    {id:11,type:"SamplerCustom",inputs:[{name:"noise_seed",type:"INT",link:142}]},
    {id:13,type:"TerryDirectorSelfLiftPauseResume",inputs:[{name:"seed",type:"INT",link:141}]},
  ],
  links:[
    link(122,69,0,6,0,"STRING"),link(139,71,6,69,0,"STRING"),
    link(190,96,0,70,6,"STRING"),
    link(188,63,0,96,0,"STRING"),link(189,94,0,96,1,"STRING"),
    link(150,77,0,78,0,"INT"),link(151,79,0,70,5,"INT"),
    link(141,72,5,13,0,"INT"),link(142,72,5,11,0,"INT"),
  ],
};
const find=graph=>traceH3PromptInputs(graph).fields.map(x=>[x.node_id,x.widget_name]);
assert.deepEqual(find(workflow),[[63,"prompt"]]);
assert.ok(!find(workflow).some(([id])=>id===5));
const enabled={...workflow,nodes:workflow.nodes.map(n=>n.id===96?
  {...n,widgets_values_named:{enabled:true}}:n)};
assert.deepEqual(find(enabled),[[94,"prompt"]]);
const disabledWire={...workflow,nodes:workflow.nodes.map(n=>n.id===70?
  {...n,properties:{...n.properties,terry_wireless_bus_channel:"不匹配"}}:n)};
assert.equal(find(disabledWire).length,0);
assert.ok(traceH3PromptInputs(disabledWire).failures.length>0);
const defs={
  "Seed (rgthree)":{input:{required:{seed:["INT",{min:0,max:1125899906842624}]}}},
  SamplerCustom:{input:{required:{noise_seed:["INT",{min:0,max:999999}]}}},
  TerryDirectorSelfLiftPauseResume:{input:{required:{seed:["INT",{min:0,max:500000}]}}},
};
const api={
  "77":{class_type:"Seed (rgthree)",inputs:{seed:8}},
  "11":{class_type:"SamplerCustom",inputs:{noise_seed:["72",5]}},
  "13":{class_type:"TerryDirectorSelfLiftPauseResume",inputs:{seed:["72",5]}},
};
const bound=resolvePreviewSeedBounds(workflow,{node_id:77,widget_name:"seed"},api,defs);
assert.equal(bound.min,0);
assert.equal(bound.max,500000);
assert.deepEqual(bound.consumers.map(x=>x.node_id).sort(),["11","13","77"]);
console.log("Preview Stage H3 editor #63 and rgthree wireless seed routes: PASS");
