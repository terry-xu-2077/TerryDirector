/** Generic disk-backed LATENT pause/continue action.
 * Pause also runs parallel saves of the same LATENT; continue targets downstream outputs.
 * The checkpoint owns all cached tensor data and never invokes a sampler.
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const CLASS_NAME = "TerryDirectorPauseResume";
const TITLE = "TerryDirector 暂停/继续";
const UUID_RE = /^[0-9a-f]{32}$/;
const OUTPUT_TYPES = new Set(["SaveVideo", "VHS_VideoCombine", "SaveImage",
  "SaveAnimatedWEBP", "SaveAnimatedPNG", "SaveAudio", "SaveLatent"]);
const MIN_WIDTH = 350;
const STYLE_ID = "td-pause-resume-action-style";
const pendingBranchSubmissions = [];
const managedPromptIds = new Set();

export function trackManagedPausePrompt(promptId) {
  if(promptId)managedPromptIds.add(String(promptId));
}

function bindPartialPromptTracking() {
  if (api.__tdPauseResumePartialTrackingBound) return;
  api.__tdPauseResumePartialTrackingBound = true;
  const original = api.queuePrompt.bind(api);
  api.queuePrompt = async (number, data, options) => {
    const output = data?.output || {};
    const explicit = Array.isArray(options?.partialExecutionTargets)
      ? options.partialExecutionTargets.map(String) : [];
    // Match the exact partial target, not any downstream node or other branch.
    // Fallback for an app.queuePrompt wrapper which dropped the partial target.
    const index = pendingBranchSubmissions.findIndex(req =>
      Object.prototype.hasOwnProperty.call(output, req.targetId) &&
      (explicit.includes(req.targetId) || explicit.length === 0));
    if (index < 0) return original(number, data, options);
    const [req] = pendingBranchSubmissions.splice(index, 1);
    try {
      const result = await original(number, data, {
        ...(options || {}),
        partialExecutionTargets: req.targetIds || [req.targetId],
      });
      if (req.node.__tdPauseResumeRun === req.run) {
        if (result?.prompt_id) {
          req.run.promptId = String(result.prompt_id);
        } else {
          req.run.busy = false;
          req.run.error = "ComfyUI 未返回有效的任务编号，请检查任务队列";
          refresh(req.node);
        }
      }
      return result;
    } catch (error) {
      if (req.node.__tdPauseResumeRun === req.run) {
        req.run.busy = false;
        req.run.error = error?.message || String(error);
        refresh(req.node);
      }
      throw error;
    }
  };
}


function widget(node, name) {
  return node?.widgets?.find(item => item.name === name);
}

function checkpointId(node) {
  return String(widget(node, "checkpoint_id")?.value || "").trim();
}

function hasCheckpoint(node) {
  const id = checkpointId(node);
  return UUID_RE.test(id) && node.__tdPauseResumeMissing !== id;
}

async function checkCheckpoint(node) {
  const id = checkpointId(node);
  if (!UUID_RE.test(id)) return false;
  try {
    const response = await api.fetchApi(
      "/terrydirector/api/checkpoints/status?id=" + encodeURIComponent(id)
    );
    if (!response.ok) throw new Error("检查点状态查询失败");
    const result = await response.json();
    if (checkpointId(node) !== id) return hasCheckpoint(node);
    node.__tdPauseResumeMissing = result.exists === true ? null : id;
    refresh(node);
    return result.exists === true;
  } catch (error) {
    // Do not discard the user's persisted checkpoint merely because HTTP
    // momentarily failed. The backend validates it before running high-res.
    console.warn("[TerryDirector 暂停/继续] checkpoint status:", error);
    return hasCheckpoint(node);
  }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ".td-pause-resume-action{box-sizing:border-box;width:100%;padding:5px 6px 9px;",
    "display:flex;flex-direction:column;gap:7px;font-family:inherit;color:#e6e8eb;}",
    ".td-pause-resume-action .td-pause-resume-main{width:100%;height:61px;border:0;",
    "border-radius:10px;display:flex;align-items:center;justify-content:center;",
    "gap:12px;cursor:pointer;transition:background .15s ease,transform .15s ease;",
    "font-family:inherit;font-size:15px;font-weight:700;line-height:1.2;letter-spacing:.25px;}",
    ".td-pause-resume-action .td-pause-resume-main:active{transform:scale(.985)}",
    ".td-pause-resume-action .td-pause-resume-main:focus-visible{outline:2px solid white;outline-offset:2px}",
    ".td-pause-resume-action.is-blue .td-pause-resume-main{background:#307cff;color:#fff;}",
    ".td-pause-resume-action.is-blue .td-pause-resume-main:hover{background:#5192ff;}",
    ".td-pause-resume-action.is-green .td-pause-resume-main{background:#c8f44e;color:#1d2810;}",
    ".td-pause-resume-action.is-green .td-pause-resume-main:hover{background:#d5ff6a;}",
    ".td-pause-resume-action .td-pause-resume-main:disabled{opacity:.56;cursor:wait;}",
    ".td-pause-resume-action .td-pause-resume-icon{display:flex;align-items:center;justify-content:center;}",
    ".td-pause-resume-action .td-pause-resume-icon svg{height:23px;width:23px;}",
    ".td-pause-resume-action .td-pause-resume-info{font-size:11px;display:flex;gap:8px;",
    "align-items:center;justify-content:space-between;color:#aab1be;min-height:18px;}",
    ".td-pause-resume-action .td-pause-resume-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
    ".td-pause-resume-action .td-pause-resume-reset{border:1px solid rgba(111,185,255,.34);",
    "border-radius:6px;background:rgba(93,171,255,.12);color:#91ccff;",
    "font:inherit;font-weight:750;text-decoration:none;cursor:pointer;padding:4px 8px;",
    "white-space:nowrap;transition:background .15s ease,border-color .15s ease,color .15s ease;}",
    ".td-pause-resume-action .td-pause-resume-reset:hover{color:#c4e6ff;border-color:rgba(111,185,255,.72);background:rgba(93,171,255,.22);}",
    ".td-pause-resume-action .td-pause-resume-reset:focus-visible{outline:2px solid #91ccff;outline-offset:2px;}",
  ].join("");
  document.head.append(style);
}

const ARROW_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M4.5 12h15m-6-6 6 6-6 6" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PAUSED_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor"/>' +
  '<rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="m7 4.5 12 7.5-12 7.5z" fill="currentColor"/></svg>';

function setWidget(node, name, value) {
  const w = widget(node, name);
  if (!w || w.value === value) return;
  w.value = value;
  w.callback?.(value);
  node.setDirtyCanvas?.(true, true);
}

function refresh(node) {
  if (node?.comfyClass !== CLASS_NAME) return;
  const id = checkpointId(node);
  const ready = hasCheckpoint(node);
  const missing = UUID_RE.test(id) && node.__tdPauseResumeMissing === id;
  const name = String(widget(node, "name")?.value || "").trim();
  const run = node.__tdPauseResumeRun;
  const blue = !ready;

  node.title = TITLE + (ready ? " · 待继续 " + id.slice(0, 8) : " · 待缓存");
  const root = node.__tdPauseResumeRoot;
  if (root) {
    root.classList.toggle("is-blue", blue);
    root.classList.toggle("is-green", !blue);
    const button = root.querySelector(".td-pause-resume-main");
    const ico = root.querySelector(".td-pause-resume-icon");
    const label = root.querySelector(".td-pause-resume-action-label");
    const status = root.querySelector(".td-pause-resume-status");
    const reset = root.querySelector(".td-pause-resume-reset");
    const busy = Boolean(run?.busy);
    button.disabled = busy;
    // Lemon green shows the persisted low-res PAUSED state. Clicking it
    // starts high-res; only the running state switches to a play icon.
    ico.innerHTML = blue ? ARROW_ICON
      : (busy && run?.mode === "continue" ? PLAY_ICON : PAUSED_ICON);
    label.textContent = busy
      ? (run.mode === "checking" ? "检查中…" : run.mode === "pause" ? "上游执行中…" :
        run.mode === "saving" ? "预览保存中…" : "下游执行中…")
      : (blue ? "保存缓存" : "继续执行");
    status.textContent = run?.error || (ready
      ? (name ? name.slice(0, 18) + " · " : "") + "检查点 " + id.slice(0, 8) + " 已保存"
      : (missing ? "原检查点文件不存在，请重新保存缓存" : "尚无缓存"));
    reset.hidden = !ready || busy;
  }
  node.setDirtyCanvas?.(true, true);
}

function findDownstreamOutputs(node) {
  const graph = node.graph || app.graph;
  const queue = [{ item: node, distance: 0 }];
  const visited = new Set();
  const finals = [];

  while (queue.length) {
    const { item, distance } = queue.shift();
    if (!item || visited.has(String(item.id))) continue;
    visited.add(String(item.id));
    if (item !== node && (OUTPUT_TYPES.has(item.comfyClass || item.type) || item.constructor?.__tdPauseOutput === true)) {
      finals.push({ item, distance });
      // Stop at actual output node; never reach a different parallel branch.
      continue;
    }
    for (const out of (item === node ? (item.outputs || []).slice(0, 1)
      : item.outputs || [])) {
      for (const linkId of out.links || []) {
        const link = graph?.links?.[linkId];
        if (!link) continue;
        const next = graph.getNodeById?.(link.target_id) ||
          graph._nodes?.find(n => String(n.id) === String(link.target_id));
        if (next) queue.push({ item: next, distance: distance + 1 });
      }
    }
  }

  if (!finals.length) {
    throw new Error("这条线路没有连接输出节点（例如 SaveImage、SaveVideo），无法执行下游");
  }
  return finals.map(entry => entry.item);
}

function findParallelOutputs(node) {
  const graph=node.graph || app.graph;
  const latent=node.inputs?.find(input=>input.name==="latent");
  const source=graph?.links?.[latent?.link];
  if(!source)return [];
  const origin=graph.getNodeById?.(source.origin_id);
  const queue=[...(origin?.outputs?.[source.origin_slot]?.links || [])];
  const visited=new Set(), finals=[];
  const dependsOnBoundary=(item,seen=new Set())=>{
    if(!item || seen.has(String(item.id)))return false;
    if((item.comfyClass || item.type)===CLASS_NAME)return true;
    const nextSeen=new Set(seen);nextSeen.add(String(item.id));
    return (item.inputs || []).some(input=>{
      const link=graph.links[input.link];
      return link && dependsOnBoundary(graph.getNodeById?.(link.origin_id),nextSeen);
    });
  };
  while(queue.length){
    const link=graph.links[queue.shift()];
    const item=link && graph.getNodeById?.(link.target_id);
    if(!item || visited.has(String(item.id)))continue;
    visited.add(String(item.id));
    // Never enter the high stage or another cache boundary.
    if((item.comfyClass || item.type)===CLASS_NAME)continue;
    if(OUTPUT_TYPES.has(item.comfyClass || item.type) || item.constructor?.__tdPauseOutput===true){
      if(!dependsOnBoundary(item))finals.push(item);
      continue;
    }
    for(const out of item.outputs || [])queue.push(...(out.links || []));
  }
  return finals;
}

function showError(error) {
  const message = error?.message || String(error);
  console.error("[TerryDirector 暂停/继续]", error);
  if (app.extensionManager?.toast?.add) {
    app.extensionManager.toast.add({
      severity: "error", summary: "暂停/继续",
      detail: message, life: 6500,
    });
  } else {
    window.alert("暂停/继续：" + message);
  }
}

async function runBranch(node) {
  if (node.__tdPauseResumeRun?.busy) return;
  const run = { busy: true, mode: "checking", promptId: null, error: "" };
  node.__tdPauseResumeRun = run;
  refresh(node);
  let request = null;
  try {
    // An ID by itself does not prove the on-disk checkpoint still exists.
    if (UUID_RE.test(checkpointId(node))) await checkCheckpoint(node);
    const ready = hasCheckpoint(node);
    const targets = ready ? findDownstreamOutputs(node) : [node, ...findParallelOutputs(node)];
    const targetIds = targets.map(target => String(target.id));
    run.mode = ready ? "continue" : "pause";

    // Set the serialized mode before ComfyUI builds the prompt.
    setWidget(node, "mode", ready ? "继续执行" : "暂停并保存");
    request = { node, run, targetId: targetIds[0], targetIds };
    pendingBranchSubmissions.push(request);
    refresh(node);
    // Partial execution leaves unrelated parallel branches untouched.
    await app.queuePrompt(0, 1, targetIds);
  } catch (error) {
    if (request) {
      const i = pendingBranchSubmissions.indexOf(request);
      if (i >= 0) pendingBranchSubmissions.splice(i, 1);
    }
    if (node.__tdPauseResumeRun === run) {
      run.busy = false;
      run.error = error?.message || String(error);
      refresh(node);
    }
    showError(error);
  }
}

function resetCache(node) {
  if (node.__tdPauseResumeRun?.busy) return;
  setWidget(node, "checkpoint_id", "");
  node.__tdPauseResumeMissing = null;
  setWidget(node, "mode", "暂停并保存");
  node.__tdPauseResumeRun = null;
  refresh(node);
}

function hideInternalControl(item) {
  if (!item) return;
  item.type = "hidden";
  item.hidden = true;
  item.computeSize = () => [0, 0];
  item.draw = () => {};
  if (item.element) item.element.style.display = "none";
  if (item.inputEl) item.inputEl.style.display = "none";
}

function attach(node) {
  if (node?.comfyClass !== CLASS_NAME) return;
  if (!node.__tdPauseResumeBound) {
    node.__tdPauseResumeBound = true;
    for (const field of ["mode", "checkpoint_id", "name"]) {
      const item = widget(node, field);
      if (!item) continue;
      const original = item.callback;
      item.callback = function (...args) {
        const value = original?.apply(this, args);
        refresh(node);
        return value;
      };
    }
    // They still serialize into the workflow; the button now owns the mode
    // switch. Avoid a second mode widget contradicting the visible action.
    hideInternalControl(widget(node, "mode"));
  }
  if (!node.__tdPauseResumeRoot) {
    ensureStyle();
    const root = document.createElement("div");
    root.className = "td-pause-resume-action is-blue";
    root.innerHTML = '<button class="td-pause-resume-main" type="button">' +
      '<span class="td-pause-resume-icon">' + ARROW_ICON + '</span>' +
      '<span class="td-pause-resume-action-label">保存缓存</span></button>' +
      '<div class="td-pause-resume-info"><span class="td-pause-resume-status">尚无缓存</span>' +
      '<button class="td-pause-resume-reset" type="button" hidden>重新保存缓存</button></div>';
    root.addEventListener("pointerdown", e => e.stopPropagation());
    root.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    root.querySelector(".td-pause-resume-main").addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      try { void runBranch(node).catch(showError); } catch (error) { showError(error); }
    });
    root.querySelector(".td-pause-resume-reset").addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      resetCache(node);
    });
    const w = node.addDOMWidget("td_pause_resume_run_button", "td_pause_resume_run_button", root, {
      hideOnZoom: false,
      getMinHeight: () => 101,
      getMaxHeight: () => 116,
      margin: 5,
    });
    w.serialize = false;
    w.options.serialize = false;
    node.__tdPauseResumeRoot = root;
    const width = Math.max(Number(node.size?.[0]) || 0, MIN_WIDTH);
    node.setSize?.([width, Math.max(Number(node.size?.[1]) || 0,
      Number(node.computeSize?.()?.[1]) || 0)]);
  }
  refresh(node);
  if (UUID_RE.test(checkpointId(node))) void checkCheckpoint(node);
}

function bindExecutionResult() {
  if (api.__tdPauseResumePauseResumeBound) return;
  api.__tdPauseResumePauseResumeBound = true;

  api.addEventListener("executed", event => {
    const detail = event.detail || {};
    const result = detail.output?.terrydirector_checkpoint?.[0];
    if (!result || typeof result.checkpoint_id !== "string") return;
    // A Preview Stage snapshot can reuse a current canvas node ID. Its cache
    // belongs to the saved task and must never overwrite the canvas widget.
    if(managedPromptIds.has(String(detail.prompt_id||"")))return;
    const node = app.graph?.getNodeById?.(Number(detail.node)) ||
      app.graph?._nodes_by_id?.[detail.node];
    if (node?.comfyClass !== CLASS_NAME) return;

    const id = result.checkpoint_id.trim();
    if (!UUID_RE.test(id)) return;
    node.__tdPauseResumeMissing = null;
    setWidget(node, "checkpoint_id", id);
    if (result.name && result.mode === "continued") {
      setWidget(node, "name", String(result.name).slice(0, 120));
    }
    node.properties ||= {};
    node.properties.tdLastCheckpoint = {
      checkpoint_id: id,
      name: String(result.name || ""),
      mode: String(result.mode || ""),
    };
    // Retain the prompt lock until execution_success/error/interrupted.

    refresh(node);
  });

  // Fallback correlation if a third-party queue wrapper suppresses the
  // prompt response. Ignore unrelated executing events.
  api.addEventListener("executing", event => {
    const detail = event.detail || {};
    if (detail.node == null || !detail.prompt_id) return;
    const node = app.graph?.getNodeById?.(Number(detail.node));
    if (node?.comfyClass === CLASS_NAME && node.__tdPauseResumeRun?.busy &&
        !node.__tdPauseResumeRun.promptId) {
      node.__tdPauseResumeRun.promptId = String(detail.prompt_id);
    }
  });

  for (const eventName of ["execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(eventName, event => {
      const info = event.detail || {};
      if(info.prompt_id)managedPromptIds.delete(String(info.prompt_id));
      for (const node of app.graph?._nodes || []) {
        if (node.comfyClass !== CLASS_NAME || !node.__tdPauseResumeRun?.busy) continue;
        const run = node.__tdPauseResumeRun;
        if (!run.promptId || String(run.promptId) !== String(info.prompt_id)) continue;
        if (eventName !== "execution_success") {
          run.error = info.exception_message || (eventName === "execution_interrupted"
            ? "执行已中断" : "生成失败；检查 ComfyUI 控制台");
        }
        run.busy = false;
        refresh(node);
      }
    });
  }
}

app.registerExtension({
  name: "TerryDirector.PauseResumeUI",
  async setup() {
    bindPartialPromptTracking();
    bindExecutionResult();
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    nodeType.__tdPauseOutput = nodeData.output_node === true;
  },
  nodeCreated(node) { queueMicrotask(() => attach(node)); },
  loadedGraphNode(node) { queueMicrotask(() => attach(node)); },
});
