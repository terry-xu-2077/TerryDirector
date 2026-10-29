/** TerryDirector SelfLift task manager — plain DOM, no React, no sampler fork. */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
  compilePreviewTargets, resolvePreviewSeedBounds, buildPreviewJob,
  validatePreviewSeed, randomPreviewSeed,
} from "./td_preview_job_compiler.js";
import { attachPreviewRichEditor, closePreviewRichEditor } from "./td_preview_rich_editor.js";
import { listPreviewInputCandidates } from "./td_preview_input_candidates.js";

const START_CLASS = "TerryDirectorSelfLiftPauseResume";
const KJ_CLASS = "ModelPreviewOverrideKJ";
const URL_BASE = "/terrydirector/api/selflift";
// Same mark URL as the TerryDirector timeline node and timeline editor.
const BRAND_MARK_URL = "/terrydirector/static/assets/mark.svg";
const state = {
  tasks: [], selected: new Set(), focused: null, preview: "sampling",
  busy: false, root: null, creating: false, configuring: false, deleting: null,
  template: null, templates: [], defaultTemplateId: null, configSelectedId: null,
  configError: "", configSaving: false, configDraft: null, createDraft: null, editDraftId: null,
  assetPicker: null, inputFiles: [],
  templateName: "当前画布", jobs: new Map(), activePromptId: null,
  sidebarRoot: null, sidebarPoll: null, sidebarFetching: false,
};
const esc = x => String(x ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nodeType = n => n?.comfyClass || n?.type;
const nodes = () => app.graph?._nodes || [];
const widget = (n, name) => n?.widgets?.find(w => w.name === name);
const getPauseNodes = () => nodes().filter(n => nodeType(n) === START_CLASS);
const getPreviewNodes = () => nodes().filter(n => nodeType(n) === KJ_CLASS);
function previewForPause(pause) {
  const links = app.graph?.links || {};
  const clean = pause?.inputs?.find(x => x.name === "low_clean");
  const samplerLink = clean?.link == null ? null : links[clean.link];
  const sampler = samplerLink && app.graph?.getNodeById?.(samplerLink.origin_id);
  const visited = new Set();
  function find(node, depth = 0) {
    if (!node || depth > 8 || visited.has(String(node.id))) return null;
    visited.add(String(node.id));
    if (nodeType(node) === KJ_CLASS) return node;
    for (const input of node.inputs || []) {
      if (!/model/i.test(input.name) || input.link == null) continue;
      const link = links[input.link];
      const origin = link && app.graph?.getNodeById?.(link.origin_id);
      const found = find(origin, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return find(sampler) || (getPreviewNodes().length === 1 ? getPreviewNodes()[0] : null);
}
const mediaUrl = (id, kind) => URL_BASE + "/tasks/" + encodeURIComponent(id) + "/media/" + kind;
function toast(message, severity = "info") {
  if (app.extensionManager?.toast?.add) app.extensionManager.toast.add({
    severity, summary: "TerryDirector · 预演台", detail: message, life: 5500,
  });
  else if (severity === "error") window.alert(message);
}
async function request(path, options = {}) {
  const response = await api.fetchApi(URL_BASE + path, options);
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "任务请求失败");
  return value;
}
function styles() {
  if (document.getElementById("td-selflift-tasks-style")) return;
  const st = document.createElement("style");
  st.id = "td-selflift-tasks-style";
  st.textContent = `
.tdm-back{position:fixed;inset:0;background:rgba(0,0,0,.73);z-index:100020;
 display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;color:#e4e7ee}
.tdm-shell{width:min(1190px,94vw);height:min(830px,90vh);background:#191b20;border:1px solid #373b43;
 box-shadow:0 22px 70px #0009;border-radius:13px;display:flex;flex-direction:column;overflow:hidden}
.tdm-head{display:flex;align-items:center;gap:12px;padding:17px 20px;border-bottom:1px solid #30343b}
.tdm-head h2{font-size:17px;margin:0;letter-spacing:.2px}.tdm-tag{font-size:11px;color:#929aa8}
.tdm-space{flex:1}.tdm-btn{background:#30343c;color:#e7eaf0;border:1px solid #454a54;border-radius:7px;
 padding:8px 12px;cursor:pointer;white-space:nowrap}.tdm-btn:hover{background:#414752}
.tdm-btn.primary{background:#2e70d3;border-color:#377ddf;color:white}.tdm-btn.primary:hover{background:#4385e8}
.tdm-btn:disabled{opacity:.4;cursor:default}.tdm-btn.close{font-size:21px;padding:2px 9px;border:0;background:transparent}
.tdm-btn.danger{color:#e6b6b5;border-color:#6b4345;background:#362629}
.tdm-btn.danger:not(:disabled):hover{background:#502b30;border-color:#b26168}
.tdm-warning{border:1px solid #754b50;border-radius:8px;background:#36272b;padding:11px 13px;color:#efc2c2;font-size:12px;line-height:1.7}
.tdm-delete-summary{max-height:110px;overflow:auto;padding:10px 12px;border:1px solid #3f454f;border-radius:6px;color:#aab3c0;font-size:12px}
.tdm-main{min-height:0;flex:1;display:grid;grid-template-columns:minmax(410px,1fr) minmax(335px,44%)}
.tdm-left{min-height:0;overflow:auto;border-right:1px solid #30343b}
.tdm-toolbar{position:sticky;top:0;background:#191b20;z-index:2;padding:12px 14px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #282b32}
.tdm-list{padding:8px 12px}.tdm-card{display:grid;grid-template-columns:25px 128px 1fr;gap:10px;
 border:1px solid transparent;border-radius:8px;padding:9px;cursor:pointer;align-items:center}
.tdm-card:hover{background:#22262d}.tdm-card.active{border-color:#4b76b2;background:#222d3e}
.tdm-thumb{width:128px;height:78px;object-fit:cover;border-radius:5px;background:#101216;border:1px solid #353943}
.tdm-card h3{margin:0 0 7px;font-size:13px;font-weight:650}.tdm-small{font-size:11px;color:#9299a5;line-height:1.6}
.tdm-card input[type=checkbox]{accent-color:#5d9eff;width:15px;height:15px}
.tdm-status{font-weight:600;font-size:11px;padding:3px 7px;border:1px solid #485363;border-radius:5px;
 display:inline-flex;align-items:center;gap:4px;color:#b9c5d4;margin:2px 0 6px}
.tdm-status.low_running,.tdm-status.high_running{color:#b6dbff;border-color:#356da4}
.tdm-status.low_complete,.tdm-status.high_complete{color:#bde8c6;border-color:#467b50}
.tdm-status.high_pending{color:#e6d1a6;border-color:#756246}
.tdm-timing{font-size:11px;color:#a5b0be;line-height:1.8}
.tdm-timing strong{color:#d6dce6;font-weight:500}
.tdm-detail-pending{padding:18px;background:#11151b;border:1px dashed #414a57;border-radius:8px;
 color:#a4b1c1;line-height:1.7;min-height:140px}
.tdm-right{min-width:0;min-height:0;display:flex;flex-direction:column;padding:16px;gap:12px}
.tdm-tabs{display:flex;gap:5px}.tdm-tabs button{border:1px solid #414650;background:#252830;color:#9ba4b2;
 border-radius:6px;padding:7px 10px;cursor:pointer}.tdm-tabs button.on{background:#344d6e;color:#f2f7ff;border-color:#527cac}
.tdm-player{width:100%;aspect-ratio:16/9;background:#0b0d11;border-radius:8px;object-fit:contain;max-height:52vh}
.tdm-live-media{position:relative;width:100%;min-width:0}
.tdm-live-caption{font-size:11px;color:#9ccaff;margin:4px 2px 0;line-height:1.6}
.tdm-live-media video{display:block}
.tdm-playback-message{font-size:11px;color:#e4b0a5;margin:6px 2px 0}
.tdm-replay-control{font-size:11px;padding:5px 10px;margin-left:auto}
.tdm-no-media{height:100%;display:grid;place-items:center;color:#78818f;text-align:center;padding:20px}
.tdm-detail{font-size:12px;color:#a7afbb;line-height:1.9}.tdm-actions{display:flex;gap:8px;flex-wrap:wrap}
.tdm-foot{padding:12px 20px;border-top:1px solid #30343b;display:flex;align-items:center;gap:12px}
.tdm-dialog{position:fixed;inset:0;z-index:100030;display:grid;place-items:center;background:rgba(0,0,0,.76);padding:20px;box-sizing:border-box}
.tdm-form{width:min(740px,92vw);max-height:calc(100vh - 48px);overflow:auto;overscroll-behavior:contain;background:#202329;border:1px solid #454b55;
 border-radius:12px;padding:22px;box-shadow:0 25px 90px #000c}
.tdm-form h2{margin:0 0 16px;font-size:17px}.tdm-field{display:flex;flex-direction:column;gap:6px;margin:10px 0}
.tdm-field label{font-size:12px;color:#aeb6c3}.tdm-field input,.tdm-field select,.tdm-field textarea{
 background:#15171b;border:1px solid #434954;color:#eef0f5;padding:9px;border-radius:6px;font:13px system-ui;
 width:100%;box-sizing:border-box}.tdm-field textarea{min-height:90px;resize:vertical}
.tdm-section{margin:18px 0 8px;padding:9px 0;border-bottom:1px solid #454b55;color:#a8c6ec;font-weight:650}
.tdm-form-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:17px}
.tdm-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:8px}
.tdm-asset{border:1px solid #434a54;background:#1b1e24;border-radius:7px;cursor:pointer;padding:5px;
 text-align:left;color:#cdd5e0;min-width:0;position:relative}
.tdm-asset:hover{border-color:#6399d5;background:#272d36}
.tdm-asset img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:4px;background:#101319}
.tdm-asset .tdm-noimg{display:grid;place-items:center;width:100%;aspect-ratio:4/3;background:#151920;border-radius:4px;color:#8c96a5}
.tdm-asset label{display:block;margin:5px 2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;cursor:pointer}
.tdm-asset .tdm-chip{position:absolute;top:9px;left:9px;background:#13161bc9;color:#cfe4ff;padding:2px 5px;border-radius:4px;font-size:10px}
.tdm-asset-picker{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;max-height:46vh;overflow:auto;padding:8px 0}
.tdm-pillset{display:flex;gap:7px;margin-top:7px}
.tdm-pillset button{flex:1;text-align:center;padding:12px 10px;border:1px solid #4c5360;border-radius:8px;
 background:#242931;color:#b7bfcb;cursor:pointer}
.tdm-pillset button.on{border-color:#5799ed;background:#263b58;color:#eef6ff}
.tdm-form input[type=checkbox]{width:auto}
.tdm-dialog h2{margin:0}
.tdm-modal-top{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.tdm-modal-top .tdm-space{flex:1}
.tdm-modal-sub{font-size:11px;color:#93a0b2;margin:8px 0}
.tdm-form.tdm-config{width:min(860px,94vw);padding:0;max-height:min(700px,90vh);overflow:hidden}
.tdm-config-header{padding:17px 20px 14px;border-bottom:1px solid #363a43;display:flex;align-items:center;gap:12px}
.tdm-config-header h2{margin:0;font-size:16px}
.tdm-config-layout{display:grid;grid-template-columns:260px minmax(0,1fr);max-height:calc(min(700px,90vh) - 65px)}
.tdm-config-sidebar{border-right:1px solid #353b45;background:#1a1d22;display:flex;flex-direction:column;min-height:0}
.tdm-config-list{min-height:0;overflow:auto;flex:1;padding:9px}
.tdm-config-entry{width:100%;border:1px solid transparent;background:transparent;color:#d1d7df;text-align:left;
 border-radius:7px;display:flex;flex-direction:column;gap:5px;padding:11px;cursor:pointer;font:13px system-ui}
.tdm-config-entry small{font-size:10px;color:#8793a2}
.tdm-config-entry.active{background:#28384e;border-color:#4a7bad}
.tdm-config-entry:hover{background:#303943}
.tdm-config-sidebar-footer{display:grid;gap:7px;padding:11px;border-top:1px solid #363a43}
.tdm-config-editor{padding:15px 20px 18px;overflow:auto;min-height:0}
.tdm-config-editor .tdm-field{margin:9px 0}
.tdm-config-editor .tdm-form-actions{margin-top:16px}
.tdm-config-error{border:1px solid #a65c5c;background:#372729;color:#ffc1be;border-radius:6px;
 padding:10px 12px;line-height:1.6;font-size:12px;margin:10px 0;white-space:pre-wrap}
@media(max-width:680px){.tdm-config-layout{grid-template-columns:155px minmax(0,1fr)}
 .tdm-form.tdm-config{max-height:94vh}.tdm-config-editor{padding:12px}}

.tdm-blank{color:#87919e;padding:38px 18px;text-align:center}.tdm-select-note{font-size:11px;color:#87919e}
/* A writing surface first: full-height prompt to the left, reference assets to the right. */
.tdm-form.tdm-create{width:min(1380px,96vw);height:min(880px,94vh);max-height:94vh;
 padding:0;display:flex;flex-direction:column;overflow:hidden}
.tdm-create-head{padding:20px 54px 14px 22px;border-bottom:1px solid #353a43;flex:none;position:relative}
.tdm-create-head .tdm-create-close{position:absolute;right:15px;top:13px}
.tdm-create-meta{display:grid;grid-template-columns:minmax(220px,.9fr) minmax(320px,1.35fr);
 gap:16px;align-items:end}
.tdm-create-meta .tdm-field{margin:0}
.tdm-create-meta .tdm-name-label{font-size:14px;font-weight:700;color:#e5ebf5}
.tdm-create-content{flex:1;min-height:0;overflow:hidden;padding:16px 22px}
.tdm-create-columns{display:grid;grid-template-columns:minmax(440px,1.4fr) minmax(300px,1fr);
 height:100%;min-height:0;column-gap:18px}
.tdm-create-left{display:flex;flex-direction:column;min-height:0;min-width:0}
.tdm-create-right{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;
 border-left:1px solid #353a43;padding-left:18px}
.tdm-create .tdm-section{margin:0 0 10px;padding:4px 0 10px;flex:none}
.tdm-create .tdm-field{margin:0}
.tdm-create .tdm-prompt-wrap{flex:1;display:flex;flex-direction:column;min-height:0;position:relative}
.tdm-create .tdm-prompt-editor{display:block;min-height:220px;flex:1;width:100%;resize:none;
 font:14px/1.68 "Segoe UI","Microsoft Yahei",system-ui,sans-serif;background:#14171c;
 color:#e4e9f1;border:1px solid #414955;border-radius:7px;padding:14px 15px;
 box-sizing:border-box;white-space:pre-wrap;overflow:auto;tab-size:4}
.tdm-create .tdm-prompt-editor:focus{outline:none;border-color:#6394d1}
.tdm-create .tdm-h3-rich-editor{white-space:pre-wrap;overflow-wrap:anywhere;cursor:text;outline:none}
.tdm-create .tdm-h3-rich-editor:empty:before{content:attr(data-placeholder);color:#788391;pointer-events:none}
.tdm-create .tdm-h3-rich-editor .terry-h3-chip{font-family:system-ui,sans-serif}
/* Full TerryXu chip pickers are portaled to <body>: place above the modal. */
.terry-h3-number-picker{z-index:2147483000!important}
.tdm-create .tdm-h3-rich-editor[data-mode="raw"]{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
 white-space:pre-wrap;tab-size:2}
.tdm-create .tdm-section-head{display:flex;justify-content:space-between;align-items:center;
 border-bottom:1px solid #454b55;padding-bottom:8px;margin-bottom:10px}
.tdm-create .tdm-section-head .tdm-section{margin:0;border:0;padding:0}
.tdm-create .tdm-mode-btn{padding:5px 10px;font-size:11px}
.tdm-prompt-hint{display:flex;gap:13px;color:#8c9aaa;font-size:11px;padding:8px 2px 10px;flex:none}
.tdm-prompt-hint b{color:#b1cce9;font-weight:600}
.tdm-create-bottom{display:grid;grid-template-columns:minmax(170px,.85fr) minmax(260px,1.5fr);
 gap:14px;align-items:end;flex:none;padding-top:8px}
.tdm-seed-row{display:flex;gap:6px;align-items:stretch}
.tdm-seed-row input{flex:1;min-width:0}
.tdm-seed-random{flex:none;min-width:40px;padding:6px 10px;font-size:18px;line-height:1.15;
 display:grid;place-items:center}
.tdm-preview-radios{display:flex;gap:14px;align-items:center;min-height:38px;flex-wrap:wrap}
.tdm-preview-radio{display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap;
 font-size:12px;color:#b7bfcb;user-select:none}
.tdm-preview-radio:has(input:checked){color:#edf4ff}
.tdm-preview-radio input{width:16px!important;height:16px!important;margin:0;accent-color:#619ff1;
 cursor:pointer}
.tdm-preview-radio input:focus-visible{outline:2px solid #9dc7fa;outline-offset:3px}
.tdm-create .tdm-assets{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:9px}
.tdm-create .tdm-asset{padding:6px}
.tdm-create .tdm-asset label{font-size:11px}
.tdm-create-foot{display:flex;align-items:center;gap:12px;padding:12px 22px 14px;
 border-top:1px solid #353a43;flex:none}
.tdm-create-foot .tdm-small{max-width:65%}

/* ComfyUI sidebar: a read-only overview, not a second task editor. */
.tdm-sidebar{box-sizing:border-box;display:flex;flex-direction:column;min-height:0;
 height:100%;width:100%;overflow:hidden;padding:18px 15px 12px;gap:0;
 color:#dce3ef;font:13px system-ui,sans-serif}
.tdm-sidebar-brand{display:flex;align-items:center;gap:11px;padding:3px 1px 17px;
 border-bottom:1px solid #343840;margin-bottom:15px;min-width:0}
.tdm-sidebar-mark{width:35px;height:35px;object-fit:contain;flex:0 0 35px}
.tdm-sidebar-identity{display:flex;flex-direction:column;gap:3px;min-width:0}
.tdm-sidebar-identity strong{font-size:16px;letter-spacing:.1px;color:#f2f3f8;
 overflow-wrap:anywhere}
.tdm-sidebar-identity span{font-size:11px;color:#8c98a9}
.tdm-sidebar-open{width:100%;min-height:38px;font-weight:600}
.tdm-sidebar-description{font-size:11px;line-height:1.6;color:#96a2b2;
 padding:10px 1px 17px}
.tdm-sidebar-overview{min-height:0;flex:1;border-top:1px solid #343840;
 padding-top:14px;display:flex;flex-direction:column}
.tdm-sidebar-overview-head{display:flex;gap:8px;align-items:baseline;
 margin:0 1px 10px;color:#d6dfe9;font-size:12px;font-weight:650}
.tdm-sidebar-count{font-size:11px;color:#8996a6;font-weight:400}
.tdm-sidebar-list{display:flex;flex-direction:column;gap:0;min-height:0;
 overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#404957 transparent}
.tdm-sidebar-entry{padding:11px 4px 12px;border-bottom:1px solid #2d3139;
 cursor:default;user-select:text}
.tdm-sidebar-entry-title{display:flex;align-items:flex-start;gap:7px;min-width:0}
.tdm-sidebar-entry-name{font-size:12px;color:#e0e6ee;line-height:1.4;font-weight:600;
 flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tdm-sidebar-entry-status{font-size:10px;color:#afb8c7;font-weight:500;
 white-space:nowrap;flex:none}
.tdm-sidebar-entry-status.low_running,.tdm-sidebar-entry-status.high_running{color:#99c9ff}
.tdm-sidebar-entry-status.low_complete,.tdm-sidebar-entry-status.high_complete{color:#a8dcb0}
.tdm-sidebar-entry-status.high_pending{color:#e0c49b}
.tdm-sidebar-entry-meta{font-size:10px;line-height:1.7;color:#929ead;
 display:flex;flex-direction:column;gap:0;margin-top:3px}
.tdm-sidebar-empty{padding:28px 8px;color:#838e9e;font-size:12px;
 text-align:center;line-height:1.8}

@media(max-width:850px){.tdm-form.tdm-create{height:94vh}
 .tdm-create-content{overflow:auto}.tdm-create-columns{grid-template-columns:1fr;gap:22px;height:auto}
 .tdm-create .tdm-prompt-editor{height:40vh;min-height:260px;flex:none}
 .tdm-create-right{border-left:0;border-top:1px solid #353a43;padding:16px 0 0;overflow:visible}
 .tdm-create-meta,.tdm-create-bottom{grid-template-columns:1fr}
 .tdm-create-foot .tdm-small{display:none}}
@media(max-width:820px){.tdm-main{grid-template-columns:1fr}.tdm-right{border-top:1px solid #333}
 .tdm-shell{overflow:auto}.tdm-card{grid-template-columns:24px 105px 1fr}.tdm-thumb{width:105px;height:64px}}
`;
  document.head.append(st);
}
function root() {
  if (state.root) return state.root;
  styles();
  const div = document.createElement("div");
  div.className = "tdm-back";
  div.hidden = true;
  div.style.display = "none";
  div.addEventListener("click", e => { if (e.target === div) close(); });
  div.addEventListener("pointerdown", e => e.stopPropagation());
  div.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && state.root?.style.display !== "none") close(); });
  document.body.append(div);
  state.root = div;
  return div;
}
function open() { root().style.display = "flex"; render(); void Promise.all([refresh(),loadTemplate()]); }
function close() { closePreviewRichEditor(); state.creating = false; state.configuring = false; state.assetPicker = null; state.deleting = null; if (state.root) state.root.style.display = "none"; }
async function refresh() {
  try {
    const result = await request("/tasks");
    state.tasks = result.tasks || [];
    renderSidebarTaskList();
    state.selected = new Set([...state.selected].filter(id => state.tasks.some(t => t.id === id)));
    if (!state.tasks.some(t => t.id === state.focused)) state.focused = state.tasks[0]?.id || null;
    render();
  } catch (e) { toast(e.message, "error"); }
}
function selectedTask() { return state.tasks.find(t => t.id === state.focused); }

