// Run: node tests/test_preview_scroll_position.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
assert.doesNotThrow(()=>new Function(source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));

const helperStart=source.indexOf("function captureRenderScrollPositions(root) {");
const helperEnd=source.indexOf("function render() {",helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart);
const helpers=new Function(source.slice(helperStart,helperEnd)+
  ";return {captureRenderScrollPositions,restoreRenderScrollPositions};")();

const oldElements=[
  {dataset:{scrollPreserve:"task-list"},scrollTop:428,scrollLeft:0},
  {dataset:{scrollPreserve:"batch-list"},scrollTop:692,scrollLeft:0},
];
let currentElements=oldElements;
const root={querySelectorAll:selector=>{
  assert.equal(selector,"[data-scroll-preserve]");
  return currentElements;
}};
const saved=helpers.captureRenderScrollPositions(root);
assert.deepEqual(saved,[
  {key:"task-list",top:428,left:0},
  {key:"batch-list",top:692,left:0},
]);

currentElements=[
  {dataset:{scrollPreserve:"batch-list"},scrollTop:0,scrollLeft:0},
  {dataset:{scrollPreserve:"task-list"},scrollTop:0,scrollLeft:0},
];
helpers.restoreRenderScrollPositions(root,saved);
assert.equal(currentElements[0].scrollTop,692);
assert.equal(currentElements[1].scrollTop,428);

oldElements[0].scrollLeft=36;
const horizontal=helpers.captureRenderScrollPositions({querySelectorAll:()=>oldElements});
const replacement=[{dataset:{scrollPreserve:"task-list"},scrollTop:0,scrollLeft:0}];
helpers.restoreRenderScrollPositions({querySelectorAll:()=>replacement},horizontal);
assert.equal(replacement[0].scrollLeft,36);

helpers.restoreRenderScrollPositions({querySelectorAll:()=>[]},saved);
helpers.restoreRenderScrollPositions(null,saved);

assert.ok(source.includes('class="tdm-left" data-scroll-preserve="task-list"'));
assert.ok(source.includes('class="tdm-batch-list" data-scroll-preserve="batch-list"'));
const renderStart=source.indexOf("function render() {");
const renderEnd=source.indexOf("function showDeleteConfirmation()",renderStart);
const renderSource=source.slice(renderStart,renderEnd);
const innerHTMLIndex=renderSource.indexOf("state.root.innerHTML =");
const restoreIndex=renderSource.indexOf("restoreRenderScrollPositions(state.root,scrollPositions)");
assert.ok(renderSource.includes("captureRenderScrollPositions(state.root)"));
assert.ok(innerHTMLIndex>=0&&restoreIndex>innerHTMLIndex);

console.log("Preview Stage task-list and batch-list scroll position preservation: PASS");
