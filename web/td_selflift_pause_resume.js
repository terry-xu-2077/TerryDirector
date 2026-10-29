/** TerryDirector SelfLift pause/continue per-branch action.
 *
 * The big action belongs to this exact node, NOT the global ComfyUI Queue:
 * - Blue/start: target the checkpoint boundary and any connected low-res video
 *   saver, without running high-res. A saved checkpoint turns green.
 * - Lemon/play: target only one downstream high-res saver; lazy low-res inputs
 *   stay untouched, and SelfLift resumes from the checkpoint.
 * Other parallel video branches are excluded by partialExecutionTargets.
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const CLASS_NAME = "TerryDirectorSelfLiftPauseResume";
const TITLE = "TerryDirector SelfLift 暂停/继续";
const UUID_RE = /^[0-9a-f]{32}$/;
const PRIMARY_OUTPUT_TYPES = new Set(["SaveVideo", "VHS_VideoCombine"]);
const OUTPUT_TYPES = new Set(["SaveVideo", "VHS_VideoCombine", "SaveImage",
  "SaveAnimatedWEBP", "SaveAnimatedPNG", "SaveAudio"]);
const MIN_WIDTH = 350;
const STYLE_ID = "td-selflift-action-style";
const pendingBranchSubmissions = [];

function bindPartialPromptTracking() {
  if (api.__tdSelfLiftPartialTrackingBound) return;
  api.__tdSelfLiftPartialTrackingBound = true;
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
      if (req.node.__tdSelfLiftRun === req.run) {
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
      if (req.node.__tdSelfLiftRun === req.run) {
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
  return UUID_RE.test(id) && node.__tdSelfLiftMissing !== id;
}

async function checkCheckpoint(node) {
  const id = checkpointId(node);
  if (!UUID_RE.test(id)) return false;
  try {
    const response = await api.fetchApi(
      "/terrydirector/api/selflift/checkpoint-status?id=" + encodeURIComponent(id)
    );
    if (!response.ok) throw new Error("检查点状态查询失败");
    const result = await response.json();
    if (checkpointId(node) !== id) return hasCheckpoint(node);
    node.__tdSelfLiftMissing = result.exists === true ? null : id;
    refresh(node);
    return result.exists === true;
  } catch (error) {
    // Do not discard the user's persisted checkpoint merely because HTTP
    // momentarily failed. The backend validates it before running high-res.
    console.warn("[TerryDirector SelfLift] checkpoint status:", error);
    return hasCheckpoint(node);
  }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ".td-selflift-action{box-sizing:border-box;width:100%;padding:5px 6px 9px;",
    "display:flex;flex-direction:column;gap:7px;font-family:inherit;color:#e6e8eb;}",
    ".td-selflift-action .td-selflift-main{width:100%;height:61px;border:0;",
    "border-radius:10px;display:flex;align-items:center;justify-content:center;",
    "gap:12px;cursor:pointer;transition:background .15s ease,transform .15s ease;",
    "font-family:inherit;font-size:15px;font-weight:700;line-height:1.2;letter-spacing:.25px;}",
    ".td-selflift-action .td-selflift-main:active{transform:scale(.985)}",
    ".td-selflift-action .td-selflift-main:focus-visible{outline:2px solid white;outline-offset:2px}",
    ".td-selflift-action.is-blue .td-selflift-main{background:#307cff;color:#fff;}",
    ".td-selflift-action.is-blue .td-selflift-main:hover{background:#5192ff;}",
    ".td-selflift-action.is-green .td-selflift-main{background:#c8f44e;color:#1d2810;}",
    ".td-selflift-action.is-green .td-selflift-main:hover{background:#d5ff6a;}",
    ".td-selflift-action .td-selflift-main:disabled{opacity:.56;cursor:wait;}",
    ".td-selflift-action .td-selflift-icon{display:flex;align-items:center;justify-content:center;}",
    ".td-selflift-action .td-selflift-icon svg{height:23px;width:23px;}",
    ".td-selflift-action .td-selflift-info{font-size:11px;display:flex;gap:8px;",
    "align-items:center;justify-content:space-between;color:#aab1be;min-height:18px;}",
    ".td-selflift-action .td-selflift-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
    ".td-selflift-action .td-selflift-reset{border:1px solid rgba(111,185,255,.34);",
    "border-radius:6px;background:rgba(93,171,255,.12);color:#91ccff;",
    "font:inherit;font-weight:750;text-decoration:none;cursor:pointer;padding:4px 8px;",
    "white-space:nowrap;transition:background .15s ease,border-color .15s ease,color .15s ease;}",
    ".td-selflift-action .td-selflift-reset:hover{color:#c4e6ff;border-color:rgba(111,185,255,.72);background:rgba(93,171,255,.22);}",
    ".td-selflift-action .td-selflift-reset:focus-visible{outline:2px solid #91ccff;outline-offset:2px;}",
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
  const missing = UUID_RE.test(id) && node.__tdSelfLiftMissing === id;
  const name = String(widget(node, "name")?.value || "").trim();
  const run = node.__tdSelfLiftRun;
  const blue = !ready;

  node.title = TITLE + (ready ? " · 待高清 " + id.slice(0, 8) : " · 待低清");
  const root = node.__tdSelfLiftRoot;
  if (root) {
    root.classList.toggle("is-blue", blue);
    root.classList.toggle("is-green", !blue);
    const button = root.querySelector(".td-selflift-main");
    const ico = root.querySelector(".td-selflift-icon");
    const label = root.querySelector(".td-selflift-action-label");
    const status = root.querySelector(".td-selflift-status");
    const reset = root.querySelector(".td-selflift-reset");
    const busy = Boolean(run?.busy);
    button.disabled = busy;
    // Lemon green shows the persisted low-res PAUSED state. Clicking it
    // starts high-res; only the running state switches to a play icon.
    ico.innerHTML = blue ? ARROW_ICON
      : (busy && run?.mode === "continue" ? PLAY_ICON : PAUSED_ICON);
    label.textContent = busy
      ? (run.mode === "checking" ? "检查中…" : run.mode === "pause" ? "低清生成中…" :
        run.mode === "saving" ? "低清视频保存中…" : "高清续采中…")
      : (blue ? "生成低清" : "继续高清");
    status.textContent = run?.error || (ready
      ? (name ? name.slice(0, 18) + " · " : "") + "检查点 " + id.slice(0, 8) + " 已保存"
      : (missing ? "原检查点文件不存在，请重新生成低清" : "尚无低清检查点"));
    reset.hidden = !ready || busy;
  }
  node.setDirtyCanvas?.(true, true);
}

function findDownstreamOutput(node) {
  const graph = node.graph || app.graph;
  const queue = [{ item: node, distance: 0 }];
  const visited = new Set();
  const finals = [];

  while (queue.length) {
    const { item, distance } = queue.shift();
    if (!item || visited.has(String(item.id))) continue;
    visited.add(String(item.id));
    if (item !== node && OUTPUT_TYPES.has(item.comfyClass || item.type)) {
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

  // If the branch produces multiple videos, we MUST NOT quietly choose an
  // arbitrary output: tell the user to keep one terminal saver for this MVP.
  const preferred = finals.filter(x => PRIMARY_OUTPUT_TYPES.has(x.item.comfyClass || x.item.type));
  const candidates = preferred.length ? preferred : finals;
  if (candidates.length === 0) {
    throw new Error("这条线路没有连接高清保存节点（例如 SaveVideo），无法单独执行高清");
  }
  if (candidates.length > 1) {
    throw new Error("这条线路有多个视频输出节点，请保留一个高清保存节点后再运行");
  }
  return candidates[0].item;
}

// Select only a low-res video saver reached from SamplerCustom's denoised x0
// output. Do not cross the pause checkpoint into the high-res route.
// Missing saver is fine: existing checkpoint-only graphs keep working.
function findLowresOutput(node) {
  const graph = node.graph || app.graph;
  const cleanInput = node.inputs?.find(input => input.name === "low_clean");
  const sourceLink = cleanInput?.link == null ? null : graph?.links?.[cleanInput.link];
  if (!sourceLink) return null;
  const sampler = graph?.getNodeById?.(sourceLink.origin_id) ||
    graph?._nodes?.find(item => String(item.id) === String(sourceLink.origin_id));
  const sourceOutput = sampler?.outputs?.[sourceLink.origin_slot];
  if (!sourceOutput) return null;

  const queue = [];
  for (const linkId of sourceOutput.links || []) {
    const link = graph?.links?.[linkId];
    if (!link || String(link.origin_id) !== String(sampler.id) ||
        Number(link.origin_slot) !== Number(sourceLink.origin_slot)) continue;
    const next = graph?.getNodeById?.(link.target_id) ||
      graph?._nodes?.find(item => String(item.id) === String(link.target_id));
    if (next && next !== node) queue.push(next);
  }

  const visited = new Set([String(node.id)]);
  const savers = [];
  while (queue.length) {
    const item = queue.shift();
    if (!item || visited.has(String(item.id))) continue;
    visited.add(String(item.id));
    const type = item.comfyClass || item.type;
    if (type === CLASS_NAME || type === "TerryDirectorSelfLiftHighres") continue;
    if (OUTPUT_TYPES.has(type)) {
      if (PRIMARY_OUTPUT_TYPES.has(type)) savers.push(item);
      continue;
    }
    for (const output of item.outputs || []) {
      for (const linkId of output.links || []) {
        const link = graph?.links?.[linkId];
        if (!link) continue;
        const next = graph?.getNodeById?.(link.target_id) ||
          graph?._nodes?.find(n => String(n.id) === String(link.target_id));
        if (next && !visited.has(String(next.id))) queue.push(next);
      }
    }
  }
  if (savers.length > 1) {
    throw new Error("低清 denoised_output 连到了多个视频保存节点，请只保留一个低清保存终点");
  }
  return savers[0] || null;
}

function showError(error) {
  const message = error?.message || String(error);
  console.error("[TerryDirector SelfLift]", error);
  if (app.extensionManager?.toast?.add) {
    app.extensionManager.toast.add({
      severity: "error", summary: "SelfLift 暂停/继续",
      detail: message, life: 6500,
    });
  } else {
    window.alert("SelfLift 暂停/继续：" + message);
  }
}

async function runBranch(node) {
  if (node.__tdSelfLiftRun?.busy) return;
  const run = { busy: true, mode: "checking", promptId: null, error: "" };
  node.__tdSelfLiftRun = run;
  refresh(node);
  let request = null;
  try {
    // An ID by itself does not prove the on-disk checkpoint still exists.
    if (UUID_RE.test(checkpointId(node))) await checkCheckpoint(node);
    const ready = hasCheckpoint(node);
    const target = ready ? findDownstreamOutput(node) : node;
    const lowresSaver = ready ? null : findLowresOutput(node);
    const targetIds = [String(target.id)];
    if (lowresSaver) targetIds.push(String(lowresSaver.id));
    run.mode = ready ? "continue" : "pause";
    run.previewOutputId = lowresSaver ? String(lowresSaver.id) : null;

    // Set the serialized mode before ComfyUI builds the prompt.
    setWidget(node, "mode", ready ? "继续高清" : "暂停并保存");
    request = { node, run, targetId: targetIds[0], targetIds };
    pendingBranchSubmissions.push(request);
    refresh(node);
    // Execute checkpoint and low-res video saver together; continue never
    // includes the low-res path.
    await app.queuePrompt(0, 1, targetIds);
  } catch (error) {
    if (request) {
      const i = pendingBranchSubmissions.indexOf(request);
      if (i >= 0) pendingBranchSubmissions.splice(i, 1);
    }
    if (node.__tdSelfLiftRun === run) {
      run.busy = false;
      run.error = error?.message || String(error);
      refresh(node);
    }
    showError(error);
  }
}

function resetForLowres(node) {
  if (node.__tdSelfLiftRun?.busy) return;
  setWidget(node, "checkpoint_id", "");
  node.__tdSelfLiftMissing = null;
  setWidget(node, "mode", "暂停并保存");
  node.__tdSelfLiftRun = null;
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
  if (!node.__tdSelfLiftBound) {
    node.__tdSelfLiftBound = true;
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
  if (!node.__tdSelfLiftRoot) {
    ensureStyle();
    const root = document.createElement("div");
    root.className = "td-selflift-action is-blue";
    root.innerHTML = '<button class="td-selflift-main" type="button">' +
      '<span class="td-selflift-icon">' + ARROW_ICON + '</span>' +
      '<span class="td-selflift-action-label">生成低清</span></button>' +
      '<div class="td-selflift-info"><span class="td-selflift-status">尚无低清检查点</span>' +
      '<button class="td-selflift-reset" type="button" hidden>重新生成低清</button></div>';
    root.addEventListener("pointerdown", e => e.stopPropagation());
    root.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    root.querySelector(".td-selflift-main").addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      try { void runBranch(node).catch(showError); } catch (error) { showError(error); }
    });
    root.querySelector(".td-selflift-reset").addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      resetForLowres(node);
    });
    const w = node.addDOMWidget("td_selflift_run_button", "td_selflift_run_button", root, {
      hideOnZoom: false,
      getMinHeight: () => 101,
      getMaxHeight: () => 116,
      margin: 5,
    });
    w.serialize = false;
    w.options.serialize = false;
    node.__tdSelfLiftRoot = root;
    const width = Math.max(Number(node.size?.[0]) || 0, MIN_WIDTH);
    node.setSize?.([width, Math.max(Number(node.size?.[1]) || 0,
      Number(node.computeSize?.()?.[1]) || 0)]);
  }
  refresh(node);
  if (UUID_RE.test(checkpointId(node))) void checkCheckpoint(node);
}

function bindExecutionResult() {
  if (api.__tdSelfLiftPauseResumeBound) return;
  api.__tdSelfLiftPauseResumeBound = true;

  api.addEventListener("executed", event => {
    const detail = event.detail || {};
    const result = detail.output?.terrydirector_selflift_checkpoint?.[0];
    if (!result || typeof result.checkpoint_id !== "string") return;
    const node = app.graph?.getNodeById?.(Number(detail.node)) ||
      app.graph?._nodes_by_id?.[detail.node];
    if (node?.comfyClass !== CLASS_NAME) return;

    const id = result.checkpoint_id.trim();
    if (!UUID_RE.test(id)) return;
    node.__tdSelfLiftMissing = null;
    setWidget(node, "checkpoint_id", id);
    if (result.name && result.mode === "continued") {
      setWidget(node, "name", String(result.name).slice(0, 120));
    }
    node.properties ||= {};
    node.properties.tdLastSelfLiftCheckpoint = {
      checkpoint_id: id,
      name: String(result.name || ""),
      mode: String(result.mode || ""),
    };
    if (node.__tdSelfLiftRun?.mode === "pause" && result.mode === "paused") {
      // The video saver can still be encoding after checkpoint write succeeds.
      if (node.__tdSelfLiftRun.previewOutputId) {
        node.__tdSelfLiftRun.mode = "saving";
      } else {
        node.__tdSelfLiftRun = null;
      }
    }
    refresh(node);
  });

  // Fallback correlation if a third-party queue wrapper suppresses the
  // prompt response. Ignore unrelated executing events.
  api.addEventListener("executing", event => {
    const detail = event.detail || {};
    if (detail.node == null || !detail.prompt_id) return;
    const node = app.graph?.getNodeById?.(Number(detail.node));
    if (node?.comfyClass === CLASS_NAME && node.__tdSelfLiftRun?.busy &&
        !node.__tdSelfLiftRun.promptId) {
      node.__tdSelfLiftRun.promptId = String(detail.prompt_id);
    }
  });

  for (const eventName of ["execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(eventName, event => {
      const info = event.detail || {};
      for (const node of app.graph?._nodes || []) {
        if (node.comfyClass !== CLASS_NAME || !node.__tdSelfLiftRun?.busy) continue;
        const run = node.__tdSelfLiftRun;
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
  name: "TerryDirector.SelfLiftPauseResumeUI",
  async setup() {
    bindPartialPromptTracking();
    bindExecutionResult();
  },
  nodeCreated(node) { queueMicrotask(() => attach(node)); },
  loadedGraphNode(node) { queueMicrotask(() => attach(node)); },
});
