/* Run: node --test tests/test_suspended_timeline.mjs
 * Suspended clips disappear from preview, timings and effective indices, but
 * remain untouched in the editable source document for later restoration. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const require = createRequire(import.meta.url);
const C = require("../src/core.js");
const projectionSource = await fs.readFile(path.join(root, "web/td_timeline_projection.js"), "utf8");
const { effectiveClipLayout } = await import(
  "data:text/javascript;charset=utf-8," + encodeURIComponent(projectionSource)
);
const webSource = await fs.readFile(path.join(root, "web/terry_director.js"), "utf8");
const editorSource = await fs.readFile(path.join(root, "src/app.js"), "utf8");

function clip(id, start, end, suspended = false) {
  return { id, name: "镜头 " + id, start, end, suspended, seed: String(id) };
}

// The original 11-clip case: only the first three (6.5s + 10s + 12s)
// are active; the authored timeline is still 123.5 seconds.
const durations = [156, 240, 288, 240, 240, 360, 288, 288, 288, 288, 288];
let pos = 0;
const eleven = durations.map((frames, index) => {
  const result = clip(String(index + 1), pos, pos + frames, index >= 3);
  pos += frames;
  return result;
});
assert.equal(pos, 2964);

function assertProjection(source, expectedIds, expectedFrames) {
  const original = JSON.stringify(source);
  const fromWeb = effectiveClipLayout(source);
  const fromEditor = C.effectiveClipLayout(source);
  assert.deepEqual(fromWeb, fromEditor);
  assert.deepEqual(fromWeb.map(item => item.id), expectedIds);
  assert.equal(fromWeb.at(-1)?.end ?? 0, expectedFrames);
  assert.equal(JSON.stringify(source), original, "the editor document must not be changed");
  return fromWeb;
}

test("eleven authored clips with eight suspended display 28.5s / 3 clips", () => {
  const effective = assertProjection(eleven, ["1", "2", "3"], 684);
  assert.deepEqual(effective.map(item => item.start), [0, 156, 396]);
  assert.equal(eleven.at(-1).end, 2964);
});

test("an interior suspended segment joins the next active clip without gap", () => {
  const items = [
    clip("a", 0, 100),
    clip("s1", 100, 240, true),
    clip("s2", 240, 350, true),
    clip("b", 400, 530),
  ];
  const layout = assertProjection(items, ["a", "b"], 230);
  assert.equal(layout[1].start, 100);
});

test("suspending the leading segment removes leading empty time", () => {
  const layout = assertProjection([
    clip("s", 0, 100, true), clip("a", 150, 250), clip("b", 275, 325)
  ], ["a", "b"], 175);
  assert.deepEqual(layout.map(item => item.start), [0, 125]);
});

test("normal active gaps and overlaps survive without adding fake gaps", () => {
  assertProjection([
    clip("a", 0, 120), clip("b", 140, 240)
  ], ["a", "b"], 240);
  assertProjection([
    clip("a", 0, 120), clip("b", 100, 210)
  ], ["a", "b"], 210);
  const middle = assertProjection([
    clip("a", 0, 120), clip("b", 100, 210),
    clip("s", 210, 330, true), clip("c", 360, 480)
  ], ["a", "b", "c"], 330);
  assert.equal(middle[2].start, 210);
});

test("all suspended clips give zero frames and no active clip", () => {
  assertProjection([clip("a", 0, 240, true), clip("b", 240, 480, true)], [], 0);
  assertProjection([], [], 0);
});

function createNodeRenderer() {
  const start = webSource.indexOf("function miniRulerHtml(totalFrames) {");
  const end = webSource.indexOf("function resolveVirtualOutputSource(", start);
  assert.ok(start >= 0 && end > start);
  const first = webSource.indexOf("const ASSET_LABELS =");
  const last = webSource.indexOf("function clamp01(", first);
  assert.ok(first >= 0 && last > first);
  const context = {
    effectiveClipLayout, FPS: 24,
    RUN_RUNNING: "running", RUN_COMPLETED: "completed", RUN_ERROR: "error",
    ADVANCED_NODE_CLASS: "TerryDirectorAdvanced", LOOP_NODE_CLASS: "TerryDirectorLooper",
    readConfig: node => ({ document: node.doc }),
    ensureActivity: () => ({}),
    timelineTitleHtml: () => "<span>时间线</span>",
    timeText: frames => (frames / 24) + "s",
    escapeHtml: value => String(value).replaceAll("<", "&lt;"),
    clamp01: value => Math.max(0, Math.min(1, Number(value) || 0)),
    queueMicrotask: () => {},
    refreshLoopConditionCards: () => {},
  };
  vm.runInNewContext(
    webSource.slice(first, last) + "\n" +
    webSource.slice(start, end) +
    "\nthis.__renderer = {renderNode, timelineHtml, authoredAssetIds};",
    context
  );
  return context.__renderer;
}

test("Looper node stats and cards reflect only 3 active clips", () => {
  const render = createNodeRenderer();
  const root = { innerHTML: "", querySelectorAll: () => [] };
  render.renderNode({ comfyClass: "TerryDirectorLooper", __tdRoot: root, doc: {
    clips: eleven, assets: []
  } });
  assert.match(root.innerHTML, /总时长：<b>28\.5<\/b>s/);
  assert.match(root.innerHTML, /片段数：<b>3<\/b>/);
  assert.equal((root.innerHTML.match(/<div class="td-mini-clip(?:\s|")/g) || []).length, 3);
  assert.doesNotMatch(root.innerHTML, /镜头 11/);
  assert.match(root.innerHTML, /片段 3/);
  assert.doesNotMatch(root.innerHTML, /片段 11/);
});

test("base node and LoopStart share the same effective preview", () => {
  const render = createNodeRenderer();
  const html = [];
  for (const comfyClass of ["TerryDirector", "TerryDirectorLooper"]) {
    const root = { innerHTML: "", querySelectorAll: () => [] };
    render.renderNode({ comfyClass, __tdRoot: root, doc: { clips: eleven, assets: [] } });
    html.push(root.innerHTML);
  }
  assert.match(html[0], /片段数：<b>3<\/b>/);
  assert.match(html[1], /片段数：<b>3<\/b>/);
  assert.equal(
    (html[0].match(/<div class="td-mini-clip(?:\s|")/g) || []).length,
    (html[1].match(/<div class="td-mini-clip(?:\s|")/g) || []).length
  );
});

test("assets referenced solely by suspended clips are not counted as in use", () => {
  const { authoredAssetIds } = createNodeRenderer();
  const doc = {
    clips: [
      { ...clip("a", 0, 240), prompt: "<Picture 1>", useGlobalPrompt: false },
      { ...clip("s", 240, 480, true), prompt: "<Picture 2>", useGlobalPrompt: true },
    ],
    assets: [
      {id:"a",kind:"image",number:1},{id:"b",kind:"image",number:2},
      {id:"c",kind:"image",number:3}
    ],
    globalPrompt: "<Picture 3>", globalPromptMode:"user",
  };
  assert.deepEqual([...authoredAssetIds(doc)], ["a"]);
  doc.clips[0].useGlobalPrompt = true;
  assert.deepEqual([...authoredAssetIds(doc)].sort(), ["a","c"]);
});

test("when every clip is suspended the mini-preview offers recovery", () => {
  const html = createNodeRenderer().timelineHtml({
    clips:[clip("a", 0, 240, true),clip("b", 240, 480, true)]
  });
  assert.match(html,/所有片段均已挂起/);
  assert.doesNotMatch(html, /td-mini-clip-meta/);
});

test("editor total uses actual generated duration without hiding editable clips", () => {
  const start = editorSource.indexOf("function renderTimelineDuration(clips){");
  const end = editorSource.indexOf("function renderClipDuration(", start);
  assert.ok(start >= 0 && end > start);
  const output = { textContent: "", title: "", setAttribute(){} };
  const context = { C, $: () => output };
  vm.runInNewContext(
    editorSource.slice(start, end) + "\nthis.__duration=renderTimelineDuration;",
    context
  );
  context.__duration(eleven);
  assert.equal(output.textContent, "00:00:28:12");
  assert.match(output.title, /挂起片段不计时/);
});

test("Advanced uses effective geometry rather than raw authored clip heads", () => {
  const section = webSource.slice(webSource.indexOf("function renderAdvancedNode(node) {"));
  assert.match(section, /const clips = effectiveClipLayout\(doc\.clips\)/);
  assert.match(section, /const totalFrames = clips\.at\(-1\)\?\.end \|\| 0/);
  assert.match(section, /state\.time = Math\.max\(0, Math\.min\(totalSeconds,/);
});
