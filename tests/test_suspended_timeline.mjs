/* node --test tests/test_suspended_timeline.mjs
 * Visible muted clips stay in the ONE original preview row; only active clips
 * contribute video duration, loop index, output frames, and seekable time. */
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
const moduleSource = await fs.readFile(path.join(root, "web/td_timeline_projection.js"), "utf8");
const { effectiveClipLayout, previewClipLayout } = await import(
  "data:text/javascript;charset=utf-8," + encodeURIComponent(moduleSource)
);
const webSource = await fs.readFile(path.join(root, "web/terry_director.js"), "utf8");
const editorSource = await fs.readFile(path.join(root, "src/app.js"), "utf8");

function clip(id, start, end, suspended = false) {
  return { id, name: "镜头 " + id, start, end, suspended, seed: String(id) };
}

// 11 authored clips, 123.5 seconds on the creative timeline.
// Only three active clips produce 28.5 seconds of actual output.
let pos = 0;
const eleven = [156,240,288,240,240,360,288,288,288,288,288].map((duration,i) => {
  const item = clip(String(i+1),pos,pos+duration,i>=3);
  pos += duration;
  return item;
});
assert.equal(pos,2964);

function verifyProjection(input, ids, length) {
  const initial = JSON.stringify(input);
  const effective = effectiveClipLayout(input);
  assert.deepEqual(effective,C.effectiveClipLayout(input));
  assert.deepEqual(effective.map(c=>c.id),ids);
  assert.equal(effective.at(-1)?.end??0,length);
  assert.equal(JSON.stringify(input),initial,"must not mutate user-authored clips");
  return effective;
}

test("11 authored / 8 paused produces 3 clips and 28.5 real seconds",()=>{
  const layout = verifyProjection(eleven,["1","2","3"],684);
  assert.deepEqual(layout.map(c=>c.start),[0,156,396]);
});

test("leading paused clips are transparent to the generated timeline",()=>{
  const effective = verifyProjection([
    clip("s",0,100,true),clip("a",150,250),clip("b",275,325)
  ],["a","b"],175);
  assert.deepEqual(effective.map(c=>c.start),[0,125]);
});

test("consecutive interior suspensions join the prior active endpoint",()=>{
  const effective = verifyProjection([
    clip("a",0,100),clip("s1",100,240,true),
    clip("s2",240,350,true),clip("b",400,530)
  ],["a","b"],230);
  assert.equal(effective[1].start,100);
});

test("intentional active gaps and overlaps are preserved",()=>{
  verifyProjection([clip("a",0,120),clip("b",140,240)],["a","b"],240);
  verifyProjection([clip("a",0,120),clip("b",100,210)],["a","b"],210);
  const eff=verifyProjection([
    clip("a",0,120),clip("b",100,210),
    clip("s",210,330,true),clip("c",360,480)
  ],["a","b","c"],330);
  assert.equal(eff[2].start,210);
});

test("all suspended authoring clips produce zero real frames",()=>{
  verifyProjection([clip("a",0,240,true),clip("b",240,480,true)],[],0);
  verifyProjection([],[],0);
});

test("visual paused cards never add frames or shift video end position",()=>{
  const preview=previewClipLayout(eleven);
  assert.equal(preview.totalFrames,684);
  assert.equal(preview.entries.length,11);
  assert.equal(preview.suspendedCount,8);
  // The full source timeline spans 2964 frames; individual suspended
  // segments have different authored lengths (10, 12 and 15 seconds).
  assert.equal(preview.visualFrames,eleven.at(-1).end);
  for(const entry of preview.entries){
    const sourceFrames = entry.clip.end-entry.clip.start;
    assert.equal(entry.visualEnd-entry.visualStart,sourceFrames,
      "each paused clip must keep its original proportional length");
  }
  assert.equal(preview.entries[2].visualEnd,684);
  assert.equal(preview.entries[3].visualStart,684);
  assert.equal(preview.realToVisual(684),684);
  assert.equal(preview.visualToReal(preview.visualFrames),684);
  for(let frame=0;frame<=684;frame+=12)
    assert.equal(preview.visualToReal(preview.realToVisual(frame)),frame);
});

