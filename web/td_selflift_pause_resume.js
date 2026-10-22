/** TerryDirector SelfLift pause/continue per-branch action.
 *
 * The big action belongs to this exact node, NOT the global ComfyUI Queue:
 * - Blue/pause: target only this checkpoint boundary; run low-res then block
 *   any downstream high-res work. A successful saved checkpoint turns green.
 * - Lemon/play: target only one downstream video output of this branch; lazy
 *   low-res inputs stay untouched, and SelfLift resumes from the checkpoint.
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

function widget(node, name) {
  return node?.widgets?.find(item => item.name === name);
}

function checkpointId(node) {
  return String(widget(node, "checkpoint_id")?.value || "").trim();
}

function hasCheckpoint(node) {
  return UUID_RE.test(checkpointId(node));
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
    ".td-selflift-action .td-selflift-reset{border:0;background:none;color:#aab1be;",
    "font:inherit;text-decoration:underline;cursor:pointer;padding:0 2px;white-space:nowrap;}",
    ".td-selflift-action .td-selflift-reset:hover{color:#fff;}",
  ].join("");
  document.head.append(style);
}

const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
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
  const ready = UUID_RE.test(id);
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
    ico.innerHTML = blue ? PAUSE_ICON : PLAY_ICON;
    label.textContent = busy
      ? (run.mode === "pause" ? "低清生成中…" : "高清续采中…")
      : (blue ? "生成低清 · 暂停" : "继续高清");
    status.textContent = run?.error || (ready
      ? (name ? name.slice(0, 18) + " · " : "") + "检查点 " + id.slice(0, 8) + " 已保存"
      : "尚无低清检查点");
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
  const ready = hasCheckpoint(node);
  const target = ready ? findDownstreamOutput(node) : node;
  const mode = ready ? "continue" : "pause";

  // The mode is a normal serialized widget, so ComfyUI's queued prompt gets
  // the correct value. A queued, paused job targets ONLY this node, not every
  // output in the current workflow.
  setWidget(node, "mode", ready ? "继续高清" : "暂停并保存");
  node.__tdSelfLiftRun = { busy: true, mode, promptId: null, error: "" };
  refresh(node);
  try {
    // Matches the partial-queue calling convention already used by the
    // TerryDirector Looper. The Looper API guard preserves its own targets.
    const result = await app.queuePrompt(0, 1, [String(target.id)]);
    if (result?.prompt_id && node.__tdSelfLiftRun) {
      node.__tdSelfLiftRun.promptId = String(result.prompt_id);
    }
  } catch (error) {
    node.__tdSelfLiftRun = { busy: false, mode, error: error?.message || String(error) };
    refresh(node);
    showError(error);
  }
}

function resetForLowres(node) {
  if (node.__tdSelfLiftRun?.busy) return;
  setWidget(node, "checkpoint_id", "");
  setWidget(node, "mode", "暂停并保存");
  node.__tdSelfLiftRun = null;
  refresh(node);
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
  }
  if (!node.__tdSelfLiftRoot) {
    ensureStyle();
    const root = document.createElement("div");
    root.className = "td-selflift-action is-blue";
    root.innerHTML = '<button class="td-selflift-main" type="button">' +
      '<span class="td-selflift-icon">' + PAUSE_ICON + '</span>' +
      '<span class="td-selflift-action-label">生成低清 · 暂停</span></button>' +
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
      node.__tdSelfLiftRun = null;
    }
    refresh(node);
  });

  for (const eventName of ["execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(eventName, event => {
      const info = event.detail || {};
      for (const node of app.graph?._nodes || []) {
        if (node.comfyClass !== CLASS_NAME || !node.__tdSelfLiftRun?.busy) continue;
        const run = node.__tdSelfLiftRun;
        if (run.promptId && String(run.promptId) !== String(info.prompt_id)) continue;
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
  async setup() { bindExecutionResult(); },
  nodeCreated(node) { queueMicrotask(() => attach(node)); },
  loadedGraphNode(node) { queueMicrotask(() => attach(node)); },
});
