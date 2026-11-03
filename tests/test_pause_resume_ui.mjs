// Generic node actions: isolated targets, persisted IDs and task/canvas ownership.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../web/td_pause_resume.js",import.meta.url),"utf8");
const handlers={},queued=[],alerts=[];
let extension;
const api={addEventListener(name,fn){handlers[name]=fn;},
  fetchApi:async()=>({ok:true,json:async()=>({exists:true})}),
  queuePrompt:async(number,data,options)=>{
    queued.push(options.partialExecutionTargets);
    return {prompt_id:"canvas-"+queued.length};
  }};
const nodes=[
  {id:13,comfyClass:"TerryDirectorPauseResume",widgets:[
    {name:"mode",value:"暂停并保存"},{name:"checkpoint_id",value:""},{name:"name",value:"缓存测试"}],
    outputs:[{links:[1]},{links:[4]}]},
  {id:7,type:"VAEDecode",outputs:[{links:[2,3]}]},
  {id:8,type:"SaveImage",outputs:[]},
  {id:11,type:"CustomOutput",outputs:[]},
  {id:23,type:"SaveImage",outputs:[]}, // Unrelated ID-output branch is excluded.
];
const graph={_nodes:nodes,links:{
  1:{target_id:7},2:{target_id:8},3:{target_id:11},4:{target_id:23},
},getNodeById(id){return nodes.find(node=>node.id===Number(id));}};
nodes[0].graph=graph;
const app={graph,registerExtension(value){extension=value;},
  async queuePrompt(number,count,targets){
    return api.queuePrompt(number,{output:Object.fromEntries(targets.map(id=>[id,{}]))},
      {partialExecutionTargets:targets});
  }};
const functions=new Function("app","api","window","document",
  source.replace(/^import[^\n]+\n/gm,"").replace(/\bexport\s+/g,"")+
  "return {runBranch,resetCache,trackManagedPausePrompt};")
  (app,api,{alert:message=>alerts.push(message)},{});
await extension.setup();
class CustomOutput {}
extension.beforeRegisterNodeDef(CustomOutput,{output_node:true});
nodes[3].constructor=CustomOutput;

await functions.runBranch(nodes[0]);
assert.deepEqual(queued,[["13"]],"pause runs only the cache boundary");
await functions.runBranch(nodes[0]);
assert.equal(queued.length,1,"do not submit a node twice while its prompt runs");
handlers.executed({detail:{node:13,prompt_id:"canvas-1",output:{terrydirector_checkpoint:[{
  checkpoint_id:"a".repeat(32),mode:"paused",name:"缓存测试",
}]}}});
assert.equal(nodes[0].widgets[1].value,"a".repeat(32));
handlers.execution_success({detail:{prompt_id:"canvas-1"}});
await functions.runBranch(nodes[0]);
assert.deepEqual(queued[1],["8","11"],"continue runs all downstream outputs, excluding parallel ID branches");
assert.equal(nodes[0].widgets[0].value,"继续执行");
handlers.execution_success({detail:{prompt_id:"canvas-2"}});

functions.trackManagedPausePrompt("managed-task");
handlers.executed({detail:{node:13,prompt_id:"managed-task",output:{terrydirector_checkpoint:[{
  checkpoint_id:"b".repeat(32),mode:"paused",
}]}}});
assert.equal(nodes[0].widgets[1].value,"a".repeat(32),"saved-task results must not mutate the canvas");
functions.resetCache(nodes[0]);
assert.equal(nodes[0].widgets[1].value,"");
assert.equal(nodes[0].widgets[0].value,"暂停并保存");

// Saving a cache also executes native saves fed by that same upstream LATENT.
const low={id:30,type:"Sampler",outputs:[{links:[10,11]}]},decode={id:31,type:"VAEDecode",outputs:[{links:[12]}]},
  create={id:32,type:"CreateVideo",outputs:[{links:[13]}]},save={id:33,type:"SaveVideo",outputs:[]};
nodes.push(low,decode,create,save);
nodes[0].inputs=[{name:"latent",link:10}];
Object.assign(graph.links,{
  10:{origin_id:30,origin_slot:0,target_id:13},11:{origin_id:30,origin_slot:0,target_id:31},
  12:{origin_id:31,origin_slot:0,target_id:32},13:{origin_id:32,origin_slot:0,target_id:33},
});
// A joined output consuming both a low branch and a paused high branch is
// not a low-stage parallel output, even if it is reachable from low tensors.
const joined={id:34,type:"SaveVideo",inputs:[{link:14},{link:15}],outputs:[]};
nodes.push(joined);decode.outputs[0].links.push(14);nodes[0].outputs[0].links.push(15);
graph.links[14]={origin_id:31,origin_slot:0,target_id:34};
graph.links[15]={origin_id:13,origin_slot:0,target_id:34};
await functions.runBranch(nodes[0]);
assert.deepEqual(queued[2],["13","33"],"pause includes only the same LATENT's parallel native save");
handlers.executed({detail:{node:13,prompt_id:"canvas-3",output:{terrydirector_checkpoint:[{
  checkpoint_id:"c".repeat(32),mode:"paused",
}]}}});
handlers.execution_success({detail:{prompt_id:"canvas-3"}});
await functions.runBranch(nodes[0]);
assert.deepEqual(queued[3],["34","8","11"],"continue excludes native low save");
assert.deepEqual(alerts,[]);
assert.ok(!source.includes("TerryDirectorSelfLiftPauseResume"));
console.log("Generic pause UI: cache-only pause, arbitrary outputs, prompt lock and canvas ownership PASS");