test("10s and 15s suspended segments retain the original 2:3 width ratio",()=>{
  const data=[clip("A",0,240),clip("10s",240,480,true),
    clip("15s",480,840,true),clip("B",840,1080)];
  const preview=previewClipLayout(data);
  assert.equal(preview.totalFrames,480);
  assert.equal(preview.visualFrames,1080);
  assert.equal(preview.entries[1].visualEnd-preview.entries[1].visualStart,240);
  assert.equal(preview.entries[2].visualEnd-preview.entries[2].visualStart,360);
  const ratio=(preview.entries[2].visualEnd-preview.entries[2].visualStart)/
    (preview.entries[1].visualEnd-preview.entries[1].visualStart);
  assert.equal(ratio,1.5);
  assert.equal(preview.visualToReal(preview.visualFrames),480);
});
test("suspended cards between active clips are contiguous display-only slots",()=>{
  const document=[
    clip("A",0,120),clip("S",120,180,true),clip("B",180,360),
    clip("T",360,480,true),clip("C",480,600)
  ];
  const preview=previewClipLayout(document);
  assert.deepEqual(preview.entries.map(x=>x.clip.id),["A","S","B","T","C"]);
  assert.equal(preview.entries[1].visualEnd,preview.entries[2].visualStart);
  assert.equal(preview.entries[3].visualEnd,preview.entries[4].visualStart);
  for(let frame=0;frame<=preview.totalFrames;frame+=5)
    assert.equal(preview.visualToReal(preview.realToVisual(frame)),frame);
});

test("leading and all-paused display states remain stable and seekable",()=>{
  const leading=previewClipLayout([clip("s",0,80,true),clip("a",80,180)]);
  assert.equal(leading.entries[0].visualEnd,leading.entries[1].visualStart);
  assert.equal(leading.visualToReal(0),0);
  assert.equal(leading.visualToReal(leading.realToVisual(0)),0);
  const all=previewClipLayout([clip("s1",0,100,true),clip("s2",100,200,true)]);
  assert.equal(all.totalFrames,0);
  assert.equal(all.entries.length,2);
  assert.equal(all.visualToReal(all.visualFrames),0);
});

