// Run: node tests/test_preview_readonly_sidebar.mjs
// Pure DOM-independent contract for the TerryDirector sidebar overview.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const file = await readFile(new URL("../web/td_selflift_task_manager.js", import.meta.url),"utf8");
const slice = (begin,end) => {
  const start=file.indexOf(begin), stop=file.indexOf(end,start);
  assert.ok(start>=0 && stop>start, "Missing "+begin);
  return file.slice(start,stop);
};
assert.ok(file.includes('const BRAND_MARK_URL = "/terrydirector/static/assets/mark.svg"'));
assert.ok(file.includes("render: el => mountPreviewSidebar(el)"));
assert.ok(file.includes("void refreshSidebarTasks()"));
assert.ok(file.includes('data-preview-sidebar-list'));
assert.ok(file.includes('aria-label="只读预演任务列表"'));
assert.ok(file.includes("renderSidebarTaskList();\n    state.selected ="));
assert.doesNotThrow(()=>new Function(file.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));

const esc = value => String(value??"").replace(/[&<>"']/g, char =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const count = {textContent:""}, holder = {innerHTML:""};
const state={
  tasks:[],
  sidebarRoot:{querySelector(selector){
    return selector.includes("sidebar-count")?count:holder;
  }},
};
const source=slice("const STATUS_NAMES=","const formatTime=")+"\n"+
  slice("function sidebarDate(","function thumb(task) {");
const {sidebarTaskMarkup,renderSidebarTaskList}=
  new Function("state","esc",source+"return {sidebarTaskMarkup,renderSidebarTaskList};")(state,esc);

renderSidebarTaskList();
assert.match(holder.innerHTML,/暂无预演任务/);
assert.equal(count.textContent,"0 个任务");

state.tasks=[
  {name:"镜头 S01",status:"low_pending",created_at:"2026-10-29T02:00:00Z"},
  {name:"<img src=x onerror=alert(1)>",status:"low_running",created_at:"2026-10-29T02:00:00Z",
   low_started_at:"2026-10-29T02:20:00Z"},
  {name:"镜头 S03",status:"low_complete",created_at:"2026-10-29T02:00:00Z",
   low_finished_at:"2026-10-29T02:40:00Z"},
  {name:"镜头 S04",status:"high_pending",created_at:"2026-10-29T02:00:00Z",queued_stage:"high"},
  {name:"镜头 S05",status:"high_running",created_at:"2026-10-29T02:00:00Z",
   high_started_at:"2026-10-29T03:10:00Z"},
  {name:"镜头 S06",status:"high_complete",created_at:"2026-10-29T02:00:00Z",
   high_finished_at:"2026-10-29T03:40:00Z"},
];
renderSidebarTaskList();
assert.equal(count.textContent,"6 个任务");
assert.equal((holder.innerHTML.match(/class="tdm-sidebar-entry"/g)||[]).length,6);
for (const status of ["低清待生成","低清生成中","低清完成",
                      "高清待生成","高清生成中","高清完成"])
  assert.ok(holder.innerHTML.includes(status),status);
assert.ok(holder.innerHTML.includes("排队"));
assert.ok(holder.innerHTML.includes("创建"));
assert.ok(holder.innerHTML.includes("高清完成"));
assert.ok(!holder.innerHTML.includes("<img src=x"));
assert.ok(!/<(?:button|input|select|textarea|a)\b/i.test(holder.innerHTML));
assert.ok(sidebarTaskMarkup(state.tasks[0]).includes("低清待生成"));
console.log("TerryDirector Preview Stage read-only branded sidebar overview: PASS");
