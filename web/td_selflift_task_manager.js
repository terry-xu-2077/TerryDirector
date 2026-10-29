/** TerryDirector SelfLift task manager — plain DOM, no React, no sampler fork. */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { queueManagedSelfLift } from "./td_selflift_pause_resume.js";

const START_CLASS = "TerryDirectorSelfLiftPauseResume";
const KJ_CLASS = "ModelPreviewOverrideKJ";
const URL_BASE = "/terrydirector/api/selflift";
const state = {
  tasks: [], selected: new Set(), focused: null, preview: "decoded",
  busy: false, root: null, creating: false, inputs: [], inputFiles: [],
  templateName: "当前画布", jobs: new Map(), activePromptId: null,
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
    severity, summary: "TerryDirector · 低清任务", detail: message, life: 5500,
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
.tdm-main{min-height:0;flex:1;display:grid;grid-template-columns:minmax(410px,1fr) minmax(335px,44%)}
.tdm-left{min-height:0;overflow:auto;border-right:1px solid #30343b}
.tdm-toolbar{position:sticky;top:0;background:#191b20;z-index:2;padding:12px 14px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #282b32}
.tdm-list{padding:8px 12px}.tdm-card{display:grid;grid-template-columns:25px 128px 1fr;gap:10px;
 border:1px solid transparent;border-radius:8px;padding:9px;cursor:pointer;align-items:center}
.tdm-card:hover{background:#22262d}.tdm-card.active{border-color:#4b76b2;background:#222d3e}
.tdm-thumb{width:128px;height:78px;object-fit:cover;border-radius:5px;background:#101216;border:1px solid #353943}
.tdm-card h3{margin:0 0 7px;font-size:13px;font-weight:650}.tdm-small{font-size:11px;color:#9299a5;line-height:1.6}
.tdm-card input[type=checkbox]{accent-color:#5d9eff;width:15px;height:15px}
.tdm-right{min-width:0;min-height:0;display:flex;flex-direction:column;padding:16px;gap:12px}
.tdm-tabs{display:flex;gap:5px}.tdm-tabs button{border:1px solid #414650;background:#252830;color:#9ba4b2;
 border-radius:6px;padding:7px 10px;cursor:pointer}.tdm-tabs button.on{background:#344d6e;color:#f2f7ff;border-color:#527cac}
.tdm-player{width:100%;aspect-ratio:16/9;background:#0b0d11;border-radius:8px;object-fit:contain;max-height:52vh}
.tdm-no-media{height:100%;display:grid;place-items:center;color:#78818f;text-align:center;padding:20px}
.tdm-detail{font-size:12px;color:#a7afbb;line-height:1.9}.tdm-actions{display:flex;gap:8px;flex-wrap:wrap}
.tdm-foot{padding:12px 20px;border-top:1px solid #30343b;display:flex;align-items:center;gap:12px}
.tdm-dialog{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.64)}
.tdm-form{width:min(670px,87vw);max-height:84vh;overflow:auto;background:#202329;border:1px solid #454b55;
 border-radius:12px;padding:22px;box-shadow:0 25px 90px #000c}
.tdm-form h2{margin:0 0 16px;font-size:17px}.tdm-field{display:flex;flex-direction:column;gap:6px;margin:10px 0}
.tdm-field label{font-size:12px;color:#aeb6c3}.tdm-field input,.tdm-field select,.tdm-field textarea{
 background:#15171b;border:1px solid #434954;color:#eef0f5;padding:9px;border-radius:6px;font:13px system-ui;
 width:100%;box-sizing:border-box}.tdm-field textarea{min-height:90px;resize:vertical}
.tdm-section{margin:18px 0 8px;padding:9px 0;border-bottom:1px solid #454b55;color:#a8c6ec;font-weight:650}
.tdm-form-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:17px}
.tdm-blank{color:#87919e;padding:38px 18px;text-align:center}.tdm-select-note{font-size:11px;color:#87919e}
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
function open() { root().style.display = "flex"; render(); void refresh(); }
function close() { state.creating = false; if (state.root) state.root.style.display = "none"; }
async function refresh() {
  try {
    const result = await request("/tasks");
    state.tasks = result.tasks || [];
    state.selected = new Set([...state.selected].filter(id => state.tasks.some(t => t.id === id)));
    if (!state.tasks.some(t => t.id === state.focused)) state.focused = state.tasks[0]?.id || null;
    render();
  } catch (e) { toast(e.message, "error"); }
}
function selectedTask() { return state.tasks.find(t => t.id === state.focused); }
function thumb(task) {
  const kind = task.media.decoded ? "decoded" : task.media.sampling ? "sampling" : null;
  if (!kind) return '<div class="tdm-thumb"></div>';
  const file = task.media[kind];
  const url = mediaUrl(task.id, kind);
  return file.endsWith(".mp4")
    ? '<video class="tdm-thumb" src="' + url + '#t=0.5" muted preload="metadata"></video>'
    : '<img class="tdm-thumb" src="' + url + '" alt="">';
}
function details(task) {
  if (!task) return '<div class="tdm-no-media">选择左侧低清任务查看预览</div>';
  const kind = state.preview, file = task.media[kind];
  const media = !file ? '<div class="tdm-player tdm-no-media">暂无' +
    (kind === "decoded" ? "低清 VAE 解码" : "TAEH3 采样") + '预览</div>'
    : file.endsWith(".mp4")
      ? '<video class="tdm-player" src="' + mediaUrl(task.id, kind) + '" controls loop playsinline></video>'
      : '<img class="tdm-player" src="' + mediaUrl(task.id, kind) + '" alt="采样预览">';
  const shape = task.low_video_shape || [], target = task.target_video_shape || [];
  return '<h3 style="margin:0;font-size:15px">' + esc(task.name) + '</h3><div class="tdm-tabs">' +
    '<button data-action="preview" data-kind="decoded" class="' + (kind === "decoded" ? "on" : "") + '">低清解码</button>' +
    '<button data-action="preview" data-kind="sampling" class="' + (kind === "sampling" ? "on" : "") + '">TAEH3 采样预览</button></div>' +
    media + '<div class="tdm-detail">检查点：' + esc(task.id.slice(0, 12)) +
    '　Seed：' + esc(task.seed) + '　低清 Latent：' + esc(shape.slice(-2).reverse().join("×")) +
    '　目标 Latent：' + esc(target.slice(-2).reverse().join("×")) +
    '<div>工作流：' + esc(task.metadata?.workflow_name || "未记录") +
    '　创建：' + esc((task.created_at || "").replace("T", " ").slice(0, 19)) + '</div></div>' +
    '<div class="tdm-actions"><button class="tdm-btn" data-action="load">载入任务工作流</button>' +
    '<button class="tdm-btn" data-action="rerun">重跑低清</button>' +
    '<button class="tdm-btn primary" data-action="highres">继续高清</button></div>';
}
function render() {
  if (!state.root || state.root.style.display === "none") return;
  const task = selectedTask();
  state.root.innerHTML = '<div class="tdm-shell"><header class="tdm-head">' +
    '<h2>TerryDirector · 低清任务</h2><span class="tdm-tag">' + state.tasks.length + ' 个检查点</span>' +
    '<div class="tdm-space"></div><button class="tdm-btn primary" data-action="create">＋ 创建低清任务</button>' +
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
      '<div class="tdm-small">' + (t.media.decoded ? "● 低清视频 " : "○ 低清视频 ") +
      (t.media.sampling ? "● TAEH3" : "○ TAEH3") + '</div></div></div>').join("")
      : '<div class="tdm-blank">尚无低清检查点。点击「创建低清任务」开始。</div>') +
    '</div></section><section class="tdm-right">' + details(task) + '</section></div>' +
    '<footer class="tdm-foot"><span class="tdm-small">批量高清会使用各任务的检查点与原始输入配置</span>' +
    '<span class="tdm-space"></span><button class="tdm-btn primary" data-action="batch" ' +
    (!state.selected.size || state.busy ? "disabled" : "") +
    '>批量高清 · ' + state.selected.size + '</button></footer></div>' +
    (state.creating ? createMarkup() : "");
  bindControls();
}
function bindControls() {
  const el = state.root;
  el.querySelectorAll("[data-action]").forEach(control => {
    const action = control.dataset.action;
    if (action === "select" || action === "select-all") {
      control.addEventListener("change", e => {
        if (action === "select-all") state.selected = e.target.checked ?
          new Set(state.tasks.map(t => t.id)) : new Set();
        else if (e.target.checked) state.selected.add(control.dataset.id);
        else state.selected.delete(control.dataset.id);
        render();
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
    if (action === "cancel-create") { state.creating = false; return render(); }
    if (action === "create") { state.creating = true; await loadInputFiles(); return render(); }
    if (action === "import-workflow") return importWorkflow();
    if (action === "submit") return submitCreate();
    if (action === "load") return loadSavedWorkflow(state.focused);
    if (action === "rerun") return queueFromCheckpoint(state.focused, "pause");
    if (action === "highres") return queueFromCheckpoint(state.focused, "continue");
    if (action === "batch") return batchHighres();
  } catch (e) { toast(e.message, "error"); }
}
async function loadInputFiles() {
  try {
    const response = await api.fetchApi("/terrydirector/api/input-files");
    state.inputFiles = (await response.json()).files || [];
  } catch { state.inputFiles = []; }
}
function editableWidgets() {
  const rows = [];
  for (const node of nodes()) {
    const type = nodeType(node);
    for (const w of node.widgets || []) {
      if (w.type === "hidden") continue;
      // A widget with a linked input socket is not the effective prompt value.
      // Its upstream text/source node is edited instead, never a dead widget.
      const socket = node.inputs?.find(x => x.name === w.name);
      if (socket?.link != null) continue;
      if ((type === "LoadImage" || type === "LoadImageMask") && w.name === "image") {
        rows.push({ node, w, kind: "image", value: w.value });
      } else if (/MiniMaxH3ReferenceToVideo|CLIPTextEncode|PrimitiveString|H3PromptEditor|TextEncode|Prompt/i.test(type) &&
        /^(prompt|text|string|value|positive_prompt|negative_prompt)$/i.test(w.name) &&
        typeof w.value === "string") {
        rows.push({ node, w, kind: "text", value: w.value });
      }
    }
  }
  return rows;
}
function createMarkup() {
  state.inputs = editableWidgets();
  const pauseNodes = getPauseNodes();
  const selection = (options, value) => options.map(v =>
    '<option value="' + esc(v) + '"' + (String(v) === String(value) ? " selected" : "") + '>' +
    esc(v) + '</option>').join("");
  const files = state.inputFiles.filter(f => f.kind === "image").map(f => f.path);
  return '<div class="tdm-dialog"><div class="tdm-form"><h2>创建低清任务</h2>' +
    '<div class="tdm-field"><label>使用的工作流</label><div class="tdm-actions">' +
    '<input value="' + esc(state.templateName) + '" disabled style="flex:1">' +
    '<button class="tdm-btn" data-action="import-workflow">导入工作流 JSON</button></div>' +
    '<span class="tdm-small">在此浮窗配置并提交任务；不会点击工作流上的运行按钮。导入会先载入 ComfyUI 画布。</span></div>' +
    '<div class="tdm-field"><label>暂停/继续节点</label><select id="tdm-pause">' +
    pauseNodes.map(n => '<option value="' + esc(n.id) + '">' + esc(n.title || START_CLASS) + ' · ' + n.id + '</option>').join("") +
    '</select></div>' +
    '<div class="tdm-field"><label>任务名称</label><input id="tdm-name" value="新低清镜头" maxlength="120"></div>' +
    '<div class="tdm-section">图片输入</div>' +
    (state.inputs.filter(x => x.kind === "image").map((p,i) =>
      '<div class="tdm-field"><label>' + esc(p.node.title || p.node.type) + ' #' + p.node.id + '</label>' +
      '<select data-patch="' + state.inputs.indexOf(p) + '">' + selection(
        [p.value, ...files.filter(f => f !== p.value)], p.value) + '</select></div>').join("") ||
      '<div class="tdm-small">未发现 LoadImage 输入节点</div>') +
    '<div class="tdm-section">提示词输入</div>' +
    (state.inputs.filter(x => x.kind === "text").map(p =>
      '<div class="tdm-field"><label>' + esc(p.node.title || p.node.type) + ' #' + p.node.id +
      ' · ' + esc(p.w.name) + '</label><textarea data-patch="' + state.inputs.indexOf(p) +
      '">' + esc(p.value) + '</textarea></div>').join("") ||
      '<div class="tdm-small">当前工作流未发现可编辑的提示词控件，请检查提示词来源节点</div>') +
    '<div class="tdm-small" style="margin-top:12px">TAEH3 动画预览：Model Preview Override 的 preview_frames 需大于 1；单帧模式会保存 JPEG。</div>' +
    '<div class="tdm-form-actions"><button class="tdm-btn" data-action="cancel-create">取消</button>' +
    '<button class="tdm-btn primary" data-action="submit" ' +
    (!pauseNodes.length ? "disabled" : "") + '>加入低清生成队列</button></div></div></div>';
}
async function importWorkflow() {
  const file = document.createElement("input");
  file.type = "file"; file.accept = ".json,application/json";
  file.onchange = async () => {
    try {
      const chosen = file.files?.[0];
      if (!chosen) return;
      const data = JSON.parse(await chosen.text());
      if (!Array.isArray(data.nodes)) throw Error("请选择 ComfyUI 画布工作流 JSON");
      if (!window.confirm("载入模板会替换当前 ComfyUI 画布，继续吗？")) return;
      await app.loadGraphData(data);
      state.templateName = chosen.name;
      render();
    } catch (e) { toast(e.message, "error"); }
  };
  file.click();
}
async function submitCreate() {
  const dialog = state.root.querySelector(".tdm-dialog");
  const id = dialog.querySelector("#tdm-pause")?.value;
  const node = app.graph?.getNodeById?.(Number(id));
  if (!node) throw Error("请先载入包含暂停/继续节点的 SelfLift 工作流");
  const name = dialog.querySelector("#tdm-name")?.value.trim() || "未命名低清镜头";
  const overrides = state.inputs.map((p, i) => ({
    node_id: p.node.id, widget_name: p.w.name,
    value: dialog.querySelector('[data-patch="' + i + '"]')?.value ?? p.value,
  }));
  overrides.push({ node_id: node.id, widget_name: "name", value: name });
  const snapshot = app.graph.serialize();
  const previewNode = previewForPause(node);
  const result = await queueManagedSelfLift(node, "pause", overrides);
  if (!result.promptId) throw Error("任务已提交，但未收到 prompt_id；请检查 ComfyUI 队列");
  state.jobs.set(result.promptId, {
    mode: "pause", overrides, workflow: snapshot, name,
    workflow_name: state.templateName,
    pause_node_id: String(node.id), preview_node_id: previewNode ? String(previewNode.id) : null,
    checkpointId: null, preview: null, uploadedStep: 0, busy: true,
  });
  state.creating = false; render();
  toast("低清任务已入队：" + name);
}
async function loadSavedWorkflow(id) {
  if (!id) throw Error("未选择任务");
  const info = await request("/tasks/" + encodeURIComponent(id) + "/workflow");
  if (!window.confirm("载入此任务原始工作流会替换当前 ComfyUI 画布，继续吗？")) return;
  await app.loadGraphData(info.workflow);
  state.templateName = selectedTask()?.metadata?.workflow_name || "已恢复任务工作流";
  toast("任务工作流已载入，图片和提示词覆盖值会在提交任务时自动恢复");
}
async function queueFromCheckpoint(id, mode) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) throw Error("请选择任务");
  const info = await request("/tasks/" + encodeURIComponent(id) + "/workflow");
  const pause = app.graph?.getNodeById?.(Number(task.metadata.pause_node_id));
  const expectedNodes = new Map((info.workflow?.nodes || []).map(n => [String(n.id), n.type]));
  const incompatible = [...expectedNodes].some(([nodeId, type]) =>
    nodeType(app.graph?.getNodeById?.(Number(nodeId))) !== type);
  if (incompatible || nodeType(pause) !== START_CLASS) {
    throw Error("当前画布不是该任务的工作流，请先点击「载入任务工作流」");
  }
  const overrides = [...(info.overrides || [])];
  if (mode === "pause") {
    const namePatch = overrides.find(x => String(x.node_id) === String(pause.id) && x.widget_name === "name");
    if (namePatch) namePatch.value = String(task.name) + " · 重跑";
  }
  const queued = await queueManagedSelfLift(pause, mode, overrides, mode === "continue" ? id : "");
  if (!queued.promptId) throw Error("未收到入队任务编号");
  if (mode === "pause") {
    state.jobs.set(queued.promptId, {
      mode, overrides, workflow: info.workflow, name: task.name + " · 重跑",
      workflow_name: task.metadata.workflow_name,
      pause_node_id: String(pause.id), preview_node_id: task.metadata.preview_node_id,
      checkpointId: null, preview: null, uploadedStep: 0, busy: true,
    });
  }
  toast((mode === "continue" ? "高清续采" : "低清重跑") + "已入队：" + task.name);
}
async function batchHighres() {
  const ids = [...state.selected];
  if (!ids.length) return;
  state.busy = true; render();
  let queued = 0, failures = [];
  try {
    for (const id of ids) {
      try { await queueFromCheckpoint(id, "continue"); queued++; }
      catch (e) { failures.push(e.message); }
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
        workflow: job.workflow,
      }),
    });
  } catch (e) { job.metadataSaved = false; toast("检查点已保存，但任务配置存档失败：" + e.message, "error"); }
  await persistPreview(job);
  void refresh();
}
async function persistPreview(job) {
  const p = job?.preview;
  if (!job?.checkpointId || !p?.image || job.previewPending || job.uploadedStep >= (p.step || 1)) return;
  if (p.image.length > 48 * 1024 * 1024 * 4 / 3) return;
  job.previewPending = true;
  try {
    const raw = atob(p.image);
    const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
    const response = await api.fetchApi(
      URL_BASE + "/tasks/" + job.checkpointId + "/sampling-preview", {
        method: "POST", headers: { "Content-Type": p.mime }, body: bytes,
      });
    if (!response.ok) throw Error((await response.json()).error || "采样预览存档失败");
    job.uploadedStep = p.step || 1;
    void refresh();
  } catch (e) { console.warn("[TerryDirector SelfLift preview]", e); }
  finally { job.previewPending = false; }
}
function bindEvents() {
  api.addEventListener("execution_start", e => {
    state.activePromptId = e.detail?.prompt_id ? String(e.detail.prompt_id) : null;
    // Also archive KJ previews when the user clicks the original blue node
    // button instead of submitting through the task manager.
    if (state.activePromptId && !state.jobs.has(state.activePromptId)) {
      const pauseNodes = getPauseNodes().filter(n =>
        widget(n, "mode")?.value === "暂停并保存");
      if (pauseNodes.length === 1) {
        const pause = pauseNodes[0], preview = previewForPause(pause);
        state.jobs.set(state.activePromptId, {
          mode: "pause", overrides: [], workflow: app.graph.serialize(),
          name: String(widget(pause, "name")?.value || "低清镜头"),
          workflow_name: state.templateName, pause_node_id: String(pause.id),
          preview_node_id: preview ? String(preview.id) : null,
          checkpointId: null, preview: null, uploadedStep: 0, busy: true,
        });
      }
    }
  });
  api.addEventListener("kj_preview_override", e => {
    const p = e.detail || {};
    const job = state.jobs.get(state.activePromptId);
    if (!job || job.mode !== "pause" || !p.image || !p.mime ||
      String(p.node_id) !== job.preview_node_id) return;
    if (!["video/mp4", "image/webp", "image/jpeg"].includes(p.mime)) return;
    if (p.image.length > 48 * 1024 * 1024 * 4 / 3) return;
    job.preview = { image: p.image, mime: p.mime, step: Number(p.step) || 1 };
    void persistPreview(job);
  });
  api.addEventListener("executed", e => {
    const p = e.detail || {};
    const info = p.output?.terrydirector_selflift_checkpoint?.[0];
    if (!info?.checkpoint_id || info.mode !== "paused") return;
    const job = state.jobs.get(String(p.prompt_id || state.activePromptId));
    if (!job || job.mode !== "pause" ||
      String(p.node) !== String(job.pause_node_id)) return;
    job.checkpointId = String(info.checkpoint_id);
    void persistJob(job);
  });
  for (const event of ["execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(event, e => {
      const job = state.jobs.get(String(e.detail?.prompt_id || ""));
      if (job) { job.busy = false; void persistPreview(job); void refresh(); }
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
        title: "低清任务", tooltip: "TerryDirector 低清任务管理器",
        type: "custom",
        render: el => {
          el.innerHTML = '<div style="padding:16px;color:#abb4c2;font:13px system-ui">' +
            '<button class="tdm-btn primary" type="button">打开低清任务管理器</button>' +
            '<p style="line-height:1.6">低清审片、TAEH3 预览、重跑与批量高清续采</p></div>';
          styles();
          el.querySelector("button").onclick = open;
          // Sidebar is only an entry point; work happens in the large overlay.
        },
      });
    }
  },
});
