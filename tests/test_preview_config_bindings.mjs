// Run: node tests/test_preview_config_bindings.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const stripped=source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"");
assert.doesNotThrow(()=>new Function(stripped));
const section=(start,end)=>{
  const p=source.indexOf(start),q=source.indexOf(end,p);
  assert.ok(p>=0 && q>p, start+" not found");
  return source.slice(p,q);
};
const bindingKey=value=>JSON.stringify({node_id:value.node_id,widget_name:value.widget_name});
const helpers=new Function("bindingKey",
  section("function traceH3PromptInputs","function matchingAssets")+";return {traceH3PromptInputs,fieldsOf};")(bindingKey);
const graph={
 nodes:[
  {id:5,type:"ModelPreviewOverrideKJ",widgets_values_named:{preview:""},
   inputs:[{name:"preview",type:"STRING",link:null}],outputs:[{type:"MODEL",links:[]}]},
  {id:6,type:"MiniMaxH3ReferenceToVideo",widgets_values_named:{prompt:"old"},
   inputs:[{name:"prompt",type:"STRING",link:42}],outputs:[{type:"CONDITIONING",links:[]}]},
  {id:63,type:"TerryXuH3PromptEditor",widgets_values_named:{prompt:"correct"},
   outputs:[{type:"STRING",links:[42]}],inputs:[]},
  {id:77,type:"SeedNode",widgets_values_named:{seed:8},
   inputs:[{name:"seed",link:null}],outputs:[{type:"INT",links:[]}]},
 ],
 links:[[42,63,0,6,0,"STRING"]],
};
const found=helpers.traceH3PromptInputs(graph);
assert.deepEqual(found.fields.map(x=>[x.node_id,x.widget_name]),[[63,"prompt"]]);
assert.equal(found.fields.some(x=>x.node_id===5),false);
assert.deepEqual(helpers.fieldsOf(graph,"seed").map(x=>x.node_id),[77]);
const direct={...graph,nodes:graph.nodes.filter(n=>n.id!==63).map(n=>n.id===6?
  {...n,inputs:[{name:"prompt",type:"STRING",link:null}]}:n),links:[]};
assert.deepEqual(helpers.traceH3PromptInputs(direct).fields.map(x=>x.node_id),[6]);
const broken={...graph,links:[]};
assert.equal(helpers.traceH3PromptInputs(broken).fields.length,0);
assert.ok(helpers.traceH3PromptInputs(broken).failures.length>0);
assert.ok(source.includes('data-action="new-config"'));
assert.ok(source.includes('data-action="select-config"'));
assert.ok(source.includes('data-action="default-config"'));
assert.ok(source.includes('data-action="rename-config"'));
assert.ok(source.includes('data-action="delete-config"'));
assert.ok(source.includes('data-action="config-name"'));
assert.ok(source.includes("state.configError="));
assert.ok(!source.includes("data-preview-config"));
console.log("Preview Stage H3 reverse binding and named-workflow config UI: PASS");