function sidebarDate(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hour12: false,
  });
}
function sidebarLastStage(task) {
  if (task.high_finished_at) return "高清完成 " + sidebarDate(task.high_finished_at);
  if (task.high_started_at) return "高清开始 " + sidebarDate(task.high_started_at);
  if (task.low_finished_at) return "低清完成 " + sidebarDate(task.low_finished_at);
  if (task.low_started_at) return "低清开始 " + sidebarDate(task.low_started_at);
  if (task.queued_stage) return "已加入 ComfyUI 队列";
  return "尚未生成";
}
function sidebarTaskMarkup(task) {
  // This is deliberately plain text: no links, editing, selection or queue actions.
  const status = Object.prototype.hasOwnProperty.call(STATUS_NAMES,task.status)
    ? task.status : "low_pending";
  const name = String(task.name || "未命名预演任务");
  return '<div class="tdm-sidebar-entry">' +
    '<div class="tdm-sidebar-entry-title"><strong class="tdm-sidebar-entry-name" title="' +
    esc(name) + '">' + esc(name) + '</strong>' +
    '<span class="tdm-sidebar-entry-status ' + status + '">' +
    esc(STATUS_NAMES[status]) + (task.queued_stage ? " · 排队" : "") + '</span></div>' +
    '<div class="tdm-sidebar-entry-meta"><span>创建 ' +
    esc(sidebarDate(task.created_at)) + '</span><span>' +
    esc(sidebarLastStage(task)) + '</span></div></div>';
}
function renderSidebarTaskList() {
  const host = state.sidebarRoot;
  if (!host) return;
  const list = host.querySelector('[data-preview-sidebar-list]');
  const count = host.querySelector('[data-preview-sidebar-count]');
  if (!list || !count) return;
  count.textContent = state.tasks.length + " 个任务";
  list.innerHTML = state.tasks.length
    ? state.tasks.map(sidebarTaskMarkup).join("")
    : '<div class="tdm-sidebar-empty">暂无预演任务<br>请先在预演台创建任务</div>';
}
async function refreshSidebarTasks() {
  const host = state.sidebarRoot;
  if (!host || state.sidebarFetching) return;
  state.sidebarFetching = true;
  try {
    const result = await request("/tasks");
    if (state.sidebarRoot !== host) return;
    state.tasks = Array.isArray(result.tasks) ? result.tasks : [];
    renderSidebarTaskList();
  } catch (error) {
    if (state.sidebarRoot === host && !state.tasks.length) {
      const list = host.querySelector('[data-preview-sidebar-list]');
      if (list) list.textContent = "暂时无法读取任务列表";
    }
    console.warn("[TerryDirector 预演台侧边栏]", error);
  } finally {
    state.sidebarFetching = false;
  }
}
function mountPreviewSidebar(el) {
  styles();
  if (state.sidebarPoll != null) {
    clearInterval(state.sidebarPoll);
    state.sidebarPoll = null;
  }
  state.sidebarRoot = el;
  el.innerHTML =
    '<div class="tdm-sidebar">' +
      '<header class="tdm-sidebar-brand">' +
        '<img class="tdm-sidebar-mark" src="' + BRAND_MARK_URL +
          '" alt="" aria-hidden="true">' +
        '<div class="tdm-sidebar-identity"><strong>TerryDirector</strong>' +
          '<span>导演节点包</span></div></header>' +
      '<button class="tdm-btn primary tdm-sidebar-open" type="button" ' +
        'data-preview-open>打开预演台</button>' +
      '<div class="tdm-sidebar-description">镜头预演、任务重跑与批量高清续采</div>' +
      '<section class="tdm-sidebar-overview" aria-label="只读预演任务列表">' +
        '<div class="tdm-sidebar-overview-head">任务列表' +
          '<span class="tdm-sidebar-count" data-preview-sidebar-count></span></div>' +
        '<div class="tdm-sidebar-list" data-preview-sidebar-list></div>' +
      '</section></div>';
  el.querySelector('[data-preview-open]').addEventListener("click", open);
  renderSidebarTaskList();
  void refreshSidebarTasks();
  // Sidebar tabs may remain mounted while hidden. Refresh only when visible.
  const poll = setInterval(() => {
    if (!el.isConnected) {
      clearInterval(poll);
      if (state.sidebarPoll === poll) state.sidebarPoll = null;
      if (state.sidebarRoot === el) state.sidebarRoot = null;
      return;
    }
    if (el.getClientRects().length && document.visibilityState !== "hidden")
      void refreshSidebarTasks();
  }, 12000);
  state.sidebarPoll = poll;
}

