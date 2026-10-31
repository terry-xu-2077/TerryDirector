// Run: node tests/test_preview_final_flush.mjs
// Regression: KJNodes sends animated previews from an async worker. The final
// step may arrive just after execution_success; do not discard it.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const code=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const slice=(start,end)=>{
  const a=code.indexOf(start),b=code.indexOf(end,a);
  assert.ok(a>=0&&b>a,start);
  return code.slice(a,b);
};
assert.doesNotThrow(()=>new Function(code.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const helper=slice("async function waitForFinalTAEH3(job,promptId) {","async function savePreviewDiagnostic(");
let clock=0,ticks=0;
const DateMock={now:()=>clock};
const timeout=(fn,ms)=>{
  clock+=ms;ticks++;
  if(ticks===2)job.preview={step:6,total:6,image:"final",mime:"video/mp4"};
  fn();
};
const state={activePromptId:"p01"};
const wait=new Function("state","Date","setTimeout",helper+"return waitForFinalTAEH3;")(state,DateMock,timeout);
const job={mode:"pause",preview_type:"sampling",preview:{step:5,total:6}};
await wait(job,"p01");
assert.equal(job.preview.step,6,"Final step must be collected");
assert.equal(ticks,2,"Do not wait full timeout when final step arrives");
const queued={mode:"pause",preview_type:"sampling",preview:{step:1,total:8}};
ticks=0;clock=0;state.activePromptId="another_prompt";
await wait(queued,"p01");
assert.equal(ticks,0,"Do not stall newer queued prompts");
assert.ok(code.includes("job.finalizing=true"));
assert.ok(code.includes("(!job.busy&&!job.finalizing)"));
assert.ok(code.includes("await waitForFinalTAEH3(job,promptId)"));
assert.ok(code.includes("await savePreviewDiagnostic(job,"));
assert.ok(code.includes("job.previewSaveError="));
assert.ok(code.includes("previewDiagnostic"));
assert.ok(code.includes("preview_error:reason"));
console.log("TAEH3 final async preview drain + durable error: PASS");
