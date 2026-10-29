// Run: node tests/test_preview_config_bindings.mjs
// Prompt/seed dropdowns are based on output interface types, never graph tracing.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const moduleCode=await readFile(new URL("../web/td_preview_input_candidates.js",import.meta.url),"utf8");
const {listPreviewInputCandidates}=await import("data:text/javascript;base64,"+
  Buffer.from(moduleCode).toString("base64"));
const strip=source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"");
assert.doesNotThrow(()=>new Function(strip));

const graph={nodes:[
  {id:5,type:"ModelPreviewOverrideKJ",widgets_values_named:{preview:""},
   inputs:[{name:"preview",type:"STRING",link:null}],outputs:[{type:"MODEL",links:[]}]},
  {id:6,type:"MiniMaxH3ReferenceToVideo",widgets_values_named:{prompt:"old"},
   inputs:[{name:"prompt",type:"STRING",link:42}],outputs:[{type:"CONDITIONING",links:[]}]},
  {id:63,type:"TerryXuH3PromptEditor",widgets_values_named:{prompt:"original"},
   outputs:[{name:"H3 Prompt",type:"STRING",links:[42]}],
   inputs:[{name:"prompt",type:"STRING",link:null}]},
  {id:94,type:"TerryXuH3PromptEditor",widgets_values_named:{prompt:"enhanced"},
   outputs:[{name:"H3 Prompt",type:"STRING",links:[]}],
   inputs:[{name:"prompt",type:"STRING",link:null}]},
  {id:90,type:"QwenH3PromptLocal",widgets_values_named:{prompt:"not editable"},
   inputs:[{name:"prompt",type:"STRING",link:180}],
   outputs:[{name:"h3_prompt",type:"STRING",links:[]}]},
  {id:77,type:"Seed (rgthree)",widgets_values_named:{seed:8},
   outputs:[{name:"SEED",type:"INT",links:[]}]},
  {id:29,type:"ComfyMathExpression",widgets_values_named:{expression:"1+1"},
   outputs:[{name:"INT",type:"INT",links:[]}]},
],links:[[42,63,0,6,0,"STRING"]]};

const prompts=listPreviewInputCandidates(graph,"prompt");
assert.deepEqual(prompts.map(x=>x.node_id),[63,94]);
assert.ok(prompts.every(x=>x.label.startsWith("[STRING]")));
assert.ok(!prompts.some(x=>x.node_id===5 || x.node_id===6 || x.node_id===90));
const seeds=listPreviewInputCandidates(graph,"seed");
assert.deepEqual(seeds.map(x=>x.node_id),[77]);
assert.ok(seeds[0].label.startsWith("[INT]"));
assert.deepEqual(listPreviewInputCandidates({nodes:[]},"prompt"),[]);

// Standard ComfyUI JSON may carry widget values without widgets_values_named.
const plain={nodes:[{id:101,type:"TextSource",
 inputs:[{name:"text",type:"STRING",widget:{name:"text"},link:null}],
 outputs:[{name:"STRING",type:"STRING,TEXT"}],widgets_values:["hello"]}]};
assert.deepEqual(listPreviewInputCandidates(plain,"prompt").map(x=>x.node_id),[101]);
const rawRgthree={nodes:[{id:77,type:"Seed (rgthree)",
  outputs:[{name:"SEED",type:"INT"}],widgets_values:[12345,"",null,"okay"]}]};
assert.deepEqual(listPreviewInputCandidates(rawRgthree,"seed").map(x=>x.node_id),[77]);

assert.ok(source.includes('data-action="new-config"'));
assert.ok(source.includes('data-action="select-config"'));
assert.ok(source.includes('data-action="default-config"'));
assert.ok(source.includes('data-action="rename-config"'));
assert.ok(source.includes('data-action="delete-config"'));
assert.ok(source.includes('data-action="config-name"'));
assert.ok(source.includes("STRING 输出节点"));
assert.ok(source.includes("INT 输出节点"));
assert.ok(!source.includes("traceH3PromptInputs"));
console.log("Preview Stage typed source dropdowns: PASS");