const STATUS_NAMES={
  low_pending:"低清待生成",low_running:"低清生成中",low_complete:"低清完成",
  high_pending:"高清待生成",high_running:"高清生成中",high_complete:"高清完成",
};
const formatTime=value => {
  if(!value)return "—";
  const date=new Date(value);
  return Number.isFinite(date.getTime())
    ? esc(date.toLocaleString("zh-CN",{
        year:"numeric",month:"2-digit",day:"2-digit",
        hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,
      }))
    : esc(String(value).replace("T"," ").slice(0,19));
};
function duration(start,end) {
  if(!start || !end)return "—";
  const diff=Math.max(0,Math.round((Date.parse(end)-Date.parse(start))/1000));
  if(!Number.isFinite(diff))return "—";
  const h=Math.floor(diff/3600),m=Math.floor(diff%3600/60),sec=diff%60;
  return (h ? h+"时" : "")+(m || h ? m+"分":"")+sec+"秒";
}
function statusMarkup(task) {
  const status=task.status || "low_complete";
  const queued=task.queued_stage && /pending$/.test(status);
  return '<span class="tdm-status '+esc(status)+'">'+
    esc(STATUS_NAMES[status] || STATUS_NAMES.low_pending)+(queued?" · 已排队":"")+'</span>';
}
function thumb(task) {
  const media=task.media||{},kind=media.sampling?"sampling":media.decoded?"decoded":null;
  if(!kind)return '<div class="tdm-thumb"></div>';
  const file=media[kind],id=task.checkpoint_id || task.id,url=mediaUrl(id,kind);
  return file.endsWith(".mp4")
    ? '<video class="tdm-thumb" src="'+url+'#t=0.5" muted preload="metadata"></video>'
    : '<img class="tdm-thumb" src="'+url+'" alt="">';
}
/** Live TAEH3 media is attached to a single queued prompt, never globally. */
function previewJobMatchesTask(job,task) {
  if(!job || !task || job.mode!=="pause" || job.preview_type==="decoded")return false;
  return !!((job.draftId && job.draftId===task.id) ||
    (job.checkpointId &&
     (job.checkpointId===task.id || job.checkpointId===task.checkpoint_id)));
}
function livePreviewJobForTask(task) {
  for(const job of state.jobs.values())
    if(job.preview && previewJobMatchesTask(job,task))return job;
  return null;
}
function previewBlobUrl(job) {
  if(!job?.preview?.image)return null;
  if(job.liveUrl && job.liveUrlVersion===job.previewVersion)return job.liveUrl;
  try {
    const binary=atob(job.preview.image);
    const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
    const next=URL.createObjectURL(new Blob([bytes],{type:job.preview.mime}));
    // Keep the preceding URL alive until the replacement source has been
    // installed; an active video may still be loading it.
    if(job.livePriorUrl) URL.revokeObjectURL(job.livePriorUrl);
    job.livePriorUrl=job.liveUrl||null;
    job.liveUrl=next;
    job.liveUrlVersion=job.previewVersion;
    return next;
  }catch(error){
    console.warn("[TerryDirector 预演台实时预览]",error);
    return null;
  }
}
function releasePreviewBlobUrls(job) {
  if(!job)return;
  for(const key of ["liveUrl","livePriorUrl"]){
    if(job[key])URL.revokeObjectURL(job[key]);
    job[key]=null;
  }
}
function livePreviewMarkup(job) {
  const url=previewBlobUrl(job);
  if(!url)return '<div class="tdm-player tdm-detail-pending">暂时无法解码本轮预览</div>';
  const p=job.preview;
  const content=p.mime==="video/mp4"
    ? '<video class="tdm-player" data-live-video data-media-key="'+esc("live:"+url)+
      '" src="'+esc(url)+'" controls autoplay muted loop playsinline preload="auto"></video>'
    : '<img class="tdm-player" src="'+esc(url)+'" alt="TAEH3 实时采样预览">';
  const step=Number(p.step)||1,total=Number(p.total)||0;
  return '<div class="tdm-live-media">'+content+
    '<div class="tdm-live-caption">TAEH3 实时采样 · 第 '+step+
    (total?" / "+total:"")+' 步 · 仅内存预览，结束后保存</div></div>';
}
function updateLivePreview(job) {
  if(!state.root || state.root.style.display==="none" || state.preview!=="sampling")return;
  // Do not replace a prompt editor, config dialog or an unrelated task.
  const task=selectedTask();
  if(!previewJobMatchesTask(job,task))return;
  const host=state.root.querySelector("[data-live-preview-host]");
  if(!host || host.dataset.taskId!==String(task.id))return;
  const wasPlaying=host.querySelector("video[data-live-video]");
  if(wasPlaying)wasPlaying.pause();
  host.innerHTML=livePreviewMarkup(job);
  const player=host.querySelector("video[data-live-video]");
  if(player)void player.play().catch(()=>{});
}
function details(task) {
  if(!task)return '<div class="tdm-no-media">选择左侧预演任务查看预览</div>';
  const media=task.media||{},kind=state.preview;
  const file=media[kind],cid=task.checkpoint_id || (task.kind==="checkpoint"?task.id:null);
  const live=kind==="sampling" ? livePreviewJobForTask(task) : null;
  const preview=live
    ? livePreviewMarkup(live)
    : !file || !cid
      ? '<div class="tdm-player tdm-detail-pending">'+
        (cid?"暂无"+(kind==="decoded"?"VAE 解码":"TAEH3")+"预览":
          task.status==="low_running"?"正在生成低清，等待首轮 TAEH3 预览":
          task.queued_stage?"已加入生成队列，等待开始执行":
          "尚未生成低清视频，请点击「开始预演」")+
        '</div>'
      : file.endsWith(".mp4")
        ? '<video class="tdm-player" data-saved-video data-media-key="'+
          esc("saved:"+cid+":"+kind+":"+file)+'" src="'+mediaUrl(cid,kind)+
          '" controls loop playsinline preload="auto"></video>'
        : '<img class="tdm-player" src="'+mediaUrl(cid,kind)+'" alt="采样预览">';
  const timing='<div class="tdm-timing"><div>任务创建：<strong>'+formatTime(task.created_at)+'</strong></div>'+
    '<div>低清生成：'+formatTime(task.low_started_at)+' → '+formatTime(task.low_finished_at)+
    '　用时 '+duration(task.low_started_at,task.low_finished_at)+'</div>'+
    '<div>高清生成：'+formatTime(task.high_started_at)+' → '+formatTime(task.high_finished_at)+
    '　用时 '+duration(task.high_started_at,task.high_finished_at)+'</div></div>';
  const pending=task.kind==="draft" && task.status==="low_pending" && !task.queued_stage;
  const canHigh=task.status==="low_complete" && !!cid && !task.queued_stage;
  const duplicate=task.kind==="draft" || task.metadata?.has_workflow;
  let actions='';
  if(pending)actions+='<button class="tdm-btn" data-action="edit-draft">编辑任务</button>'+
    '<button class="tdm-btn primary" data-action="run-draft">开始预演</button>';
  if(duplicate)actions+='<button class="tdm-btn" data-action="duplicate">以此新建</button>';
  if(canHigh)actions+='<button class="tdm-btn primary" data-action="highres">继续高清</button>';
  if(task.kind==="checkpoint" && task.status==="low_complete")
    actions+='<button class="tdm-btn" data-action="load">载入任务工作流</button>';
  if(task.status==="low_running" || task.status==="high_running")
    actions+='<span class="tdm-small">生成中 · 可在 ComfyUI 队列查看进度</span>';
  return '<h3 style="margin:0;font-size:15px">'+esc(task.name||"未命名任务")+'</h3>'+
    statusMarkup(task)+
    '<div class="tdm-tabs">'+
    '<button data-action="preview" data-kind="sampling" class="'+(kind==="sampling"?"on":"")+'">TAEH3 采样预览</button>'+
    '<button data-action="preview" data-kind="decoded" class="'+(kind==="decoded"?"on":"")+'">VAE 解码</button>'+
    ((live?.preview?.mime==="video/mp4" || file?.endsWith(".mp4")) ?
      '<button class="tdm-btn tdm-replay-control" data-action="toggle-preview-playback" '+
      'type="button">播放 / 暂停</button>' : '')+'</div>'+
    '<div data-live-preview-host data-task-id="'+esc(task.id)+'">'+preview+'</div>'+
    '<div class="tdm-detail">Seed：'+esc(task.seed||"—")+
    '　工作流：'+esc(task.metadata?.workflow_name||"未记录")+
    (cid?'　检查点：'+esc(cid.slice(0,12)):'')+'</div>'+
    timing+(task.error?'<div class="tdm-warning">'+esc(task.error)+'</div>':'')+
    '<div class="tdm-actions">'+actions+'</div>';
}

