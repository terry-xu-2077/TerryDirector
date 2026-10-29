// Run: node tests/test_preview_rich_h3_contract.mjs
// Pure JS verification of vendored TerryXu rich-token syntax and serialization.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path,import.meta.url),"utf8");
const rich=await read("../web/td_h3_rich_text.js");
const menus=await read("../web/td_h3_shared_menus.js");
const adapter=await read("../web/td_preview_rich_editor.js");
const manager=await read("../web/td_selflift_task_manager.js");
const noImports=source=>source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")
  .replace(/\bexport\s+/gm,"");

// Compilation checks (dynamic imports are validated separately by source paths).
for(const source of [rich,menus,adapter,manager]){
  assert.doesNotThrow(()=>new Function(noImports(source)));
}
const api=new Function("app","Node",noImports(rich)+
  ";return {serializeH3RichText,H3_TOKEN_PATTERN,H3_CAMERA_COMMANDS};")(
  {ui:{settings:{getSettingValue:()=>"zh-CN"}}},{TEXT_NODE:3,ELEMENT_NODE:1}
);
const text=value=>({nodeType:3,nodeValue:value});
const token=raw=>({nodeType:1,tagName:"SPAN",dataset:{raw},childNodes:[]});
const br={nodeType:1,tagName:"BR",childNodes:[]};
const editor={childNodes:[
  text("镜头跟随 "), token("<Picture 1>"), text("，然后 "), token("The camera pushes in "),
  br,token("[Shot 2]"),text(" "),token("<d>[Chinese] 立即撤离</d>"),
]};
assert.equal(api.serializeH3RichText(editor),
  "镜头跟随 <Picture 1>，然后 The camera pushes in \n[Shot 2] <d>[Chinese] 立即撤离</d>");
const tags="summary:\n[Shot 1] <Picture 1> (S2) [00:13] <d>[Chinese] 你好</d> The camera moves in an arc around the subject ";
const matches=[...tags.matchAll(new RegExp(api.H3_TOKEN_PATTERN.source,api.H3_TOKEN_PATTERN.flags))].map(m=>m[0]);
for(const expected of ["summary:","[Shot 1]","<Picture 1>","(S2)","[00:13]",
                       "<d>[Chinese] 你好</d>","The camera moves in an arc around the subject "])
  assert.ok(matches.includes(expected),`Missing H3 token: ${expected}`);
assert.equal(api.H3_CAMERA_COMMANDS.length,20);
assert.ok(menus.includes('export function openH3AssetMenuForChip'));
assert.ok(menus.includes('export function attachH3Menus'));
assert.ok(menus.includes('data.lastIndexOf("\\\\")'));
assert.ok(adapter.includes('__terryH3MediaOptions:liveAssets'));
assert.ok(adapter.includes('bindH3TagInteractions(editor'));
assert.ok(manager.includes('class="tdm-prompt-editor tdm-h3-rich-editor"'));
assert.ok(manager.includes('data-action="toggle-prompt-mode"'));
console.log("Preview Stage complete TerryXu H3 rich editor contract: PASS");
