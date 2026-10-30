// Run: node tests/test_preview_create_controls.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const parameters=await readFile(new URL("../web/td_preview_task_parameters.js",import.meta.url),"utf8");
const mod=await import("data:text/javascript;base64,"+Buffer.from(parameters).toString("base64"));
assert.doesNotThrow(()=>new Function(source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));
const begin=source.indexOf("function createMarkup() {"),end=source.indexOf("function installCreatePromptEditor()",begin);
assert.ok(begin>=0 && end>begin);
const create=new Function("state","esc","assetCard","PREVIEW_RESOLUTION_OPTIONS",
  "taskAspectRatio","taskResolutionInfo",source.slice(begin,end)+";return createMarkup;");
const state={template:{workflow_name:"预演工作流"},tasks:[],
 createDraft:{source:"template",name:"S1_E1",seed:"42",prompt:"",previewType:"sampling",
 duration_seconds:15,highres_megapixels:0.8,assets:[],api_prompt:{}}};
const html=()=>create(state,x=>String(x),()=>"<asset/>",mod.PREVIEW_RESOLUTION_OPTIONS,
 mod.taskAspectRatio,mod.taskResolutionInfo)();
let rendered=html();
assert.ok(rendered.indexOf("新建任务名称")<rendered.indexOf("基于"));
assert.ok(rendered.includes('id="tdm-new-task-name"'));
assert.equal((rendered.match(/tdm-inline-field/g)||[]).length,6);
assert.equal((rendered.match(/type="radio"/g)||[]).length,2);
assert.match(rendered,/value="sampling" checked/);
assert.ok(!rendered.includes('value="decoded" checked'));
assert.ok(rendered.includes('id="tdm-new-task-duration"') || rendered.includes('id="tdm-task-duration"'));
assert.ok(rendered.includes('min="4" max="20" step="1"'));
assert.ok(rendered.includes('value="15"'));
assert.ok(rendered.includes('data-action="task-resolution"'));
assert.ok(rendered.includes("0.20 MP 低清"));
assert.ok(rendered.indexOf("预览视频")>rendered.indexOf("高清分辨率"));
state.createDraft.previewType="decoded";
rendered=html();
assert.match(rendered,/value="decoded" checked/);
assert.ok(!rendered.includes('value="sampling" checked'));
assert.ok(rendered.includes('data-action="random-seed"'));
assert.ok(source.includes('data-action="batch-create"'));
assert.ok(source.includes('data-action="batch-submit"'));
assert.ok(source.includes("function batchImportMarkup()"));
assert.ok(source.includes("matchingAssets(state.template.workflow)"));
assert.ok(rendered.includes('aria-label="生成随机种子"'));
assert.ok(source.includes('state.createDraft.duration_seconds=seconds;'));
assert.ok(source.includes('state.createDraft.highres_megapixels=Number(control.value);'));
console.log("Preview Stage inline create controls, duration/resolution and preview selection: PASS");