function bindPreviewPlaybackErrors() {
  const player=state.root?.querySelector('[data-live-preview-host] video');
  if(!player || player.dataset.previewErrorBound==="1")return;
  player.dataset.previewErrorBound="1";
  player.addEventListener("error",()=>{
    const detail=player.error?.message || "视频格式可能与当前浏览器不兼容";
    showPreviewPlaybackError("无法播放预览："+detail);
  });
}
function showPreviewPlaybackError(message) {
  const host=state.root?.querySelector('[data-live-preview-host]');
  if(!host)return;
  let label=host.querySelector(".tdm-playback-message");
  if(!label){
    label=document.createElement("div");
    label.className="tdm-playback-message";
    label.setAttribute("role","status");
    host.appendChild(label);
  }
  label.textContent=message;
}
async function togglePreviewPlayback() {
  const player=state.root?.querySelector('[data-live-preview-host] video');
  if(!player)throw Error("当前没有可以播放的视频");
  if(!player.paused){
    player.pause();
    return;
  }
  try {
    // Explicit user gesture is useful when Chromium blocks earlier autoplay.
    await player.play();
  }catch(error){
    showPreviewPlaybackError("播放失败："+(error?.message || error));
    throw Error("视频无法播放："+(error?.message || error));
  }
}
function render() {
  if (!state.root || state.root.style.display === "none") return;
  const task = selectedTask();
  // Keep the same media element across regular task/status refreshes.
  // Reconstructing the whole dialog used to reset playback while the user
  // was clicking the controls (especially around task completion).
  const oldPlayer=state.root.querySelector('[data-live-preview-host] video[data-media-key]');
  const oldKey=oldPlayer?.dataset.mediaKey;
  const oldTime=oldPlayer?.currentTime;
  const oldPlaying=oldPlayer && !oldPlayer.paused && !oldPlayer.ended;
  closePreviewRichEditor();
  state.root.innerHTML = '<div class="tdm-shell"><header class="tdm-head">' +
    '<h2>TerryDirector · 预演台</h2><span class="tdm-tag">' + state.tasks.length + ' 个任务</span>' +
    '<div class="tdm-space"></div><button class="tdm-btn" data-action="config">配置工作流</button>' +
    '<button class="tdm-btn primary" data-action="create">＋ 新建预演</button>' +
    '<button class="tdm-btn" data-action="refresh">刷新</button><button class="tdm-btn close" data-action="close">×</button></header>' +
    '<div class="tdm-main"><section class="tdm-left"><div class="tdm-toolbar">' +
    '<label><input type="checkbox" data-action="select-all" ' +
    (state.tasks.length && state.selected.size === state.tasks.length ? "checked" : "") +
    '> 全选</label><span class="tdm-space"></span><span class="tdm-small">已选 ' + state.selected.size + '</span></div>' +
    '<div class="tdm-list">' +
    (state.tasks.length ? state.tasks.map(t => '<div class="tdm-card ' + (t.id === state.focused ? "active" : "") +
      '" data-action="focus" data-id="' + esc(t.id) + '">' +
      '<input type="checkbox" data-action="select" data-id="' + esc(t.id) + '" ' +
      (state.selected.has(t.id) ? "checked" : "") + '>' + thumb(t) +
      '<div><h3>' + esc(t.name || "未命名镜头") + '</h3><div class="tdm-small">' +
      esc((t.created_at || "").replace("T", " ").slice(0, 16)) + '</div>' +
      '<div>'+statusMarkup(t)+'</div><div class="tdm-small">创建 '+formatTime(t.created_at)+'</div>'+
      '<div class="tdm-small">'+(t.low_finished_at?'低清完成 '+formatTime(t.low_finished_at):
        t.low_started_at?'低清开始 '+formatTime(t.low_started_at):'尚未生成')+'</div>'+
      (t.high_finished_at?'<div class="tdm-small">高清完成 '+formatTime(t.high_finished_at)+'</div>':'')+
      '</div></div>').join("")
      : '<div class="tdm-blank">还没有预演任务，点击「新建预演」创建任务，之后手动开始生成。</div>') +
    '</div></section><section class="tdm-right">' + details(task) + '</section></div>' +
    '<footer class="tdm-foot">' +
    '<button class="tdm-btn danger" data-action="delete" ' +
    (!state.selected.size || state.busy ? "disabled" : "") +
    '>删除所选 · ' + state.selected.size + '</button>' +
    '<span class="tdm-space"></span><button class="tdm-btn primary" data-action="batch" ' +
    (!state.selected.size || state.busy ||
     [...state.selected].some(id=>state.tasks.find(t=>t.id===id)?.status!=="low_complete")
      ? "disabled" : "") +
    '>批量高清续采 · ' + state.selected.size + '</button></footer></div>' +
    (state.creating ? createMarkup() : "") +
    (state.configuring ? configMarkup() : "") +
    (state.deleting ? deleteMarkup() : "");
  if(oldPlayer && oldKey){
    const replacement=state.root.querySelector('[data-live-preview-host] video[data-media-key]');
    if(replacement?.dataset.mediaKey===oldKey){
      replacement.replaceWith(oldPlayer);
      if(Number.isFinite(oldTime) && Math.abs(oldPlayer.currentTime-oldTime)>0.3){
        try{oldPlayer.currentTime=oldTime;}catch{/* media not seekable yet */}
      }
      if(oldPlaying && oldPlayer.paused)
        void oldPlayer.play().catch(()=>{});
    }
  }
  bindControls();
  bindPreviewPlaybackErrors();
  wireImageFallback(state.root.querySelector(".tdm-assets"));
  renderAssetChoices();
  installCreatePromptEditor();
}
function showDeleteConfirmation() {
  if (state.busy || !state.selected.size) return;
  const tasks = state.tasks.filter(task => state.selected.has(task.id));
  if (!tasks.length) return;
  state.deleting = { ids: tasks.map(task => task.id), tasks };
  render();
}

function deleteMarkup() {
  const { ids, tasks } = state.deleting;
  const many = ids.length >= 10;
  const names = tasks.slice(0, 4).map(task =>
    esc(task.name || "未命名预演") + " · " + esc(task.id.slice(0, 8))).join("、");
  return '<div class="tdm-dialog"><div class="tdm-form" role="alertdialog" ' +
    'aria-modal="true" aria-label="确认删除预演任务">' +
    '<h2>删除 ' + ids.length + ' 个预演任务？</h2>' +
    '<div class="tdm-warning">将永久删除所选任务的配置；已经生成的检查点、Latent 和预览也将被删除。' +
    '运行中或已排队的任务不可删除。删除后无法恢复。</div>' +
    '<div class="tdm-delete-summary" style="margin-top:13px">' + names +
    (tasks.length > 4 ? ' 等 ' + tasks.length + ' 个任务' : '') + '</div>' +
    (many ? '<div class="tdm-field"><label>为避免大量误删，请输入「删除」</label>' +
      '<input data-action="delete-ack" placeholder="输入 删除" autocomplete="off"></div>' : '') +
    '<div class="tdm-form-actions">' +
    '<button class="tdm-btn" data-action="cancel-delete">取消</button>' +
    '<button class="tdm-btn danger" data-action="confirm-delete" ' +
    (many || state.busy ? 'disabled' : '') + '>永久删除 ' + ids.length + ' 个任务</button>' +
    '</div></div></div>';
}

async function deleteSelectedTasks() {
  const ids=state.deleting?.ids;
  if(!ids?.length || state.busy)return;
  state.busy=true;render();
  try {
    const selected=state.tasks.filter(t=>ids.includes(t.id));
    if(selected.some(t=>t.queued_stage || ["low_running","high_running","high_pending"].includes(t.status)))
      throw Error("运行中或排队中的任务不能删除");
    const draftIds=selected.filter(t=>t.kind==="draft").map(t=>t.id);
    const checkpointIds=[...new Set(selected.map(t=>t.checkpoint_id ||
      (t.kind==="checkpoint"?t.id:null)).filter(Boolean))];
    if(checkpointIds.length)await request("/tasks/batch-delete",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({checkpoint_ids:checkpointIds}),
    });
    if(draftIds.length)await request("/drafts/batch-delete",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({draft_ids:draftIds}),
    });
    state.selected.clear();state.deleting=null;
    if(ids.includes(state.focused))state.focused=null;
    toast("已删除 "+selected.length+" 个预演任务","success");
    await refresh();
  }catch(error){
    toast("删除失败："+error.message,"error");
  }finally{state.busy=false;render();}
}

function bindControls() {
  const el = state.root;
  el.querySelectorAll("[data-action]").forEach(control => {
    const action = control.dataset.action;
    if (action === "delete-ack") {
      control.addEventListener("input", () => {
        const confirm = el.querySelector('[data-action="confirm-delete"]');
        if (confirm) confirm.disabled = control.value.trim() !== "删除";
      });
    } else if (action === "select" || action === "select-all") {
      // Never bubble checkbox clicks to the selectable task row.
      control.addEventListener("click", e => e.stopPropagation());
      control.addEventListener("pointerdown", e => e.stopPropagation());
      control.addEventListener("change", e => {
        e.stopPropagation();
        if (action === "select-all") state.selected = e.target.checked ?
          new Set(state.tasks.map(t => t.id)) : new Set();
        else if (e.target.checked) state.selected.add(control.dataset.id);
        else state.selected.delete(control.dataset.id);
        render();
      });
    } else if (action === "draft-field") {
      control.addEventListener("input", () => {
        if (!state.createDraft) return;
        state.createDraft[control.dataset.field] = control.value;
      });
    } else if (action === "preview-choice") {
      control.addEventListener("change", () => {
        if (state.createDraft && control.checked) {
          state.createDraft.previewType = control.value;
        }
      });
    } else if (action === "config-name") {
      control.addEventListener("input",()=> {
        if(state.configDraft)state.configDraft.workflow_name=control.value;
      });
    } else if (action === "config-field") {
      control.addEventListener("change", () => {
        if (!state.configDraft) return;
        const key = control.dataset.field;
        if (key === "prompt_binding" || key === "seed_binding") {
          state.configDraft[key] = control.value ? JSON.parse(control.value) : null;
        } else {
          state.configDraft[key] = control.value;
        }
        state.configError="";
      });
    } else if (action === "asset-search") {
      control.addEventListener("input", () => {
        if (state.assetPicker) state.assetPicker.search = control.value;
        renderAssetChoices();
      });
    } else if (action === "source-change") {
      control.addEventListener("change", e => {
        void changeCreateSource({}, e.target.value).catch(err => toast(err.message, "error"));
      });
    } else control.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      void handleAction(action, control.dataset);
    });
  });
}
async function handleAction(action, data) {
  try {
    if (action === "close") return close();
    if (action === "refresh") return refresh();
    if (action === "focus") { state.focused = data.id; return render(); }
    if (action === "preview") { state.preview = data.kind; return render(); }
    if (action === "toggle-preview-playback") return await togglePreviewPlayback();
    if (action === "cancel-create") { state.creating = false; state.editDraftId = null; state.assetPicker = null; return render(); }
    if (action === "config") return await openConfig();
    if (action === "new-config") return await loadConfigDraft(null);
    if (action === "select-config") return await loadConfigDraft(data.id);
    if (action === "default-config") {
      await request("/templates/"+encodeURIComponent(state.configSelectedId)+"/default",{method:"POST"});
      await loadTemplate();
      return render();
    }
    if (action === "rename-config") {
      const id=state.configSelectedId,name=state.configDraft?.workflow_name?.trim();
      if(!id || !name)throw Error("请输入工作流名称");
      await request("/templates/"+encodeURIComponent(id)+"/rename",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name}),
      });
      await loadTemplate();
      toast("工作流已改名");
      return render();
    }
    if (action === "delete-config") {
      const id=state.configSelectedId;
      if(!id || !window.confirm("永久删除这份预演工作流配置？已生成的预演任务及检查点不会受影响。"))return;
      await request("/templates/"+encodeURIComponent(id),{method:"DELETE"});
      await loadTemplate();
      return await loadConfigDraft(state.defaultTemplateId);
    }
    if (action === "random-seed") {
      if (!state.createDraft) return;
      const seed = randomPreviewSeed(state.createDraft);
      state.createDraft.seed = seed;
      const input = state.root?.querySelector("#tdm-new-task-seed");
      if (input) input.value = seed;
      return;
    }
    if (action === "set-preview") { state.createDraft.previewType = data.kind; return render(); }
    if (action === "toggle-prompt-mode") {
      state.createDraft.editorMode = state.createDraft.editorMode === "raw" ? "visual" : "raw";
      return render();
    }
    if (action === "cancel-config") { state.configuring = false; return render(); }
    if (action === "save-config") return await saveConfig();
    if (action === "use-canvas") return useCurrentWorkflow();
    if (action === "open-assets") { state.assetPicker = { index: Number(data.index), search: "" }; return render(); }
    if (action === "close-assets") { state.assetPicker = null; return render(); }
    if (action === "choose-asset") return chooseAsset(data);
    if (action === "cancel-delete") { state.deleting = null; return render(); }
    if (action === "delete") return showDeleteConfirmation();
    if (action === "confirm-delete") return deleteSelectedTasks();
    if (action === "create") return await openCreate();
    if (action === "duplicate") {
      await loadInputFiles();
      state.editDraftId=null;
      state.creating=true;
      return await changeCreateSource({}, "task:"+state.focused);
    }
    if (action === "import-workflow") return importWorkflow();
    if (action === "upload-image") return uploadImage(Number(data.index));
    if (action === "submit") return await submitCreate();
    if (action === "run-draft") return await runDraft(state.focused);
    if (action === "edit-draft") return await editDraft(state.focused);
    if (action === "load") return loadSavedWorkflow(state.focused);
    if (action === "rerun") return await queueFromCheckpoint(state.focused, "pause");
    if (action === "highres") {
      const task=selectedTask();
      if(task?.kind==="draft")return await runDraft(task.id,"continue");
      return await queueFromCheckpoint(state.focused,"continue");
    }
    if (action === "batch") return await batchHighres();
  } catch (e) {
    if(state.configuring) {
      state.configError=String(e?.message||e);
      state.configSaving=false;
      render();
    }
    toast(e.message, "error");
  }
}

