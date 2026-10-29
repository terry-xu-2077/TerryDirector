// Run: node tests/test_preview_create_controls.mjs
// CPU-only contract for the Preview Stage task creation controls.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../web/td_selflift_task_manager.js", import.meta.url), "utf8");
const stripImports = source.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"");
assert.doesNotThrow(() => new Function(stripImports));
const between = (start, end) => {
  const left = source.indexOf(start), right = source.indexOf(end, left);
  assert.ok(left >= 0 && right > left, `Missing source fragment: ${start}`);
  return source.slice(left, right);
};
const create = new Function("state","esc","assetCard",
  between("function createMarkup() {","function installCreatePromptEditor()") +
  "; return createMarkup;");
const state = {
  template:{workflow_name:"预演工作流"}, tasks:[],
  createDraft:{source:"template",name:"S1_E1",seed:"42",prompt:"",previewType:"sampling",assets:[]},
};
const html = () => create(state, x => String(x), () => "<asset/>")();
let rendered = html();
assert.ok(rendered.indexOf("新建任务名称") < rendered.indexOf("基于"));
assert.ok(rendered.includes('id="tdm-new-task-name"'));
assert.ok(rendered.includes('value="S1_E1"'));
assert.equal((rendered.match(/type="radio"/g) || []).length, 2);
assert.equal((rendered.match(/name="tdm-preview-type"/g) || []).length, 2);
assert.match(rendered,/value="sampling" checked/);
assert.ok(!rendered.includes('value="decoded" checked'));
state.createDraft.previewType = "decoded";
rendered = html();
assert.match(rendered,/value="decoded" checked/);
assert.ok(!rendered.includes('value="sampling" checked'));
assert.ok(rendered.includes('data-action="random-seed"'));
assert.ok(rendered.includes('aria-label="生成随机种子"'));
assert.ok(rendered.includes('id="tdm-new-task-seed"'));
assert.ok(!rendered.includes('data-action="set-preview"'));

const randomSnippet = between("// Non-negative 53-bit seed","function createMarkup() {");
const seedWithBits = (high,low) => new Function("globalThis",
  randomSnippet + "; return randomPreviewSeed;")({
    crypto:{getRandomValues(values){values[0]=high;values[1]=low;}},
  })();
assert.equal(seedWithBits(0,0),"0");
assert.equal(seedWithBits(0xffffffff,0xffffffff),String(Number.MAX_SAFE_INTEGER));
assert.equal(seedWithBits(0,17),"17");
assert.ok(source.includes('state.createDraft.seed = seed;'));
assert.ok(source.includes('if (input) input.value = seed;'));
assert.ok(source.includes('state.createDraft.previewType = control.value;'));
console.log("Preview Stage task name, radio preview and random seed controls: PASS");