function createNodeRenderer(){
  const opens=[];
  const start=webSource.indexOf("function miniRulerHtml(totalFrames,");
  const end=webSource.indexOf("function resolveVirtualOutputSource(",start);
  const first=webSource.indexOf("const ASSET_LABELS =");
  const last=webSource.indexOf("function clamp01(",first);
  assert.ok(start>=0&&end>start&&first>=0&&last>first);
  const context={
    opens, effectiveClipLayout, previewClipLayout, FPS:24,
    RUN_RUNNING:"running",RUN_COMPLETED:"completed",RUN_ERROR:"error",
    ADVANCED_NODE_CLASS:"TerryDirectorAdvanced",LOOP_NODE_CLASS:"TerryDirectorLooper",
    readConfig:node=>({document:node.doc}),ensureActivity:()=>({}),
    openEditor:(...args)=>opens.push(args),
    timelineTitleHtml:()=>"<span>时间线</span>",
    timeText:frames=>(frames/24)+"s",
    escapeHtml:value=>String(value).replace(/[&<>"']/g,c=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    })[c]),
    clamp01:value=>Math.max(0,Math.min(1,Number(value)||0)),
    queueMicrotask:()=>{},refreshLoopConditionCards:()=>{}
  };
  vm.runInNewContext(
    webSource.slice(first,last)+"\n"+webSource.slice(start,end)+
    "\nthis.__render={renderNode,timelineHtml,authoredAssetIds,bindSuspendedClipButtons,opens};",
    context
  );
  return context.__render;
}

test("LoopStart uses old single-row muted clip cards, correct 28.5s / 3",()=>{
  const render=createNodeRenderer();
  const root={innerHTML:"",querySelectorAll:()=>[]};
  render.renderNode({comfyClass:"TerryDirectorLooper",__tdRoot:root,doc:{clips:eleven,assets:[]}});
  const html=root.innerHTML;
  assert.match(html,/总时长：<b>28\.5<\/b>s/);
  assert.match(html,/片段数：<b>3<\/b>/);
  assert.equal((html.match(/<div class="td-mini-clip(?:\s|")/g)||[]).length,11);
  assert.equal((html.match(/class="td-mini-clip is-suspended"/g)||[]).length,8);
  assert.match(html,/td-mini-ruler-tick/);
  // First three segments occupy their original fraction of the 123.5s ruler.
  const first = html.match(/class="td-mini-clip" style="left:0%;width:([\d.]+)%/);
  assert.ok(first, "Original timeline card style must be restored");
  assert.ok(Math.abs(Number(first[1])-(156/2964*100))<0.001);
  assert.match(html,/片段 11/);
  assert.match(html,/镜头 11/);
  assert.doesNotMatch(html,/td-mini-suspended-strip/);
});

test("Base and LoopStart match; paused clips never affect used asset count",()=>{
  const render=createNodeRenderer();
  for(const comfyClass of ["TerryDirector","TerryDirectorLooper"]){
    const root={innerHTML:"",querySelectorAll:()=>[]};
    render.renderNode({comfyClass,__tdRoot:root,doc:{clips:eleven,assets:[]}});
    assert.equal((root.innerHTML.match(/class="td-mini-clip is-suspended"/g)||[]).length,8);
    assert.match(root.innerHTML,/片段数：<b>3<\/b>/);
  }
  const doc={
    clips:[
      {...clip("a",0,240),prompt:"<Picture 1>",useGlobalPrompt:false},
      {...clip("s",240,480,true),prompt:"<Picture 2>",useGlobalPrompt:true}
    ],
    assets:[{id:"a",kind:"image",number:1},{id:"b",kind:"image",number:2},
      {id:"c",kind:"image",number:3}],
    globalPrompt:"<Picture 3>",globalPromptMode:"user"
  };
  assert.deepEqual([...render.authoredAssetIds(doc)],["a"]);
  doc.clips[0].useGlobalPrompt=true;
  assert.deepEqual([...render.authoredAssetIds(doc)].sort(),["a","c"]);
});

test("all-suspended nodes keep both grey cards but show 0s / 0 active",()=>{
  const render=createNodeRenderer();
  const doc={clips:[clip("a",0,240,true),clip("b",240,480,true)],assets:[]};
  const root={innerHTML:"",querySelectorAll:()=>[]};
  render.renderNode({comfyClass:"TerryDirectorLooper",__tdRoot:root,doc});
  assert.match(root.innerHTML,/总时长：<b>0<\/b>s/);
  assert.match(root.innerHTML,/片段数：<b>0<\/b>/);
  assert.equal((root.innerHTML.match(/class="td-mini-clip is-suspended"/g)||[]).length,2);
});

test("clicking a paused clip opens editor on that exact authored ID",()=>{
  const render=createNodeRenderer(),callbacks=new Map();
  const button={dataset:{suspendedClip:"4"},addEventListener:(type,fn)=>callbacks.set(type,fn)};
  const root={innerHTML:"",querySelectorAll:selector=>selector==="[data-suspended-clip]"?[button]:[]};
  const node={comfyClass:"TerryDirectorLooper",__tdRoot:root,doc:{clips:eleven,assets:[]}};
  render.renderNode(node);
  let prevented=false,stopped=false;
  callbacks.get("click")({preventDefault:()=>{prevented=true},stopPropagation:()=>{stopped=true}});
  assert.equal(render.opens.length,1);
  assert.equal(render.opens[0][0],node);
  assert.equal(render.opens[0][2],"4");
  assert.ok(prevented&&stopped);
  assert.match(webSource,/documentData\.selected = selectedClipId/);
});

test("old suspended clip styles are restored and names are HTML escaped",async()=>{
  const render=createNodeRenderer();
  const html=render.timelineHtml({clips:[{...clip("bad",0,100,true),name:'<script>alert("x")</script>'}]});
  assert.match(html,/class="td-mini-clip is-suspended"/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/&lt;script&gt;/);
  assert.match(html,/&quot;x&quot;/);
  const css=await fs.readFile(path.join(root,"web/terry_director.css"),"utf8");
  assert.match(css,/\.td-node-shell-director \.td-mini-clip\.is-suspended/);
  assert.match(css,/\.td-node-shell-advanced \.td-adv-clip\.is-suspended/);
  assert.doesNotMatch(css,/\.td-mini-suspended-strip/);
});

test("Advanced maps paused geometry into cursor and seeks without second row",()=>{
  const section=webSource.slice(webSource.indexOf("function renderAdvancedNode(node) {"));
  assert.match(section,/const layout = previewClipLayout\(doc\.clips, clips\)/);
  assert.match(section,/const totalFrames = layout\.totalFrames/);
  assert.match(section,/const clipHtml = layout\.entries\.map/);
  assert.match(section,/const playheadPercent = seconds => layout\.percent\(layout\.realToVisual\(seconds \* FPS\)\)/);
  assert.match(section,/layout\.visualToReal\(fraction \* layout\.visualFrames\)/);
  assert.match(section,/bindSuspendedClipButtons\(node, root\)/);
  assert.match(section,/event\.target\.closest\("\[data-clip\], \[data-suspended-clip\]"\)/);
  assert.doesNotMatch(section,/suspendedClipsHtml/);
});

test("editor duration stays accurate while authoring all clips",()=>{
  const start=editorSource.indexOf("function renderTimelineDuration(clips){");
  const end=editorSource.indexOf("function renderClipDuration(",start);
  assert.ok(start>=0&&end>start);
  const output={textContent:"",title:"",setAttribute(){}};
  const context={C,$:()=>output};
  vm.runInNewContext(editorSource.slice(start,end)+"\nthis.__duration=renderTimelineDuration;",context);
  context.__duration(eleven);
  assert.equal(output.textContent,"00:00:28:12");
  assert.match(output.title,/挂起片段不计时/);
});