async function loadTemplate() {
  try {
    const catalogue=await request("/templates");
    state.templates=catalogue.templates || [];
    state.defaultTemplateId=catalogue.default_id || null;
    const result=await request("/template");
    state.template=result.template?.schema===2 ? result.template : null;
  } catch(e) { toast("读取工作流配置失败："+e.message,"error"); }
  render();
}
async function loadInputFiles() {
  try {
    const response = await api.fetchApi("/terrydirector/api/input-files");
    state.inputFiles = (await response.json()).files || [];
  } catch { state.inputFiles = []; }
}
function nodeValue(node, name) {
  if (!node) return undefined;
  if (node.widgets_values_named && Object.hasOwn(node.widgets_values_named, name)) {
    return node.widgets_values_named[name];
  }
  // Legacy workflows do not always serialize the named widget representation.
  const names = (node.inputs || []).filter(x => x.widget && x.link == null)
    .map(x => x.widget.name || x.name);
  const idx = names.indexOf(name);
  return idx < 0 ? undefined : node.widgets_values?.[idx];
}
/** Trace H3.prompt wiring upstream to an editable STRING origin.
 * Never scan unrelated STRING widgets (e.g. ModelPreviewOverrideKJ.preview).
 */
function fieldsOf(workflow,type) {
  return listPreviewInputCandidates(workflow,type);
}
function matchingAssets(workflow) {
  return (workflow?.nodes || []).filter(node =>
    /^(LoadImage|LoadImageMask)$/.test(node.type) &&
    typeof nodeValue(node, "image") === "string").map(node => ({
      node_id: node.id, widget_name: "image", value: nodeValue(node, "image"),
    }));
}
const bindingKey = obj => JSON.stringify({ node_id: obj.node_id, widget_name: obj.widget_name });
function bindingNode(graph, binding) {
  return (graph?.nodes || []).find(n => String(n.id) === String(binding?.node_id));
}
function templateFromGraph(workflow, name) {
  const prompts = fieldsOf(workflow, "prompt");
  const seeds = fieldsOf(workflow, "seed");
  const pause = (workflow.nodes || []).find(n => n.type === START_CLASS);
  return {
    schema: 1, workflow, workflow_name: name || "当前画布", source_name:name || "当前画布",
    pause_node_id: pause?.id || null,
    // Select automatically only when there is exactly one typed source.
    // Multiple STRING/INT output providers must be chosen by the user.
    prompt_binding: prompts.length === 1
      ? {node_id:prompts[0].node_id,widget_name:prompts[0].widget_name} : null,
    seed_binding: seeds.length === 1
      ? {node_id:seeds[0].node_id,widget_name:seeds[0].widget_name} : null,
    preview_node_id: (workflow.nodes || []).find(n => n.type === KJ_CLASS)?.id || null,
  };
}
async function loadConfigDraft(templateId) {
  if(!templateId) {
    const fresh=templateFromGraph(app.graph.serialize(),"新预演工作流");
    state.configSelectedId=null;state.configDraft=fresh;
  } else {
    const result=await request("/template?id="+encodeURIComponent(templateId));
    if(!result.template?.workflow)throw Error("保存的工作流数据不完整");
    state.configSelectedId=templateId;
    state.configDraft=structuredClone(result.template);
  }
  state.configError="";
  // Validate any existing binding against explicitly typed output providers.
  // Do not trace branches or infer which alternative source is active.
  const promptCandidates=fieldsOf(state.configDraft.workflow,"prompt");
  const selected=state.configDraft.prompt_binding;
  if(!promptCandidates.some(p=>bindingKey(p)===bindingKey(selected||{}))) {
    state.configDraft.prompt_binding=promptCandidates.length===1
      ? {node_id:promptCandidates[0].node_id,
         widget_name:promptCandidates[0].widget_name}
      : null;
    if(templateId)state.configError=promptCandidates.length===1
      ? "原提示词映射不符合 STRING 输出类型，已找到唯一可用节点，请重新保存。"
      : "原提示词映射不符合 STRING 输出类型，请在下拉菜单手动选择文本节点。";
  }
  render();
}
async function openConfig() {
  state.configuring=true;state.creating=false;state.configError="";
  await loadTemplate();
  await loadConfigDraft(state.defaultTemplateId);
}
function useCurrentWorkflow() {
  const retained=state.configDraft?.workflow_name || "新预演工作流";
  state.configDraft = templateFromGraph(app.graph.serialize(), retained);
  state.configDraft.source_name="当前画布";
  state.configDraft.template_id=state.configSelectedId;
  state.configError="";
  render();
}
function configMarkup() {
  const cfg=state.configDraft,graph=cfg?.workflow;
  const pauseNodes=(graph?.nodes||[]).filter(n=>n.type===START_CLASS);
  const prompts=fieldsOf(graph,"prompt");
  const seeds=fieldsOf(graph,"seed");
  const selected=state.configSelectedId;
  const current=state.templates.find(t=>t.id===selected);
  const listing=state.templates.map(item=>
    '<button class="tdm-config-entry '+(item.id===selected?'active':'')+
    '" data-action="select-config" data-id="'+esc(item.id)+'">'+
    '<span>'+esc(item.name)+(item.id===state.defaultTemplateId?' ★':'')+'</span>'+
    '<small>'+(item.id===state.defaultTemplateId?'默认工作流':'已保存')+'</small></button>').join("");
  function selectBinding(key,options) {
    const currentValue=bindingKey(cfg?.[key]||{});
    return '<select data-action="config-field" data-field="'+key+'">'+
      (!options.some(p=>bindingKey(p)===currentValue)?
        '<option value="" selected>请选择有效的上游输入</option>':'')+
      (options.length?'':'<option value="">未检测到可编辑输入</option>')+
      options.map(item=>'<option value="'+esc(bindingKey(item))+'" '+
        (currentValue===bindingKey(item)?'selected':'')+'>'+esc(item.label)+'</option>').join("")+
      '</select>';
  }
  return '<div class="tdm-dialog"><div class="tdm-form tdm-config" role="dialog" aria-modal="true">'+
    '<header class="tdm-config-header"><h2>配置预演工作流</h2><span class="tdm-space"></span>'+
    '<button class="tdm-btn close" data-action="cancel-config">×</button></header>'+
    '<div class="tdm-config-layout"><aside class="tdm-config-sidebar">'+
    '<div class="tdm-config-list">'+(listing||'<p class="tdm-small" style="padding:12px">尚无已配置工作流</p>')+
    '</div><div class="tdm-config-sidebar-footer">'+
    '<button class="tdm-btn primary" data-action="new-config">＋ 新建工作流</button>'+
    '<button class="tdm-btn" data-action="default-config" '+(!selected||selected===state.defaultTemplateId?'disabled':'')+'>设为默认</button>'+
    '<button class="tdm-btn" data-action="rename-config" '+(!selected?'disabled':'')+'>仅修改名称</button>'+
    '<button class="tdm-btn danger" data-action="delete-config" '+(!selected?'disabled':'')+'>删除此工作流</button>'+
    '</div></aside><div class="tdm-config-editor">'+
    '<div class="tdm-field"><label>工作流名称</label>'+
    '<input data-action="config-name" value="'+esc(cfg?.workflow_name||"新预演工作流")+'" maxlength="100"></div>'+
    '<div class="tdm-field"><label>工作流来源</label><div class="tdm-actions">'+
    '<input value="'+esc(cfg?.source_name||"当前画布")+'" disabled style="flex:1;min-width:0">'+
    '<button class="tdm-btn" data-action="use-canvas">使用当前画布</button>'+
    '<button class="tdm-btn" data-action="import-workflow">导入 JSON</button></div></div>'+
    '<div class="tdm-field"><label>暂停/继续节点</label><select data-action="config-field" data-field="pause_node_id">'+
    pauseNodes.map(n=>'<option value="'+esc(n.id)+'" '+(String(n.id)===String(cfg?.pause_node_id)?'selected':'')+'>'+
      esc((n.title||n.type)+' #'+n.id)+'</option>').join("")+'</select></div>'+
    '<div class="tdm-field"><label>提示词输入（STRING 输出节点）</label>'+
    selectBinding("prompt_binding",prompts)+'</div>'+
    (prompts.length>1?'<div class="tdm-small">检测到 '+prompts.length+
      ' 个 STRING 文本源，请选择本次预演需要接管的节点。</div>':'')+
    '<div class="tdm-field"><label>种子输入（INT 输出节点）</label>'+
    selectBinding("seed_binding",seeds)+'</div>'+
    '<div class="tdm-small">参考资产将使用工作流内的 LoadImage 节点，在新建预演时编辑。</div>'+
    (state.configError?'<div class="tdm-config-error">'+esc(state.configError)+'</div>':'')+
    '<div class="tdm-form-actions">'+
    '<button class="tdm-btn" data-action="cancel-config">取消</button>'+
    '<button class="tdm-btn primary" data-action="save-config" '+
    (state.configSaving||!pauseNodes.length||!prompts.length||!seeds.length?'disabled':'')+
    '>'+(state.configSaving?'保存中…':'保存工作流配置')+'</button></div>'+
    '</div></div></div></div>';
}

