/** TerryDirector SelfLift task manager — plain DOM, no React, no sampler fork. */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
  compilePreviewTargets, detectLowresReviewSink, resolvePreviewSeedBounds, buildPreviewJob,
  validatePreviewSeed, randomPreviewSeed,
} from "./td_preview_job_compiler.js";
import { attachPreviewRichEditor, closePreviewRichEditor } from "./td_preview_rich_editor.js";
import { listPreviewInputCandidates } from "./td_preview_input_candidates.js";
import {
  rememberSamplingPreview,finalSamplingCandidates,previewFallbackWarning,
} from "./td_preview_candidate_buffer.js";
import {
  progressFromEvent,progressFromState,recordSamplerProgress,formatSamplingProgress,
} from "./td_preview_sampling_progress.js";
import {
  PREVIEW_DURATION_MIN,PREVIEW_DURATION_MAX,PREVIEW_DURATION_DEFAULT,
  PREVIEW_RESOLUTION_OPTIONS,PREVIEW_RESOLUTION_DEFAULT,
  taskVideoFrameCount,taskResolutionInfo,taskAspectRatio,
} from "./td_preview_task_parameters.js";
import { parsePreviewBatches } from "./td_preview_batch_import.js";

const START_CLASS = "TerryDirectorSelfLiftPauseResume";
const KJ_CLASS = "ModelPreviewOverrideKJ";
const NATIVE_PREVIEW_CLASS = "TerryDirectorH3Preview";
const isPreviewNode = n => [KJ_CLASS,NATIVE_PREVIEW_CLASS].includes(nodeType(n));
const URL_BASE = "/terrydirector/api/selflift";
// Same mark URL as the TerryDirector timeline node and timeline editor.
const BRAND_MARK_URL = "/terrydirector/static/assets/mark.svg";
const PREVIEW_SETTINGS_KEY = "terrydirector.preview-stage.settings.v1";
const BATCH_IMPORT_DRAFT_KEY = "terrydirector.preview-stage.batch-import-draft.v1";
function normalizePreviewSettings(value) {
  const mp=Number(value?.highres_megapixels);
  return {
    highres_megapixels:PREVIEW_RESOLUTION_OPTIONS.includes(mp)?mp:PREVIEW_RESOLUTION_DEFAULT,
    default_preview_mode:value?.default_preview_mode==="sampling"?"sampling":"decoded",
  };
}
function readPreviewSettings() {
  try {
    if(typeof localStorage!=="undefined"){
      const raw=localStorage.getItem(PREVIEW_SETTINGS_KEY);
      if(raw)return normalizePreviewSettings(JSON.parse(raw));
    }
  } catch(error) { console.warn("[TerryDirector 预演台] 读取默认设置失败",error); }
  return normalizePreviewSettings(null);
}
function writePreviewSettings(value) {
  try {
    if(typeof localStorage!=="undefined")
      localStorage.setItem(PREVIEW_SETTINGS_KEY,JSON.stringify(normalizePreviewSettings(value)));
  } catch(error) { console.warn("[TerryDirector 预演台] 保存默认设置失败",error); }
}
function readBatchImportDraft() {
  try {
    if(typeof localStorage==="undefined")return null;
    const raw=localStorage.getItem(BATCH_IMPORT_DRAFT_KEY);
    if(!raw)return null;
    const draft=JSON.parse(raw);
    if(draft?.version!==1||!Array.isArray(draft.batches)){
      clearBatchImportDraft();return null;
    }
    return draft;
  } catch(error) {
    console.warn("[TerryDirector 预演台] 读取批量任务草稿失败",error);
    clearBatchImportDraft();return null;
  }
}
function clearBatchImportDraft() {
  try {
    if(typeof localStorage!=="undefined")localStorage.removeItem(BATCH_IMPORT_DRAFT_KEY);
  } catch(error) { console.warn("[TerryDirector 预演台] 清除批量任务草稿失败",error); }
}
function saveBatchImportDraft(batch) {
  if(!batch||batch.saving)return false;
  const importText=String(batch.importText||""),text=String(batch.text||"");
  const batches=Array.isArray(batch.batches)?batch.batches:[];
  if(!importText.trim()&&!text.trim()&&!batches.length)return false;
  const snapshot={
    version:1,savedAt:new Date().toISOString(),
    phase:batch.promptImportOpen?"import":"config",
    text,importText,importFileName:String(batch.importFileName||""),
    preamble:String(batch.preamble||""),error:String(batch.error||""),
    generatedAssets:Array.isArray(batch.generatedAssets)?batch.generatedAssets:[],
    parseWarnings:Array.isArray(batch.parseWarnings)?batch.parseWarnings:[],
    parseErrors:Array.isArray(batch.parseErrors)?batch.parseErrors:[],
    batches:batches.map(item=>({
      ...item,references:(item.references||[]).map(ref=>({...ref,path:String(ref.path||"")})),
    })),
    activeIndex:Number.isInteger(Number(batch.activeIndex))?Number(batch.activeIndex):0,
    selectedRefIndex:Number.isInteger(Number(batch.selectedRefIndex))?Number(batch.selectedRefIndex):-1,
    highres_megapixels:Number(batch.highres_megapixels),
    sampling_preview_enabled:!!batch.sampling_preview_enabled,
    vae_decode_enabled:!!batch.vae_decode_enabled,
  };
  try {
    if(typeof localStorage==="undefined")return false;
    localStorage.setItem(BATCH_IMPORT_DRAFT_KEY,JSON.stringify(snapshot));
    return true;
  } catch(error) {
    console.warn("[TerryDirector 预演台] 暂存批量任务失败",error);
    return false;
  }
}
function batchDraftDateLabel(savedAt) {
  const date=new Date(savedAt);
  if(Number.isNaN(date.getTime()))return "上次暂存";
  return date.toLocaleString(undefined,{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
}
function defaultPreviewOptions(settings) {
  const mode=(settings||state.previewSettings)?.default_preview_mode==="sampling"?"sampling":"decoded";
  return mode==="sampling"
    ? {sampling_preview_enabled:true,vae_decode_enabled:false}
    : {sampling_preview_enabled:false,vae_decode_enabled:true};
}
function normalizeTaskPreviewOptions(value, fallback=defaultPreviewOptions()) {
  if(typeof value==="string")return value==="decoded"
    ? {sampling_preview_enabled:false,vae_decode_enabled:true}
    : {sampling_preview_enabled:true,vae_decode_enabled:false};
  const legacy=value?.previewType ?? value?.preview_type;
  const sampling=typeof value?.sampling_preview_enabled==="boolean"
    ? value.sampling_preview_enabled
    : typeof value?.samplingPreviewEnabled==="boolean"
      ? value.samplingPreviewEnabled : legacy==="decoded" ? false :
        legacy==="sampling" ? true : fallback.sampling_preview_enabled;
  const decoded=typeof value?.vae_decode_enabled==="boolean"
    ? value.vae_decode_enabled
    : typeof value?.vaeDecodeEnabled==="boolean"
      ? value.vaeDecodeEnabled : legacy==="decoded" ? true :
        legacy==="sampling" ? false : fallback.vae_decode_enabled;
  return {sampling_preview_enabled:!!sampling,vae_decode_enabled:!!decoded};
}
function legacyPreviewType(options) {
  return options?.vae_decode_enabled && !options?.sampling_preview_enabled ? "decoded" : "sampling";
}
function samplingPreviewEnabled(value) {
  if(typeof value?.sampling_preview_enabled==="boolean")return value.sampling_preview_enabled;
  if(typeof value?.samplingPreviewEnabled==="boolean")return value.samplingPreviewEnabled;
  return value?.preview_type!=="decoded" && value?.previewType!=="decoded";
}
const state = {
  tasks: [], selected: new Set(), focused: null, preview: "auto", statusFilter: "all",
  busy: false, root: null, creating: false, configuring: false, deleting: null,
  template: null, templates: [], defaultTemplateId: null, configSelectedId: null,
  configError: "", configSaving: false, configDraft: null, createDraft: null, editDraftId: null,
  assetPicker: null, inputFiles: [], batchImport: null,
  templateName: "当前画布", jobs: new Map(), activePromptId: null,
  sidebarRoot: null, sidebarPoll: null, sidebarFetching: false,
  mediaRevisions: new Map(), elapsedTimer: null,
  settingsOpen:false, settingsDraft:null, previewSettings:readPreviewSettings(),
};
const esc = x => String(x ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nodeType = n => n?.comfyClass || n?.type;
const nodes = () => app.graph?._nodes || [];
const widget = (n, name) => n?.widgets?.find(w => w.name === name);
const getPauseNodes = () => nodes().filter(n => nodeType(n) === START_CLASS);
const getPreviewNodes = () => nodes().filter(isPreviewNode);
function previewForPause(pause) {
  const links = app.graph?.links || {};
  const clean = pause?.inputs?.find(x => x.name === "low_clean");
  const samplerLink = clean?.link == null ? null : links[clean.link];
  const sampler = samplerLink && app.graph?.getNodeById?.(samplerLink.origin_id);
  const visited = new Set();
  function find(node, depth = 0) {
    if (!node || depth > 8 || visited.has(String(node.id))) return null;
    visited.add(String(node.id));
    if (isPreviewNode(node)) return node;
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
const mediaUrl = (id, kind) => URL_BASE + "/tasks/" + encodeURIComponent(id) +
  "/media/" + kind + "?rev=" + (state.mediaRevisions.get(id)||0);
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
.tdm-status-filter{background:#252930;color:#d8e0eb;border:1px solid #404753;border-radius:6px;
 padding:6px 10px;min-width:160px;max-width:190px;font:12px "Segoe UI Symbol",system-ui;cursor:pointer}
.tdm-status-filter:focus-visible{outline:2px solid #6594d7;outline-offset:1px}
@media(max-width:600px){.tdm-status-filter{min-width:120px;max-width:155px}}
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
.tdm-card-status-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-width:0}
.tdm-card-progress{font-family:Consolas,"Cascadia Mono","DejaVu Sans Mono",monospace;
 font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;max-width:100%;
 color:#a8c6f4;line-height:1.5;overflow:hidden;text-overflow:ellipsis}
.tdm-card-progress:empty{display:none}
.tdm-status-icon{font:700 13px/1 "Segoe UI Symbol",system-ui,sans-serif;
 display:inline-flex;align-items:center;justify-content:center;min-width:14px;flex:none;
 color:#9daabe}
.tdm-status.low_running .tdm-status-icon,.tdm-status.high_running .tdm-status-icon{color:#86bfff}
.tdm-status.low_complete .tdm-status-icon,.tdm-status.high_complete .tdm-status-icon{color:#a9dfb2}
.tdm-status.high_pending .tdm-status-icon{color:#e6c792}
.tdm-sidebar-entry-status .tdm-status-icon{font-size:11px;min-width:11px;margin-right:3px;vertical-align:-1px}
.tdm-timing{font-size:11px;color:#a5b0be;line-height:1.8;font-variant-numeric:tabular-nums}
.tdm-timing strong{color:#d6dce6;font-weight:500}
.tdm-timing .tdm-elapsed{font-weight:650;color:#eda660;margin-left:14px}
.tdm-detail-pending{padding:18px;background:#11151b;border:1px dashed #414a57;border-radius:8px;
 color:#a4b1c1;line-height:1.7;min-height:140px}
.tdm-right{min-width:0;min-height:0;display:flex;flex-direction:column;padding:16px;gap:12px}
.tdm-tabs{display:flex;gap:5px;flex-wrap:wrap;align-items:center}.tdm-tabs button{border:1px solid #414650;background:#252830;color:#9ba4b2;
 border-radius:6px;padding:7px 10px;cursor:pointer}.tdm-tabs button.on{background:#344d6e;color:#f2f7ff;border-color:#527cac}
.tdm-player{width:100%;aspect-ratio:16/9;background:#0b0d11;border-radius:8px;object-fit:contain;max-height:52vh}
.tdm-live-media{position:relative;width:100%;min-width:0}
.tdm-live-caption{font-size:11px;color:#9ccaff;margin:4px 2px 0;line-height:1.6}
.tdm-live-media video{display:block}
.tdm-playback-message{font-size:11px;color:#e4b0a5;margin:6px 2px 0}
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
.tdm-create .tdm-asset .tdm-noimg{display:flex;flex-direction:column;gap:8px;font-size:28px}
.tdm-create .tdm-asset .tdm-noimg small{font-size:12px;line-height:1.2;color:#8c96a5}
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
.tdm-create .tdm-inline-field{display:flex;flex-direction:row;align-items:center;gap:12px;margin:0;min-width:0}
.tdm-create .tdm-inline-field>label:first-child{flex:0 0 88px;min-width:0;white-space:nowrap;color:#b0bac9;font-size:12px}
.tdm-create-meta .tdm-inline-field>label:first-child{flex-basis:94px}
.tdm-create .tdm-inline-field>.tdm-inline-control{flex:1;min-width:0}
.tdm-create .tdm-inline-field>input,.tdm-create .tdm-inline-field>select{flex:1;min-width:0;width:auto}
.tdm-create .tdm-slider-control{display:flex;align-items:center;gap:12px}
.tdm-create .tdm-slider-control input[type=range]{flex:1;min-width:45px;width:100%;padding:0;
 height:22px;background:transparent;accent-color:#68a3ff;cursor:pointer;border:0}
.tdm-create .tdm-slider-value{min-width:42px;text-align:right;font-variant-numeric:tabular-nums;color:#e1e9f6;font-size:12px;font-weight:600}
.tdm-create .tdm-inline-field select{max-width:100%}
@media(max-width:630px){.tdm-create .tdm-inline-field>label:first-child{flex-basis:66px}
 .tdm-create-meta{grid-template-columns:1fr!important}}
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
.tdm-create-bottom{display:flex;flex-direction:column;gap:9px;align-items:stretch;flex:none;
 padding-top:10px;border-top:1px solid #303744}
.tdm-create-bottom .tdm-inline-field{min-height:34px}
.tdm-seed-row{display:flex;gap:6px;align-items:stretch}
.tdm-seed-row input{flex:1;min-width:0}
.tdm-seed-random{flex:none;min-width:40px;padding:6px 10px;font-size:18px;line-height:1.15;
 display:grid;place-items:center}
.tdm-preview-options{display:flex;gap:16px;align-items:center;min-height:38px;flex-wrap:wrap}
.tdm-preview-option{display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap;
 font-size:12px;color:#b7bfcb;user-select:none}
.tdm-preview-option:has(input:checked){color:#edf4ff}
.tdm-preview-option input{width:16px!important;height:16px!important;margin:0;accent-color:#619ff1;cursor:pointer}
.tdm-preview-option input:focus-visible{outline:2px solid #9dc7fa;outline-offset:3px}
.tdm-preview-option input:disabled{cursor:not-allowed;opacity:.4}
.tdm-form.tdm-settings{width:min(560px,92vw);padding:22px}
.tdm-settings h2{margin:0;font-size:17px}
.tdm-settings .tdm-field{margin:16px 0}
.tdm-settings .tdm-form-actions{margin-top:20px}
.tdm-settings-note{font-size:11px;color:#929eae;line-height:1.65}
.tdm-batch-options{display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap;padding:12px 20px;
 background:#1b1e24;border-bottom:1px solid #353a43;flex:none}
.tdm-batch-option{display:flex;flex-direction:column;gap:6px;min-width:150px}
.tdm-batch-option>label{font-size:11px;color:#aeb8c6}
.tdm-batch-option select{background:#15171b;border:1px solid #434954;color:#eef0f5;
 padding:8px;border-radius:6px;font:12px system-ui;min-width:320px}
.tdm-batch-option:first-child{min-width:320px}
.tdm-batch-options .tdm-preview-options{min-height:34px}
.tdm-batch-options .tdm-batch-note{margin-left:auto;align-self:center}
.tdm-create .tdm-assets{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:9px}
.tdm-create .tdm-asset{padding:6px}
.tdm-create .tdm-asset label{font-size:11px}
.tdm-create .tdm-asset .tdm-media-icon{height:auto;min-height:0;aspect-ratio:4/3;box-sizing:border-box;gap:8px;font-size:26px}
.tdm-create .tdm-asset .tdm-media-icon small{font-size:12px;line-height:1.2;color:#91a5bd}
.tdm-create .tdm-asset label{display:flex;align-items:center;gap:4px;min-width:0}
.tdm-create .tdm-asset .tdm-asset-index{display:inline-flex;align-items:center;flex:none;
 padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;line-height:1.45}
.tdm-create .tdm-asset[data-kind="image"]{border-color:#607fa5}
.tdm-create .tdm-asset[data-kind="image"]:hover{border-color:#8db5e8;background:#222b37}
.tdm-create .tdm-asset[data-kind="image"] .tdm-asset-index{color:#d9ebff;background:rgba(103,154,220,.22)}
.tdm-create .tdm-asset[data-kind="video"]{border-color:#648b73}
.tdm-create .tdm-asset[data-kind="video"]:hover{border-color:#91c5a0;background:#243129}
.tdm-create .tdm-asset[data-kind="video"] .tdm-asset-index{color:#e0f6e7;background:rgba(104,168,123,.22)}
.tdm-create .tdm-asset[data-kind="audio"]{border-color:#8071a5}
.tdm-create .tdm-asset[data-kind="audio"]:hover{border-color:#ad9add;background:#2a2635}
.tdm-create .tdm-asset[data-kind="audio"] .tdm-asset-index{color:#efe7ff;background:rgba(141,112,201,.24)}
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

/* Batch prompt import: prompt parsing on the left, one shared media pool on the right. */
.tdm-form.tdm-batch{width:min(1480px,97vw);height:min(930px,95vh);max-height:95vh;padding:0;display:flex;flex-direction:column;overflow:hidden}
.tdm-batch-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid #353a43;flex:none}
.tdm-batch-head h2{font-size:17px;margin:0 0 4px}
.tdm-batch-head .tdm-small{font-size:11px;color:#929eae}
.tdm-batch-columns{display:grid;grid-template-columns:minmax(460px,1.08fr) minmax(400px,1fr);flex:1;min-height:0;gap:18px;padding:16px 20px}
.tdm-batch-left{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}
.tdm-batch-text{width:100%;height:34%;min-height:170px;max-height:44%;resize:vertical;box-sizing:border-box;background:#14171c;color:#e4e9f1;border:1px solid #414955;border-radius:7px;padding:12px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}
.tdm-batch-text:focus{outline:none;border-color:#6394d1}
.tdm-batch-text[readonly]{resize:vertical;cursor:text;color:#d8e0eb}
.tdm-batch-import-overlay{z-index:100040;background:rgba(0,0,0,.84)}
.tdm-form.tdm-batch-import{width:min(900px,92vw);max-height:88vh;display:flex;flex-direction:column;gap:12px}
.tdm-batch-import-head{display:flex;align-items:flex-start;gap:12px}
.tdm-batch-import-head h2{font-size:17px;margin:0 0 4px}
.tdm-batch-import-head .tdm-small{font-size:11px;color:#929eae}
.tdm-batch-import-text{width:100%;height:min(48vh,520px);min-height:230px;box-sizing:border-box;resize:vertical;
 background:#14171c;color:#e4e9f1;border:1px solid #414955;border-radius:7px;padding:12px;
 font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow:auto}
.tdm-batch-import-text:focus{outline:none;border-color:#6394d1}
.tdm-batch-import-drop{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
 border:1px dashed #596575;border-radius:8px;background:#1a2029;padding:12px 14px;color:#aeb9c8}
.tdm-batch-import-drop.dragover{border-color:#6ea5e7;background:#243449}
.tdm-batch-import-drop strong{font-size:12px;color:#dce5f2}
.tdm-batch-import-drop small{font-size:10px;color:#8996a8}
.tdm-batch-import-drop .tdm-space{min-width:10px}
.tdm-batch-import-error{font-size:11px;line-height:1.5;color:#f0b4a8;background:#382729;border:1px solid #70464a;border-radius:6px;padding:8px 10px}
.tdm-batch-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:3px}
.tdm-batch-item{display:flex;align-items:flex-start;gap:10px;text-align:left;width:100%;padding:10px 11px;border:1px solid #343b46;border-radius:7px;background:#1c2027;color:#dce4ef;cursor:pointer}
.tdm-batch-item:hover{background:#242c37}
.tdm-batch-item.active{background:#26364a;border-color:#5b86b9}
.tdm-batch-item-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.tdm-batch-item strong{font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.tdm-batch-item small{font-size:10px;color:#98a4b4;line-height:1.5}
.tdm-batch-item-status{font-size:10px;white-space:nowrap;color:#a9d7b3}
.tdm-batch-item-status.warn{color:#e6b77e}
.tdm-batch-right{display:flex;flex-direction:column;gap:9px;min-width:0;min-height:0;border-left:1px solid #353a43;padding-left:17px}
.tdm-batch-section-head{display:flex;align-items:center;gap:8px;justify-content:space-between}
.tdm-batch-section-head strong{font-size:12px;color:#e1e8f2}
.tdm-batch-section-head span{font-size:10px;color:#929eae}
.tdm-batch-ref-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:8px;
 flex:1;min-height:0;max-height:none;overflow:auto;align-content:start;padding:2px}
.tdm-batch-ref{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:7px 9px;border:1px solid #363d48;border-radius:6px;background:#1b2027;color:#dce4ef;cursor:pointer}
.tdm-batch-ref.active{border-color:#6394d1;background:#253449}
.tdm-batch-ref strong{font-size:11px;overflow-wrap:anywhere}
.tdm-batch-ref small{font-size:10px;color:#98a4b4;overflow-wrap:anywhere}
.tdm-batch-generated{font-size:10px;line-height:1.5;color:#c5a77f;padding:5px 0}
.tdm-batch-generated details{margin:4px 0;padding:6px 8px;border:1px solid #343c47;border-radius:5px;background:#171c23;color:#cbd5e1}
.tdm-batch-generated summary{cursor:pointer;color:#d6b47e;overflow-wrap:anywhere}
.tdm-batch-generated pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;margin:6px 0 0;padding:7px;border-radius:4px;background:#10141a;color:#d6deea;font:10px/1.55 inherit}
.tdm-batch-generated-warning{color:#e0a96e}
.tdm-batch-generated-open{padding:5px 9px;border:1px solid #455365;border-radius:6px;background:#252c36;color:#c6daef;font:11px system-ui;white-space:nowrap;cursor:pointer}
.tdm-batch-generated-open:hover{border-color:#7297c7;background:#2d3949;color:#eef6ff}
.tdm-batch-prompts-overlay{z-index:100060}
.tdm-form.tdm-batch-prompts{width:min(880px,92vw);max-height:min(84vh,820px);padding:0;overflow:hidden;display:flex;flex-direction:column}
.tdm-batch-prompts-head{padding:18px 20px 14px;border-bottom:1px solid #353c47;display:flex;align-items:center;gap:12px;flex:none}
.tdm-batch-prompts-head h2{margin:0;font-size:16px}
.tdm-batch-prompts-body{padding:16px 20px 20px;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px}
.tdm-batch-prompt-item{border:1px solid #3a4655;border-radius:8px;background:#1b2027;padding:11px;min-width:0}
.tdm-batch-prompt-info{display:flex;flex-wrap:wrap;gap:5px 10px;margin:0 0 9px;align-items:center}
.tdm-batch-prompt-info strong{font-size:12px;color:#dbe8fa}
.tdm-batch-prompt-info span{font-size:11px;color:#95a6bb}
.tdm-batch-prompt-editor{position:relative}
.tdm-batch-prompts .tdm-batch-prompt-text{display:block;width:100%;min-height:125px;height:150px;max-height:40vh;padding:13px 43px 12px 12px;resize:vertical;box-sizing:border-box;background:#141920;color:#dce3ed;border:1px solid #394555;border-radius:6px;font:12px/1.7 ui-monospace,Consolas,monospace}
.tdm-batch-prompt-copy{position:absolute;top:9px;right:9px;width:27px;height:27px;display:grid;place-items:center;padding:0;border:1px solid #485567;border-radius:5px;background:#26303d;color:#aebed3;cursor:pointer}
.tdm-batch-prompt-copy:hover{border-color:#83a9d9;color:#e3f1ff;background:#314257}
.tdm-batch-prompt-copy:disabled{opacity:.35;cursor:not-allowed}
.tdm-batch-prompt-empty{padding:28px 10px;text-align:center;font-size:12px;color:#9aa7b9}
.tdm-batch-summary{font-size:11px;color:#a9c7e7;line-height:1.5}
.tdm-batch-warning{font-size:10px;line-height:1.5;color:#e7b77e;background:#30271f;border:1px solid #624a31;border-radius:6px;padding:8px 10px}
.tdm-batch-warning:empty,.tdm-batch-generated:empty{display:none}
.tdm-batch-ref-card{display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px;border:1px solid #363d48;border-radius:8px;background:#1b2027}
.tdm-batch-ref-card[data-kind="image"]{border-color:#607fa5}
.tdm-batch-ref-card[data-kind="video"]{border-color:#648b73}
.tdm-batch-ref-card[data-kind="audio"]{border-color:#8071a5}
.tdm-batch-ref-card.active[data-kind="image"]{border-color:#8db5e8;background:#222b37;box-shadow:inset 0 0 0 1px rgba(141,181,232,.22)}
.tdm-batch-ref-card.active[data-kind="video"]{border-color:#91c5a0;background:#243129;box-shadow:inset 0 0 0 1px rgba(145,197,160,.22)}
.tdm-batch-ref-card.active[data-kind="audio"]{border-color:#ad9add;background:#2a2635;box-shadow:inset 0 0 0 1px rgba(173,154,221,.22)}
.tdm-batch-ref-head{display:flex;align-items:center;gap:6px;min-width:0}
.tdm-batch-ref-select{display:flex;align-items:center;gap:5px;flex:1;min-width:0;min-height:22px;padding:0;border:0;background:transparent;color:#dce4ef;text-align:left;cursor:pointer}
.tdm-batch-ref-index{display:inline-flex;align-items:center;flex:none;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;line-height:1.4}
.tdm-batch-ref-card[data-kind="image"] .tdm-batch-ref-index{color:#d9ebff;background:rgba(103,154,220,.22)}
.tdm-batch-ref-card[data-kind="video"] .tdm-batch-ref-index{color:#e0f6e7;background:rgba(104,168,123,.22)}
.tdm-batch-ref-card[data-kind="audio"] .tdm-batch-ref-index{color:#efe7ff;background:rgba(141,112,201,.24)}
.tdm-batch-ref-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aeb9c8;font-size:10px}
.tdm-batch-ref-remove{flex:none;width:25px;height:25px;padding:0;border:1px solid #3f4855;border-radius:5px;background:#222831;color:#aeb9c8;font-size:17px;line-height:1;cursor:pointer}
.tdm-batch-ref-remove:hover{border-color:#a65d66;background:#382328;color:#ffd6d9}
.tdm-batch-ref-remove:disabled{opacity:.35;cursor:not-allowed}
.tdm-batch-ref-sync{width:100%;margin-top:auto;padding:5px 7px;font-size:10px;line-height:1.35}
.tdm-batch-ref-preview{display:flex;flex:1;align-items:center;justify-content:center;min-height:110px;max-height:none;overflow:hidden;border-radius:5px;background:#11151b;cursor:pointer}
.tdm-batch-ref-preview:hover{outline:1px solid #657b96;outline-offset:-1px}
.tdm-batch-ref-preview img,.tdm-batch-ref-preview video{display:block;width:100%;height:100%;max-height:100%;object-fit:contain;background:#11151b}
.tdm-batch-ref-preview audio{display:block;width:100%;height:38px}
.tdm-batch-ref-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:7px;
 min-height:0;max-height:none;width:100%;box-sizing:border-box;padding:8px 10px;
 overflow:auto;color:#8491a2;text-align:center;font-size:10px}
.tdm-batch-ref-empty>span,.tdm-media-icon{font-size:24px;line-height:1;color:#91a5bd;flex:none}
.tdm-batch-ref-description{font-size:10px;line-height:1.45;color:#b5c0ce;overflow-wrap:anywhere;white-space:normal}
.tdm-asset .tdm-media-icon{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:74px;background:#11151b}
.tdm-batch-note{font-size:10px;color:#8f9cac;line-height:1.5}
.tdm-batch-autosave-hint{font-size:11px;line-height:1.4;color:#94a0b0;white-space:normal;text-align:right;max-width:260px}
.tdm-batch-foot{display:flex;align-items:center;gap:12px;padding:11px 20px 13px;border-top:1px solid #353a43;flex:none}
.tdm-batch-foot>div{min-width:0;display:flex;flex-direction:column;gap:3px}
.tdm-batch-empty{padding:16px;color:#8995a5;text-align:center;font-size:11px;line-height:1.6}
@media(max-width:850px){.tdm-form.tdm-batch{height:94vh}.tdm-batch-columns{grid-template-columns:1fr;overflow:auto}.tdm-batch-left{min-height:480px}.tdm-batch-right{border-left:0;border-top:1px solid #353a43;padding:14px 0 0;min-height:450px}}

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
function open() {
  root().style.display = "flex"; render();
  if(state.elapsedTimer==null)
    state.elapsedTimer=setInterval(updateVisibleElapsed,1000);
  void Promise.all([refresh(),loadTemplate()]);
}
function stopPreviewPlayback() {
  const players=state.root?.querySelectorAll?.("video") || [];
  for(const player of players){
    try{player.pause();player.removeAttribute?.("autoplay");}
    catch{/* closing the preview must not be blocked by a media element */}
  }
}
function close() {
  if(state.batchImport?.saving){
    toast("批量任务正在创建，请等待完成后再关闭","warning");return;
  }
  saveBatchImportDraft(state.batchImport);
  stopPreviewPlayback();
  if(state.elapsedTimer!=null){clearInterval(state.elapsedTimer);state.elapsedTimer=null;}
  closePreviewRichEditor(); state.creating = false; state.configuring = false;
  state.assetPicker = null; state.batchImport = null; state.deleting = null;
  state.settingsOpen=false;state.settingsDraft=null;
  if (state.root) state.root.style.display = "none";
}
async function refresh() {
  try {
    const result = await request("/tasks");
    state.tasks = result.tasks || [];
    renderSidebarTaskList();
    const visible=visibleTasks();
    const ids=new Set(visible.map(t=>t.id));
    state.selected = new Set([...state.selected].filter(id => ids.has(id)));
    if (!ids.has(state.focused)) state.focused = visible[0]?.id || null;
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
function taskIsQueued(task) {
  // queued_stage also remains set while a task runs; only pending stages
  // are waiting in ComfyUI's queue. Running tasks must never say "排队".
  return !!task?.queued_stage &&
    (task.status==="low_pending" || task.status==="high_pending");
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
    '<span class="tdm-status-icon" aria-hidden="true">'+esc(STATUS_ICONS[status])+'</span>'+
    esc(STATUS_NAMES[status]) + (taskIsQueued(task) ? " · 排队" : "") + '</span></div>' +
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
// Circles represent low-res; diamonds represent high-res.
 // Outline = waiting, centered mark = generating, solid = completed.
const STATUS_ICONS={
  low_pending:"○",low_running:"◉",low_complete:"●",
  high_pending:"◇",high_running:"◈",high_complete:"◆",
};
const STATUS_FILTER_OPTIONS=[
  {value:"all",label:"全部状态",icon:"≡"},
  ...Object.entries(STATUS_NAMES).map(([value,label])=>({
    value,label,icon:STATUS_ICONS[value],
  })),
];
function visibleTasks() {
  return state.statusFilter==="all" ? state.tasks :
    state.tasks.filter(t=>(t.status || "low_complete")===state.statusFilter);
}
function selectedTaskRows() {
  return state.tasks.filter(t=>state.selected.has(t.id));
}
function batchActionInfo() {
  const tasks=selectedTaskRows(),count=tasks.length;
  if(!count)return {label:"批量操作 · 0",disabled:true,action:null};
  const statuses=new Set(tasks.map(t=>t.status || "low_complete"));
  if(statuses.size!==1)
    return {label:"状态不一致 · "+count,disabled:true,action:null};
  const status=tasks[0].status || "low_complete";
  const label=(name,disabled=true,action=null)=>({
    label:name+" · "+count,disabled:disabled||state.busy,action,
  });
  if(status==="low_pending")
    return tasks.some(t=>t.kind!=="draft" || t.queued_stage)
      ? label("低清已排队")
      : label("批量开始预演",false,"low");
  if(status==="low_complete")
    return tasks.some(t=>t.queued_stage ||
      !(t.checkpoint_id || t.kind==="checkpoint"))
      ? label("高清不可续采")
      : label("批量高清续采",false,"high");
  if(status==="high_pending")return label(
    tasks.some(t=>t.queued_stage)?"高清已排队":"高清待生成");
  if(status==="low_running")return label("低清生成中");
  if(status==="high_running")return label("高清生成中");
  if(status==="high_complete")return label("高清已完成");
  return label("批量操作");
}
function randomizeNewTaskSeed(draft) {
  // One seed is used by the source and downstream sampler. Its saved
  // bounds were computed from their intersection when configuring workflow.
  if(draft)draft.seed=randomPreviewSeed(draft);
  return draft;
}

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
function stageElapsed(task,stage) {
  const high=stage==="high";
  const start=high?task?.high_started_at:task?.low_started_at;
  const end=high?task?.high_finished_at:task?.low_finished_at;
  if(!start)return "—";
  const running=high?task?.status==="high_running":task?.status==="low_running";
  return duration(start,end||(running?new Date().toISOString():null));
}
// Refresh just the elapsed labels, without replacing the browser's video element.
function updateVisibleElapsed() {
  if(!state.root || state.root.style.display==="none")return;
  const task=selectedTask();
  if(!task)return;
  for(const stage of ["low","high"]){
    const el=state.root.querySelector('[data-elapsed-stage="'+stage+'"]');
    if(el)el.textContent=stageElapsed(task,stage);
  }
}
function statusMarkup(task) {
  const status=task.status || "low_complete";
  const queued=taskIsQueued(task);
  return '<span class="tdm-status '+esc(status)+'">'+
    '<span class="tdm-status-icon" aria-hidden="true">'+
      esc(STATUS_ICONS[status] || STATUS_ICONS.low_pending)+'</span>'+
    esc(STATUS_NAMES[status] || STATUS_NAMES.low_pending)+(queued?" · 已排队":"")+'</span>';
}
function runningJobForTask(task) {
  if(!task)return null;
  for(const job of state.jobs.values()){
    if(!job.busy || !job.samplingProgress)continue;
    if((job.draftId && job.draftId===task.id) ||
       (job.checkpointId && (job.checkpointId===task.id ||
          job.checkpointId===task.checkpoint_id)))return job;
  }
  return null;
}
function taskProgressText(task) {
  const job=runningJobForTask(task);
  return job ? formatSamplingProgress(job.samplingProgress) : "";
}
function progressMarkup(task) {
  const text=taskProgressText(task);
  return '<span class="tdm-card-progress" data-progress-task-id="'+esc(task.id)+
    '" title="'+esc(text)+'">'+esc(text)+'</span>';
}
function updateTaskProgress(job) {
  if(!job?.samplingProgress)return;
  const ids=[job.draftId,job.checkpointId].filter(Boolean);
  if(!ids.length)return;
  const text=formatSamplingProgress(job.samplingProgress);
  for(const id of ids){
    const targets=state.root?.querySelectorAll('[data-progress-task-id]') || [];
    for(const target of targets){
      if(target.dataset.progressTaskId!==String(id))continue;
      target.textContent=text;
      target.title=text;
    }
  }
}
function handleSamplerProgress(event,fromState=false) {
  const detail=event.detail||{};
  // Never take progress from another prompt in the queue.
  const promptId=String(detail.prompt_id || state.activePromptId || "");
  if(!promptId || (state.activePromptId && promptId!==state.activePromptId))return;
  const job=state.jobs.get(promptId);
  if(!job || !job.busy || job.finalizing)return;
  const progress=fromState
    ? progressFromState(detail,job) : progressFromEvent(detail,job);
  if(!progress)return;
  if(recordSamplerProgress(job,progress))updateTaskProgress(job);
}
function thumb(task) {
  const media=task.media||{},kind=task.status==="high_complete"&&media.highres?"highres":
    media.sampling?"sampling":media.decoded?"decoded":null;
  if(!kind)return '<div class="tdm-thumb"></div>';
  const file=media[kind],id=task.checkpoint_id || task.id,url=mediaUrl(id,kind);
  return /\.(mp4|webm|mkv|mov|avi|m4v)$/i.test(file)
    ? '<video class="tdm-thumb" src="'+url+'#t=0.5" muted preload="metadata"></video>'
    : '<img class="tdm-thumb" src="'+url+'" alt="">';
}
/** Only real media sources get tabs: missing videos must never show an empty tab. */
function availablePreviewKinds(task) {
  const media=task?.media||{};
  const available=[];
  if(media.sampling || livePreviewJobForTask(task))available.push("sampling");
  if(media.decoded)available.push("decoded");
  if(media.highres)available.push("highres");
  return available;
}
function effectivePreviewKind(task) {
  const choices=availablePreviewKinds(task);
  if(state.preview!=="auto" && choices.includes(state.preview))return state.preview;
  if(choices.includes("highres") && task?.status==="high_complete")return "highres";
  if(choices.includes("decoded"))return "decoded";
  return choices[0]||null;
}
function previewJobMatchesTask(job,task) {
  if(!job || !task || job.mode!=="pause" || !samplingPreviewEnabled(job))return false;
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
    : '<img class="tdm-player" src="'+esc(url)+'" alt="采样预览">';
  const step=Number(p.step)||1,total=Number(p.total)||0;
  return '<div class="tdm-live-media">'+content+
    '<div class="tdm-live-caption">采样预览 · 第 '+step+
    (total?" / "+total:"")+' 步 · 仅内存预览，结束后保存</div></div>';
}
function updateLivePreview(job) {
  if(!state.root || state.root.style.display==="none")return;
  // The default "auto" tab also displays sampling media during low-res runs.
  // Check the *visible* tab instead of requiring a manual sampling-tab click.
  const task=selectedTask();
  if(effectivePreviewKind(task)!=="sampling" || !previewJobMatchesTask(job,task))return;
  const host=state.root.querySelector("[data-live-preview-host]");
  if(!host || host.dataset.taskId!==String(task.id))return;
  const wasPlaying=host.querySelector("video[data-live-video]");
  if(wasPlaying)wasPlaying.pause();
  host.innerHTML=livePreviewMarkup(job);
  const player=host.querySelector("video[data-live-video]");
  if(player){
    const target=Number(job.duration_seconds);
    if(Number.isFinite(target)&&target>=4&&target<=20){
      const setRate=()=>{
        if(Number.isFinite(player.duration)&&player.duration>0){
          player.playbackRate=Math.max(0.25,Math.min(4,player.duration/target));
        }
      };
      player.addEventListener("loadedmetadata",setRate,{once:true});
      if(player.readyState>=1)setRate();
    }
    void player.play().catch(()=>{});
  }
}
function details(task) {
  if(!task)return '<div class="tdm-no-media">选择左侧预演任务查看预览</div>';
  const media=task.media||{};
  const kind=effectivePreviewKind(task);
  const file=media[kind],cid=task.checkpoint_id || (task.kind==="checkpoint"?task.id:null);
  const live=kind==="sampling" ? livePreviewJobForTask(task) : null;
  const preview=live
    ? livePreviewMarkup(live)
    : !file || !cid
      ? '<div class="tdm-player tdm-detail-pending">'+
        (task.status==="high_complete" && !media.highres
          ? "高清已完成，但未找到关联的成片文件。请刷新预演台；若 ComfyUI 历史已清除，需要重新关联原始输出。"
          : task.status==="low_running"?"正在生成低清，等待采样预览":
            task.queued_stage?"已加入生成队列，等待开始执行":
            "尚未生成可用视频，请点击「开始预演」")+
        '</div>'
      : /\.(mp4|webm|mkv|mov|avi|m4v)$/i.test(file)
        ? '<video class="tdm-player" data-saved-video data-media-key="'+
          esc("saved:"+cid+":"+kind+":"+file+":"+(state.mediaRevisions.get(cid)||0))+
          '" src="'+mediaUrl(cid,kind)+
          '" controls loop playsinline preload="auto"></video>'
        : '<img class="tdm-player" src="'+mediaUrl(cid,kind)+'" alt="采样预览">';
  const previewDiagnostic=kind==="sampling" && !file && task.metadata?.preview_error
    ? '<div class="tdm-warning">预览未保存：'+esc(task.metadata.preview_error)+'</div>'
    : kind==="sampling" && file && task.metadata?.preview_warning
      ? '<div class="tdm-warning">'+esc(task.metadata.preview_warning)+'</div>'
      : '';
  const timing='<div class="tdm-timing"><div>任务创建：<strong>'+formatTime(task.created_at)+'</strong></div>'+
    '<div>低清开始：<strong>'+formatTime(task.low_started_at)+'</strong>'+
    '<span class="tdm-elapsed">用时：<span data-elapsed-stage="low">'+esc(stageElapsed(task,"low"))+'</span></span></div>'+
    '<div>高清开始：<strong>'+formatTime(task.high_started_at)+'</strong>'+
    '<span class="tdm-elapsed">用时：<span data-elapsed-stage="high">'+esc(stageElapsed(task,"high"))+'</span></span></div></div>';
  const pending=task.kind==="draft" && task.status==="low_pending" && !task.queued_stage;
  const canHigh=task.status==="low_complete" && !!cid && !task.queued_stage;
  const duplicate=task.kind==="draft" || task.metadata?.has_workflow;
  let actions='';
  if(pending)actions+='<button class="tdm-btn" data-action="edit-draft">编辑任务</button>'+
    '<button class="tdm-btn primary" data-action="run-draft">开始预演</button>';
  if(duplicate)actions+='<button class="tdm-btn" data-action="duplicate">以此新建</button>';
  if(canHigh)actions+='<button class="tdm-btn primary" data-action="highres">继续高清</button>';
  if(cid && task.status==="low_complete" && kind==="sampling")
    actions+='<button class="tdm-btn" data-action="rebuild-preview" '+(state.busy?'disabled':'')+
      '>重建预览</button>';
  if(task.kind==="checkpoint" && task.status==="low_complete")
    actions+='<button class="tdm-btn" data-action="load">载入任务工作流</button>';
  const labels={sampling:"采样预览",decoded:"低清视频",highres:"高清视频"};
  const tabs=availablePreviewKinds(task);
  return '<h3 style="margin:0;font-size:15px">'+esc(task.name||"未命名任务")+'</h3>'+
    statusMarkup(task)+
    (tabs.length?'<div class="tdm-tabs">'+
      tabs.map(tab=>'<button data-action="preview" data-kind="'+tab+'" class="'+
        (kind===tab?"on":"")+'">'+labels[tab]+'</button>').join("")+'</div>':"")+
    '<div data-live-preview-host data-task-id="'+esc(task.id)+'">'+preview+'</div>'+
    previewDiagnostic+
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
function captureRenderScrollPositions(root) {
  if(!root?.querySelectorAll)return [];
  return Array.from(root.querySelectorAll("[data-scroll-preserve]"),element=>({
    key:element.dataset.scrollPreserve,
    top:element.scrollTop,
    left:element.scrollLeft,
  })).filter(position=>position.key);
}
function restoreRenderScrollPositions(root,positions) {
  if(!root?.querySelectorAll||!Array.isArray(positions))return;
  const elements=Array.from(root.querySelectorAll("[data-scroll-preserve]"));
  for(const position of positions){
    const element=elements.find(item=>item.dataset.scrollPreserve===position.key);
    if(!element)continue;
    element.scrollTop=position.top;
    element.scrollLeft=position.left;
  }
}
function render() {
  if (!state.root || state.root.style.display === "none") return;
  const task = selectedTask();
  const visible=visibleTasks();
  const batch=batchActionInfo();
  const scrollPositions=captureRenderScrollPositions(state.root);
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
    '<button class="tdm-btn" data-action="settings">设置</button>' +
    '<button class="tdm-btn primary" data-action="create">＋ 新建预演</button>' +
    '<button class="tdm-btn" data-action="batch-create">批量添加</button>' +
    '<button class="tdm-btn" data-action="refresh">刷新</button><button class="tdm-btn close" data-action="close">×</button></header>' +
    '<div class="tdm-main"><section class="tdm-left" data-scroll-preserve="task-list"><div class="tdm-toolbar">' +
    '<label><input type="checkbox" data-action="select-all" ' +
    (visible.length && visible.every(t=>state.selected.has(t.id)) ? "checked" : "") +
    '> 全选</label>'+
    '<select class="tdm-status-filter" data-action="status-filter" aria-label="按任务状态筛选">'+
    STATUS_FILTER_OPTIONS.map(option=>'<option value="'+option.value+'"'+
      (option.value===state.statusFilter?' selected':'')+'>'+
      esc(option.icon+'  '+option.label)+'</option>').join("")+
    '</select><span class="tdm-space"></span><span class="tdm-small">已选 ' + state.selected.size + '</span></div>' +
    '<div class="tdm-list">' +
    (visible.length ? visible.map(t => '<div class="tdm-card ' + (t.id === state.focused ? "active" : "") +
      '" data-action="focus" data-id="' + esc(t.id) + '">' +
      '<input type="checkbox" data-action="select" data-id="' + esc(t.id) + '" ' +
      (state.selected.has(t.id) ? "checked" : "") + '>' + thumb(t) +
      '<div><h3>' + esc(t.name || "未命名镜头") + '</h3><div class="tdm-small">' +
      esc((t.created_at || "").replace("T", " ").slice(0, 16)) + '</div>' +
      '<div class="tdm-card-status-row">'+statusMarkup(t)+progressMarkup(t)+'</div>'+
      '<div class="tdm-small">创建 '+formatTime(t.created_at)+'</div>'+
      '<div class="tdm-small">'+(t.low_finished_at?'低清完成 '+formatTime(t.low_finished_at):
        t.low_started_at?'低清开始 '+formatTime(t.low_started_at):'尚未生成')+'</div>'+
      (t.high_finished_at?'<div class="tdm-small">高清完成 '+formatTime(t.high_finished_at)+'</div>':'')+
      '</div></div>').join("")
      : '<div class="tdm-blank">'+
      (state.tasks.length?'当前状态下没有预演任务，可更改上方筛选条件。':
        '还没有预演任务，点击「新建预演」创建任务，之后手动开始生成。')+
      '</div>') +
    '</div></section><section class="tdm-right">' + details(task) + '</section></div>' +
    '<footer class="tdm-foot">' +
    '<button class="tdm-btn danger" data-action="delete" ' +
    (!state.selected.size || state.busy ? "disabled" : "") +
    '>删除所选 · ' + state.selected.size + '</button>' +
    '<span class="tdm-space"></span><button class="tdm-btn primary" data-action="batch" ' +
    (batch.disabled ? "disabled" : "") +
    '>'+esc(batch.label)+'</button></footer></div>' +
    (state.creating ? createMarkup() : "") +
    (state.configuring ? configMarkup() : "") +
    (state.settingsOpen ? settingsMarkup() : "") +
    (state.deleting ? deleteMarkup() : "") +
    (state.batchImport ? batchImportMarkup() : "") +
    (state.batchImport && state.assetPicker ? assetPickerMarkup() : "") +
    (state.batchImport?.generatedPromptsOpen ? batchGeneratedPromptModalMarkup() : "");
  restoreRenderScrollPositions(state.root,scrollPositions);
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
  wireMediaFallback(state.root.querySelector(".tdm-assets"));
  wireMediaFallback(state.root.querySelector(".tdm-batch-ref-list"));
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
  const promptDropZone=el.querySelector("[data-batch-prompt-dropzone]");
  if(promptDropZone){
    const prevent=e=>{e.preventDefault();e.stopPropagation();};
    promptDropZone.addEventListener("dragenter",e=>{
      prevent(e);promptDropZone.classList.add("dragover");
    });
    promptDropZone.addEventListener("dragover",e=>{
      prevent(e);if(e.dataTransfer)e.dataTransfer.dropEffect="copy";
      promptDropZone.classList.add("dragover");
    });
    promptDropZone.addEventListener("dragleave",e=>{
      if(!promptDropZone.contains(e.relatedTarget))promptDropZone.classList.remove("dragover");
    });
    promptDropZone.addEventListener("drop",e=>{
      prevent(e);promptDropZone.classList.remove("dragover");
      const file=Array.from(e.dataTransfer?.files||[]).find(isBatchPromptFile);
      if(!file){toast("请拖入 .md、.markdown 或 .txt 提示词文件","warning");return;}
      void loadBatchPromptFile(file).catch(error=>toast("读取提示词失败："+(error?.message||error),"error"));
    });
  }
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
          new Set(visibleTasks().map(t => t.id)) : new Set();
        else if (e.target.checked) state.selected.add(control.dataset.id);
        else state.selected.delete(control.dataset.id);
        render();
      });
    } else if (action === "status-filter") {
      control.addEventListener("change",()=>{
        const next=control.value;
        state.statusFilter=STATUS_FILTER_OPTIONS.some(x=>x.value===next)?next:"all";
        const visible=visibleTasks(),ids=new Set(visible.map(t=>t.id));
        state.selected=new Set([...state.selected].filter(id=>ids.has(id)));
        if(!ids.has(state.focused))state.focused=visible[0]?.id||null;
        render();
      });
    } else if (action === "batch-import-text") {
      control.addEventListener("input",()=>{
        if(!state.batchImport)return;
        state.batchImport.importText=control.value;
        state.batchImport.importError="";
        state.root?.querySelector(".tdm-batch-import-error")?.remove();
      });
    } else if (action === "batch-text") {
      control.addEventListener("input",()=>{
        if(!state.batchImport)return;
        state.batchImport.text=control.value;parseBatchImportText();renderBatchImportViews();
      });
    } else if (action === "batch-resolution") {
      control.addEventListener("change",()=>{
        if(state.batchImport)state.batchImport.highres_megapixels=Number(control.value);
      });
    } else if (action === "batch-preview-option") {
      control.addEventListener("change",()=>{
        if(state.batchImport)state.batchImport[control.dataset.field]=control.checked;
      });
    } else if (action === "settings-resolution") {
      control.addEventListener("change",()=>{
        if(state.settingsDraft)state.settingsDraft.highres_megapixels=Number(control.value);
      });
    } else if (action === "settings-default-mode") {
      control.addEventListener("change",()=>{
        if(state.settingsDraft && control.checked)
          state.settingsDraft.default_preview_mode=control.value==="sampling"?"sampling":"decoded";
      });
    } else if (action === "task-duration") {
      control.addEventListener("input",()=>{
        if(!state.createDraft)return;
        const seconds=Number(control.value);
        if(!Number.isInteger(seconds) || seconds<PREVIEW_DURATION_MIN ||
           seconds>PREVIEW_DURATION_MAX)return;
        state.createDraft.duration_seconds=seconds;
        const output=state.root.querySelector("[data-duration-output]");
        if(output)output.textContent=seconds+" 秒";
      });
    } else if (action === "task-resolution") {
      control.addEventListener("change",()=>{
        if(state.createDraft)state.createDraft.highres_megapixels=Number(control.value);
      });
    } else if (action === "task-preview-option") {
      control.addEventListener("change",()=>{
        if(state.createDraft)state.createDraft[control.dataset.field]=control.checked;
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
        } else if(key==="h3_node_id") {
          const node=findH3ReferenceNode(state.configDraft.workflow,control.value);
          state.configDraft.h3_node_id=node?.id??null;
          state.configDraft.h3_media_bindings=node?h3MediaInputNames(node):[];
          state.configDraft.prompt_binding=node?{node_id:node.id,widget_name:"prompt"}:null;
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
    if (action === "batch-create") return await openBatchImport();
    if (action === "batch-import-browse") return browseBatchPromptFile();
    if (action === "batch-import-apply") return applyBatchPromptImport();
    if (action === "batch-import-cancel") {
      saveBatchImportDraft(state.batchImport);
      state.batchImport=null;state.assetPicker=null;
      return render();
    }
    if (action === "batch-import-recover") {
      const saved=readBatchImportDraft();
      if(!saved||!restoreBatchImportDraft(saved)){
        toast("没有找到可恢复的批量任务草稿","warning");return render();
      }
      state.assetPicker=null;
      render();
      toast("已恢复上次暂存的批量任务","success");
      return;
    }
    if (action === "batch-cancel") {
      if(state.batchImport?.saving)return;
      saveBatchImportDraft(state.batchImport);
      state.batchImport=null;state.assetPicker=null;return render();
    }
    if (action === "batch-select") {
      const batch=state.batchImport;
      if(batch){batch.activeIndex=Number(data.index)||0;
        const refs=batch.batches[batch.activeIndex]?.references||[];
        const missing=refs.findIndex(ref=>!ref.path);
        batch.selectedRefIndex=missing>=0?missing:(refs.length?0:-1);}
      return render();
    }
    if (action === "batch-select-ref") {
      if(state.batchImport)state.batchImport.selectedRefIndex=Number(data.index);
      return render();
    }
    if (action === "batch-open-assets") {
      const index=Number(data.index),ref=state.batchImport?.batches?.[state.batchImport.activeIndex]?.references?.[index];
      if(!ref)return;
      state.batchImport.selectedRefIndex=index;
      state.assetPicker={index,batchReferenceIndex:index,kind:ref.kind||"image",search:""};
      return render();
    }
    if (action === "batch-remove-asset") {
      removeBatchAsset(Number(data.index));
      return renderBatchImportViews();
    }
    if (action === "batch-sync-asset") {
      syncBatchAssetToOtherBatches(Number(data.index));
      return renderBatchImportViews();
    }
    if (action === "batch-generated-open") {
      if(state.batchImport)state.batchImport.generatedPromptsOpen=true;
      return render();
    }
    if (action === "batch-generated-close") {
      if(state.batchImport)state.batchImport.generatedPromptsOpen=false;
      return render();
    }
    if (action === "batch-generated-copy") return await copyBatchGeneratedPrompt(Number(data.index));
    if (action === "batch-submit") return await createBatchTasks();
    if (action === "focus") { state.focused = data.id; state.preview="auto"; return render(); }
    if (action === "preview") { state.preview = data.kind; return render(); }
    if (action === "rebuild-preview") {
      if(state.busy)return;
      const task=selectedTask();
      const id=task?.checkpoint_id || (task?.kind==="checkpoint"?task.id:null);
      if(!id || task.status!=="low_complete")throw Error("没有可重建的低清检查点");
      state.busy=true;
      render();
      try{
        await request("/tasks/"+encodeURIComponent(id)+"/rebuild-native-preview",{
          method:"POST",
        });
        // Same filename, different bytes: force Chromium to fetch fresh video.
        state.mediaRevisions.set(id,(state.mediaRevisions.get(id)||0)+1);
        toast("低清预览已从检查点重新生成，无需再次采样","success");
      }finally{
        state.busy=false;
        await refresh();
      }
      return;
    }
    if (action === "cancel-create") { state.creating = false; state.editDraftId = null; state.assetPicker = null; return render(); }
    if (action === "config") return await openConfig();
    if (action === "settings") {
      state.settingsDraft={...state.previewSettings};
      state.settingsOpen=true;return render();
    }
    if (action === "cancel-settings") {
      state.settingsOpen=false;state.settingsDraft=null;return render();
    }
    if (action === "save-settings") {
      const next=normalizePreviewSettings(state.settingsDraft);
      state.previewSettings=next;writePreviewSettings(next);
      state.settingsOpen=false;state.settingsDraft=null;
      toast("预演台默认设置已保存","success");return render();
    }
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
    if (action === "open-assets") {
      const index=Number(data.index),kind=state.createDraft?.assets?.[index]?.kind||"image";
      state.assetPicker={index,kind,search:""};return render();
    }
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
    if (action === "upload-asset") return uploadAsset(Number(data.index));
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
    if (action === "batch") return await batchSelected();
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
    if(state.template){
      const h3=findH3ReferenceNode(state.template.workflow,state.template.h3_node_id) ||
        findH3ReferenceNode(state.template.workflow,null);
      if(h3){
        state.template.h3_node_id=h3.id;
        state.template.h3_media_bindings=h3MediaInputNames(h3);
        state.template.prompt_binding={node_id:h3.id,widget_name:"prompt"};
      }
    }
  } catch(e) { toast("读取工作流配置失败："+e.message,"error"); }
  render();
}
async function loadInputFiles() {
  try {
    const response = await api.fetchApi("/terrydirector/api/input-files");
    state.inputFiles = (await response.json()).files || [];
  } catch { state.inputFiles = []; }
}
const H3_REFERENCE_CLASS = "MiniMaxH3ReferenceToVideo";
function h3ReferenceNodes(workflow) {
  return (workflow?.nodes||[]).filter(node =>
    String(node?.type||node?.properties?.["Node name for S&R"]||"")===H3_REFERENCE_CLASS);
}
function h3MediaInputKind(name) {
  const key=String(name||"");
  if(/^ref_images\.ref_image_\d+$/.test(key))return "image";
  if(/^ref_videos\.ref_video_\d+$/.test(key))return "video";
  if(/^ref_audios\.ref_audio_\d+$/.test(key))return "audio";
  if(/^ref_video_audios\.ref_video_audio_\d+$/.test(key))return "video_audio";
  return null;
}
// ComfyUI native MiniMaxH3ReferenceToVideo Autogrow schema limits.
const H3_REFERENCE_LIMITS = Object.freeze({image:9,video:3,video_audio:3,audio:3});
function h3MediaInputNames(node) {
  if(!node)return [];
  return [
    ...Array.from({length:H3_REFERENCE_LIMITS.image},(_,i)=>"ref_images.ref_image_"+i),
    ...Array.from({length:H3_REFERENCE_LIMITS.video},(_,i)=>"ref_videos.ref_video_"+i),
    ...Array.from({length:H3_REFERENCE_LIMITS.video_audio},(_,i)=>"ref_video_audios.ref_video_audio_"+i),
    ...Array.from({length:H3_REFERENCE_LIMITS.audio},(_,i)=>"ref_audios.ref_audio_"+i),
  ];
}
function h3MediaSlots(node) {
  if(!node)return [];
  const order={image:0,video:1,audio:2};
  return h3MediaInputNames(node).map(name=>{
    const kind=h3MediaInputKind(name);
    if(!kind||kind==="video_audio")return null;
    const match=name.match(/_(\d+)$/),index=Number(match?.[1]||0);
    const title=kind==="image"?"参考图片":kind==="video"?"参考视频":"独立音频";
    return {node_id:node.id,widget_name:name,value:"",kind,slot_kind:kind,
      slot_index:index,label:title+" "+(index+1),h3_media:true};
  }).filter(Boolean).sort((a,b)=>order[a.kind]-order[b.kind]||a.slot_index-b.slot_index);
}
function findH3ReferenceNode(workflow,nodeId) {
  const list=h3ReferenceNodes(workflow);
  return nodeId==null?(list.length===1?list[0]:null):
    list.find(node=>String(node.id)===String(nodeId))||null;
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
function matchingAssets(workflow,h3NodeId=null) {
  const h3=findH3ReferenceNode(workflow,h3NodeId);
  if(h3)return h3MediaSlots(h3);
  const loaders=[
    {kind:"image",pattern:/^(LoadImage|LoadImageMask)$/i,widgets:["image"]},
    {kind:"audio",pattern:/^(?:(?:VHS_)?LoadAudio(?:Path|Upload)?|AudioLoader)$/i,
      widgets:["audio","audio_file","audio_path","file","path"]},
    {kind:"video",pattern:/^(?:(?:VHS_)?LoadVideo(?:Path|Upload)?|VideoLoader)$/i,
      widgets:["video","video_path","file","path"]},
  ];
  const assets=[];
  for(const node of workflow?.nodes||[]){
    const loader=loaders.find(item=>item.pattern.test(String(node.type||"")));
    if(!loader)continue;
    const widget_name=loader.widgets.find(name=>typeof nodeValue(node,name)==="string");
    if(!widget_name)continue;
    assets.push({node_id:node.id,widget_name,value:nodeValue(node,widget_name),kind:loader.kind});
  }
  return assets;
}
const bindingKey = obj => JSON.stringify({ node_id: obj.node_id, widget_name: obj.widget_name });
function bindingNode(graph, binding) {
  return (graph?.nodes || []).find(n => String(n.id) === String(binding?.node_id));
}
function templateFromGraph(workflow, name) {
  const prompts = fieldsOf(workflow, "prompt");
  const seeds = fieldsOf(workflow, "seed");
  const pause = (workflow.nodes || []).find(n => n.type === START_CLASS);
  const h3Nodes=h3ReferenceNodes(workflow),h3=h3Nodes.length===1?h3Nodes[0]:null;
  return {
    schema: 1, workflow, workflow_name: name || "当前画布", source_name:name || "当前画布",
    pause_node_id: pause?.id || null,
    h3_node_id:h3?.id??null,
    h3_media_bindings:h3?h3MediaInputNames(h3):[],
    prompt_binding: h3?{node_id:h3.id,widget_name:"prompt"}:
      prompts.length === 1
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
  const h3Nodes=h3ReferenceNodes(state.configDraft.workflow);
  const h3=findH3ReferenceNode(state.configDraft.workflow,state.configDraft.h3_node_id) ||
    (h3Nodes.length===1?h3Nodes[0]:null);
  if(h3){
    state.configDraft.h3_node_id=h3.id;
    state.configDraft.prompt_binding={node_id:h3.id,widget_name:"prompt"};
    state.configDraft.h3_media_bindings=h3MediaInputNames(h3);
  }else{
    state.configDraft.h3_node_id=null;
    state.configDraft.h3_media_bindings=[];
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
function settingsMarkup() {
  const settings=state.settingsDraft||state.previewSettings;
  return '<div class="tdm-dialog"><section class="tdm-form tdm-settings" role="dialog" aria-modal="true">'+
    '<header class="tdm-modal-top"><h2>预演台设置</h2><span class="tdm-space"></span>'+
    '<button class="tdm-btn close" data-action="cancel-settings" aria-label="关闭">×</button></header>'+
    '<div class="tdm-field"><label>默认高清分辨率</label><select data-action="settings-resolution">'+
    PREVIEW_RESOLUTION_OPTIONS.map(mp=>'<option value="'+mp+'"'+
      (mp===Number(settings.highres_megapixels)?' selected':'')+'>'+mp.toFixed(2)+' MP</option>').join("")+
    '</select></div>'+
    '<div class="tdm-field"><label>默认预览方式</label>'+
    '<div class="tdm-preview-options" role="radiogroup" aria-label="默认预览方式">'+
    '<label class="tdm-preview-option"><input type="radio" name="tdm-default-preview-mode" '+
    'data-action="settings-default-mode" value="sampling" '+
    (settings.default_preview_mode==="sampling"?'checked':'')+'>采样预览</label>'+
    '<label class="tdm-preview-option"><input type="radio" name="tdm-default-preview-mode" '+
    'data-action="settings-default-mode" value="decoded" '+
    (settings.default_preview_mode!=="sampling"?'checked':'')+'>VAE 解码</label></div></div>'+
    '<div class="tdm-settings-note">只影响之后新建的任务和批次，不会修改已经创建的任务。</div>'+
    '<footer class="tdm-form-actions"><button class="tdm-btn" data-action="cancel-settings">取消</button>'+
    '<button class="tdm-btn primary" data-action="save-settings">保存默认设置</button></footer>'+
    '</section></div>';
}
function configMarkup() {
  const cfg=state.configDraft,graph=cfg?.workflow;
  const pauseNodes=(graph?.nodes||[]).filter(n=>n.type===START_CLASS);
  const prompts=fieldsOf(graph,"prompt");
  const seeds=fieldsOf(graph,"seed");
  const h3Nodes=h3ReferenceNodes(graph),h3=findH3ReferenceNode(graph,cfg?.h3_node_id);
  const h3Required=h3Nodes.length>0,h3Ready=!!h3;
  let lowresReview=null,lowresReviewError="";
  try{
    lowresReview=detectLowresReviewSink(graph,cfg?.api_prompt||{},cfg?.pause_node_id);
  }catch(error){lowresReviewError=String(error?.message||error);}
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
  const h3Markup=h3Nodes.length
    ? '<div class="tdm-field"><label>H3 参考生成节点</label><select data-action="config-field" data-field="h3_node_id">'+
      (h3Nodes.length>1?'<option value="">请选择 H3 节点</option>':'')+
      h3Nodes.map(node=>'<option value="'+esc(node.id)+'" '+
        (String(node.id)===String(cfg?.h3_node_id??(h3Nodes.length===1?h3Nodes[0].id:""))?'selected':'')+'>'+
        esc((node.title||node.type)+' #'+node.id)+'</option>').join("")+
      '</select><div class="tdm-small">已识别 MiniMax H3 参考生成视频节点。提示词和参考资产将直接写入该节点。</div></div>'
    : '<div class="tdm-field"><label>H3 参考生成节点</label><div class="tdm-small">未检测到 MiniMax H3 参考生成视频节点；当前使用通用输入映射。</div></div>';
  const promptMarkup=h3Ready
    ? '<div class="tdm-field"><label>提示词输入</label><div class="tdm-small">自动绑定 H3 节点的 prompt 输入。新建任务时直接覆盖该输入，不使用工作流中的外部文本/提示词节点。</div></div>'
    : '<div class="tdm-field"><label>提示词输入（STRING 输出节点）</label>'+selectBinding("prompt_binding",prompts)+'</div>'+
      (prompts.length>1?'<div class="tdm-small">检测到 '+prompts.length+
        ' 个 STRING 文本源，请选择本次预演需要接管的节点。</div>':'');
  const assetHelp=h3Ready
    ? '参考图片、视频和音频会直接接入 H3 节点对应输入端；原工作流中的媒体加载节点会被忽略。参考视频会自动提取画面及配对音轨。'
    : '参考资产将使用工作流内的 LoadImage、LoadAudio、LoadVideo 等媒体加载节点，在新建预演时编辑。';
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
    '<div class="tdm-field"><label>低清 VAE 解码（自动识别）</label>'+
    '<div class="tdm-small">'+
    (lowresReviewError?'检测异常：'+esc(lowresReviewError):
      lowresReview?
        '已检测：'+esc(lowresReview.type)+' #'+esc(lowresReview.id)+
        ' · 选择 VAE 解码预览时，自动保存到对应检查点 review.mp4（不改原工作流）':
        '未检测到完整的低清 VAE 视频+音频输出；仍可使用采样预览')+
    '</div></div>'+
    h3Markup+promptMarkup+
    '<div class="tdm-field"><label>种子输入（INT 输出节点）</label>'+
    selectBinding("seed_binding",seeds)+'</div>'+
    '<div class="tdm-small">'+assetHelp+'</div>'+
    (state.configError?'<div class="tdm-config-error">'+esc(state.configError)+'</div>':'')+
    '<div class="tdm-form-actions">'+
    '<button class="tdm-btn" data-action="cancel-config">取消</button>'+
    '<button class="tdm-btn primary" data-action="save-config" '+
    (state.configSaving||!pauseNodes.length||(!h3Required&&!prompts.length)||(h3Required&&!h3Ready)||!seeds.length?'disabled':'')+
    '>'+(state.configSaving?'保存中…':'保存工作流配置')+'</button></div>'+
    '</div></div></div></div>';
}

async function compileConfiguredWorkflow(cfg) {
  const h3Node=findH3ReferenceNode(cfg.workflow,cfg.h3_node_id);
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
  if(cfg.h3_node_id!=null && !h3Node)
    throw Error("配置的 MiniMax H3 参考生成视频节点不存在，请重新选择");
  if(h3Node && apiPrompt[String(h3Node.id)]?.class_type!==H3_REFERENCE_CLASS)
    throw Error("无法识别 H3 参考生成节点的 API 输入，请检查 ComfyUI 节点版本");
  const bindings=h3Node?["seed_binding"]:["prompt_binding","seed_binding"];
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
  if(h3Node && !Object.prototype.hasOwnProperty.call(apiPrompt[String(h3Node.id)]?.inputs||{},"prompt"))
    throw Error("H3 节点没有可覆盖的 prompt 输入");
  const targets=compilePreviewTargets(cfg.workflow,apiPrompt,cfg.pause_node_id);
  const seedRuntime=runtimeGraph.getNodeById?.(Number(cfg.seed_binding.node_id));
  const defResponse=await api.fetchApi("/object_info");
  if(!defResponse.ok)throw Error("无法读取采样器输入范围，请检查 ComfyUI 节点定义");
  const nodeDefinitions=await defResponse.json();
  const bounds=resolvePreviewSeedBounds(cfg.workflow,cfg.seed_binding,
    apiPrompt,nodeDefinitions,seedRuntime);
  return {
    ...cfg,schema:2,workflow:structuredClone(cfg.workflow),
    h3_node_id:h3Node?.id??null,
    h3_media_bindings:h3Node?h3MediaInputNames(h3Node):[],
    prompt_binding:h3Node?{node_id:h3Node.id,widget_name:"prompt"}:cfg.prompt_binding,
    api_prompt:apiPrompt, ...targets,
    seed_min:bounds.min,seed_max:bounds.max,
    seed_consumers:bounds.consumers,
  };
}
async function saveConfig() {
  const cfg=state.configDraft;
  if(state.configSaving)return;
  if(!cfg?.seed_binding || !cfg?.pause_node_id ||
     (!cfg?.h3_node_id && !cfg?.prompt_binding))
    throw Error("请选择暂停节点、H3 参考生成节点（或提示词源）和种子输入");
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
function buildDraft(cfg, overrides = [], preferredName = "", previewOptions = null) {
  const options=normalizeTaskPreviewOptions(previewOptions??cfg);
  if(options.vae_decode_enabled && !cfg.decoded_target){
    options.vae_decode_enabled=false;
    if(!options.sampling_preview_enabled)options.sampling_preview_enabled=true;
  }
  const values = overridesLookup(overrides);
  function valueAt(binding) {
    if (!binding) return "";
    const key = String(binding.node_id) + ":" + binding.widget_name;
    return values.has(key) ? values.get(key) :
      nodeValue(bindingNode(cfg.workflow, binding), binding.widget_name);
  }
  const assets = matchingAssets(cfg.workflow,cfg.h3_node_id).map(item => ({
    ...item, value: values.get(String(item.node_id) + ":" + item.widget_name) ?? item.value,
  }));
  return {
    workflow: structuredClone(cfg.workflow), workflow_name: cfg.workflow_name,
    pause_node_id: cfg.pause_node_id, prompt_binding: cfg.prompt_binding,
    seed_binding: cfg.seed_binding, preview_node_id: cfg.preview_node_id,
    h3_node_id:cfg.h3_node_id??null,
    h3_media_bindings:structuredClone(cfg.h3_media_bindings||[]),
    api_prompt: cfg.api_prompt ? structuredClone(cfg.api_prompt) : null,
    pause_target: cfg.pause_target, highres_target: cfg.highres_target,
    decoded_target: cfg.decoded_target, seed_min:cfg.seed_min,seed_max:cfg.seed_max,
    h3Properties: structuredClone(cfg.h3_properties || {}),
    name: preferredName || "新预演镜头",
    prompt: String(valueAt(cfg.prompt_binding) ?? ""),
    seed: String(valueAt(cfg.seed_binding) ?? "8"),
    previewType:legacyPreviewType(options),
    sampling_preview_enabled:options.sampling_preview_enabled,
    vae_decode_enabled:options.vae_decode_enabled,
    duration_seconds: Number(cfg.duration_seconds ?? PREVIEW_DURATION_DEFAULT),
    highres_megapixels: Number(cfg.highres_megapixels ?? state.previewSettings?.highres_megapixels ?? PREVIEW_RESOLUTION_DEFAULT),
    assets, source: "template",
  };
}
async function changeCreateSource(_data, source) {
  if (!source) return;
  state.editDraftId=null;
  if (source === "template") {
    if (!state.template) throw Error("请先在「配置工作流」中选择模板");
    state.createDraft = randomizeNewTaskSeed(buildDraft(state.template));
    state.createDraft.source = source;
  } else if (source.startsWith("task:")) {
    const id = source.slice(5);
    if(id.startsWith("draft_")){
      const prior=await request("/drafts/"+encodeURIComponent(id));
      const cfg={...prior,h3_properties:prior.h3_properties};
      state.createDraft=buildDraft(cfg,[],(prior.name||"预演镜头")+" · 新版",prior);
      state.createDraft.prompt=prior.prompt;
      state.createDraft.duration_seconds=Number(prior.duration_seconds ?? PREVIEW_DURATION_DEFAULT);
      state.createDraft.highres_megapixels=Number(prior.highres_megapixels ?? state.previewSettings.highres_megapixels ?? PREVIEW_RESOLUTION_DEFAULT);
      randomizeNewTaskSeed(state.createDraft);
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
    configured.duration_seconds=meta.duration_seconds ?? PREVIEW_DURATION_DEFAULT;
    configured.highres_megapixels=meta.highres_megapixels ?? PREVIEW_RESOLUTION_DEFAULT;
    state.createDraft = buildDraft(configured, result.overrides || [],
      (task.name || "预演镜头") + " · 新版", task.metadata || {});
    randomizeNewTaskSeed(state.createDraft);
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
    state.createDraft = randomizeNewTaskSeed(buildDraft(state.template));
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
async function openBatchImport() {
  if(!state.template)await loadTemplate();
  if(!state.template){
    state.creating=false;state.batchImport=null;
    await openConfig();
    toast("请先配置并保存预演工作流，再批量添加任务","warning");
    return;
  }
  await loadInputFiles();
  state.creating=false;state.configuring=false;state.assetPicker=null;
  state.editDraftId=null;
  const batchOptions=normalizeTaskPreviewOptions(defaultPreviewOptions());
  if(batchOptions.vae_decode_enabled && !state.template.decoded_target){
    batchOptions.vae_decode_enabled=false;
    if(!batchOptions.sampling_preview_enabled)batchOptions.sampling_preview_enabled=true;
  }
  state.batchImport={
    template:structuredClone(state.template),assetSlots:matchingAssets(state.template.workflow,state.template.h3_node_id),
    text:"",importText:"",importFileName:"",importError:"",promptImportOpen:true,
    preamble:"",generatedAssets:[],parseWarnings:[],parseErrors:[],
    batches:[],error:"",activeIndex:0,selectedRefIndex:-1,
    saving:false,
    highres_megapixels:state.previewSettings.highres_megapixels,
    sampling_preview_enabled:batchOptions.sampling_preview_enabled,
    vae_decode_enabled:batchOptions.vae_decode_enabled,
  };
  render();
}
function restoreBatchImportDraft(draft) {
  if(!draft||!state.template)return false;
  const template=structuredClone(state.template);
  // Reparse old saved drafts: they predate document-level [待生成资产] support.
  const parsedDraft=draft.text?parsePreviewBatches(draft.text):null;
  const batches=(Array.isArray(draft.batches)?draft.batches:[]).map(item=>({
    ...item,
    references:(Array.isArray(item.references)?item.references:[]).map(ref=>{
      const kind=ref.kind||"image",path=String(ref.path||"");
      const available=path&&state.inputFiles.some(file=>file.kind===kind&&file.path===path);
      return {...ref,kind,path:available?path:""};
    }),
    generatedAssets:Array.isArray(item.generatedAssets)?item.generatedAssets:[],
  }));
  const activeIndex=batches.length?Math.max(0,Math.min(Number(draft.activeIndex)||0,batches.length-1)):0;
  const refs=batches[activeIndex]?.references||[];
  let selectedRefIndex=Number.isInteger(Number(draft.selectedRefIndex))?Number(draft.selectedRefIndex):-1;
  if(!refs.length)selectedRefIndex=-1;
  else if(selectedRefIndex<0||selectedRefIndex>=refs.length){
    const missing=refs.findIndex(ref=>!ref.path);
    selectedRefIndex=missing>=0?missing:0;
  }
  const options=normalizeTaskPreviewOptions(draft,defaultPreviewOptions());
  if(options.vae_decode_enabled&&!template.decoded_target){
    options.vae_decode_enabled=false;
    if(!options.sampling_preview_enabled)options.sampling_preview_enabled=true;
  }
  const mp=Number(draft.highres_megapixels);
  state.batchImport={
    template,assetSlots:matchingAssets(template.workflow,template.h3_node_id),
    text:String(draft.text||""),importText:String(draft.importText||draft.text||""),
    importFileName:String(draft.importFileName||""),importError:"",
    promptImportOpen:draft.phase==="import"||!batches.length,
    preamble:parsedDraft?.batches?.length?parsedDraft.preamble:String(draft.preamble||""),
    generatedAssets:Array.isArray(draft.generatedAssets)?draft.generatedAssets:(parsedDraft?.generatedAssets||[]),
    parseWarnings:Array.isArray(draft.parseWarnings)?draft.parseWarnings:(parsedDraft?.parseWarnings||[]),
    parseErrors:Array.isArray(draft.parseErrors)?draft.parseErrors:(parsedDraft?.parseErrors||[]),
    batches,error:String(draft.error||""),
    activeIndex,selectedRefIndex,saving:false,
    highres_megapixels:PREVIEW_RESOLUTION_OPTIONS.includes(mp)?mp:state.previewSettings.highres_megapixels,
    sampling_preview_enabled:options.sampling_preview_enabled,
    vae_decode_enabled:options.vae_decode_enabled,
  };
  return true;
}
function wireMediaFallback(holder) {
  if (!holder) return;
  holder.querySelectorAll(".tdm-media-thumb").forEach(media => {
    const fallback = () => {
      const placeholder = document.createElement("span");
      placeholder.className = "tdm-noimg";
      placeholder.textContent = media.tagName==="VIDEO"?"视频无法预览":
        media.tagName==="AUDIO"?"音频无法播放":"图片未找到";
      media.replaceWith(placeholder);
    };
    if(media.tagName==="IMG"){
      if(media.complete && media.naturalWidth===0)fallback();
      else media.addEventListener("error",fallback,{once:true});
    }else if(media.tagName==="VIDEO"){
      const seekFirstFrame=()=>{
        if(!Number.isFinite(media.duration)&&media.duration!==Infinity)return;
        try{media.currentTime=Math.min(0.12,Math.max(0,(media.duration||0.12)/2));}catch{}
      };
      media.addEventListener("loadedmetadata",seekFirstFrame,{once:true});
      media.addEventListener("seeked",()=>media.pause(),{once:true});
      if(media.readyState>=1)seekFirstFrame();
      media.addEventListener("error",fallback,{once:true});
    }else media.addEventListener("error",fallback,{once:true});
  });
}
function assetUrl(path) {
  if (!path) return "";
  return "/view?filename=" + encodeURIComponent(path) + "&type=input";
}
function mediaKindLabel(kind) {
  return kind==="video"?"视频":kind==="audio"?"音频":"图片";
}
function mediaKindIcon(kind) {
  return kind==="video"?"▶":kind==="audio"?"♫":"▧";
}
function mediaPreviewMarkup(file,options={}) {
  const kind=file?.kind||options.kind||"image",path=file?.path||"";
  if(!path)return kind==="image"?'<span class="tdm-noimg"><span>＋</span><small>添加图片</small></span>':
    '<span class="tdm-media-icon">'+mediaKindIcon(kind)+'<small>未绑定'+mediaKindLabel(kind)+'</small></span>';
  const url=file?.preview_url||assetUrl(path);
  if(kind==="image")return '<img class="tdm-media-thumb" loading="lazy" src="'+esc(url)+'" alt="">';
  if(kind==="video"&&options.controls)
    return '<video class="tdm-media-thumb" src="'+esc(url)+'" controls muted playsinline preload="metadata"></video>';
  if(kind==="audio"&&options.controls)
    return '<audio class="tdm-media-thumb" src="'+esc(url)+'" controls preload="metadata"></audio>';
  return '<span class="tdm-media-icon">'+mediaKindIcon(kind)+'<small>'+mediaKindLabel(kind)+'</small></span>';
}
function assetCard(path, title, attrs, selected = false, kind = "image", incompatible = false, slotLabel = false) {
  const file=state.inputFiles.find(item=>item.path===path)||{path,kind,preview_url:path?assetUrl(path):""};
  const preview=mediaPreviewMarkup(file,{kind});
  const labelText=String(title || path || ("添加"+mediaKindLabel(kind)));
  const primaryLabel=slotLabel?labelText.split(" · ")[0].replace(/^(?:参考|独立)/,""):labelText;
  const labelMarkup=slotLabel
    ? '<span class="tdm-asset-index">'+esc(primaryLabel)+'</span>'
    : esc(labelText);
  return '<button type="button" class="tdm-asset' + (selected ? ' selected' : '')+
    (incompatible?' incompatible':'')+'" data-kind="'+esc(kind)+'" '+attrs+'>'+preview+
    '<label title="' + esc(path || "未选择") + '">' + labelMarkup + '</label></button>';
}
function resolutionOptionsMarkup(selectedValue,ratioLabel) {
  return PREVIEW_RESOLUTION_OPTIONS.map(mp=>{
    const info=taskResolutionInfo(mp,ratioLabel);
    return '<option value="'+mp+'"'+(mp===Number(selectedValue)?' selected':'')+'>'+
      esc(mp.toFixed(2)+' MP 高清 ('+info.high.width+'×'+info.high.height+
        ') · '+info.lowMp.toFixed(2)+' MP 低清 ('+info.low.width+'×'+info.low.height+')')+
      '</option>';
  }).join("");
}
function createMarkup() {
  const draft = state.createDraft;
  if (!draft) return "";
  const ratio=taskAspectRatio(draft.api_prompt,draft.workflow);
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
    '<div class="tdm-field tdm-inline-field"><label class="tdm-name-label" for="tdm-new-task-name">'+
    (state.editDraftId?"编辑任务名称":"新建任务名称")+'</label>' +
    '<input id="tdm-new-task-name" data-action="draft-field" data-field="name" ' +
    'maxlength="120" value="' + esc(draft.name) + '"></div>' +
    '<div class="tdm-field tdm-inline-field"><label for="tdm-new-task-source">基于</label>'+
    '<select id="tdm-new-task-source" data-action="source-change">' +
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
    '<div class="tdm-field tdm-inline-field"><label for="tdm-new-task-seed">种子</label><div class="tdm-inline-control tdm-seed-row">' +
    '<input id="tdm-new-task-seed" data-action="draft-field" data-field="seed" ' +
    'inputmode="numeric" value="' + esc(draft.seed) + '">' +
    '<button type="button" class="tdm-btn tdm-seed-random" data-action="random-seed" ' +
    'title="生成随机种子" aria-label="生成随机种子">🎲</button></div></div>' +
    '<div class="tdm-field tdm-inline-field"><label for="tdm-task-duration">视频时长</label>'+
    '<div class="tdm-inline-control tdm-slider-control">'+
    '<input type="range" id="tdm-task-duration" min="4" max="20" step="1" '+
    'data-action="task-duration" aria-label="视频时长" value="'+esc(draft.duration_seconds)+'">'+
    '<output class="tdm-slider-value" for="tdm-task-duration" data-duration-output>'+
      esc(draft.duration_seconds)+' 秒</output></div></div>'+
    '<div class="tdm-field tdm-inline-field"><label for="tdm-task-resolution">高清分辨率</label>'+
    '<select id="tdm-task-resolution" data-action="task-resolution">'+
    resolutionOptionsMarkup(draft.highres_megapixels,ratio)+'</select></div>'+
    '<div class="tdm-field tdm-inline-field"><label>预览输出</label>' +
    '<div class="tdm-inline-control tdm-preview-options" aria-label="预览输出">' +
    '<label class="tdm-preview-option"><input type="checkbox" data-action="task-preview-option" ' +
    'data-field="sampling_preview_enabled" '+(draft.sampling_preview_enabled?'checked':'')+
    '>采样预览</label>' +
    '<label class="tdm-preview-option"><input type="checkbox" data-action="task-preview-option" ' +
    'data-field="vae_decode_enabled" '+(draft.vae_decode_enabled?'checked':'')+
    (!draft.decoded_target?' disabled title="当前工作流未识别到低清 VAE 解码线路"':'')+
    '>VAE 解码</label></div></div></div>' +
    '</section>' +
    '<aside class="tdm-create-right">' +
    '<div class="tdm-section">参考资产 <span class="tdm-small">· 点击缩略图替换</span></div>' +
    (draft.h3_node_id?'<div class="tdm-small">H3 上限：图片 9 · 视频 3 · 独立音频 3；视频音轨自动配对</div>':'') +'<div class="tdm-assets">' + draft.assets.map((asset,i) =>
      assetCard(asset.value, (asset.label||mediaKindLabel(asset.kind)+" "+(i+1))+" · "+(asset.value||"未设置"),
        'data-action="open-assets" data-index="' + i + '"',false,asset.kind||"image",false,true)).join("") + '</div>' +
    (draft.assets.length ? '' : '<div class="tdm-small">'+
      (draft.h3_node_id?'当前 H3 节点没有可用的参考输入槽位':'当前模板没有可识别的图片、视频或音频输入')+'</div>') +
    '</aside></div></div>' +
    '<footer class="tdm-create-foot"><span class="tdm-small">创建任务只保存配置，不会启动 ComfyUI 生成。</span>' +
    '<span class="tdm-space"></span>' +
    '<button class="tdm-btn" data-action="cancel-create">取消</button>' +
    '<button class="tdm-btn primary" data-action="submit">'+
    (state.editDraftId?'保存修改':'创建任务')+'</button></footer>' +
    '</div></div>' +
    (state.assetPicker ? assetPickerMarkup() : "");
}
function findBatchPoolAsset(name,kind="image") {
  const wanted=String(name||"").replace(/\\/g,"/").split("/").pop().trim().toLowerCase();
  if(!wanted)return null;
  const candidates=state.inputFiles.filter(file=>file.kind===kind);
  const exact=candidates.find(file=>{
    const fileName=String(file.name||"").toLowerCase();
    const pathName=String(file.path||"").replace(/\\/g,"/").split("/").pop().toLowerCase();
    return fileName===wanted||pathName===wanted||String(file.path||"").toLowerCase().endsWith("/"+wanted);
  });
  if(exact)return exact.path;
  if(wanted.length<2)return null;
  const partial=candidates.filter(file=>{
    const fileName=String(file.name||"").toLowerCase();
    const pathName=String(file.path||"").replace(/\\/g,"/").split("/").pop().toLowerCase();
    return fileName.includes(wanted)||pathName.includes(wanted);
  });
  return partial.length===1?partial[0].path:null;
}
function parseBatchImportText() {
  const batch=state.batchImport;if(!batch)return;
  const previous=new Map((batch.batches||[]).map(item=>[
    item.name,(item.references||[]).map(ref=>({name:ref.name,path:ref.path,kind:ref.kind||"image"}))
  ]));
  const parsed=parsePreviewBatches(batch.text);
  batch.preamble=parsed.preamble;batch.error=parsed.error;
  batch.generatedAssets=parsed.generatedAssets||[];
  batch.parseWarnings=parsed.parseWarnings||[];
  batch.parseErrors=parsed.parseErrors||[];
  batch.batches=parsed.batches.map(item=>({
    ...item,
    references:item.references.map((ref,index)=>{
      const oldRefs=previous.get(item.name)||[];
      const saved=oldRefs[index]?.name===ref.name&&oldRefs[index]?.kind===ref.kind?
        oldRefs[index].path:oldRefs.find(old=>old.name===ref.name&&old.kind===ref.kind)?.path;
      const savedExists=saved&&state.inputFiles.some(file=>file.kind===ref.kind&&file.path===saved);
      return {...ref,path:savedExists?saved:findBatchPoolAsset(ref.name,ref.kind)};
    }),
  }));
  batch.activeIndex=Math.min(batch.activeIndex,Math.max(0,batch.batches.length-1));
  const refs=batch.batches[batch.activeIndex]?.references||[];
  if(!refs.length)batch.selectedRefIndex=-1;
  else if(batch.selectedRefIndex<0||batch.selectedRefIndex>=refs.length){
    const missing=refs.findIndex(ref=>!ref.path);batch.selectedRefIndex=missing>=0?missing:0;
  }
}
function batchTaskStatus(item) {
  const slots=state.batchImport?.assetSlots||[],references=item.references||[];
  const kinds=["image","audio","video"];
  const overflowByKind=Object.fromEntries(kinds.map(kind=>[
    kind,Math.max(0,references.filter(ref=>(ref.kind||"image")===kind).length-
      slots.filter(slot=>(slot.kind||"image")===kind).length)
  ]));
  const overflow=Object.values(overflowByKind).reduce((sum,value)=>sum+value,0);
  const missing=references.filter(ref=>!ref.path).length,empty=!String(item.body||"").trim();
  const formatErrors=(item.parseErrors||[]).length;
  return {overflow,overflowByKind,missing,empty,formatErrors,valid:!overflow&&!missing&&!empty&&!formatErrors};
}
function batchImportStats() {
  const items=state.batchImport?.batches||[];
  const valid=items.filter(item=>batchTaskStatus(item).valid).length;
  return {total:items.length,valid,invalid:items.length-valid,slots:state.batchImport?.assetSlots?.length||0};
}
function batchListMarkup() {
  const batch=state.batchImport;
  if(!batch?.batches.length)return '<div class="tdm-batch-empty">'+esc(batch?.error||"粘贴或导入 Markdown 后，将在这里显示识别出的批次。")+'</div>';
  return batch.batches.map((item,index)=>{
    const status=batchTaskStatus(item);
    const label=status.formatErrors?"引用格式错误 "+status.formatErrors+" 项":
      status.overflow?"超出媒体槽位 "+status.overflow+" 项":
      status.missing?"缺少资产 "+status.missing+" 项":status.empty?"正文为空":"可创建";
    return '<button type="button" class="tdm-batch-item '+(index===batch.activeIndex?"active":"")+
      '" data-action="batch-select" data-index="'+index+'"><span class="tdm-batch-item-main">'+
      '<strong>'+esc(item.name)+'</strong><small>'+item.duration_seconds+' 秒 · '+String(item.sourceBody||item.body).length+' 字 · '+
      item.references.length+' 项引用资产'+(item.generatedAssets.length?' · '+item.generatedAssets.length+' 项待生成资产':'')+
      '</small></span><span class="tdm-batch-item-status '+(status.valid?"":"warn")+'">'+esc(label)+'</span></button>';
  }).join("");
}
function batchSlotPreviewMarkup(ref) {
  const file=state.inputFiles.find(item=>item.path===ref.path&&item.kind===(ref.kind||"image"));
  if(!file)return '<div class="tdm-batch-ref-empty"><span>'+mediaKindIcon(ref.kind)+'</span>'+
    (ref.description?'<small class="tdm-batch-ref-description">'+esc(ref.description)+'</small>':'')+'</div>';
  return mediaPreviewMarkup(file,{controls:true});
}
function batchReferenceLabel(item,index) {
  const ref=item?.references?.[index];
  const kind=ref?.kind||"image";
  const number=(item?.references||[]).slice(0,index+1)
    .filter(entry=>(entry.kind||"image")===kind).length;
  return mediaKindLabel(kind)+" "+number+(ref?.displayName?" · "+ref.displayName:"");
}
function batchReferencesMarkup() {
  const batch=state.batchImport,item=batch?.batches?.[batch.activeIndex];
  if(!item)return '<div class="tdm-batch-empty">选择左侧批次查看引用资产</div>';
  if(!item.references.length)return '<div class="tdm-batch-empty">本批次没有声明现成图片、音频或视频引用。工作流媒体输入将保持默认值。</div>';
  return item.references.map((ref,index)=>{
    const selected=index===batch.selectedRefIndex,kind=ref.kind||"image";
    const file=state.inputFiles.find(entry=>entry.path===ref.path&&entry.kind===kind);
    const label=batchReferenceLabel(item,index),separator=label.indexOf(" · ");
    const primary=separator>=0?label.slice(0,separator):label;
    const secondary=separator>=0?label.slice(separator):"";
    return '<article class="tdm-batch-ref-card '+(selected?"active":"")+'" data-kind="'+esc(kind)+'">'+
      '<div class="tdm-batch-ref-head">'+
      '<button type="button" class="tdm-batch-ref-select" data-action="batch-select-ref" data-index="'+index+'">'+
      '<span class="tdm-batch-ref-index">'+esc(primary)+'</span>'+
      (secondary?'<span class="tdm-batch-ref-name">'+esc(secondary)+'</span>':"")+'</button>'+
      '<button type="button" class="tdm-batch-ref-remove" data-action="batch-remove-asset" data-index="'+index+'" '+
      (!ref.path||batch.saving?'disabled ':'')+'title="清除当前绑定" aria-label="清除当前绑定">×</button></div>'+
      '<div class="tdm-batch-ref-preview" data-action="batch-open-assets" data-index="'+index+'" role="button" tabindex="0" '+
      'title="点击选择或替换资产">'+batchSlotPreviewMarkup(ref)+'</div>'+
      '<button type="button" class="tdm-btn tdm-batch-ref-sync" data-action="batch-sync-asset" data-index="'+index+'" '+
      (file?'':'disabled ')+'title="将相同媒体类型、相同引用名称的绑定同步到其他批次">同步到其他批次</button>'+
      '</article>';
  }).join("");
}
function batchGeneratedPromptEntries() {
  const batch=state.batchImport||{};
  const global=(batch.generatedAssets||[]).map(asset=>({
    batchName:"文档全局",
    name:String(asset.name||"未命名资产"),
    type:asset.type||"image",
    prompt:String(asset.prompt||""),
  }));
  const local=(batch.batches||[]).flatMap((item,batchIndex)=>
    (item.generatedAssets||[]).map(asset=>{
      if(typeof asset==="string")return {
        batchName:item.name||"批次 "+(batchIndex+1),
        name:asset,type:"image",prompt:"",
      };
      return {
        batchName:item.name||"批次 "+(batchIndex+1),
        name:String(asset.name||"未命名资产"),
        type:asset.type||"image",
        prompt:String(asset.prompt||""),
      };
    }));
  // A shared asset is generated once, even if several batches refer to it.
  const seen=new Set();
  return [...global,...local].filter(entry=>{
    const key=entry.type+"\u0000"+entry.name+"\u0000"+entry.prompt;
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}
function batchGeneratedPromptModalMarkup() {
  const entries=batchGeneratedPromptEntries();
  const blocks=entries.map((entry,index)=>{
    const typeLabel=({image:"图片",audio:"音频",video:"视频"})[entry.type]||"资产";
    return '<section class="tdm-batch-prompt-item">'+
      '<div class="tdm-batch-prompt-info"><strong>'+esc(entry.name)+'</strong>'+
      '<span>'+esc(typeLabel)+' · '+esc(entry.batchName)+'</span></div>'+
      '<div class="tdm-batch-prompt-editor">'+
      '<textarea class="tdm-batch-prompt-text" readonly spellcheck="false" aria-label="'+
      esc(entry.name)+'的生成提示词">'+esc(entry.prompt||"尚未提供生成提示词")+'</textarea>'+
      '<button type="button" class="tdm-batch-prompt-copy" data-action="batch-generated-copy" data-index="'+index+'" '+
      (!entry.prompt.trim()?'disabled ':'')+'title="复制提示词" aria-label="复制'+esc(entry.name)+'的提示词">'+
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '+
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
      '<rect x="8" y="8" width="12" height="12" rx="2"/>'+
      '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button></div></section>';
  }).join("");
  return '<div class="tdm-dialog tdm-batch-prompts-overlay">'+
    '<section class="tdm-form tdm-batch-prompts" role="dialog" aria-modal="true" aria-label="待生成资产提示词">'+
    '<header class="tdm-batch-prompts-head"><h2>待生成资产提示词</h2>'+
    '<span class="tdm-small">'+entries.length+' 项 · 按文档与批次顺序排列</span>'+
    '<span class="tdm-space"></span>'+
    '<button class="tdm-btn close" data-action="batch-generated-close" aria-label="关闭">×</button></header>'+
    '<div class="tdm-batch-prompts-body" data-scroll-preserve="generated-prompts">'+
    ((state.batchImport?.parseWarnings||[]).map(message=>'<div class="tdm-batch-generated-warning">'+esc(message)+'</div>').join("")+
      (state.batchImport?.parseErrors||[]).map(message=>'<div class="tdm-batch-generated-warning">解析错误：'+esc(message)+'</div>').join("")+
      (blocks||'<div class="tdm-batch-prompt-empty">当前批量任务没有待生成资产提示词</div>'))+
    '</div></section></div>';
}
async function copyBatchGeneratedPrompt(index) {
  const entry=batchGeneratedPromptEntries()[index];
  if(!entry?.prompt?.trim())return false;
  let copied=false;
  try {
    if(typeof navigator!=="undefined"&&navigator.clipboard?.writeText){
      try{await navigator.clipboard.writeText(entry.prompt);copied=true;}catch{/* Fallback below */ }
    }
    if(!copied){
      const textarea=document.createElement("textarea");
      textarea.value=entry.prompt;
      textarea.style.position="fixed";
      textarea.style.opacity="0";
      document.body.appendChild(textarea);
      try{
        textarea.focus();textarea.select();
        copied=!!document.execCommand("copy");
      }finally{textarea.remove();}
    }
    if(!copied)throw Error("剪贴板不可用");
    toast("已复制："+entry.name,"success");
    return true;
  }catch(error){
    toast("复制失败："+(error?.message||error),"error");
    return false;
  }
}
function batchGeneratedMarkup() {
  const item=state.batchImport?.batches?.[state.batchImport.activeIndex];
  if(!item)return "";
  const warnings=(item.parseWarnings||[]).map(warning=>
    '<div class="tdm-small tdm-batch-generated-warning">'+esc(warning)+'</div>').join("");
  const errors=(item.parseErrors||[]).map(error=>
    '<div class="tdm-small tdm-batch-generated-warning">引用格式错误：'+esc(error)+'</div>').join("");
  const unparsed=(item.unparsedGeneratedAssets||[]).map(value=>
    '<details><summary>未识别的待生成资产内容</summary><pre>'+esc(value)+'</pre></details>').join("");
  return warnings+errors+unparsed;
}
function batchImportSummary() {
  const stats=batchImportStats(),slots=state.batchImport?.assetSlots||[];
  const capacities=["image","audio","video"].filter(kind=>slots.some(slot=>(slot.kind||"image")===kind))
    .map(kind=>mediaKindLabel(kind)+" "+slots.filter(slot=>(slot.kind||"image")===kind).length);
  return stats.total+' 个批次 · '+stats.valid+' 个可创建 · '+stats.invalid+
    ' 个需处理 · 工作流媒体槽位：'+(capacities.join(" / ")||"未识别");
}
function batchImportWarning() {
  const items=state.batchImport?.batches||[],slots=state.batchImport?.assetSlots||[];
  const kinds=["image","audio","video"],overflowKinds=[];
  for(const kind of kinds){
    const capacity=slots.filter(slot=>(slot.kind||"image")===kind).length;
    const required=Math.max(0,...items.map(item=>item.references.filter(ref=>(ref.kind||"image")===kind).length));
    if(required>capacity)overflowKinds.push(mediaKindLabel(kind)+" "+required+"/"+capacity);
  }
  const overflow=items.filter(item=>batchTaskStatus(item).overflow>0).length;
  const missing=items.filter(item=>batchTaskStatus(item).missing>0).length;
  const malformed=items.filter(item=>(item.parseErrors||[]).length);
  const warnings=[];
  if(overflow)warnings.push('工作流媒体输入槽位不足：'+overflowKinds.join("、")+'；'+overflow+' 个批次超出容量，不会创建。');
  if(missing)warnings.push(missing+' 个批次仍有未绑定媒体，请点击对应资产预览区域完成绑定。');
  if(malformed.length)warnings.push(malformed.length+' 个批次存在引用资产格式错误，需检查当前批次原文。');
  return warnings.join(" ");
}
function batchImportMarkup() {
  const batch=state.batchImport;if(!batch)return "";
  if(batch.promptImportOpen)return batchPromptImportMarkup();
  const stats=batchImportStats(),current=batch.batches[batch.activeIndex],disabled=stats.valid===0||batch.saving;
  const ratio=taskAspectRatio(batch.template?.api_prompt,batch.template?.workflow);
  return '<div class="tdm-dialog"><div class="tdm-form tdm-batch" role="dialog" aria-modal="true" aria-label="批量添加任务">'+
    '<header class="tdm-batch-head"><div><h2>批量添加任务</h2>'+
    '<div class="tdm-small">识别 [待生成资产] 中的 &lt;Prompt 名字&gt;，以及 [全局参考] 中的媒体引用</div></div>'+
    '<span class="tdm-space"></span><span class="tdm-batch-autosave-hint">关闭后自动暂存，下次批量添加时可继续编辑</span>'+
    '<button class="tdm-btn close" data-action="batch-cancel" aria-label="关闭">×</button></header>'+
    '<div class="tdm-batch-options">'+
    '<div class="tdm-batch-option"><label>高清分辨率</label><select data-action="batch-resolution">'+
    resolutionOptionsMarkup(batch.highres_megapixels,ratio)+'</select></div>'+
    '<div class="tdm-batch-option"><label>预览输出</label><div class="tdm-preview-options">'+
    '<label class="tdm-preview-option"><input type="checkbox" data-action="batch-preview-option" '+
    'data-field="sampling_preview_enabled" '+(batch.sampling_preview_enabled?'checked':'')+
    (batch.saving?' disabled':'')+'>采样预览</label>'+
    '<label class="tdm-preview-option"><input type="checkbox" data-action="batch-preview-option" '+
    'data-field="vae_decode_enabled" '+(batch.vae_decode_enabled?'checked':'')+
    (!batch.template.decoded_target?' disabled title="当前工作流未识别到低清 VAE 解码线路"':'')+
    (batch.saving?' disabled':'')+'>VAE 解码</label></div></div>'+
    '<div class="tdm-batch-note">这组设置对本次创建的所有批次生效，不单独修改某个批次。</div></div>'+
    '<div class="tdm-batch-columns"><section class="tdm-batch-left">'+
    '<div class="tdm-batch-section-head"><strong>当前批次提示词原文</strong>'+
    '<span>'+(current?esc(current.name):"尚未导入批次")+'</span></div>'+
    '<textarea class="tdm-batch-text" readonly spellcheck="false" aria-label="当前批次提示词原文" '+
    'placeholder="这里显示当前选中批次的完整提示词原文">'+
    esc(current?.sourceBody||current?.body||"")+'</textarea>'+
    '<div class="tdm-batch-summary" data-batch-summary>'+esc(batchImportSummary())+'</div>'+
    '<div class="tdm-batch-warning" data-batch-warning>'+esc(batchImportWarning())+'</div>'+
    '<div class="tdm-batch-list" data-scroll-preserve="batch-list">'+batchListMarkup()+'</div></section>'+
    '<aside class="tdm-batch-right"><div class="tdm-batch-section-head"><strong>当前批次引用资产</strong>'+
    '<button type="button" class="tdm-batch-generated-open" data-action="batch-generated-open">查看待生成资产提示词</button></div>'+
    '<div class="tdm-batch-note">点击资产预览区域选择或替换对应类型媒体；绑定后可同步到其他批次。文件名相同的引用会自动匹配。</div>'+
    '<div class="tdm-batch-ref-list">'+batchReferencesMarkup()+'</div>'+
    '<div class="tdm-batch-generated">'+batchGeneratedMarkup()+'</div>'+
    '</aside></div>'+
    '<footer class="tdm-batch-foot"><div><div class="tdm-batch-summary" data-batch-summary>'+esc(batchImportSummary())+'</div>'+
    '<div class="tdm-batch-note">缺少媒体或超出对应类型的工作流槽位时，该批次不会创建；未引用的输入槽保留工作流模板默认值。</div></div>'+
    '<span class="tdm-space"></span><button class="tdm-btn" data-action="batch-cancel" '+(batch.saving?'disabled':'')+'>取消</button>'+
    '<button class="tdm-btn primary" data-action="batch-submit" '+(disabled?'disabled':'')+'>'+
    (batch.saving?'正在创建…':'创建 '+stats.valid+' 个任务')+'</button></footer></div></div>';
}
function batchPromptImportMarkup() {
  const batch=state.batchImport;if(!batch?.promptImportOpen)return "";
  const savedDraft=readBatchImportDraft();
  const recoveryButton=savedDraft?
    '<button class="tdm-btn" data-action="batch-import-recover" title="恢复上次暂存的批量任务">继续编辑上次的批量任务（'+
      esc(batchDraftDateLabel(savedDraft.savedAt))+'）</button>':"";
  return '<div class="tdm-dialog tdm-batch-import-overlay"><section class="tdm-form tdm-batch-import" '+
    'role="dialog" aria-modal="true" aria-label="导入多批次提示词">'+
    '<header class="tdm-batch-import-head"><div><h2>导入多批次提示词</h2>'+
    '<div class="tdm-small">识别「批次NN｜名称」、[待生成资产] 提示词及 [全局参考] 媒体引用</div></div>'+
    '<span class="tdm-space"></span><span class="tdm-batch-autosave-hint">关闭后自动暂存，下次批量添加时可继续编辑</span>'+
    '<button class="tdm-btn close" data-action="batch-import-cancel" aria-label="关闭">×</button></header>'+
    '<textarea class="tdm-batch-import-text" data-action="batch-import-text" spellcheck="false" '+
    'placeholder="在这里粘贴完整提示词；每个「批次01｜名称」标题单独占一行">'+esc(batch.importText||"")+'</textarea>'+
    '<div class="tdm-batch-import-drop" data-batch-prompt-dropzone>'+
    '<span aria-hidden="true">⇩</span><div><strong>拖入 .md / .markdown / .txt 文件</strong><br>'+
    '<small>'+(batch.importFileName?"已读取："+esc(batch.importFileName):"也可以直接粘贴文本，或浏览文件选择")+'</small></div>'+
    '<span class="tdm-space"></span><button class="tdm-btn" data-action="batch-import-browse">浏览文件</button></div>'+
    (batch.importError?'<div class="tdm-batch-import-error">'+esc(batch.importError)+'</div>':'')+
    '<footer class="tdm-form-actions">'+recoveryButton+'<span class="tdm-space"></span>'+
    '<button class="tdm-btn" data-action="batch-import-cancel">取消</button>'+
    '<button class="tdm-btn primary" data-action="batch-import-apply">确定</button></footer>'+
    '</section></div>';
}
function bindBatchDynamicActions(holder) {
  holder?.querySelectorAll("[data-action]").forEach(control=>{
    control.addEventListener("click",event=>{
      if(control.classList.contains("tdm-batch-ref-preview")){
        const media=event.target?.closest?.("video,audio");
        if(media){
          const isVideo=String(media.tagName||"").toLowerCase()==="video";
          const frameClick=isVideo&&Number.isFinite(event.offsetY)&&
            event.offsetY<Math.max(0,Number(media.clientHeight||0)-34);
          if(!frameClick)return;
        }
      }
      event.preventDefault();event.stopPropagation();void handleAction(control.dataset.action,control.dataset);
    });
    if(control.classList.contains("tdm-batch-ref-preview")){
      control.addEventListener("keydown",event=>{
        if(event.target?.closest?.("video,audio"))return;
        if(event.key!=="Enter"&&event.key!==" ")return;
        event.preventDefault();event.stopPropagation();void handleAction(control.dataset.action,control.dataset);
      });
    }
  });
}
function renderBatchImportViews() {
  const batch=state.batchImport;if(!batch)return;
  const list=state.root?.querySelector(".tdm-batch-list");
  if(list){list.innerHTML=batchListMarkup();bindBatchDynamicActions(list);}
  const refs=state.root?.querySelector(".tdm-batch-ref-list");
  if(refs){refs.innerHTML=batchReferencesMarkup();bindBatchDynamicActions(refs);wireMediaFallback(refs);}
  const generated=state.root?.querySelector(".tdm-batch-generated");
  if(generated)generated.innerHTML=batchGeneratedMarkup();
  const warning=state.root?.querySelector("[data-batch-warning]");
  if(warning)warning.textContent=batchImportWarning();
  const summary=batchImportSummary();
  state.root?.querySelectorAll("[data-batch-summary]").forEach(node=>node.textContent=summary);
  const submit=state.root?.querySelector('[data-action="batch-submit"]');
  if(submit){const stats=batchImportStats();submit.disabled=stats.valid===0||batch.saving;
    submit.textContent=batch.saving?"正在创建…":"创建 "+stats.valid+" 个任务";}
}
function removeBatchAsset(index) {
  const batch=state.batchImport,item=batch?.batches?.[batch.activeIndex];
  const ref=item?.references?.[index];
  if(!ref||!ref.path)return false;
  ref.path="";
  batch.selectedRefIndex=index;
  return true;
}
function syncBatchAssetToOtherBatches(index) {
  const batch=state.batchImport,item=batch?.batches?.[batch.activeIndex];
  const source=item?.references?.[index];
  if(!source?.path)throw Error("请先绑定当前媒体槽位");
  const kind=source.kind||"image",name=String(source.name||"").trim().toLowerCase();
  if(!name)throw Error("当前媒体引用缺少名称，无法同步");
  let synced=0;
  for(let batchIndex=0;batchIndex<batch.batches.length;batchIndex++){
    if(batchIndex===batch.activeIndex)continue;
    for(const target of batch.batches[batchIndex].references||[]){
      if((target.kind||"image")===kind&&String(target.name||"").trim().toLowerCase()===name){
        target.path=source.path;synced++;
      }
    }
  }
  toast(synced?"已同步到其他批次的 "+synced+" 个相同引用槽位":"其他批次没有相同媒体类型和引用名称的槽位",
    synced?"success":"info");
}
function isBatchPromptFile(file) {
  return !!file&&(/\.(?:md|markdown|txt)$/i.test(String(file.name||""))||
    /^(?:text\/plain|text\/markdown)$/i.test(String(file.type||"")));
}
async function loadBatchPromptFile(file) {
  const batch=state.batchImport;if(!batch||!file)return;
  if(!isBatchPromptFile(file))throw Error("仅支持 .md、.markdown 和 .txt 提示词文件");
  batch.importText=await file.text();
  batch.importFileName=file.name||"已导入文件";
  batch.importError="";
  render();
}
function browseBatchPromptFile() {
  const picker=document.createElement("input");
  picker.type="file";picker.accept=".md,.markdown,.txt,text/markdown,text/plain";
  picker.onchange=()=>{
    const file=picker.files?.[0];if(!file)return;
    void loadBatchPromptFile(file).catch(error=>toast("读取提示词失败："+(error?.message||error),"error"));
  };
  picker.click();
}
function applyBatchPromptImport() {
  const batch=state.batchImport;if(!batch)return;
  const editor=state.root?.querySelector('[data-action="batch-import-text"]');
  const candidate=String(editor ? editor.value : batch.importText || "");
  batch.importText=candidate;
  const parsed=parsePreviewBatches(candidate);
  if(!parsed.batches.length){
    batch.importError=parsed.error||"未识别到有效批次，请检查提示词标题格式";
    render();return;
  }
  batch.text=candidate;
  batch.activeIndex=0;batch.selectedRefIndex=-1;
  parseBatchImportText();
  batch.promptImportOpen=false;
  batch.importError="";
  const count=batch.batches.length,fileName=batch.importFileName;
  render();
  toast("已识别 "+count+" 个批次"+(fileName?" · "+fileName:""),"success");
}
function batchPromptWithMediaTokens(body,references) {
  const refs=Array.isArray(references)?references:[];
  const counts={image:0,audio:0,video:0};
  const tokens=refs.map(ref=>{
    const kind=ref.kind||"image";
    counts[kind]=(counts[kind]||0)+1;
    const tokenType=kind==="audio"?"Audio":kind==="video"?"Video":"Picture";
    return {...ref,kind,token:"<"+tokenType+" "+counts[kind]+">",used:false};
  });
  let insideGlobalReferences=false,skippingPrompt=false,skippingTypedPrompt=false;
  const output=[];
  for(const line of String(body??"").split(/\r?\n/)){
    if(/^\s*\[全局参考\]\s*$/.test(line)){
      insideGlobalReferences=true;skippingPrompt=false;skippingTypedPrompt=false;output.push(line);continue;
    }
    if(insideGlobalReferences&&/^\s*\[[^\]]+\]\s*$/.test(line)){
      insideGlobalReferences=false;skippingPrompt=false;skippingTypedPrompt=false;output.push(line);continue;
    }
    if(!insideGlobalReferences){output.push(line);continue;}
    const content=line.trim().replace(/^(?:[-*+•]\s+|\d+[.)、]\s*)/,"");
    const tag=content.match(/^<\s*(Picture|Audio|Video|Prompt)\s+([^>]+?)\s*>\s*[:：]\s*(.*)$/i);
    const legacyGenerated=/^待生成资产\s*[｜|:：]/.test(content);
    const legacyReference=content.match(/^(.+?\.(?:png|jpe?g|webp|bmp|gif|tif|tiff|svg|mp4|mov|mkv|webm|avi|m4v|wav|mp3|flac|ogg|m4a|aac|opus))\s*(?:[：:]|$)/i);
    if(skippingPrompt&&!tag&&!legacyGenerated&&(skippingTypedPrompt||!legacyReference))continue;
    skippingPrompt=false;skippingTypedPrompt=false;
    if(tag){
      const type=tag[1].toLowerCase(),name=tag[2].trim(),suffix=tag[3]||"";
      if(type==="prompt"){skippingPrompt=true;skippingTypedPrompt=true;continue;}
      const kind=type==="picture"?"image":type==="audio"?"audio":"video";
      const matched=tokens.find(entry=>!entry.used&&entry.kind===kind&&entry.name===name);
      if(!matched){output.push(line);continue;}
      matched.used=true;output.push(matched.token+(suffix.trim()?"："+suffix.trim():""));continue;
    }
    if(legacyGenerated){skippingPrompt=/生图提示词/.test(content);continue;}
    let matched=null,suffix="";
    for(const entry of tokens){
      if(entry.used||!content.startsWith(entry.name))continue;
      const rest=content.slice(entry.name.length);
      if(rest&&!/^(?:\s*[:：]|\s+)/.test(rest))continue;
      matched=entry;suffix=rest;break;
    }
    if(matched){matched.used=true;output.push(matched.token+suffix);}
    else output.push(line);
  }
  return output.join("\n");
}
async function createBatchTasks() {
  const batch=state.batchImport;if(!batch||batch.saving)return;
  const ready=batch.batches.filter(item=>batchTaskStatus(item).valid);
  const skipped=batch.batches.length-ready.length;
  if(!ready.length)throw Error("没有可创建的批次。请先补齐引用媒体，或调整工作流对应类型的媒体输入槽位数量。");
  if(skipped&&!window.confirm("共有 "+batch.batches.length+" 个批次，其中 "+skipped+
    " 个批次缺少媒体或超出对应类型的工作流输入槽位。本次只创建其余 "+ready.length+" 个有效批次，继续吗？"))return;
  batch.saving=true;render();
  let created=0,firstId=null;const failures=[],completedItems=new Set();
  for(const item of ready){
    try{
      const draft=randomizeNewTaskSeed(buildDraft(batch.template,[],item.name,batch));
      draft.prompt=[batch.preamble,batchPromptWithMediaTokens(item.body,item.references)].filter(Boolean).join("\n\n");
      draft.duration_seconds=Number(item.duration_seconds||PREVIEW_DURATION_DEFAULT);
      draft.highres_megapixels=Number(batch.highres_megapixels??state.previewSettings.highres_megapixels);
      draft.sampling_preview_enabled=!!batch.sampling_preview_enabled;
      draft.vae_decode_enabled=!!batch.vae_decode_enabled;
      draft.previewType=legacyPreviewType(draft);
      const slotsByKind=new Map();
      for(const slot of draft.assets){
        const kind=slot.kind||"image";
        if(slot.slot_kind==="video_audio")continue;
        if(!slotsByKind.has(kind))slotsByKind.set(kind,[]);
        slotsByKind.get(kind).push(slot);
      }
      for(const ref of item.references){
        const slot=slotsByKind.get(ref.kind||"image")?.shift();
        if(slot)slot.value=ref.path;
      }
      const payload=draftSnapshot(draft);
      const saved=await request("/drafts",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload)});
      created++;completedItems.add(item);if(!firstId)firstId=saved.id;
    }catch(error){failures.push(item.name+"："+(error?.message||String(error)));}
  }
  batch.saving=false;
  const remaining=batch.batches.filter(item=>!completedItems.has(item));
  if(remaining.length){
    batch.batches=remaining;
    batch.activeIndex=Math.min(batch.activeIndex,remaining.length-1);
    const refs=batch.batches[batch.activeIndex]?.references||[];
    if(batch.selectedRefIndex<0||batch.selectedRefIndex>=refs.length){
      const missing=refs.findIndex(ref=>!ref.path);
      batch.selectedRefIndex=missing>=0?missing:(refs.length?0:-1);
    }
    saveBatchImportDraft(batch);
  }else clearBatchImportDraft();
  state.batchImport=null;state.statusFilter="all";
  if(firstId)state.focused=firstId;
  await refresh();
  const message="已创建 "+created+" 个待生成任务"+
    (skipped?"；跳过 "+skipped+" 个资产条件不满足的批次":"")+
    (failures.length?"；创建失败 "+failures.length+" 个："+failures[0]:"");
  toast(message,failures.length?"error":(skipped?"warning":"success"));
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
  const picker=state.assetPicker;if(!picker)return "";
  const label=mediaKindLabel(picker.kind||"image");
  return '<div class="tdm-dialog" style="z-index:100040"><div class="tdm-form" role="dialog" aria-modal="true">'+
    '<div class="tdm-modal-top"><h2>选择'+label+'资产</h2><span class="tdm-space"></span>'+
    '<button class="tdm-btn" data-action="close-assets">×</button></div>'+
    '<div class="tdm-actions"><input style="flex:1" data-action="asset-search" placeholder="按文件名搜索'+label+'" value="'+
    esc(picker.search)+'"><button class="tdm-btn" data-action="upload-asset" data-index="'+
    picker.index+'">上传'+label+'</button></div>'+
    '<div class="tdm-asset-picker"></div></div></div>';
}
function renderAssetChoices() {
  if (!state.assetPicker) return;
  const holder = state.root?.querySelector(".tdm-asset-picker");
  if (!holder) return;
  const kind=state.assetPicker.kind||"image";
  const matches=state.inputFiles.filter(f=>f.kind===kind&&
    f.path.toLowerCase().includes(state.assetPicker.search.toLowerCase())).slice(0,150);
  holder.innerHTML=matches.map(f=>assetCard(f.path,f.name,
    'data-action="choose-asset" data-path="'+esc(f.path)+'"',false,kind)).join("")||
    '<div class="tdm-small">没有匹配的'+mediaKindLabel(kind)+'资产</div>';
  wireMediaFallback(holder);
  holder.querySelectorAll('[data-action="choose-asset"]').forEach(button =>
    button.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      chooseAsset(button.dataset);
    }));
}
function chooseAsset(data) {
  const picker=state.assetPicker;
  const file=state.inputFiles.find(item=>item.path===data.path);
  if(Number.isInteger(picker?.batchReferenceIndex)){
    const index=picker.batchReferenceIndex;
    const item=state.batchImport?.batches?.[state.batchImport.activeIndex],ref=item?.references?.[index];
    if(!ref)return;
    const kind=ref.kind||"image";
    if(!file||file.kind!==kind)throw Error("资产类型不匹配，需要"+mediaKindLabel(kind));
    ref.path=data.path;state.batchImport.selectedRefIndex=index;
  }else{
    const index=picker?.index,slot=state.createDraft?.assets?.[index];
    if(index==null||!slot)return;
    const kind=slot.kind||"image";
    if(!file||file.kind!==kind)throw Error("资产类型不匹配，需要"+mediaKindLabel(kind));
    slot.value=data.path;
  }
  state.assetPicker=null;render();
}
async function uploadAsset(index) {
  const picker=state.assetPicker;
  const batchReferenceIndex=Number.isInteger(picker?.batchReferenceIndex)?picker.batchReferenceIndex:null;
  const batchRef=batchReferenceIndex==null?null:
    state.batchImport?.batches?.[state.batchImport.activeIndex]?.references?.[batchReferenceIndex];
  const slot=batchReferenceIndex==null?state.createDraft?.assets?.[index]:batchRef;
  if(!slot)return;
  const kind=slot.kind||"image",fileInput=document.createElement("input");
  fileInput.type="file";
  fileInput.accept={
    image:".png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.svg",
    video:".mp4,.mov,.mkv,.webm,.avi,.m4v",
    audio:".wav,.mp3,.flac,.ogg,.m4a,.aac,.opus",
  }[kind]||"";
  fileInput.onchange=async()=>{
    const file=fileInput.files?.[0];if(!file)return;
    try{
      const form=new FormData();form.append("file",file,file.name);
      const response=await api.fetchApi("/terrydirector/api/upload",{method:"POST",body:form});
      const data=await response.json();
      if(!response.ok||!data.path||data.kind!==kind)
        throw Error(data.error||"上传失败，文件类型与"+mediaKindLabel(kind)+"槽位不匹配");
      state.inputFiles.push(data);
      if(batchReferenceIndex==null){
        slot.value=data.path;
      }else{
        slot.path=data.path;
        state.batchImport.selectedRefIndex=batchReferenceIndex;
      }
      state.assetPicker=null;render();
      toast(mediaKindLabel(kind)+"已导入："+data.name);
    }catch(error){toast(error.message,"error");}
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
  taskVideoFrameCount(Number(draft.duration_seconds));
  if(!PREVIEW_RESOLUTION_OPTIONS.includes(Number(draft.highres_megapixels)))
    throw Error("请选择有效的高清分辨率");
  return {
    name:String(draft.name||"").trim() || "未命名预演镜头",
    prompt:String(draft.prompt||""),seed:String(seed),
    assets:structuredClone(draft.assets||[]),
    previewType:legacyPreviewType(draft),
    sampling_preview_enabled:!!draft.sampling_preview_enabled,
    vae_decode_enabled:!!draft.vae_decode_enabled,
    duration_seconds:Number(draft.duration_seconds),
    highres_megapixels:Number(draft.highres_megapixels),
    workflow_name:draft.workflow_name,
    workflow:structuredClone(draft.workflow),api_prompt:structuredClone(draft.api_prompt),
    prompt_binding:draft.prompt_binding,seed_binding:draft.seed_binding,
    h3_node_id:draft.h3_node_id??null,h3_media_bindings:structuredClone(draft.h3_media_bindings||[]),
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
  state.statusFilter="all";
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
  state.createDraft=buildDraft(config,[],row.name,row);
  state.createDraft.prompt=row.prompt;
  state.createDraft.seed=row.seed;
  state.createDraft.duration_seconds=Number(row.duration_seconds ?? PREVIEW_DURATION_DEFAULT);
  state.createDraft.highres_megapixels=Number(row.highres_megapixels ?? state.previewSettings.highres_megapixels ?? PREVIEW_RESOLUTION_DEFAULT);
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
    {node_id:draft.prompt_binding.node_id,widget_name:draft.prompt_binding.widget_name,
      value:draft.prompt,...(draft.h3_node_id?{role:"h3_prompt"}:{})},
    {node_id:draft.seed_binding.node_id,widget_name:draft.seed_binding.widget_name,value:seed},
    ...(draft.assets||[]).map(a=>({node_id:a.node_id,widget_name:a.widget_name,value:a.value,
      ...(a.h3_media?{role:"h3_media",kind:a.kind,slot_kind:a.slot_kind}: {})})),
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
    const previewOptions=normalizeTaskPreviewOptions(draft);
    const template={
      schema:2,workflow:draft.workflow,api_prompt:draft.api_prompt,
      h3_node_id:draft.h3_node_id??null,h3_media_bindings:draft.h3_media_bindings||[],
      pause_node_id:draft.pause_node_id,pause_target:draft.pause_target,
      highres_target:draft.highres_target,decoded_target:draft.decoded_target,
      seed_min:draft.seed_min,seed_max:draft.seed_max,
      duration_seconds:draft.duration_seconds,
      highres_megapixels:draft.highres_megapixels,
    };
    const overrides=draftOverrides(draft);
    const queued=await submitPreviewJob(template,overrides,mode,
      mode==="continue"?draft.checkpoint_id:"",previewOptions);
    const job={
      draftId:id,mode,overrides,
      workflow:draft.workflow,api_prompt:draft.api_prompt,name:draft.name,
      workflow_name:draft.workflow_name,pause_node_id:String(draft.pause_node_id),
      pause_target:draft.pause_target,highres_target:draft.highres_target,
      decoded_target:draft.decoded_target,seed_min:draft.seed_min,seed_max:draft.seed_max,
      preview_node_id:draft.preview_node_id==null?null:String(draft.preview_node_id),
      prompt_binding:draft.prompt_binding,seed_binding:draft.seed_binding,
      h3_properties:draft.h3_properties||{},h3_node_id:draft.h3_node_id??null,
      preview_type:legacyPreviewType(previewOptions),
      sampling_preview_enabled:previewOptions.sampling_preview_enabled,
      vae_decode_enabled:previewOptions.vae_decode_enabled,
      duration_seconds:draft.duration_seconds,highres_megapixels:draft.highres_megapixels,
      checkpointId:mode==="continue"?draft.checkpoint_id:null,
      preview:null,uploadedStep:0,busy:true,
    };
    state.jobs.set(queued.promptId,job);
    await draftTransition(id,"ack",{prompt_id:queued.promptId});
    if(mode==="continue")await saveLegacyLifecycle(draft.checkpoint_id,"high_pending",{
      highres_prompt_id:queued.promptId,highres_video:null,
    });
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
    h3_node_id:task.metadata.h3_node_id??null,
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
  const previewOptions=normalizeTaskPreviewOptions(task.metadata||{});
  if(mode==="continue" && task.status!=="low_complete")
    throw Error("只有低清完成的任务可以续采高清");
  if(mode==="continue")
    await saveLegacyLifecycle(id,"high_pending",{queued_stage:"high",
      highres_video:null,highres_prompt_id:null});
  let queued;
  try{
    queued=await submitPreviewJob(template,overrides,mode,
      mode==="continue"?id:"",previewOptions);
  }catch(error){
    if(mode==="continue")await saveLegacyLifecycle(id,"low_complete",{
      queued_stage:null,error:String(error.message||error),
    }).catch(()=>{});
    throw error;
  }
  if(mode==="continue") {
    await saveLegacyLifecycle(id,"high_pending",{
      queued_stage:"high",highres_prompt_id:queued.promptId,
    });
    state.jobs.set(queued.promptId,{
      mode:"continue",checkpointId:id,highres_target:template.highres_target,
      api_prompt:info.api_prompt,busy:true,
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
      preview_type:legacyPreviewType(previewOptions),
      sampling_preview_enabled:previewOptions.sampling_preview_enabled,
      vae_decode_enabled:previewOptions.vae_decode_enabled,
      h3_node_id:task.metadata.h3_node_id??null,
      prompt_binding:info.prompt_binding,
      seed_binding:info.seed_binding,h3_properties:info.h3_properties||{},
      checkpointId:null,preview:null,uploadedStep:0,busy:true,
    });
  }
  toast((mode==="continue"?"高清续采":"预演重跑")+"已入队："+task.name);
}

async function batchSelected() {
  const batch=batchActionInfo();
  if(batch.disabled || !batch.action)return;
  const ids=selectedTaskRows().map(task=>task.id);
  if(!ids.length)return;
  state.busy=true;render();
  let queued=0;
  const failures=[];
  try {
    for(const id of ids){
      try{
        const task=state.tasks.find(t=>t.id===id);
        if(batch.action==="low"){
          if(task?.status!=="low_pending" || task.kind!=="draft" || task.queued_stage)
            throw Error("任务已不处于低清待生成状态");
          await runDraft(id,"pause");
        }else{
          if(task?.status!=="low_complete" || task.queued_stage)
            throw Error("任务已不处于低清完成状态");
          if(task.kind==="draft")await runDraft(id,"continue");
          else await queueFromCheckpoint(id,"continue");
        }
        queued++;
      }catch(error){failures.push(error?.message||String(error));}
    }
  }finally {
    state.busy=false;
    await refresh();
  }
  const kind=batch.action==="low"?"预演":"高清";
  if(failures.length)
    toast(kind+"已入队 "+queued+" 个；失败 "+failures.length+" 个："+failures[0],"error");
  else toast("已排队 "+queued+" 个"+kind+"任务，按 ComfyUI 队列顺序执行");
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
        sampling_preview_enabled:samplingPreviewEnabled(job),
        vae_decode_enabled:job.vae_decode_enabled===true,
        h3_node_id:job.h3_node_id??null,
        workflow: job.workflow,api_prompt:job.api_prompt,draft_id:job.draftId||null,
        pause_target:job.pause_target,highres_target:job.highres_target,
        decoded_target:job.decoded_target,seed_min:job.seed_min,seed_max:job.seed_max,
        duration_seconds:job.duration_seconds,highres_megapixels:job.highres_megapixels,
      }),
    });
  } catch (e) { job.metadataSaved = false; toast("检查点已保存，但任务配置存档失败：" + e.message, "error"); }
  // The checkpoint can be written before the final sampling preview arrives.
  // Saving the media here would capture a stale iteration. Finalize only in
  // execution_success/error/interrupted for this specific prompt.
  void refresh();
}
async function persistPreview(job) {
  // The native final clip already lives in its checkpoint folder.
  // Never overwrite it with an incomplete browser-owned KJ preview.
  if(job?.nativePreviewSaved)return true;
  // Each KJ step is its own encoded clip. Try newest first; only a verified
  // candidate ever reaches sampling_preview.mp4. A broken last H.264 packet
  // must not prevent using a decodable earlier step.
  if(job?.previewPersistPromise)return job.previewPersistPromise;
  if(!job || job.previewSaved || !samplingPreviewEnabled(job) ||
     !job.checkpointId)return false;
  const candidates=finalSamplingCandidates(job);
  if(!candidates.length)return false;
  const upload=(async()=>{
    const duration=Number(job.duration_seconds);
    const query=Number.isInteger(duration) && duration>=4 && duration<=20
      ? "?duration="+encodeURIComponent(duration) : "";
    const errors=[];
    for(const p of candidates){
      try{
        if(p.image.length>48*1024*1024*4/3)
          throw Error("本轮预览超过 48 MB 单文件上限");
        const raw=atob(p.image);
        const bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));
        const response=await api.fetchApi(
          URL_BASE+"/tasks/"+encodeURIComponent(job.checkpointId)+"/sampling-preview"+query,{
            method:"POST",headers:{"Content-Type":p.mime},body:bytes,
          });
        if(!response.ok){
          let reason="预览保存失败（HTTP "+response.status+"）";
          try{reason=(await response.json()).error||reason;}catch{/* non-JSON error */}
          throw Error(reason);
        }
        job.previewSaved=true;
        job.uploadedStep=p.step;
        job.previewSaveError=null;
        job.previewSaveWarning=previewFallbackWarning(p,candidates);
        if(job.previewSaveWarning)
          console.warn("[TerryDirector 预演台]",job.previewSaveWarning);
        await recordPreviewSaveResult(job,p,candidates[0].total||null);
        return true;
      }catch(error){
        const reason=String(error?.message||error);
        console.warn("[TerryDirector 预演台] 采样预览候选视频解码/保存失败，步骤 "+
          p.step+":",reason);
        errors.push("第 "+p.step+" 步："+reason.slice(0,220));
      }
    }
    job.previewSaveError="已尝试 "+candidates.length+" 轮候选采样预览（包含首轮保底）均无法解码或保存。"+
      "可能是 KJNodes 的 H.264 数据损坏。"+
      (errors.length?" "+errors[0]:"");
    return false;
  })();
  job.previewPersistPromise=upload;
  try{return await upload;}
  finally{job.previewPersistPromise=null;}
}
async function recordPreviewSaveResult(job,p,latestTotal) {
  if(!job?.checkpointId)return;
  try{
    const url="/tasks/"+encodeURIComponent(job.checkpointId)+"/metadata";
    const previous=await request(url).catch(()=>({}));
    await request(url,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({...previous,preview_error:null,
        preview_warning:job.previewSaveWarning||null,
        preview_saved_step:p.step,preview_total_steps:latestTotal,
      })});
  }catch(error){
    // The already-validated video exists even if ancillary metadata fails.
    console.warn("[TerryDirector 预演台] 预览已保存，记录采样步数失败",error);
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
async function waitForFinalSamplingPreview(job,promptId) {
  // KJNodes encodes animated video in a bounded worker, so the final
  // kj_preview_override can arrive slightly after execution_success.
  // This promise does not block ComfyUI's queue or the next running task.
  if(job.mode!=="pause" || !samplingPreviewEnabled(job))return;
  const deadline=Date.now()+3500;
  while(Date.now()<deadline){
    if(job.preview?.total && job.preview.step>=job.preview.total)break;
    if(state.activePromptId && state.activePromptId!==promptId)break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
}
async function savePreviewDiagnostic(job,error) {
  if(!job?.checkpointId)return;
  const reason=String(error?.message||error).slice(0,1200);
  console.error("[TerryDirector 预演台] 检查点",job.checkpointId,"采样预览保存失败：",reason);
  toast("低清检查点已保存，但采样预览缺失："+reason,"error");
  try {
    const url="/tasks/"+encodeURIComponent(job.checkpointId)+"/metadata";
    const previous=await request(url).catch(()=>({}));
    await request(url,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({...previous,preview_error:reason})});
  }catch(e){console.warn("[TerryDirector 预演台] 无法存档预览诊断",e);}
}
function bindEvents() {
  api.addEventListener("execution_start",e=>{
    state.activePromptId=e.detail?.prompt_id?String(e.detail.prompt_id):null;
    const job=state.jobs.get(state.activePromptId);
    if(job){
      job.busy=true;
      job.progressStartedAt=Date.now();
      job.samplingProgress=null;
      job.progressNode=null;
      if(job.draftId) {
        job.startPromise=draftTransition(job.draftId,"start",{
          prompt_id:state.activePromptId,
        });
        void job.startPromise.then(refresh).catch(err=>
          toast("开始状态记录失败："+err.message,"error"));
      }
      else if(job.mode==="continue")
        void saveLegacyLifecycle(job.checkpointId,"high_running",{
          high_started_at:new Date().toISOString(),
          highres_prompt_id:state.activePromptId,
        })
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
          progressStartedAt:Date.now(),api_prompt:null,
          name:String(widget(pause,"name")?.value||"预演镜头"),
          workflow_name:state.templateName,pause_node_id:String(pause.id),
          preview_node_id:preview?String(preview.id):null,
          preview_type:"sampling",checkpointId:null,preview:null,
          uploadedStep:0,busy:true,
        });
      }
    }
  });
  // Native ComfyUI progress is emitted for each actual sampler step.
  // Neither event contains tqdm's formatted text; we reconstruct the same
  // concise format, with elapsed/ETA derived from the prompt's clock.
  api.addEventListener("progress",e=>handleSamplerProgress(e));
  api.addEventListener("progress_state",e=>handleSamplerProgress(e,true));
  const onPreviewPacket = e=>{
    const p=e.detail||{};
    // Prefer the event's prompt identity; for KJ versions without it, only
    // the currently executing ComfyUI prompt can receive the preview.
    const promptId=String(p.prompt_id||state.activePromptId||"");
    const job=state.jobs.get(promptId);
    if(!job || (!job.busy&&!job.finalizing) || job.mode!=="pause" ||
       job.preview_type==="decoded" || !p.image || !p.mime ||
       String(p.node_id)!==String(job.preview_node_id))return;
    if(!["video/mp4","image/webp","image/jpeg"].includes(p.mime))return;
    if(p.image.length>48*1024*1024*4/3)return;
    const step=Number(p.step)||1, previous=job.preview?.step||0;
    if(step<previous)return; // Ignore delayed/stale packets for this job.
    if(!rememberSamplingPreview(job,{image:p.image,mime:p.mime,step,
      total:Number(p.total)||null}))return;
    job.previewReceived=(job.previewReceived||0)+1;
    job.previewReceivedAt=Date.now();
    job.previewVersion=(job.previewVersion||0)+1;
    // Update the selected task's player only: no network request, no disk
    // writes, no full-window re-render, no interference with queued tasks.
    updateLivePreview(job);
  };
  api.addEventListener("kj_preview_override",onPreviewPacket);
  api.addEventListener("terrydirector_preview",onPreviewPacket);
  api.addEventListener("executed",e=>{
    const p=e.detail||{},info=p.output?.terrydirector_selflift_checkpoint?.[0];
    const promptId=String(p.prompt_id||state.activePromptId||"");
    const job=state.jobs.get(promptId);
    if(job?.mode==="continue" && job.checkpointId &&
       String(p.node)===String(job.highres_target)){
      // Native SaveVideo returns {images:[{filename,subfolder,type}]},
      // VHS_VideoCombine returns {gifs:[...]}. Both point to Comfy output.
      const outputs=p.output||{};
      const candidates=["images","gifs","videos"].flatMap(key=>
        Array.isArray(outputs[key])?outputs[key]:[]);
      const video=candidates.find(x=>x?.type==="output" &&
        /\.(mp4|webm|mkv|mov|avi|m4v)$/i.test(x.filename||""));
      if(video)job.highresPersistPromise=request(
        "/tasks/"+encodeURIComponent(job.checkpointId)+"/highres-video",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({node_id:job.highres_target,prompt_id:promptId,video}),
        }).catch(error=>{
          console.warn("[TerryDirector 预演台] 高清视频关联失败，将尝试任务历史恢复",error);
        });
      return;
    }
    if(!info?.checkpoint_id||info.mode!=="paused")return;
    if(!job||job.mode!=="pause"||String(p.node)!==String(job.pause_node_id))return;
    job.checkpointId=String(info.checkpoint_id);
    job.nativePreviewSaved=info.native_preview_saved===true;
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
      job.finalizing=true;
      void (async()=>{
        await Promise.allSettled([
          job.startPromise,job.persistPromise,job.checkpointPromise,
          job.highresPersistPromise,
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
        // KJ sends the final animated frame asynchronously. Drain only this
        // job's in-memory preview; do not block newer queued tasks.
        if(event==="execution_success" && !job.nativePreviewSaved)
          await waitForFinalSamplingPreview(job,promptId);
        let saved=false;
        if(job.mode==="pause" && samplingPreviewEnabled(job)){
          saved=await persistPreview(job);
          if(!saved && job.checkpointId){
            await savePreviewDiagnostic(job,
              job.previewSaveError ||
              (!job.previewReceived
                ? "未收到有效采样预览事件；请检查采样预览节点是否产生视频，以及节点 ID 是否匹配"
                : "已收到 "+job.previewReceived+" 次采样预览，但无法写入检查点"));
          }
        }
        // Remove the in-memory source BEFORE reloading task metadata, so
        // refresh() renders the saved MP4 once instead of briefly mounting
        // a Blob URL and revoking it during the following render.
        state.jobs.delete(promptId);
        releasePreviewBlobUrls(job);
        if(event==="execution_success" && job.mode==="continue" &&
           (state.focused===job.draftId || state.focused===job.checkpointId))
          state.preview="auto";
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
