// Run: node tests/test_preview_generated_prompts_modal.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
assert.doesNotThrow(()=>new Function(source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));

const begin=source.indexOf("function batchGeneratedPromptEntries() {");
const end=source.indexOf("function batchImportSummary() {",begin);
assert.ok(begin>=0&&end>begin);

const state={batchImport:{batches:[
 {name:"批次01｜场景一",generatedAssets:[
  {type:"image",name:"峡道母图",prompt:"一张 2.39:1 宽银幕镜头。\n阴影 <岩壁> & 远景。"},
  {type:"video",name:"载具运动",prompt:"低角度跟随，穿越隧道。"},
 ]},
 {name:"批次02｜场景二",generatedAssets:[
  {type:"audio",name:"环境声",prompt:"远处风声，近处水滴。"},
  {type:"image",name:"待补充",prompt:""},
 ]},
 {name:"批次03｜无待生成资产",generatedAssets:[]},
]}};
const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,
 char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
let copiedText="",fallbackText="",fallbackRemoved=false,fallbackCount=0;
const navigator={clipboard:{writeText:async text=>{copiedText=text;}}};
const document={
 body:{appendChild(element){fallbackText=element.value;}},
 createElement(name){
  assert.equal(name,"textarea");
  return {value:"",style:{},focus(){},select(){},
   remove(){fallbackRemoved=true;}};
 },
 execCommand(command){assert.equal(command,"copy");fallbackCount++;return true;},
};
const toasts=[];
const ui=new Function("state","esc","navigator","document","toast",
 source.slice(begin,end)+
 ";return {batchGeneratedPromptEntries,batchGeneratedPromptModalMarkup,copyBatchGeneratedPrompt,batchGeneratedMarkup};")(
 state,escapeHtml,navigator,document,(message,severity)=>toasts.push({message,severity}));

const entries=ui.batchGeneratedPromptEntries();
assert.equal(entries.length,4);
assert.deepEqual(entries.map(item=>item.name),["峡道母图","载具运动","环境声","待补充"]);
assert.deepEqual(entries.map(item=>item.batchName),
 ["批次01｜场景一","批次01｜场景一","批次02｜场景二","批次02｜场景二"]);
const markup=ui.batchGeneratedPromptModalMarkup();
assert.ok(markup.includes('role="dialog" aria-modal="true"'));
assert.ok(markup.includes("4 项 · 按批次顺序排列"));
assert.equal((markup.match(/class="tdm-batch-prompt-item"/g)||[]).length,4);
assert.equal((markup.match(/data-action="batch-generated-copy"/g)||[]).length,4);
assert.ok(markup.includes('data-action="batch-generated-copy" data-index="3" disabled'));
assert.ok(markup.includes('readonly spellcheck="false"'));
assert.ok(markup.includes("阴影 &lt;岩壁&gt; &amp; 远景"));
assert.ok(!markup.includes("<岩壁>"));
assert.ok(markup.includes('data-action="batch-generated-close"'));
assert.ok(markup.includes('aria-label="复制峡道母图的提示词"'));
assert.ok(markup.includes("<svg"));
assert.ok(markup.indexOf("批次01｜场景一")<markup.indexOf("批次02｜场景二"));
assert.ok(markup.indexOf("峡道母图")<markup.indexOf("载具运动"));
assert.ok(!ui.batchGeneratedMarkup().includes("峡道母图"),
 "prompts should only appear in the modal, not as duplicate inline cards");

assert.equal(await ui.copyBatchGeneratedPrompt(0),true);
assert.equal(copiedText,entries[0].prompt);
assert.deepEqual(toasts.at(-1),{message:"已复制：峡道母图",severity:"success"});
assert.equal(await ui.copyBatchGeneratedPrompt(3),false);
assert.equal(await ui.copyBatchGeneratedPrompt(99),false);

delete navigator.clipboard;
assert.equal(await ui.copyBatchGeneratedPrompt(1),true);
assert.equal(fallbackText,entries[1].prompt);
assert.equal(fallbackCount,1);
assert.equal(fallbackRemoved,true);

state.batchImport.batches=[];
const emptyMarkup=ui.batchGeneratedPromptModalMarkup();
assert.ok(emptyMarkup.includes("当前批量任务没有待生成资产提示词"));
assert.ok(!emptyMarkup.includes('data-action="batch-generated-copy"'));

const batchMarkupStart=source.indexOf("function batchImportMarkup() {");
const batchMarkupEnd=source.indexOf("function batchPromptImportMarkup()",batchMarkupStart);
const batchSection=source.slice(batchMarkupStart,batchMarkupEnd);
assert.ok(batchSection.includes('data-action="batch-generated-open"'));
assert.ok(batchSection.includes("查看待生成资产提示词"));
assert.ok(!batchSection.includes("data-batch-current-name"));
assert.ok(source.includes('state.batchImport?.generatedPromptsOpen ? batchGeneratedPromptModalMarkup() : ""'));
assert.ok(source.includes('action === "batch-generated-open"'));
assert.ok(source.includes('action === "batch-generated-close"'));
assert.ok(source.includes('action === "batch-generated-copy"'));
assert.ok(source.includes(".tdm-batch-prompt-copy{position:absolute;top:9px;right:9px;"));
console.log("Preview Stage generated prompt modal, per-item copy, and fallback: PASS");