async function compileConfiguredWorkflow(cfg) {
  // Existing on-screen workflow: read-only compilation. Imported JSON:
  // construct an isolated LiteGraph instance; never invoke loadGraphData(),
  // register a workflow tab, or modify the live ComfyUI root graph.
  const active=app.rootGraph || app.graph;
  const installed=active.serialize();
  const fingerprint=graph=>JSON.stringify({
    nodes:(graph.nodes||[]).map(n=>[n.id,n.type,n.widgets_values_named||n.widgets_values]),
    links:graph.links||[],
  });
  const matching=fingerprint(installed)===fingerprint(cfg.workflow);
  let snapshot, runtimeGraph=active;
  if(matching) {
    snapshot=await app.graphToPrompt(active);
  } else {
    const Ctor=active?.constructor;
    if(typeof Ctor!=="function")throw Error("无法创建独立工作流编译图，请从当前画布配置");
    const isolated=new Ctor();
    try {
      await isolated.configure(structuredClone(cfg.workflow));
      snapshot=await app.graphToPrompt(isolated);
      runtimeGraph=isolated;
    } catch(e) {
      throw Error("无法独立编译导入的工作流：" + (e?.message || String(e)));
    }
  }
  if(!snapshot?.output || !snapshot?.workflow)throw Error("ComfyUI 未生成可执行的 API 工作流");
  const apiPrompt=structuredClone(snapshot.output);
  const bindings=["prompt_binding","seed_binding"];
  for(const key of bindings) {
    const binding=cfg[key];
    if(!binding || !Object.prototype.hasOwnProperty.call(
      apiPrompt[String(binding.node_id)]?.inputs || {},binding.widget_name)) {
      throw Error("无法映射到实际输入源：" + key + "。请在配置窗口重新选择节点");
    }
    if(Array.isArray(apiPrompt[String(binding.node_id)].inputs[binding.widget_name])) {
      throw Error("选中的 " + key + " 是下游连线输入，请选择原始输入节点");
    }
  }
  const targets=compilePreviewTargets(cfg.workflow,apiPrompt,cfg.pause_node_id);
  const seedRuntime=runtimeGraph.getNodeById?.(Number(cfg.seed_binding.node_id));
  const defResponse=await api.fetchApi("/object_info");
  if(!defResponse.ok)throw Error("无法读取采样器输入范围，请检查 ComfyUI 节点定义");
  const nodeDefinitions=await defResponse.json();
  const bounds=resolvePreviewSeedBounds(cfg.workflow,cfg.seed_binding,
    apiPrompt,nodeDefinitions,seedRuntime);
  return {
    ...cfg,schema:2,workflow:structuredClone(cfg.workflow),
    api_prompt:apiPrompt, ...targets,
    seed_min:bounds.min,seed_max:bounds.max,
    seed_consumers:bounds.consumers,
  };
}
async function saveConfig() {
  const cfg=state.configDraft;
  if(state.configSaving)return;
  if(!cfg?.prompt_binding || !cfg?.seed_binding || !cfg?.pause_node_id)
    throw Error("请选择暂停节点、H3 提示词源和种子输入");
  const name=String(cfg.workflow_name||"").trim();
  if(!name || name.length>100)throw Error("请输入 1～100 字的工作流名称");
  state.configSaving=true;state.configError="";
  render();
  try {
    const compiled=await compileConfiguredWorkflow({...cfg,workflow_name:name});
    if(state.configSelectedId)compiled.template_id=state.configSelectedId;
    else delete compiled.template_id;
    const saved=await request("/template",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(compiled),
    });
    state.configSelectedId=saved.id;
    await loadTemplate();
    await loadConfigDraft(saved.id);
    toast("预演工作流已保存："+name);
  } catch(error) {
    state.configError=String(error?.message||error);
    toast("保存失败："+state.configError,"error");
    render();
  } finally {
    state.configSaving=false;
    render();
  }
}

function overridesLookup(overrides) {
  return new Map((overrides || []).map(x => [String(x.node_id) + ":" + x.widget_name, x.value]));
}
function buildDraft(cfg, overrides = [], preferredName = "", previewType = "sampling") {
  const values = overridesLookup(overrides);
  function valueAt(binding) {
    if (!binding) return "";
    const key = String(binding.node_id) + ":" + binding.widget_name;
    return values.has(key) ? values.get(key) :
      nodeValue(bindingNode(cfg.workflow, binding), binding.widget_name);
  }
  const assets = matchingAssets(cfg.workflow).map(item => ({
    ...item, value: values.get(String(item.node_id) + ":" + item.widget_name) ?? item.value,
  }));
  return {
    workflow: structuredClone(cfg.workflow), workflow_name: cfg.workflow_name,
    pause_node_id: cfg.pause_node_id, prompt_binding: cfg.prompt_binding,
    seed_binding: cfg.seed_binding, preview_node_id: cfg.preview_node_id,
    api_prompt: cfg.api_prompt ? structuredClone(cfg.api_prompt) : null,
    pause_target: cfg.pause_target, highres_target: cfg.highres_target,
    decoded_target: cfg.decoded_target, seed_min:cfg.seed_min,seed_max:cfg.seed_max,
    h3Properties: structuredClone(cfg.h3_properties || {}),
    name: preferredName || "新预演镜头",
    prompt: String(valueAt(cfg.prompt_binding) ?? ""),
    seed: String(valueAt(cfg.seed_binding) ?? "8"),
    previewType: previewType === "decoded" ? "decoded" : "sampling",
    assets, source: "template",
  };
}
async function changeCreateSource(_data, source) {
  if (!source) return;
  state.editDraftId=null;
  if (source === "template") {
    if (!state.template) throw Error("请先在「配置工作流」中选择模板");
    state.createDraft = buildDraft(state.template);
    state.createDraft.source = source;
  } else if (source.startsWith("task:")) {
    const id = source.slice(5);
    if(id.startsWith("draft_")){
      const prior=await request("/drafts/"+encodeURIComponent(id));
      const cfg={...prior,h3_properties:prior.h3_properties};
      state.createDraft=buildDraft(cfg,[],(prior.name||"预演镜头")+" · 新版",prior.previewType);
      state.createDraft.prompt=prior.prompt;
      state.createDraft.seed=prior.seed;
      state.createDraft.assets=structuredClone(prior.assets||[]);
      state.createDraft.source=source;
      state.editDraftId=null;state.assetPicker=null;
      render();
      return;
    }
    const task = state.tasks.find(t => t.id === id);
    if (!task) throw Error("来源任务不存在");
    const result = await request("/tasks/" + encodeURIComponent(id) + "/workflow");
    const configured = templateFromGraph(result.workflow,
      task.metadata?.workflow_name || "从预演任务继承");
    if(!result.api_prompt)throw Error("这条任务没有独立可执行快照，请重新配置工作流");
    Object.assign(configured,{
      schema:2,api_prompt:result.api_prompt,
      pause_target:result.pause_target,highres_target:result.highres_target,
      decoded_target:result.decoded_target,seed_min:result.seed_min,seed_max:result.seed_max,
    });
    configured.pause_node_id = task.metadata.pause_node_id || configured.pause_node_id;
    configured.preview_node_id = task.metadata.preview_node_id || configured.preview_node_id;
    const meta = await request("/tasks/" + encodeURIComponent(id) + "/metadata");
    configured.prompt_binding = meta.prompt_binding || configured.prompt_binding;
    configured.seed_binding = meta.seed_binding || configured.seed_binding;
    configured.h3_properties = meta.h3_properties || {};
    state.createDraft = buildDraft(configured, result.overrides || [],
      (task.name || "预演镜头") + " · 新版", task.metadata?.preview_type || "sampling");
    state.createDraft.source = source;
  }
  state.assetPicker = null;
  render();
}
async function openCreate() {
  await loadInputFiles();
  state.createDraft = null;
  state.editDraftId = null;
  state.creating = true; state.configuring = false;
  if (state.template) {
    state.createDraft = buildDraft(state.template);
    state.createDraft.source = "template";
  } else {
    const source = state.tasks.find(x => x.metadata?.has_workflow);
    if (source) {
      try { await changeCreateSource({}, "task:" + source.id); }
      catch { state.createDraft = null; }
    }
    if (!state.createDraft) {
      state.creating = false;
      openConfig();
      toast("先配置一次工作流，之后创建预演只需输入提示词、资产和种子");
      return;
    }
  }
  render();
}
function wireImageFallback(holder) {
  if (!holder) return;
  holder.querySelectorAll(".tdm-asset img").forEach(image => {
    const fallback = () => {
      const placeholder = document.createElement("span");
      placeholder.className = "tdm-noimg";
      placeholder.textContent = "图片未找到";
      image.replaceWith(placeholder);
    };
    if (image.complete && image.naturalWidth === 0) fallback();
    else image.addEventListener("error", fallback, { once: true });
  });
}
function assetUrl(path) {
  if (!path) return "";
  return "/view?filename=" + encodeURIComponent(path) + "&type=input";
}
function assetCard(path, title, attrs, selected = false) {
  const image = path ? '<img loading="lazy" src="' + esc(assetUrl(path)) + '" alt="">' :
    '<span class="tdm-noimg">＋</span>';
  return '<button type="button" class="tdm-asset' + (selected ? ' selected' : '') +
    '" ' + attrs + '>' + image + '<label title="' + esc(path || "未选择") + '">' +
    esc(title || path || "添加图片") + '</label></button>';
}
function createMarkup() {
  const draft = state.createDraft;
  if (!draft) return "";
  const sources = [
    { id: "template", title: state.template ? "已配置工作流 · " + state.template.workflow_name : "未配置工作流" },
    ...state.tasks.filter(t => t.metadata?.has_workflow).map(t => ({
      id: "task:" + t.id, title: "继承 · " + (t.name || "预演") + " · " + t.id.slice(0, 8),
    })),
  ];
  return '<div class="tdm-dialog"><div class="tdm-form tdm-create" role="dialog" aria-modal="true">' +
    '<header class="tdm-create-head">' +
    '<button class="tdm-btn close tdm-create-close" data-action="cancel-create" aria-label="关闭">×</button>' +
    '<div class="tdm-create-meta">' +
    '<div class="tdm-field"><label class="tdm-name-label" for="tdm-new-task-name">'+
    (state.editDraftId?"编辑任务名称":"新建任务名称")+'</label>' +
    '<input id="tdm-new-task-name" data-action="draft-field" data-field="name" ' +
    'maxlength="120" value="' + esc(draft.name) + '"></div>' +
    '<div class="tdm-field"><label>基于</label><select data-action="source-change">' +
    sources.map(x => '<option value="' + esc(x.id) + '"' +
      (x.id === "template" && !state.template ? " disabled" : "") +
      (draft.source === x.id ? " selected" : "") + '>' + esc(x.title) + '</option>').join("") +
    '</select></div></div>' +
    '</header>' +
    '<div class="tdm-create-content"><div class="tdm-create-columns">' +
    '<section class="tdm-create-left">' +
    '<div class="tdm-section-head"><div class="tdm-section">提示词</div>' +
    '<button type="button" class="tdm-btn tdm-mode-btn" data-action="toggle-prompt-mode">' +
    (draft.editorMode === "raw" ? "切换富文本" : "查看 H3 原文") +
    '</button></div>' +
    '<div class="tdm-prompt-wrap"><div contenteditable="true" spellcheck="false" ' +
    'class="tdm-prompt-editor tdm-h3-rich-editor" data-placeholder="编写镜头描述，@ 引用右侧资产，\\ 或 / 插入 H3 指令…"></div></div>' +
    '<div class="tdm-prompt-hint"><span><b>@</b> 引用资产</span>' +
    '<span><b>\\ 或 /</b> H3 语法 / 运镜</span><span>↑↓ 选择 · Enter 插入</span></div>' +
    '<div class="tdm-create-bottom">' +
    '<div class="tdm-field"><label for="tdm-new-task-seed">种子</label><div class="tdm-seed-row">' +
    '<input id="tdm-new-task-seed" data-action="draft-field" data-field="seed" ' +
    'inputmode="numeric" value="' + esc(draft.seed) + '">' +
    '<button type="button" class="tdm-btn tdm-seed-random" data-action="random-seed" ' +
    'title="生成随机种子" aria-label="生成随机种子">🎲</button></div></div>' +
    '<div class="tdm-field"><label>预览视频</label>' +
    '<div class="tdm-preview-radios" role="radiogroup" aria-label="预览视频">' +
    '<label class="tdm-preview-radio"><input type="radio" name="tdm-preview-type" ' +
    'data-action="preview-choice" value="sampling" ' +
    (draft.previewType !== "decoded" ? 'checked' : '') + '>TAEH3 · 默认</label>' +
    '<label class="tdm-preview-radio"><input type="radio" name="tdm-preview-type" ' +
    'data-action="preview-choice" value="decoded" ' +
    (draft.previewType === "decoded" ? 'checked' : '') + '>VAE 解码</label></div></div></div>' +
    '</section>' +
    '<aside class="tdm-create-right">' +
    '<div class="tdm-section">参考资产 <span class="tdm-small">· 点击缩略图替换</span></div>' +
    '<div class="tdm-assets">' + draft.assets.map((asset,i) =>
      assetCard(asset.value, "图片 " + (i + 1) + " · " + (asset.value || "未设置"),
        'data-action="open-assets" data-index="' + i + '"')).join("") + '</div>' +
    (draft.assets.length ? '' : '<div class="tdm-small">当前模板没有 LoadImage 参考资产</div>') +
    '</aside></div></div>' +
    '<footer class="tdm-create-foot"><span class="tdm-small">创建任务只保存配置，不会启动 ComfyUI 生成。</span>' +
    '<span class="tdm-space"></span>' +
    '<button class="tdm-btn" data-action="cancel-create">取消</button>' +
    '<button class="tdm-btn primary" data-action="submit">'+
    (state.editDraftId?'保存修改':'创建任务')+'</button></footer>' +
    '</div></div>' +
    (state.assetPicker ? assetPickerMarkup() : "");
}
function installCreatePromptEditor() {
  const editor = state.root?.querySelector(".tdm-h3-rich-editor");
  if (!editor || !state.createDraft) return;
  // Capture this specific draft: releasing a previous editor must not copy
  // its old prompt into a newly selected source task's draft.
  const draft=state.createDraft;
  attachPreviewRichEditor(editor,{
    draft,
    mode:draft.editorMode === "raw" ? "raw" : "visual",
    onChange:text=>{ draft.prompt=text; },
  });
}
function assetPickerMarkup() {
  const picker = state.assetPicker;
  if (!picker) return "";
  return '<div class="tdm-dialog" style="z-index:100040"><div class="tdm-form" role="dialog" aria-modal="true">' +
    '<div class="tdm-modal-top"><h2>选择参考资产</h2><span class="tdm-space"></span>' +
    '<button class="tdm-btn" data-action="close-assets">×</button></div>' +
    '<div class="tdm-actions"><input style="flex:1" data-action="asset-search" placeholder="按文件名搜索图片" value="' +
    esc(picker.search) + '"><button class="tdm-btn" data-action="upload-image" data-index="' +
    picker.index + '">上传图片</button></div>' +
    '<div class="tdm-asset-picker"></div></div></div>';
}
function renderAssetChoices() {
  if (!state.assetPicker) return;
  const holder = state.root?.querySelector(".tdm-asset-picker");
  if (!holder) return;
  const matches = state.inputFiles.filter(f => f.kind === "image" &&
    f.path.toLowerCase().includes(state.assetPicker.search.toLowerCase())).slice(0, 150);
  holder.innerHTML = matches.map(f => assetCard(f.path, f.name,
    'data-action="choose-asset" data-path="' + esc(f.path) + '"')).join("") ||
    '<div class="tdm-small">没有匹配的图片</div>';
  wireImageFallback(holder);
  holder.querySelectorAll('[data-action="choose-asset"]').forEach(button =>
    button.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      chooseAsset(button.dataset);
    }));
}
function chooseAsset(data) {
  const index = state.assetPicker?.index;
  if (index == null || !state.createDraft?.assets[index]) return;
  state.createDraft.assets[index].value = data.path;
  state.assetPicker = null;
  render();
}
async function uploadImage(index) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp,image/bmp,image/tiff";
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const response = await api.fetchApi("/terrydirector/api/upload", {
        method: "POST", body: form,
      });
      const data = await response.json();
      if (!response.ok || !data.path || data.kind !== "image") {
        throw Error(data.error || "图片上传失败");
      }
      state.inputFiles.push(data);
      if (state.createDraft?.assets[index]) {
        state.createDraft.assets[index].value = data.path;
      }
      state.assetPicker = null;
      render();
      toast("图片已导入：" + data.name);
    } catch (e) { toast(e.message, "error"); }
  };
  fileInput.click();
}
async function importWorkflow() {
  const file = document.createElement("input");
  file.type = "file"; file.accept = ".json,application/json";
  file.onchange = async () => {
    try {
      const chosen = file.files?.[0];
      if (!chosen) return;
      const data = JSON.parse(await chosen.text());
      if (!Array.isArray(data.nodes)) throw Error("请选择 ComfyUI 完整工作流 JSON");
      state.configDraft = templateFromGraph(data, chosen.name);
      render();
    } catch (e) { toast(e.message, "error"); }
  };
  file.click();
}
// Submit a fully compiled API prompt directly, with no on-canvas mutations.
async function submitPreviewJob(template,overrides,mode,checkpointId,previewType) {
  const payload=buildPreviewJob(template,overrides,mode,checkpointId,previewType);
  const result=await api.queuePrompt(0,{
    output:payload.output,workflow:payload.workflow,
  },{partialExecutionTargets:payload.targets});
  if(!result?.prompt_id)throw Error("ComfyUI 未返回任务编号，任务可能未成功入队");
  return {promptId:String(result.prompt_id),targetIds:payload.targets};
}
function draftSnapshot(draft) {
  if(!draft?.workflow || !draft.api_prompt || !draft.prompt_binding || !draft.seed_binding)
    throw Error("工作流尚未编译，请在「配置工作流」重新保存");
  const seed=validatePreviewSeed(draft.seed,draft);
  return {
    name:String(draft.name||"").trim() || "未命名预演镜头",
    prompt:String(draft.prompt||""),seed:String(seed),
    assets:structuredClone(draft.assets||[]),previewType:draft.previewType,
    workflow_name:draft.workflow_name,
    workflow:structuredClone(draft.workflow),api_prompt:structuredClone(draft.api_prompt),
    prompt_binding:draft.prompt_binding,seed_binding:draft.seed_binding,
    pause_node_id:draft.pause_node_id,preview_node_id:draft.preview_node_id,
    pause_target:draft.pause_target,highres_target:draft.highres_target,
    decoded_target:draft.decoded_target,seed_min:draft.seed_min,seed_max:draft.seed_max,
    h3_properties:structuredClone(draft.h3Properties||{}),
  };
}
async function submitCreate() {
  // Deliberately no ComfyUI queue operation here. This is a durable draft.
  const payload=draftSnapshot(state.createDraft);
  const editId=state.editDraftId;
  const saved=await request(editId?"/drafts/"+encodeURIComponent(editId):"/drafts",{
    method:editId?"PUT":"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),
  });
  state.editDraftId=null;state.creating=false;state.assetPicker=null;
  state.focused=saved.id;
  await refresh();
  toast(editId?"任务修改已保存":"任务已创建，点击「开始预演」后才会生成","success");
}
async function editDraft(id) {
  if(!id?.startsWith("draft_"))throw Error("只能编辑未运行的预演任务");
  const row=await request("/drafts/"+encodeURIComponent(id));
  if(row.status!=="low_pending" || row.queued_stage)
    throw Error("任务已经进入运行阶段，无法修改");
  await loadInputFiles();
  const config={
    ...row,workflow:row.workflow,api_prompt:row.api_prompt,
    h3_properties:row.h3_properties,
  };
  state.createDraft=buildDraft(config,[],row.name,row.previewType);
  state.createDraft.prompt=row.prompt;
  state.createDraft.seed=row.seed;
  state.createDraft.assets=structuredClone(row.assets||[]);
  state.createDraft.source="task:"+id;
  state.editDraftId=id;
  state.creating=true;
  render();
}
async function draftTransition(id,action,fields={}) {
  return request("/drafts/"+encodeURIComponent(id)+"/status",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action,...fields}),
  });
}
function draftOverrides(draft) {
  const seed=validatePreviewSeed(draft.seed,draft);
  return [
    {node_id:draft.prompt_binding.node_id,widget_name:draft.prompt_binding.widget_name,value:draft.prompt},
    {node_id:draft.seed_binding.node_id,widget_name:draft.seed_binding.widget_name,value:seed},
    ...(draft.assets||[]).map(a=>({node_id:a.node_id,widget_name:a.widget_name,value:a.value})),
    {node_id:draft.pause_node_id,widget_name:"name",value:draft.name},
  ];
}
async function runDraft(id,mode="pause") {
  if(!id?.startsWith("draft_"))throw Error("请选择已创建的预演任务");
  const draft=await request("/drafts/"+encodeURIComponent(id));
  if(mode==="continue" && !draft.checkpoint_id)throw Error("低清完成后才能执行高清");
  const operation=mode==="pause"?"claim_low":"claim_high";
  await draftTransition(id,operation);
  try {
    const template={
      schema:2,workflow:draft.workflow,api_prompt:draft.api_prompt,
      pause_node_id:draft.pause_node_id,pause_target:draft.pause_target,
      highres_target:draft.highres_target,decoded_target:draft.decoded_target,
      seed_min:draft.seed_min,seed_max:draft.seed_max,
    };
    const overrides=draftOverrides(draft);
    const queued=await submitPreviewJob(template,overrides,mode,
      mode==="continue"?draft.checkpoint_id:"",draft.previewType);
    const job={
      draftId:id,mode,overrides,
      workflow:draft.workflow,api_prompt:draft.api_prompt,name:draft.name,
      workflow_name:draft.workflow_name,pause_node_id:String(draft.pause_node_id),
      pause_target:draft.pause_target,highres_target:draft.highres_target,
      decoded_target:draft.decoded_target,seed_min:draft.seed_min,seed_max:draft.seed_max,
      preview_node_id:draft.preview_node_id==null?null:String(draft.preview_node_id),
      prompt_binding:draft.prompt_binding,seed_binding:draft.seed_binding,
      h3_properties:draft.h3_properties||{},preview_type:draft.previewType,
      checkpointId:mode==="continue"?draft.checkpoint_id:null,
      preview:null,uploadedStep:0,busy:true,
    };
    state.jobs.set(queued.promptId,job);
    await draftTransition(id,"ack",{prompt_id:queued.promptId});
    await refresh();
    toast((mode==="pause"?"低清":"高清")+"任务已加入 ComfyUI 队列");
  } catch(error) {
    await draftTransition(id,"fail",{error:String(error?.message||error)}).catch(()=>{});
    await refresh();
    throw error;
  }
}

async function loadSavedWorkflow(id) {
  if (!id) throw Error("未选择任务");
  const info = await request("/tasks/" + encodeURIComponent(id) + "/workflow");
  if (!window.confirm("载入此任务原始工作流会替换当前 ComfyUI 画布，继续吗？")) return;
  await app.loadGraphData(info.workflow);
  state.templateName = selectedTask()?.metadata?.workflow_name || "已恢复任务工作流";
  toast("任务工作流已载入，图片和提示词覆盖值会在提交任务时自动恢复");
}
async function queueFromCheckpoint(id,mode) {
  const task=state.tasks.find(t=>t.id===id);
  if(!task)throw Error("请选择任务");
  const info=await request("/tasks/"+encodeURIComponent(id)+"/workflow");
  if(!info.api_prompt || !Array.isArray(info.workflow?.nodes))
    throw Error("该任务没有独立执行快照，请重新配置预演工作流后创建新任务");
  const overrides=structuredClone(info.overrides || []);
  const template={
    schema:2,workflow:info.workflow,api_prompt:info.api_prompt,
    pause_node_id:task.metadata.pause_node_id,
    pause_target:info.pause_target,highres_target:info.highres_target,
    decoded_target:info.decoded_target,seed_min:info.seed_min,seed_max:info.seed_max,
  };
  const name=mode==="pause" ? task.name+" · 重跑":task.name;
  if(mode==="pause") {
    const patch=overrides.find(x=>
      String(x.node_id)===String(template.pause_node_id) && x.widget_name==="name");
    if(patch)patch.value=name;
    else overrides.push({node_id:template.pause_node_id,widget_name:"name",value:name});
  }
  const previewType=task.metadata?.preview_type || "sampling";
  if(mode==="continue" && task.status!=="low_complete")
    throw Error("只有低清完成的任务可以续采高清");
  if(mode==="continue")
    await saveLegacyLifecycle(id,"high_pending",{queued_stage:"high"});
  let queued;
  try{
    queued=await submitPreviewJob(template,overrides,mode,
      mode==="continue"?id:"",previewType);
  }catch(error){
    if(mode==="continue")await saveLegacyLifecycle(id,"low_complete",{
      queued_stage:null,error:String(error.message||error),
    }).catch(()=>{});
    throw error;
  }
  if(mode==="continue") {
    state.jobs.set(queued.promptId,{
      mode:"continue",checkpointId:id,busy:true,
    });
    void refresh();
  }
  if(mode==="pause") {
    state.jobs.set(queued.promptId,{
      mode,overrides,workflow:info.workflow,api_prompt:info.api_prompt,name,
      workflow_name:task.metadata.workflow_name,
      pause_node_id:String(template.pause_node_id),
      pause_target:template.pause_target,highres_target:template.highres_target,
      decoded_target:template.decoded_target,seed_min:template.seed_min,seed_max:template.seed_max,
      preview_node_id:task.metadata.preview_node_id,
      preview_type:previewType,prompt_binding:info.prompt_binding,
      seed_binding:info.seed_binding,h3_properties:info.h3_properties||{},
      checkpointId:null,preview:null,uploadedStep:0,busy:true,
    });
  }
  toast((mode==="continue"?"高清续采":"预演重跑")+"已入队："+task.name);
}

async function batchHighres() {
  const ids = [...state.selected];
  if (!ids.length) return;
  state.busy = true; render();
  let queued = 0, failures = [];
  try {
    for (const id of ids) {
      try {
        const task=state.tasks.find(t=>t.id===id);
        if(task?.status!=="low_complete")throw Error("任务未处于低清完成状态");
        if(task.kind==="draft")await runDraft(id,"continue");
        else await queueFromCheckpoint(id,"continue");
        queued++;
      } catch(e){failures.push(e.message);}
    }
  } finally { state.busy = false; render(); }
  if (failures.length) toast("成功入队 " + queued + " 个；失败 " + failures.length + " 个：" + failures[0], "error");
  else toast("已排队 " + queued + " 个高清任务，按队列顺序逐一执行");
}
async function persistJob(job) {
  if (!job?.checkpointId || job.metadataSaved) return;
  job.metadataSaved = true;
  try {
    await request("/tasks/" + job.checkpointId + "/metadata", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow_name: job.workflow_name, overrides: job.overrides,
        pause_node_id: job.pause_node_id, preview_node_id: job.preview_node_id,
        prompt_binding: job.prompt_binding, seed_binding: job.seed_binding,
        h3_properties: job.h3_properties || {},
        preview_type: job.preview_type || "sampling",
        workflow: job.workflow,api_prompt:job.api_prompt,draft_id:job.draftId||null,
        pause_target:job.pause_target,highres_target:job.highres_target,
        decoded_target:job.decoded_target,seed_min:job.seed_min,seed_max:job.seed_max,
      }),
    });
  } catch (e) { job.metadataSaved = false; toast("检查点已保存，但任务配置存档失败：" + e.message, "error"); }
  // The checkpoint can be written before the final sampling preview arrives.
  // Saving the media here would capture a stale iteration. Finalize only in
  // execution_success/error/interrupted for this specific prompt.
  void refresh();
}
async function persistPreview(job) {
  // One final upload per job; do not write every sampling iteration.
  if(job?.previewPersistPromise)return job.previewPersistPromise;
  if(job?.previewSaved || job?.preview_type==="decoded" ||
     !job?.checkpointId || !job?.preview?.image)return false;
  const p=job.preview;
  if(p.image.length > 48*1024*1024*4/3)return false;
  const upload=(async()=>{
    const raw=atob(p.image);
    const bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));
    const response=await api.fetchApi(
      URL_BASE+"/tasks/"+encodeURIComponent(job.checkpointId)+"/sampling-preview",{
        method:"POST",headers:{"Content-Type":p.mime},body:bytes,
      });
    if(!response.ok){
      let reason="TAEH3 最终预览保存失败";
      try{reason=(await response.json()).error||reason;}catch{/* non-JSON error */}
      throw Error(reason);
    }
    job.previewSaved=true;
    job.uploadedStep=p.step||1;
    return true;
  })();
  job.previewPersistPromise=upload;
  try{return await upload;}
  catch(error){
    console.warn("[TerryDirector TAEH3 最终预览保存]",error);
    toast("最终采样预览未能保存："+error.message,"error");
    return false;
  }finally{
    job.previewPersistPromise=null;
  }
}
async function saveLegacyLifecycle(checkpointId,status,extras={}) {
  if(!checkpointId)return;
  let previous={};
  try {
    previous=await request("/tasks/"+encodeURIComponent(checkpointId)+"/metadata");
  } catch {/* Older checkpoints have no task.json yet. */}
  const value={...previous,
    workflow_name:previous.workflow_name||state.templateName,
    lifecycle_status:status,...extras,
  };
  await request("/tasks/"+encodeURIComponent(checkpointId)+"/metadata",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(value),
  });
}
function bindEvents() {
  api.addEventListener("execution_start",e=>{
    state.activePromptId=e.detail?.prompt_id?String(e.detail.prompt_id):null;
    const job=state.jobs.get(state.activePromptId);
    if(job){
      job.busy=true;
      if(job.draftId) {
        job.startPromise=draftTransition(job.draftId,"start",{
          prompt_id:state.activePromptId,
        });
        void job.startPromise.then(refresh).catch(err=>
          toast("开始状态记录失败："+err.message,"error"));
      }
      else if(job.mode==="continue")
        void saveLegacyLifecycle(job.checkpointId,"high_running",{high_started_at:new Date().toISOString()})
          .then(refresh).catch(err=>toast(err.message,"error"));
      return;
    }
    // Preserve original ComfyUI manual-node workflows without creating
    // a Preview Stage task draft on their behalf.
    if(state.activePromptId){
      const pauseNodes=getPauseNodes().filter(n=>widget(n,"mode")?.value==="暂停并保存");
      if(pauseNodes.length===1){
        const pause=pauseNodes[0],preview=previewForPause(pause);
        state.jobs.set(state.activePromptId,{
          mode:"pause",overrides:[],workflow:app.graph.serialize(),
          name:String(widget(pause,"name")?.value||"预演镜头"),
          workflow_name:state.templateName,pause_node_id:String(pause.id),
          preview_node_id:preview?String(preview.id):null,
          preview_type:"sampling",checkpointId:null,preview:null,
          uploadedStep:0,busy:true,
        });
      }
    }
  });
  api.addEventListener("kj_preview_override",e=>{
    const p=e.detail||{};
    // Prefer the event's prompt identity; for KJ versions without it, only
    // the currently executing ComfyUI prompt can receive the preview.
    const promptId=String(p.prompt_id||state.activePromptId||"");
    const job=state.jobs.get(promptId);
    if(!job || !job.busy || job.mode!=="pause" ||
       job.preview_type==="decoded" || !p.image || !p.mime ||
       String(p.node_id)!==String(job.preview_node_id))return;
    if(!["video/mp4","image/webp","image/jpeg"].includes(p.mime))return;
    if(p.image.length>48*1024*1024*4/3)return;
    const step=Number(p.step)||1, previous=job.preview?.step||0;
    if(step<previous)return; // Ignore delayed/stale packets for this job.
    job.preview={image:p.image,mime:p.mime,step,total:Number(p.total)||null};
    job.previewVersion=(job.previewVersion||0)+1;
    // Update the selected task's player only: no network request, no disk
    // writes, no full-window re-render, no interference with queued tasks.
    updateLivePreview(job);
  });
  api.addEventListener("executed",e=>{
    const p=e.detail||{},info=p.output?.terrydirector_selflift_checkpoint?.[0];
    if(!info?.checkpoint_id||info.mode!=="paused")return;
    const job=state.jobs.get(String(p.prompt_id||state.activePromptId));
    if(!job||job.mode!=="pause"||String(p.node)!==String(job.pause_node_id))return;
    job.checkpointId=String(info.checkpoint_id);
    job.persistPromise=persistJob(job);
    if(job.draftId)
      job.checkpointPromise=draftTransition(job.draftId,"checkpoint",{
        checkpoint_id:job.checkpointId,
      }).catch(error=>toast("检查点状态存档失败："+error.message,"error"));
  });
  for(const event of ["execution_success","execution_error","execution_interrupted"]){
    api.addEventListener(event,e=>{
      const promptId=String(e.detail?.prompt_id||"");
      const job=state.jobs.get(promptId);
      if(!job)return;
      job.busy=false;
      void (async()=>{
        await Promise.allSettled([
          job.startPromise,job.persistPromise,job.checkpointPromise,
        ].filter(Boolean));
        if(job.draftId){
          const action=event==="execution_success"?"finish":"fail";
          const details=action==="fail"?{error:event==="execution_interrupted"?
            "生成已中断":String(e.detail?.exception_message||"生成失败")}:{};
          try{
            await draftTransition(job.draftId,action,details);
          }catch(error){
            // A successful low-stage execution without a checkpoint must
            // never be reported as a completed task.
            if(action==="finish"){
              await draftTransition(job.draftId,"fail",{
                error:"执行结束但未找到有效低清检查点："+error.message,
              }).catch(()=>{});
            }
            toast("更新任务状态失败："+error.message,"error");
          }
        }else if(job.mode==="continue"&&job.checkpointId){
          try{
            await saveLegacyLifecycle(job.checkpointId,
              event==="execution_success"?"high_complete":"low_complete",
              event==="execution_success"?
                {high_finished_at:new Date().toISOString()}:
                {error:"高清执行中断或失败"});
          }catch(error){toast(error.message,"error");}
        }
        // After execution finishes, persist only the latest preview. The
        // save is independent of later queued jobs and their live previews.
        await persistPreview(job);
        // Remove the in-memory source BEFORE reloading task metadata, so
        // refresh() renders the saved MP4 once instead of briefly mounting
        // a Blob URL and revoking it during the following render.
        state.jobs.delete(promptId);
        releasePreviewBlobUrls(job);
        await refresh();
      })();
    });
  }
}

app.registerExtension({
  name: "TerryDirector.SelfLiftTaskManager",
  async setup() {
    bindEvents();
    if (app.extensionManager?.registerSidebarTab) {
      app.extensionManager.registerSidebarTab({
        id: "terrydirector-selflift-tasks", icon: "pi pi-video",
        title: "预演台", tooltip: "TerryDirector 预演台",
        type: "custom",
        render: el => mountPreviewSidebar(el),
      });
    }
  },
});
