import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { activeLoopClip, collectLoopSamplerProgress } from "./td_loop_progress.js";
import { effectiveClipLayout } from "./td_timeline_projection.js";
import {
  findLoopMemorySources,
  readLoopOutputResolution,
} from "./td_loop_memory.js";
import { createLoopOutputCheckCard } from "./td_loop_output_check.js";
import { installLoopRegionOverlay } from "./td_loop_region.js";

const LOOP_NODE_CLASS = "TerryDirectorLooper";
const LOOP_END_NODE_CLASS = "TerryDirectorLoopEnd";
const LOOP_INFO_NODE_CLASS = "TerryDirectorLoopInfo";
const H3_CONDITION_NODE_CLASS = "MiniMaxH3ReferenceToVideo";
const LOOP_CONDITION_NODE_CLASS = "TerryDirectorLoopCondition";
const BRAND_MARK_URL = "/terrydirector/static/assets/mark.svg";
function timelineTitleHtml(label = "时间线") {
  return '<span class="td-mini-title"><img class="td-mini-brand" src="' +
    BRAND_MARK_URL + '" alt="" aria-hidden="true"><span>' + label + '</span></span>';
}
const LOOP_MEMORY_SOURCE_CLASSES = new Set([
  LOOP_NODE_CLASS, LOOP_INFO_NODE_CLASS, H3_CONDITION_NODE_CLASS,
  "TerryDirectorLoopCondition", "BasicGuider", "SamplerCustomAdvanced",
  "KSampler", "KSamplerAdvanced",
  "ResolutionSelector", "PrimitiveInt", "PrimitiveFloat",
  "PrimitiveString", "Reroute", "GetNode", "SetNode",
  "MiniMaxH3VAEDecodeFast", "TerryDirectorH3X2LowRAMDecode", "VAELoader",
  "TerryXuMemoryCleanup", "LTXVSeparateAVLatent",
  "SelfLiftAvatarH3Sampler", "TerryDirectorSelfLiftSampler",
  "TerryWireBusPack", "TerryWireBusUnpack",
  "TerryWirelessBusPack", "TerryWirelessBusUnpack",
]);
const isDirector = node => node?.comfyClass === LOOP_NODE_CLASS;
const FPS = 24;
const LOOP_DEFAULT_WIDTH = 360;
const LOOP_DEFAULT_HEIGHT = 220;
const LOOP_MIN_WIDTH = 320;

function applyNewLoopDefaultSize(node) {
  if (![LOOP_NODE_CLASS, LOOP_END_NODE_CLASS].includes(node?.comfyClass)) return;
  // nodeCreated runs before saved workflow geometry is configured, so this is
  // only the constructor default. Loaded/pasted geometry can overwrite it.
  node.setSize?.([LOOP_DEFAULT_WIDTH, LOOP_DEFAULT_HEIGHT]);
}
const OUTPUT_MEMORY_NOTICE_GIB = 4;
const OUTPUT_MEMORY_HIGH_GIB = 8;

const tdTempDisk = { info: null, failed: false, pending: false, requestedAt: 0 };

function refreshTempDiskSpace({ force = false } = {}) {
  const now = Date.now();
  // One lightweight request across all LoopEnd nodes. Refresh on node change,
  // but do not continuously poll or request again on its own rerender.
  if (tdTempDisk.pending ||
      (!force && now - tdTempDisk.requestedAt < 30000)) return;
  tdTempDisk.requestedAt = now;
  tdTempDisk.pending = true;
  void api.fetchApi("/terrydirector/api/temp-space")
    .then(async response => {
      if (!response.ok) throw new Error("Temp disk query failed");
      const data = await response.json();
      if (data.available && Number.isFinite(Number(data.free_bytes))) {
        tdTempDisk.info = {
          freeBytes: Math.max(0, Number(data.free_bytes)),
          drive: String(data.drive || ""),
        };
        tdTempDisk.failed = false;
      } else {
        tdTempDisk.info = null;
        tdTempDisk.failed = true;
      }
    })
    .catch(() => {
      tdTempDisk.info = null;
      tdTempDisk.failed = true;
    })
    .finally(() => {
      tdTempDisk.pending = false;
      refreshAllOutputMemoryInfo();
    });
}


const TRANSITION_SETTING_ID = "TerryDirector.DefaultTransitionMode";
const TAIL_REFERENCE_PROMPT_SETTING_ID = "TerryDirector.TailReferencePrompt";
const DEFAULT_TAIL_REFERENCE_PROMPT = "[镜头连续性参考]\n{picture} 为上一镜头最终帧。仅参考人物与场景状态、色彩、光线和整体基调；当前镜头按照本段描述重新构图与运镜。";
const TRANSITION_MODES = new Set(["tail_reference", "tail_continuation", "independent"]);
const cssHref = new URL("./terry_director.css", import.meta.url).href;

// TerryDirector must be able to run exactly one director node even when another
// extension monkey-patches app.queuePrompt and accidentally drops its third
// partial-execution argument. Keep the normal ComfyUI app.queuePrompt path (so
// beforeQueued callbacks, seed controls and queue bookkeeping still run), then
// repair the partial target at the lower api.queuePrompt boundary if needed.
const tdPendingPartialRuns = [];
let tdActiveExecutionPromptId = null;

function removePendingPartialRun(request) {
  const index = tdPendingPartialRuns.indexOf(request);
  if (index >= 0) tdPendingPartialRuns.splice(index, 1);
}

function prunePendingPartialRuns() {
  const now = Date.now();
  for (let index = tdPendingPartialRuns.length - 1; index >= 0; index -= 1) {
    if ((tdPendingPartialRuns[index]?.expiresAt || 0) <= now) {
      tdPendingPartialRuns.splice(index, 1);
    }
  }
}

function bindDirectorPartialQueueGuard() {
  if (api.__tdPartialQueueGuardBound) return;
  const originalQueuePrompt = api.queuePrompt.bind(api);

  api.queuePrompt = async function(number, data, options) {
    prunePendingPartialRuns();
    const output = data?.output || {};

    const requestIndex = tdPendingPartialRuns.findIndex(request =>
      request?.nodeId &&
      Object.prototype.hasOwnProperty.call(output, request.nodeId)
    );

    if (requestIndex >= 0) {
      const [request] = tdPendingPartialRuns.splice(requestIndex, 1);
      const existingTargets = Array.isArray(options?.partialExecutionTargets)
        ? options.partialExecutionTargets.map(String)
        : [];
      const intact =
        existingTargets.length === 1 &&
        existingTargets[0] === request.nodeId;

      if (!intact) {
        console.warn(
          `[TerryDirector] Restored partial execution target ${request.nodeId}; ` +
          "an upstream app.queuePrompt wrapper dropped or changed it."
        );
      }

      return originalQueuePrompt(number, data, {
        ...(options || {}),
        partialExecutionTargets: [request.nodeId],
      });
    }

    return originalQueuePrompt(number, data, options);
  };

  api.__tdPartialQueueGuardBound = true;
}

function loopExecutionTarget(node) {
  if (node?.comfyClass !== LOOP_NODE_CLASS) return String(node.id);
  const graph = node.graph || app.graph;
  const visited = new Set();
  const queue = [node];
  const ends = [];
  while (queue.length) {
    const cursor = queue.shift();
    if (!cursor || visited.has(cursor.id)) continue;
    visited.add(cursor.id);
    if (cursor.comfyClass === LOOP_END_NODE_CLASS) {
      ends.push(String(cursor.id));
      continue;
    }
    for (const output of cursor.outputs || []) {
      for (const linkId of output.links || []) {
        const link = graph?.links?.[linkId];
        if (!link) continue;
        const next = graph?.getNodeById?.(link.target_id) ||
          graph?._nodes?.find(n => n.id === link.target_id);
        if (next && !visited.has(next.id)) queue.push(next);
      }
    }
  }
  if (ends.length !== 1) {
    throw new Error("TerryDirector 循环需要恰好一个已连线的「循环结束」节点");
  }
  // LoopEnd now saves clips and optionally Final internally. Do not trigger
  // an old downstream SaveVideo when the user clicks the director Run button,
  // otherwise the already encoded Final would be saved a second time.
  return ends[0];
}

function queueDirectorNode(node) {
  const request = {
    nodeId: loopExecutionTarget(node),
    // Keep queued-behind-current-run requests alive, but do not let a failed
    // submission affect unrelated prompts indefinitely.
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
  tdPendingPartialRuns.push(request);

  return app.queuePrompt(0, 1, [request.nodeId]).catch(error => {
    removePendingPartialRun(request);
    throw error;
  });
}

function normalizeTransitionMode(value, fallback = "tail_reference") {
  return TRANSITION_MODES.has(value) ? value : fallback;
}

function defaultTransitionMode() {
  return normalizeTransitionMode(
    app.extensionManager?.setting?.get?.(TRANSITION_SETTING_ID),
    "tail_reference"
  );
}

function tailReferencePromptSetting() {
  const value = app.extensionManager?.setting?.get?.(TAIL_REFERENCE_PROMPT_SETTING_ID);
  return typeof value === "string" && value.trim()
    ? value
    : DEFAULT_TAIL_REFERENCE_PROMPT;
}

function tailReferencePromptSettingRenderer(_name, setter, value) {
  const textarea = document.createElement("textarea");
  textarea.className = "td-tail-reference-setting";
  textarea.rows = 5;
  textarea.spellcheck = false;
  textarea.value = typeof value === "string" ? value : DEFAULT_TAIL_REFERENCE_PROMPT;
  textarea.placeholder = DEFAULT_TAIL_REFERENCE_PROMPT;
  textarea.title = "使用 {picture} 代表实际的 <Picture N>，使用 {picture_number} 代表实际编号。";
  textarea.addEventListener("change", () => setter(textarea.value));
  return textarea;
}


const RUN_IDLE = "idle";
const RUN_RUNNING = "running";
const RUN_COMPLETED = "completed";
const RUN_ERROR = "error";

function directorNodeFromId(value) {
  if (value == null) return null;
  const id = String(value);
  return (app.graph?._nodes || []).find(
    node => isDirector(node) && String(node.id) === id
  ) || null;
}

function directorNodeFromExecutionId(value) {
  if (value == null) return null;
  const raw = String(value);
  const direct = directorNodeFromId(raw);
  if (direct) return direct;
  // Expanded GraphBuilder IDs are prefixed like "321.0.0.node_name".
  const parent = raw.match(/^(\d+)(?:[.:_]|$)/)?.[1];
  return parent ? directorNodeFromId(parent) : null;
}

function blankActivity(node) {
  const clips = readConfig(node).document.clips || [];
  return Object.fromEntries(clips.map(clip => [
    clip.id,
    {
      status: RUN_IDLE,
      progress: 0,
      elapsedSeconds: 0,
      completedAt: null,
      error: "",
    },
  ]));
}

function ensureActivity(node) {
  node.__tdRunActivity ||= blankActivity(node);
  const clips = readConfig(node).document.clips || [];
  const valid = new Set(clips.map(clip => clip.id));
  for (const id of Object.keys(node.__tdRunActivity)) {
    if (!valid.has(id)) delete node.__tdRunActivity[id];
  }
  for (const clip of clips) {
    node.__tdRunActivity[clip.id] ||= {
      status: RUN_IDLE,
      progress: 0,
      elapsedSeconds: 0,
      completedAt: null,
      error: "",
    };
  }
  return node.__tdRunActivity;
}

function activityPayload(node) {
  return {
    clips: clone(ensureActivity(node)),
    readonly: !!(node.__tdPromptId || node.__tdLocalRunLock),
  };
}

function pushActivity(node) {
  renderNode(node);
  if (node?.comfyClass === LOOP_NODE_CLASS) refreshLoopConditionCards(node);
  if (!frameReady || activeNode !== node || !frame?.contentWindow) return;
  frame.contentWindow.postMessage(
    { type: "terrydirector:activity", activity: activityPayload(node) },
    location.origin
  );
}

function bindLoopSegmentActivity() {
  if (api.__tdLoopSegmentActivityBound) return;
  api.__tdLoopSegmentActivityBound = true;
  api.addEventListener("terrydirector:loop-segment", event => {
    const detail = event.detail || {};
    const node = directorNodeFromId(detail.node_id);
    if (node?.comfyClass !== LOOP_NODE_CLASS) return;
    if (tdActiveExecutionPromptId != null) ensurePromptRun(node, tdActiveExecutionPromptId);
    const activity = ensureActivity(node);
    const clip = activity[String(detail.clip_id)];
    if (!clip) return;
    const now = performance.now();
    if (detail.status === "running") {
      Object.assign(clip, {
        status: RUN_RUNNING, progress: 0, startedAt: now,
        samplingStep: null, samplingSteps: null,
        completedAt: null, elapsedSeconds: 0, error: "",
      });
    } else if (detail.status === "completed") {
      Object.assign(clip, {
        status: RUN_COMPLETED, progress: 1,
        elapsedSeconds: clip.startedAt ? (now - clip.startedAt) / 1000 : 0,
        completedAt: new Date().toISOString(), error: "",
      });
    } else {
      return;
    }
    pushActivity(node);
  });
}

function pushPreferences() {
  if (!frameReady || !frame?.contentWindow) return;
  frame.contentWindow.postMessage(
    {
      type: "terrydirector:preferences",
      defaultTransitionMode: defaultTransitionMode(),
    },
    location.origin
  );
}

function ensurePromptRun(node, promptId) {
  if (node.__tdPromptId === promptId) return;
  node.__tdPromptId = promptId;
  node.__tdLocalRunLock = false;
  node.__tdRunActivity = blankActivity(node);
  pushActivity(node);
}

function segmentIndex(nodeId) {
  const match = String(nodeId ?? "").match(/td_s(\d+)_/i);
  return match ? Number(match[1]) - 1 : -1;
}

function applyProgressState(detail) {
  const promptId = detail?.prompt_id;
  const states = Object.values(detail?.nodes || {});
  const byDirector = new Map();

  for (const state of states) {
    const node = directorNodeFromId(state?.display_node_id);
    if (!node) continue;
    const index = segmentIndex(state?.node_id);
    if (index < 0) continue;
    ensurePromptRun(node, promptId);
    if (!byDirector.has(node)) byDirector.set(node, new Map());
    const bySegment = byDirector.get(node);
    if (!bySegment.has(index)) bySegment.set(index, []);
    bySegment.get(index).push(state);
  }

  for (const [node, segments] of byDirector) {
    const clips = readConfig(node).document.clips || [];
    const activity = ensureActivity(node);
    let changed = false;

    for (const [index, nodeStates] of segments) {
      const clip = clips[index];
      if (!clip) continue;
      const previous = activity[clip.id];
      const now = performance.now();
      const sample = nodeStates.find(state => /td_s\d+_sample(?:$|[^a-z0-9])/i.test(String(state.node_id)));
      const assemble = nodeStates.find(state => /td_s\d+_assemble(?:$|[^a-z0-9])/i.test(String(state.node_id)));
      const failed = nodeStates.some(state => state.state === RUN_ERROR);
      const active = nodeStates.some(state => state.state === RUN_RUNNING);
      const startedAt = previous.startedAt || (active || sample ? now : null);
      let next = previous;

      if (failed) {
        next = {
          ...previous,
          status: RUN_ERROR,
          progress: previous.progress || 0,
          elapsedSeconds: startedAt ? (now - startedAt) / 1000 : previous.elapsedSeconds,
          completedAt: null,
          error: "生成失败",
          startedAt,
        };
      } else if (assemble?.state === "finished") {
        next = {
          ...previous,
          status: RUN_COMPLETED,
          progress: 1,
          elapsedSeconds: startedAt ? (now - startedAt) / 1000 : previous.elapsedSeconds,
          completedAt: previous.completedAt || new Date().toISOString(),
          error: "",
          startedAt,
        };
      } else if (sample || active) {
        const max = Number(sample?.max) || 0;
        const value = Number(sample?.value) || 0;
        next = {
          ...previous,
          status: RUN_RUNNING,
          progress: sample ? (max > 0 ? Math.max(0, Math.min(1, value / max)) : 0) : 0,
          elapsedSeconds: startedAt ? (now - startedAt) / 1000 : 0,
          completedAt: null,
          error: "",
          startedAt,
        };
      }

      if (JSON.stringify(next) !== JSON.stringify(previous)) {
        activity[clip.id] = next;
        changed = true;
      }
    }
    if (changed) pushActivity(node);
  }
}

/**
 * Native H3 sampler nodes have their own visible node IDs, not the "td_sN_*"
 * expanded node IDs in the loop. Link their real progress_state
 * value/max back to the enclosing Looper and zero-based active segment.
 */
function applyLoopSamplerProgress(detail) {
  const promptId = detail?.prompt_id;
  // A late event from an older prompt must never reset an already completed
  // segment or re-lock a different director instance.
  if (promptId == null || tdActiveExecutionPromptId == null ||
      String(promptId) !== String(tdActiveExecutionPromptId)) return;

  const changes = new Set();
  for (const sample of collectLoopSamplerProgress(detail, app.graph)) {
    const node = directorNodeFromId(sample.loopId);
    if (node?.comfyClass !== LOOP_NODE_CLASS) continue;
    if (node.__tdPromptId != null && String(node.__tdPromptId) !== String(promptId)) continue;

    const clip = activeLoopClip(readConfig(node).document.clips, sample.iteration);
    if (!clip) continue;
    ensurePromptRun(node, promptId);
    const record = ensureActivity(node)[clip.id];
    if (!record || record.status === RUN_COMPLETED || record.status === RUN_ERROR) continue;

    const now = performance.now();
    const startedAt = record.startedAt || now;
    // Sampling at N/N is not yet a finished segment: VAE decode and the
    // per-clip MOV/MP4 encoding still has to finish. Only the saved event sets 100%.
    const progress = Math.min(0.99, sample.fraction);
    if (record.status === RUN_RUNNING &&
        record.progress === progress &&
        record.samplingStep === sample.step &&
        record.samplingSteps === sample.totalSteps) continue;

    Object.assign(record, {
      status: RUN_RUNNING,
      progress,
      samplingStep: sample.step,
      samplingSteps: sample.totalSteps,
      startedAt,
      elapsedSeconds: (now - startedAt) / 1000,
      completedAt: null,
      error: "",
    });
    changes.add(node);
  }

  for (const node of changes) pushActivity(node);
}

function finishPromptActivity(promptId, success, message = "") {
  let matched = false;
  for (const node of app.graph?._nodes || []) {
    if (!isDirector(node) || node.__tdPromptId !== promptId) continue;
    matched = true;
    const activity = ensureActivity(node);
    const now = performance.now();
    for (const record of Object.values(activity)) {
      if (success) {
        if (record.status !== RUN_IDLE) {
          record.status = RUN_COMPLETED;
          record.progress = 1;
          record.completedAt ||= new Date().toISOString();
          if (record.startedAt) record.elapsedSeconds = (now - record.startedAt) / 1000;
          record.error = "";
        }
      } else if (record.status === RUN_RUNNING) {
        record.status = RUN_ERROR;
        record.completedAt = null;
        if (record.startedAt) record.elapsedSeconds = (now - record.startedAt) / 1000;
        record.error = message || "生成失败";
      }
    }
    node.__tdPromptId = null;
    node.__tdLocalRunLock = false;
    pushActivity(node);
  }
  return matched;
}

function bindExecutionActivity() {
  if (bindExecutionActivity.bound) return;
  bindExecutionActivity.bound = true;
  api.addEventListener("execution_start", event => {
    tdActiveExecutionPromptId = event.detail?.prompt_id ?? null;
  });
  api.addEventListener("progress_state", event => {
    applyProgressState(event.detail);
    applyLoopSamplerProgress(event.detail);
  });
  api.addEventListener("execution_cached", event => {
    const promptId = event.detail?.prompt_id;
    for (const id of event.detail?.nodes || []) {
      const node = directorNodeFromId(id);
      if (!node) continue;
      ensurePromptRun(node, promptId);
      const activity = ensureActivity(node);
      for (const record of Object.values(activity)) {
        record.status = RUN_COMPLETED;
        record.progress = 1;
        record.completedAt = new Date().toISOString();
        record.error = "";
      }
      pushActivity(node);
    }
  });
  for (const name of ["execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(name, event => {
      const promptId = event.detail?.prompt_id;
      if (tdActiveExecutionPromptId === promptId) tdActiveExecutionPromptId = null;
      const success = name === "execution_success";
      const message = name === "execution_interrupted" ? "生成已取消"
        : (event.detail?.exception_message || "生成失败");
      const matched = finishPromptActivity(promptId, success, message);
      if (matched && name === "execution_interrupted") {
        void api.freeMemory({ freeExecutionCache: true });
      }
    });
  }
}

function ensureCss() {
  if (document.querySelector('link[data-terrydirector-style]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssHref;
  link.dataset.terrydirectorStyle = "1";
  document.head.append(link);
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function defaultDocument() {
  return {
    version: 2,
    fps: FPS,
    selected: "clip-1",
    globalPrompt: "",
    aiGlobalPrompt: "",
    globalPromptMode: "user",
    globalAiMetadata: {},
    autoAiEnhance: false,
    clips: [
      {
        id: "clip-1",
        name: "片段 01",
        start: 0,
        end: FPS * 10,
        seed: null,
        aiSeed: null,
        prompt: "",
        aiPrompt: "",
        promptMode: "user",
        aiOptOut: false,
        aiMetadata: {},
        refs: [],
        useGlobalPrompt: true,
        transitionMode: "tail_reference",
        suspended: false,
        kind: "generated",
      },
    ],
    assets: [],
  };
}

function defaultConfig() {
  return {
    version: 4,
    document: defaultDocument(),
  };
}

function normalizeAuthoredSeed(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || !/^\d+$/.test(text)) return null;
  try {
    const max = (1n << 64n) - 1n;
    const parsed = BigInt(text);
    return String(parsed > max ? max : parsed);
  } catch {
    return null;
  }
}

function normalizeConfig(value) {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = {};
    }
  }

  const base = defaultConfig();
  if (!source || typeof source !== "object" || source.version !== 4) {
    return base;
  }
  const rawDoc =
    source.document && typeof source.document === "object"
      ? source.document
      : base.document;

  const clips = Array.isArray(rawDoc.clips) && rawDoc.clips.length
    ? rawDoc.clips.map((raw, index) => {
        const start = Math.max(0, Number.parseInt(raw?.start, 10) || 0);
        const end = Math.max(
          start + 1,
          Number.parseInt(raw?.end, 10) || start + FPS * 10
        );
        return {
          id: String(raw?.id || `clip-${index + 1}`),
          name: String(raw?.name || `片段 ${String(index + 1).padStart(2, "0")}`),
          kind: raw?.kind === "entity" ? "entity" : "generated",
          sourceAssetId: String(raw?.sourceAssetId || ""),
          start,
          end,
          seed: normalizeAuthoredSeed(raw?.seed),
          aiSeed: normalizeAuthoredSeed(raw?.aiSeed),
          prompt: String(raw?.prompt || ""),
          aiPrompt: String(raw?.aiPrompt || ""),
          promptMode: raw?.promptMode === "ai" ? "ai" : "user",
          aiOptOut: raw?.aiOptOut === true,
          aiMetadata: raw?.aiMetadata && typeof raw.aiMetadata === "object" ? clone(raw.aiMetadata) : {},
          refs: Array.isArray(raw?.refs) ? raw.refs.map(String) : [],
          useGlobalPrompt: raw?.useGlobalPrompt !== false,
          transitionMode: normalizeTransitionMode(raw?.transitionMode, "tail_continuation"),
          suspended: raw?.suspended === true,
        };
      })
    : base.document.clips;

  const assets = Array.isArray(rawDoc.assets)
    ? rawDoc.assets
        .filter(
          asset =>
            asset &&
            ["image", "video", "audio"].includes(asset.kind) &&
            asset.source?.path
        )
        .map(asset => ({
          id: String(asset.id),
          name: String(asset.name || asset.source.path),
          ...(String(asset.displayName || "").trim()
            ? { displayName: String(asset.displayName).trim().slice(0, 80) }
            : {}),
          kind: asset.kind,
          number: Math.max(1, Number.parseInt(asset.number, 10) || 1),
          source: {
            type: "comfy-input",
            path: String(asset.source.path)
              .replaceAll("\\", "/")
              .replace(/^\/+/, ""),
          },
        }))
    : [];

  const selected = clips.some(clip => clip.id === rawDoc.selected)
    ? rawDoc.selected
    : clips[0].id;

  const validAssets = new Set(assets.map(asset => asset.id));
  for (const clip of clips) {
    clip.refs = clip.refs.filter(id => validAssets.has(id));
  }

  return {
    version: 4,
    document: {
      version: 2,
      fps: FPS,
      selected,
      globalPrompt: String(rawDoc.globalPrompt || ""),
      aiGlobalPrompt: String(rawDoc.aiGlobalPrompt || ""),
      globalPromptMode: rawDoc.globalPromptMode === "ai" ? "ai" : "user",
      globalAiMetadata: rawDoc.globalAiMetadata && typeof rawDoc.globalAiMetadata === "object" ? clone(rawDoc.globalAiMetadata) : {},
      autoAiEnhance: rawDoc.autoAiEnhance === true,
      clips,
      assets,
    },
  };
}

function timeText(frames) {
  const seconds = Math.max(0, frames) / FPS;
  return `${Number(seconds.toFixed(seconds % 1 ? 2 : 0))}s`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

const ASSET_LABELS = { image: "picture", video: "video", audio: "audio" };
const ASSET_TAG_PATTERN = /<(Picture|Video|Audio)\s+(\d+)>/gi;

function referencedAssetIds(prompt, assets) {
  const lookup = new Map(
    assets.map(asset => [
      `${ASSET_LABELS[asset.kind]}:${Number(asset.number)}`,
      asset.id,
    ])
  );
  const ids = new Set();
  for (const match of String(prompt || "").matchAll(ASSET_TAG_PATTERN)) {
    const id = lookup.get(`${match[1].toLowerCase()}:${Number(match[2])}`);
    if (id) ids.add(id);
  }
  return ids;
}

function authoredAssetIds(documentData, activeClips = effectiveClipLayout(documentData.clips)) {
  const assets = documentData.assets || [];
  const globalPrompt = documentData.globalPromptMode === "ai" && documentData.aiGlobalPrompt
    ? documentData.aiGlobalPrompt : documentData.globalPrompt;
  // Suspended clips cannot consume a reference. Global prompt images only
  // count if an active clip actually enables the global prompt.
  const ids = activeClips.some(clip => clip.useGlobalPrompt !== false)
    ? referencedAssetIds(globalPrompt, assets) : new Set();
  for (const clip of activeClips) {
    const activePrompt = clip.promptMode === "ai" && clip.aiPrompt ? clip.aiPrompt : clip.prompt;
    for (const id of referencedAssetIds(activePrompt, assets)) ids.add(id);
  }
  return ids;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function configWidget(node) {
  return node.widgets?.find(widget => widget.name === "config_json") || null;
}

function tailReferencePromptWidget(node) {
  return node.widgets?.find(widget => widget.name === "tail_reference_prompt") || null;
}

function syncTailReferencePromptWidget(node, mark = false) {
  const widget = tailReferencePromptWidget(node);
  if (!widget) return;
  const value = tailReferencePromptSetting();
  if (widget.value !== value) {
    widget.value = value;
    widget.callback?.(value);
    if (mark) markChanged(node);
  }
  hideBackingWidget(widget);
}

function syncAllTailReferencePromptWidgets() {
  for (const node of app.graph?._nodes || []) {
    if (isDirector(node)) syncTailReferencePromptWidget(node, true);
  }
}

function hideBackingWidget(widget) {
  if (!widget) return;
  widget.__tdHidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, 0];
  widget.draw = () => {};
  widget.hidden = true;
  if (widget.element) widget.element.style.display = "none";
  if (widget.inputEl) widget.inputEl.style.display = "none";
}

function readConfig(node) {
  return normalizeConfig(configWidget(node)?.value || "");
}

function markChanged(node) {
  node.graph?.setDirtyCanvas?.(true, true);
  node.graph?.change?.();
  app.graph?.setDirtyCanvas?.(true, true);
}

function writeConfig(node, config, render = true) {
  const widget = configWidget(node);
  if (!widget) return;
  const normalized = normalizeConfig(config);
  const nextValue = JSON.stringify(normalized);
  if (widget.value !== nextValue) {
    node.__tdRunActivity = null;
    node.__tdPromptId = null;
  }
  widget.value = nextValue;
  widget.callback?.(widget.value);
  markChanged(node);
  if (render) renderNode(node);
  queueMicrotask(refreshAllOutputMemoryInfo);
}

function miniRulerHtml(totalFrames, percentAtFrame = frame => totalFrames > 0 ? frame / totalFrames * 100 : 0) {
  const totalSeconds = Math.max(0, totalFrames / FPS);
  const desired = totalSeconds / 6;
  const candidates = [1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 300, 600];
  const step = candidates.find(value => value >= desired) || candidates.at(-1);
  const ticks = [];
  for (let seconds = 0; seconds <= totalSeconds + 0.0001; seconds += step) {
    const left = percentAtFrame(seconds * FPS);
    const minutes = Math.floor(seconds / 60);
    const remain = Math.round(seconds % 60);
    const label = `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
    const edgeClass = seconds === 0 ? " is-first" : Math.abs(seconds - totalSeconds) < 0.001 ? " is-last" : "";
    ticks.push(`<span class="td-mini-ruler-tick${edgeClass}" style="left:${left}%"><b>${label}</b><i></i></span>`);
  }
  return `<div class="td-mini-ruler" aria-hidden="true">${ticks.join("")}</div>`;
}


/** A suspended card is still an ordinary clip in the SAME preview row.
 * Clicking it locates the source clip in the editor without changing output.
 */
function bindSuspendedClipButtons(node, root) {
  root.querySelectorAll("[data-suspended-clip]").forEach(button => {
    const edit = event => {
      event.preventDefault();
      event.stopPropagation();
      openEditor(node, button, button.dataset.suspendedClip);
    };
    button.addEventListener("click", edit);
    button.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") edit(event);
    });
  });
}

function timelineHtml(documentData, activity = {}) {
  const clips = documentData.clips || [];
  if (!clips.length) {
    return '<div class="td-mini-empty">尚无片段 · 点击编辑</div>';
  }

  const total = Math.max(1, ...clips.map(clip => Number(clip.end) || 0));
  const clipHtml = clips
    .map((clip, index) => {
      const left = Math.max(0, Math.min(100, (clip.start / total) * 100));
      const width = Math.max(
        0.8,
        Math.min(100 - left, ((clip.end - clip.start) / total) * 100)
      );
      const record = activity?.[clip.id] || {};
      const running = !clip.suspended && record.status === RUN_RUNNING;
      const completed = !clip.suspended && record.status === RUN_COMPLETED;
      const failed = !clip.suspended && record.status === RUN_ERROR;
      const progress = completed ? 1 : running ? clamp01(record.progress) : 0;
      const percent = Math.round(progress * 100);
      const progressDone = running && percent >= 100;
      const visualCompleted = completed || progressDone;
      const durationFrames = Math.max(1, (Number(clip.end) || 0) - (Number(clip.start) || 0));
      const suspended = clip.suspended ? " is-suspended" : "";
      const runClass = visualCompleted ? " is-completed" : running ? " is-running" : failed ? " is-error" : "";
      const duration = timeText(Math.max(0, durationFrames));
      const samplingSteps = Number(record.samplingSteps);
      const samplingInfo = running && samplingSteps > 0
        ? ` · 采样 ${Number(record.samplingStep) || 0}/${samplingSteps}`
        : "";
      const statusText = visualCompleted
        ? "已完成"
        : running
          ? (samplingInfo ? `生成中 ${percent}%${samplingInfo}` : (percent > 0 ? `生成中 ${percent}%` : "准备中"))
          : failed
            ? "生成失败"
            : "";
      const title = clip.suspended
        ? `片段 ${index + 1} · ${clip.name} · 已挂起（不参与生成）`
        : statusText ? `${clip.name} · ${statusText}` : clip.name;
      const pausedAttrs = clip.suspended
        ? ` data-suspended-clip="${escapeHtml(clip.id)}" role="button" tabindex="0" aria-label="${escapeHtml(title)}"`
        : "";
      const progressHtml = (running || visualCompleted)
        ? `<span class="td-mini-clip-progress"><i style="width:${visualCompleted ? 100 : percent}%"></i></span>`
        : "";

      return `<div class="td-mini-clip${suspended}${runClass}" style="left:${left}%;width:${width}%;z-index:${running && !visualCompleted ? 12 : index + 1}" title="${escapeHtml(title)}"${pausedAttrs}><div class="td-mini-clip-meta"><span class="td-mini-index">片段 ${index + 1}</span><span class="td-mini-duration">${duration}</span></div><span class="td-mini-label">${escapeHtml(clip.name)}</span>${progressHtml}</div>`;
    })
    .join("");

  return miniRulerHtml(total) + clipHtml;
}

function renderNode(node) {
  const root = node.__tdRoot;
  if (!root) return;

  const config = readConfig(node);
  const doc = config.document;
  const activeClips = effectiveClipLayout(doc.clips);
  const total = activeClips.at(-1)?.end || 0;
  const usedAssetIds = authoredAssetIds(doc, activeClips);
  const usedAssets = doc.assets.filter(asset => usedAssetIds.has(asset.id)).length;
  const activity = ensureActivity(node);
  const totalSeconds = Number((total / FPS).toFixed((total / FPS) % 1 ? 2 : 0));

  root.innerHTML = `<div class="td-node-card td-node-card-director">
    <div class="td-mini-wrap td-mini-wrap-director">
      <div class="td-mini-head">
        <strong>${timelineTitleHtml()}</strong>
        <span class="td-mini-stats">
          总时长：<b>${totalSeconds}</b>s
          <i></i>
          片段数：<b>${activeClips.length}</b>
          <i></i>
          导入资产：<b>${doc.assets.length}</b><em>（<b>${usedAssets}</b> 个被使用）</em>
        </span>
        <span class="td-node-spacer"></span>
        <button class="td-mini-edit" data-action="edit">✦ 编辑</button>
      </div>
      <div class="td-mini-timeline" data-action="edit" title="原始片段编排预览（包含挂起片段）；总时长只计算有效片段">${timelineHtml(doc, activity)}</div>
    </div>
  </div>`;

  root.querySelectorAll('[data-action="edit"]').forEach(button => {
    button.addEventListener("click", () => openEditor(node, button));
  });
  bindSuspendedClipButtons(node, root);
  if (node.comfyClass === LOOP_NODE_CLASS) {
    queueMicrotask(() => refreshLoopConditionCards(node));
  }
}



function resolveVirtualOutputSource(source, seen = new Set()) {
  if (!source?.node) return source || null;
  let node = source.node;
  let outputIndex = Number(source.outputIndex);
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) return source;

  for (let depth = 0; depth < 16; depth += 1) {
    const key = String(node.id) + ":" + outputIndex;
    if (seen.has(key)) break;
    seen.add(key);

    // TerryTools exposes a versioned resolver on both wired and wireless
    // Bus-Out nodes. Keep the generic resolveVirtualOutput fallback for its
    // older wireless implementation and other compatible virtual nodes.
    const resolver =
      (typeof node.__terryBusResolveOutput === "function"
        ? node.__terryBusResolveOutput
        : typeof node.resolveVirtualOutput === "function"
          ? node.resolveVirtualOutput
          : null);
    if (!resolver) break;

    let resolved = null;
    try {
      resolved = resolver.call(node, outputIndex);
    } catch {
      break;
    }
    const nextNode = resolved?.node;
    const nextSlot = Number(resolved?.slot ?? resolved?.outputIndex);
    if (!nextNode || !Number.isSafeInteger(nextSlot) || nextSlot < 0) break;
    if (nextNode === node && nextSlot === outputIndex) break;
    node = nextNode;
    outputIndex = nextSlot;
  }

  return { node, outputIndex };
}

function linkedOutputForInput(node, inputName) {
  if (!node) return null;
  const graph = node.graph || app.rootGraph || app.graph;
  const inputIndex = node.inputs?.findIndex(item => item.name === inputName) ?? -1;
  if (inputIndex < 0 || !graph) return null;

  // ComfyUI frontend 1.53+ stores graph.links as a Map. Prefer the node/graph
  // accessors so this also works with ECS-backed links and older frontends.
  let link = node.getInputLink?.(inputIndex) || null;
  if (!link) {
    const linkId = node.inputs?.[inputIndex]?.link;
    if (linkId != null) {
      link =
        graph.getLink?.(linkId) ||
        graph.links?.get?.(linkId) ||
        graph.links?.[linkId] ||
        null;
    }
  }
  if (!link) return null;
  const upstreamNode = graph.getNodeById?.(link.origin_id);
  const outputIndex = Number(link.origin_slot);
  if (!upstreamNode || !Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    return null;
  }
  return resolveVirtualOutputSource({ node: upstreamNode, outputIndex });
}

function linkedNodeForInput(node, inputName) {
  return linkedOutputForInput(node, inputName)?.node || null;
}

function effectiveTimelineFrames(documentData) {
  // Exactly the same projection drives the video preview and memory estimate.
  return effectiveClipLayout(documentData?.clips).at(-1)?.end || 0;
}

function mergeFrameMemoryEstimate(frames, resolution) {
  const { width, height } = resolution;
  const gib = frames * width * height * 3 * 4 / (1024 ** 3);
  return {
    state: "ready",
    frames,
    seconds: frames / FPS,
    width,
    height,
    gib,
    level:
      gib >= OUTPUT_MEMORY_HIGH_GIB
        ? "high"
        : gib >= OUTPUT_MEMORY_NOTICE_GIB
          ? "notice"
          : "normal",
  };
}

function loopEndMemoryEstimate(node) {
  // Prefer the actual LoopEnd image path. For known Fast Decode VAE contracts
  // this can safely include spatial scaling instead of reporting H3 input size.
  const { looper, h3 } = findLoopMemorySources(node, linkedNodeForInput);
  if (!looper) return { state: "disconnected" };
  const documentData = readConfig(looper).document;
  const frames = effectiveTimelineFrames(documentData);
  const activeClips = (documentData.clips || []).filter(clip => !clip.suspended).length;
  const externalDecoded = Boolean(linkedNodeForInput(node, "images"));
  const summary = {
    state: "summary",
    frames,
    seconds: frames / FPS,
    activeClips,
    hint: frames > 0
      ? externalDecoded
        ? "外部解码链的尺寸变化无法被安全确认；当前不会猜测未知 VAE 或后处理倍率。"
        : "分辨率来自动态或暂不支持的上游计算；请以生成时的实际尺寸为准。"
      : "当前没有启用的片段。",
  };
  if (frames < 1) return summary;
  const resolution = readLoopOutputResolution(
    node,
    h3,
    linkedNodeForInput,
    linkedOutputForInput,
  );
  if (!resolution) return summary;
  return {
    ...mergeFrameMemoryEstimate(frames, resolution),
    activeClips,
    source: resolution.source,
    resolutionLabel: resolution.resolutionLabel,
    scale: resolution.scale,
    vaeName: resolution.vaeName,
  };
}

function renderOutputMemoryInfo(node) {
  const root = node?.__tdOutputInfoRoot;
  if (!root || node.comfyClass !== LOOP_END_NODE_CLASS) return;
  const estimate = loopEndMemoryEstimate(node);
  refreshTempDiskSpace();
  const segmentFormat = node.widgets?.find(widget => widget.name === "segment_format")?.value;
  const mergeFinal = node.widgets?.find(widget => widget.name === "merge_final")?.value;
  const card = createLoopOutputCheckCard(estimate, tdTempDisk, { segmentFormat, mergeFinal });
  root.hidden = false;
  root.className = card.className;
  root.innerHTML = card.html;
  queueMicrotask(() => {
    try {
      const computed = node.computeSize?.();
      const width = Math.max(Number(node.size?.[0]) || 320, 320);
      const height = Math.max(Number(node.size?.[1]) || 0,
        Number(computed?.[1]) || 0,
        estimate?.state === "disconnected" ? 165 : 245);
      node.setSize?.([width, height]);
    } catch {}
    node.setDirtyCanvas?.(true, true);
  });
}

function refreshAllOutputMemoryInfo() {
  for (const node of app.graph?._nodes || []) {
    if (node?.comfyClass === LOOP_END_NODE_CLASS) renderOutputMemoryInfo(node);
  }
}

// Cleanup and reroute nodes forward their input without changing its value.
// Follow only known pass-throughs when resolving the owning timeline.
function followLoopConditionPassthrough(source) {
  const visited = new Set();
  for (let depth = 0; source?.node && depth < 16; depth += 1) {
    const upstream = source.node;
    const type = upstream.comfyClass;
    const passthrough = type === "Reroute" ||
      type === "TerryXuMemoryCleanup" ||
      type === "RAMCleanup" ||
      type === "VRAMCleanup";
    if (!passthrough) return source;
    if (Number(source.outputIndex) !== 0 || visited.has(upstream)) return null;
    visited.add(upstream);
    const inputName = type === "Reroute" ? upstream.inputs?.[0]?.name : "anything";
    if (!inputName) return null;
    source = linkedOutputForInput(upstream, inputName);
  }
  return null;
}

function loopConditionLooper(node) {
  if (node?.comfyClass !== LOOP_CONDITION_NODE_CLASS) return null;
  const info = followLoopConditionPassthrough(
    linkedOutputForInput(node, "segment_data")
  );
  // LoopInfo output 4 carries segment_data; other outputs do not.
  if (info?.node?.comfyClass !== LOOP_INFO_NODE_CLASS ||
      Number(info.outputIndex) !== 4) return null;
  const looper = followLoopConditionPassthrough(
    linkedOutputForInput(info.node, "loop_context")
  );
  return looper?.node?.comfyClass === LOOP_NODE_CLASS &&
    Number(looper.outputIndex) === 0 ? looper.node : null;
}

function loopConditionSnapshot(node) {
  const looper = loopConditionLooper(node);
  if (!looper) return { state: "disconnected" };

  const doc = readConfig(looper).document;
  const clips = (doc.clips || []).filter(clip => !clip.suspended);
  const activity = ensureActivity(looper);
  const records = clips.map(clip => activity[String(clip.id)] || {
    status: RUN_IDLE, progress: 0, elapsedSeconds: 0,
  });

  let index = records.findIndex(record => record.status === RUN_RUNNING);
  let state = "idle";
  if (index >= 0) {
    state = "running";
  } else if (records.some(record => record.status === RUN_ERROR)) {
    index = records.findIndex(record => record.status === RUN_ERROR);
    state = "error";
  } else if (clips.length && records.every(record => record.status === RUN_COMPLETED)) {
    index = clips.length - 1;
    state = "completed";
  } else {
    index = records.findIndex(record => record.status !== RUN_COMPLETED);
    if (index < 0) index = clips.length ? 0 : -1;
  }

  const clip = index >= 0 ? clips[index] : null;
  const record = index >= 0 ? records[index] : null;
  const transition = clip
    ? normalizeTransitionMode(clip.transitionMode, "tail_reference")
    : "tail_reference";
  const transitionLabel = transition === "tail_continuation"
    ? "尾帧续接"
    : transition === "independent"
      ? "独立"
      : "尾帧参考";
  const contextLabel = !clip
    ? "—"
    : index === 0
      ? "首段"
      : transition === "independent"
        ? "独立"
        : transition === "tail_continuation"
          ? "上一片段续接"
          : "上一片段尾帧";
  const fallbackSeed = looper.widgets?.find(widget => widget.name === "seed")?.value;
  const seed = clip?.seed != null && String(clip.seed).trim() !== ""
    ? String(clip.seed)
    : fallbackSeed;
  const frames = clip ? Math.max(1, Number(clip.end) - Number(clip.start)) : 0;

  return {
    state,
    looper,
    clip,
    index,
    total: clips.length,
    transitionLabel,
    contextLabel,
    seed: Number.isFinite(Number(seed)) ? String(seed) : "—",
    seconds: frames > 0 ? frames / FPS : 0,
    progress: record ? clamp01(record.progress) : 0,
    elapsedSeconds: Number(record?.elapsedSeconds) || 0,
  };
}

function renderLoopConditionCard(node) {
  const root = node?.__tdLoopConditionRoot;
  if (!root) return;
  const data = loopConditionSnapshot(node);
  node.__tdLoopOwnerId = data.looper ? String(data.looper.id) : null;

  if (data.state === "disconnected") {
    root.className = "td-loop-condition-card is-idle";
    root.innerHTML =
      '<div class="td-loop-condition-title"><strong>当前片段</strong>' +
      '<span>等待连接</span></div>' +
      '<div class="td-loop-condition-empty">连接循环信息的「片段数据」后显示执行状态。</div>';
    return;
  }

  const clipName = data.clip?.name || "暂无片段";
  const number = data.total ? (data.index + 1) + " / " + data.total : "—";
  const duration = data.seconds > 0
    ? Number(data.seconds.toFixed(data.seconds % 1 ? 2 : 0)) + "s"
    : "—";
  const percent = Math.round(data.progress * 100);
  const stateLabel = data.state === "running"
    ? "生成中 " + percent + "%"
    : data.state === "completed"
      ? "✓ 已完成"
      : data.state === "error"
        ? "生成失败"
        : "等待执行";

  root.className = "td-loop-condition-card is-" + data.state;
  const clipSummary = number + " · " + clipName + " · " + duration;
  const continuitySummary = data.transitionLabel + " · " +
    data.contextLabel + " · Seed " + data.seed;
  root.innerHTML =
    '<div class="td-loop-condition-title"><strong>当前片段</strong><span>' +
      escapeHtml(stateLabel) + '</span></div>' +
    '<div class="td-loop-condition-row"><span>片段</span><strong title="' +
      escapeHtml(clipSummary) + '">' + escapeHtml(clipSummary) + '</strong></div>' +
    '<div class="td-loop-condition-row"><span>衔接</span><strong title="' +
      escapeHtml(continuitySummary) + '">' + escapeHtml(continuitySummary) + '</strong></div>' +
    '<div class="td-loop-condition-progress"><i style="width:' +
      (data.state === "completed" ? 100 : percent) + '%"></i></div>';
}

function refreshLoopConditionCards(looper = null) {
  const graph = looper?.graph || app.graph;
  for (const node of graph?._nodes || []) {
    if (node?.comfyClass !== LOOP_CONDITION_NODE_CLASS || !node.__tdLoopConditionRoot) continue;
    if (looper) {
      const owner = loopConditionLooper(node);
      if (!owner || String(owner.id) !== String(looper.id)) continue;
    }
    renderLoopConditionCard(node);
  }
}

function mountLoopConditionNode(node) {
  if (!node || node.comfyClass !== LOOP_CONDITION_NODE_CLASS) return;
  if (node.__tdLoopConditionRoot) {
    renderLoopConditionCard(node);
    return;
  }

  const root = document.createElement("div");
  root.className = "td-loop-condition-card is-idle";
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

  const widget = node.addDOMWidget(
    "terrydirector_loop_condition_info",
    "terrydirector_loop_condition_info",
    root,
    {
      hideOnZoom: false,
      getMinHeight: () => 88,
      getMaxHeight: () => 104,
      margin: 5,
    }
  );
  widget.serialize = false;
  widget.options.serialize = false;
  node.__tdLoopConditionRoot = root;
  node.__tdLoopConditionWidget = widget;

  if (!node.__tdLoopConditionLinkBound) {
    const previous = node.onConnectionsChange;
    node.onConnectionsChange = function(...args) {
      const result = previous?.apply(this, args);
      queueMicrotask(() => renderLoopConditionCard(this));
      return result;
    };
    node.__tdLoopConditionLinkBound = true;
  }

  const width = Math.max(Number(node.size?.[0]) || 330, 330);
  const computed = node.computeSize?.();
  node.setSize?.([width, Math.max(Number(computed?.[1]) || 0, 250)]);
  renderLoopConditionCard(node);
}

function mountOutputNode(node) {
  if (!node || node.comfyClass !== LOOP_END_NODE_CLASS) return;
  ensureCss();

  if (!node.__tdOutputInfoRoot) {
    const root = document.createElement("div");
    root.className = "td-output-memory-card is-idle";
    root.innerHTML = `
      <div class="td-output-memory-title">
        <span class="td-output-memory-icon">i</span>
        <strong>合并画面内存</strong>
      </div>
      <div class="td-output-memory-note">正在读取连接信息…</div>
    `;
    root.addEventListener("pointerdown", event => event.stopPropagation());
    root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

    const widget = node.addDOMWidget(
      "terrydirector_output_memory_info",
      "terrydirector_output_memory_info",
      root,
      {
        hideOnZoom: false,
        getMinHeight: () => node.comfyClass === LOOP_END_NODE_CLASS ? 120 : 76,
        getMaxHeight: () => node.comfyClass === LOOP_END_NODE_CLASS ? 160 : 96,
        margin: 5,
      }
    );
    widget.serialize = false;
    widget.options.serialize = false;
    node.__tdOutputInfoRoot = root;
    node.__tdOutputInfoWidget = widget;

    const width = Math.max(Number(node.size?.[0]) || 320, 320);
    const computed = node.computeSize?.();
    node.setSize?.([
      width,
      Math.max(
        Number(node.size?.[1]) || 0,
        Number(computed?.[1]) || 0,
        node.comfyClass === LOOP_END_NODE_CLASS ? 245 : 185
      ),
    ]);
  }

  if (!node.__tdOutputConnectionBound) {
    const previousConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function(...args) {
      const result = previousConnectionsChange?.apply(this, args);
      queueMicrotask(() => renderOutputMemoryInfo(this));
      return result;
    };
    node.__tdOutputConnectionBound = true;
  }

  renderOutputMemoryInfo(node);
}


/**
 * The old Output estimates resolution from TerryDirector Config. LoopEnd
 * estimates it from the official H3 ReferenceToVideo node, so changes to its
 * width/height widgets must refresh the same shared memory notice.
 */
function bindLoopMemorySource(node) {
  if (!node || !LOOP_MEMORY_SOURCE_CLASSES.has(node.comfyClass)) return;
  const watchedWidgets = node.comfyClass === H3_CONDITION_NODE_CLASS
    ? ["width", "height"]
    : node.comfyClass === "ResolutionSelector"
      ? ["aspect_ratio", "megapixels", "multiple"]
      : node.comfyClass === "VAELoader"
        ? ["vae_name"]
        : ["PrimitiveInt", "PrimitiveFloat", "PrimitiveString"].includes(node.comfyClass)
          ? ["value"]
          : [];
  for (const name of watchedWidgets) {
    const widget = node.widgets?.find(item => item.name === name);
    if (!widget || widget.__tdMemoryRefreshBound) continue;
    const originalCallback = widget.callback;
    widget.callback = function(...args) {
      const result = originalCallback?.apply(this, args);
      queueMicrotask(refreshAllOutputMemoryInfo);
      return result;
    };
    widget.__tdMemoryRefreshBound = true;
  }
  if (node.__tdLoopMemoryLinkBound) return;
  const originalConnectionCallback = node.onConnectionsChange;
  node.onConnectionsChange = function(...args) {
    const result = originalConnectionCallback?.apply(this, args);
    queueMicrotask(refreshAllOutputMemoryInfo);
    return result;
  };
  node.__tdLoopMemoryLinkBound = true;
}

// Only the loop node owns an embedded timeline; upstream model choice stays external.
function mountNode(node) {
  if (node?.comfyClass !== LOOP_NODE_CLASS) return;
  ensureActivity(node);
  if (!node.__tdAiLinkBound) {
    const previous = node.onConnectionsChange;
    node.onConnectionsChange = function(...args) {
      const result = previous?.apply(this, args);
      queueMicrotask(() => { if (this === activeNode) pushAiConfig(this); });
      return result;
    };
    node.__tdAiLinkBound = true;
  }
  syncTailReferencePromptWidget(node);
  if (!node.__tdMinWidthBound) {
    const originalOnResize = node.onResize;
    node.onResize = function(size) {
      if (Array.isArray(size) && size[0] < LOOP_MIN_WIDTH) size[0] = LOOP_MIN_WIDTH;
      originalOnResize?.call(this, size);
    };
    node.__tdMinWidthBound = true;
  }
  const hide = () => {
    hideBackingWidget(configWidget(node));
    hideBackingWidget(tailReferencePromptWidget(node));
    for (const name of ["initial_iteration_value", "rerun_clip_id", "resume_previous"]) {
      hideBackingWidget(node.widgets?.find(w => w.name === name));
    }
  };
  hide();
  if (node.__tdRoot) {
    renderNode(node);
    return;
  }
  ensureCss();
  const backing = configWidget(node);
  if (!backing) return;
  const root = document.createElement("div");
  root.className = "td-node-shell td-node-shell-director";
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
  const widget = node.addDOMWidget("terrydirector_panel", "terrydirector", root, {
    hideOnZoom: false,
    getMinHeight: () => 118,
    getMaxHeight: () => 148,
    margin: 3,
  });
  widget.serialize = false;
  widget.options.serialize = false;
  node.__tdRoot = root;
  node.__tdDomWidget = widget;
  const originalCallback = backing.callback;
  backing.callback = value => {
    originalCallback?.(value);
    queueMicrotask(() => { hide(); renderNode(node); });
  };
  if ((node.size?.[0] || 0) < LOOP_MIN_WIDTH) {
    node.setSize?.([LOOP_MIN_WIDTH, node.size?.[1] || LOOP_DEFAULT_HEIGHT]);
  }
  renderNode(node);
}

const LLAMA_MODE_NEVER = 2;
const LLAMA_MODE_BYPASS = 4;
let tdAiConfigWatchTimer = null;
let tdAiConfigSignature = "";

function staticNodeType(node) {
  return String(
    node?.comfyClass ||
    node?.type ||
    node?.constructor?.comfyClass ||
    node?.constructor?.type ||
    ""
  );
}

function staticWidgetValue(node, names) {
  for (const name of names) {
    const widget = node?.widgets?.find(item => item?.name === name);
    if (widget?.value !== undefined) return widget.value;
  }
  return undefined;
}

function staticBooleanOutputValue(source, fallback = false, seen = new Set()) {
  if (!source?.node) return !!fallback;
  const node = source.node;
  const slot = Number(source.outputIndex);
  if (!Number.isSafeInteger(slot) || slot < 0) return !!fallback;

  const key = "bool-out:" + String(node.id) + ":" + slot;
  if (seen.has(key)) return !!fallback;
  seen.add(key);

  const type = staticNodeType(node);
  const lower = type.toLowerCase();

  if ((lower === "reroute" || lower.endsWith("reroute")) && node.inputs?.[0]) {
    return staticBooleanInputValue(node, node.inputs[0].name, fallback, seen);
  }

  const runtime = node.__terryRuntimeBool ?? node.properties?.terry_bool_switch_state;
  if (runtime !== undefined) return Boolean(runtime);

  const value = staticWidgetValue(
    node,
    ["value", "boolean", "bool", "switch", "enabled"]
  );
  return value !== undefined ? Boolean(value) : !!fallback;
}

function staticBooleanInputValue(node, inputName, fallback = false, seen = new Set()) {
  const widgetValue = staticWidgetValue(node, [inputName]);
  const local = typeof widgetValue === "boolean" ? widgetValue : !!fallback;
  const source = linkedOutputForInput(node, inputName);
  if (!source?.node) return local;
  return staticBooleanOutputValue(source, local, seen);
}

function staticIntegerOutputValue(source, fallback = 1, seen = new Set()) {
  if (!source?.node) return Number(fallback) || 1;
  const node = source.node;
  const slot = Number(source.outputIndex);
  if (!Number.isSafeInteger(slot) || slot < 0) return Number(fallback) || 1;

  const key = "int-out:" + String(node.id) + ":" + slot;
  if (seen.has(key)) return Number(fallback) || 1;
  seen.add(key);

  const type = staticNodeType(node).toLowerCase();
  if ((type === "reroute" || type.endsWith("reroute")) && node.inputs?.[0]) {
    return staticIntegerInputValue(node, node.inputs[0].name, fallback, seen);
  }

  const runtime = node.__terryRuntimeIndex ?? node.properties?.terry_line_switch_index;
  if (Number.isFinite(Number(runtime))) return Number(runtime);

  const value = staticWidgetValue(
    node,
    ["value", "index", "integer", "number", "select", "route"]
  );
  return Number.isFinite(Number(value)) ? Number(value) : (Number(fallback) || 1);
}

function staticIntegerInputValue(node, inputName, fallback = 1, seen = new Set()) {
  const widgetValue = staticWidgetValue(node, [inputName]);
  const local = Number.isFinite(Number(widgetValue)) ? Number(widgetValue) : (Number(fallback) || 1);
  const source = linkedOutputForInput(node, inputName);
  if (!source?.node) return local;
  return staticIntegerOutputValue(source, local, seen);
}

function staticRouteInputs(node) {
  return (node?.inputs || [])
    .filter(input => {
      const name = String(input?.name || "");
      return (
        /^routes\./.test(name) ||
        /^route[_\.\-]?\d+$/i.test(name) ||
        /^input[_\.\-]?\d+$/i.test(name)
      );
    })
    .sort((a, b) => {
      const number = input => {
        const match = String(input?.name || "").match(/(\d+)(?!.*\d)/);
        return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
      };
      return number(a) - number(b);
    });
}

function staticTwoWayBranchNames(node) {
  const names = new Set((node?.inputs || []).map(input => String(input?.name || "")));
  for (const pair of [
    ["on_false", "on_true"],
    ["input_false", "input_true"],
    ["false", "true"],
  ]) {
    if (names.has(pair[0]) && names.has(pair[1])) return pair;
  }
  return null;
}

function staticSwitchBoolean(node, fallback = false, seen = new Set()) {
  for (const name of ["switch", "enabled", "condition", "boolean", "bool"]) {
    if (node?.inputs?.some(input => input?.name === name) ||
        node?.widgets?.some(widget => widget?.name === name)) {
      return staticBooleanInputValue(node, name, fallback, seen);
    }
  }
  return !!fallback;
}

function staticSwitchIndex(node, fallback = 1, seen = new Set()) {
  for (const name of ["index", "route", "select", "selected"]) {
    if (node?.inputs?.some(input => input?.name === name) ||
        node?.widgets?.some(widget => widget?.name === name)) {
      return staticIntegerInputValue(node, name, fallback, seen);
    }
  }
  return Number(fallback) || 1;
}

function staticStringOutputValue(source, fallback = "", seen = new Set()) {
  if (!source?.node) return String(fallback ?? "");
  const parent = source.node;
  const slot = Number(source.outputIndex);
  if (!Number.isSafeInteger(slot) || slot < 0) return String(fallback ?? "");

  const key = "string-out:" + String(parent.id) + ":" + slot;
  if (seen.has(key)) return String(fallback ?? "");
  seen.add(key);

  const type = staticNodeType(parent);
  const lower = type.toLowerCase();

  // Reroute-style nodes are pure passthroughs.
  if ((lower === "reroute" || lower.endsWith("reroute")) && parent.inputs?.[0]) {
    return staticStringInputValue(parent, parent.inputs[0].name, fallback, seen);
  }

  // Native ComfyUI If/Else plus TerryXu two-way flow control. The generic
  // branch-name fallback also covers common third-party boolean switches.
  const branchPair = staticTwoWayBranchNames(parent);
  if (
    type === "ComfySwitchNode" ||
    type === "ComfySoftSwitchNode" ||
    type === "TerryXuBoolSwitch" ||
    (branchPair && lower.includes("switch"))
  ) {
    const [offName, onName] = branchPair || (
      type === "TerryXuBoolSwitch"
        ? ["input_false", "input_true"]
        : ["on_false", "on_true"]
    );
    const enabled = staticSwitchBoolean(parent, false, seen);
    return staticStringInputValue(parent, enabled ? onName : offName, fallback, seen);
  }

  // TerryXu multi-line switch plus conventional route/index switches.
  const routes = staticRouteInputs(parent);
  if (
    type === "TerryXuLineSwitch" ||
    (routes.length > 1 && lower.includes("switch"))
  ) {
    if (!routes.length) return String(fallback ?? "");
    const requested = Math.trunc(staticSwitchIndex(parent, 1, seen));
    const selected = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, routes.length));
    return staticStringInputValue(parent, routes[selected - 1].name, fallback, seen);
  }

  // Future TerryXu / third-party frontend nodes can expose their own static
  // resolver without requiring TerryDirector to know their class name.
  const resolver =
    typeof parent.__terryResolveStaticOutput === "function"
      ? parent.__terryResolveStaticOutput
      : typeof parent.resolveStaticOutput === "function"
        ? parent.resolveStaticOutput
        : null;
  if (resolver) {
    try {
      const resolved = resolver.call(parent, slot);
      if (typeof resolved === "string") return resolved;
      if (resolved?.node) {
        return staticStringOutputValue(
          { node: resolved.node, outputIndex: Number(resolved.slot ?? resolved.outputIndex ?? 0) },
          fallback,
          seen
        );
      }
      if (resolved?.inputName) {
        return staticStringInputValue(parent, String(resolved.inputName), fallback, seen);
      }
    } catch {
      // Fall through to ordinary static widget resolution.
    }
  }

  // Common static text/primitive nodes expose their payload as a widget.
  for (const name of ["value", "text", "string", "prompt", "system_prompt"]) {
    const candidate = parent.widgets?.find(widget => widget.name === name)?.value;
    if (typeof candidate === "string") return candidate;
  }
  const stringWidget = parent.widgets?.find(widget => typeof widget.value === "string");
  return typeof stringWidget?.value === "string"
    ? stringWidget.value
    : String(fallback ?? "");
}

function staticStringInputValue(node, inputName, fallback = "", seen = new Set()) {
  const widgetValue = node?.widgets?.find(widget => widget.name === inputName)?.value;
  const local = typeof widgetValue === "string" ? widgetValue : String(fallback ?? "");
  const source = linkedOutputForInput(node, inputName);
  if (!source?.node) return local;

  // Queue auto-enhancement receives the evaluated upstream STRING through the
  // Python Llama-config node. Editor-owned manual AI jobs do not execute the
  // Comfy graph, so resolve static routing nodes recursively here.
  return staticStringOutputValue(source, local, seen);
}

function directorLlamaState(node) {
  const linked = linkedNodeForInput(node, "llama_config");
  if (linked?.comfyClass !== "TerryDirectorLlamaConfig") {
    return { config: null, status: "disconnected", signature: "disconnected" };
  }

  const mode = Number(linked.mode ?? 0);
  const inactive = mode === LLAMA_MODE_NEVER || mode === LLAMA_MODE_BYPASS;
  const status = mode === LLAMA_MODE_BYPASS
    ? "bypassed"
    : mode === LLAMA_MODE_NEVER
      ? "muted"
      : "active";
  const value = (name, fallback) =>
    linked.widgets?.find(w => w.name === name)?.value ?? fallback;
  const raw = {
    type: "TERRYDIRECTOR_LLAMA_CONFIG",
    version: 1,
    model: String(value("model", "")),
    vision_model: String(value("vision_model", "None")),
    system_prompt_preset: String(value("system_prompt_preset", "H3 Skill")),
    system_prompt: staticStringInputValue(linked, "system_prompt", ""),
    seed: Number(value("seed", 8888)),
    think_mode: !!value("think_mode", false),
    n_ctx: Number(value("n_ctx", 16384)),
    max_tokens: Number(value("max_tokens", 8192)),
    temperature: Number(value("temperature", 0.7)),
    top_p: Number(value("top_p", 0.8)),
    gpu_layers: Number(value("gpu_layers", -1)),
  };
  return {
    config: inactive ? null : raw,
    status,
    signature: JSON.stringify([String(linked.id), mode, raw]),
  };
}

async function startStandalonePromptEnhancement(node, prompt) {
  const state = directorLlamaState(node);
  if (state.status !== "active" || !state.config) {
    const reason = state.status === "bypassed"
      ? "TerryDirector Llama 当前为 Bypassed"
      : state.status === "muted"
        ? "TerryDirector Llama 当前为 Never"
        : "请先连接 TerryDirector Llama";
    throw new Error(reason);
  }

  const text = String(prompt || "").trim();
  if (!text) throw new Error("提示词为空，无法增强");

  const response = await api.fetchApi("/terrydirector/api/ai-enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "prompt",
      llama_config: state.config,
      prompt: text,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "无法启动 AI 增强");

  const jobId = String(payload.job_id || "");
  if (!jobId) throw new Error("AI 增强任务未返回有效 ID");

  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    try {
      await api.fetchApi(
        "/terrydirector/api/ai-jobs/" + encodeURIComponent(jobId) + "/cancel",
        { method: "POST" }
      );
    } catch {}
  };

  const result = async () => {
    for (;;) {
      const statusResponse = await api.fetchApi(
        "/terrydirector/api/ai-jobs/" + encodeURIComponent(jobId),
        { cache: "no-store" }
      );
      if (!statusResponse.ok) throw new Error("AI 增强任务状态不可用");
      const job = await statusResponse.json();
      if (job.status === "completed") {
        const record = Array.isArray(job.results) ? job.results.at(-1) : null;
        const enhanced = String(record?.prompt || "").trim();
        if (!enhanced) throw new Error("AI 增强未返回有效提示词");
        return { prompt: enhanced, metadata: record?.metadata || {}, job };
      }
      if (job.status === "cancelled") throw new Error("AI 增强已取消");
      if (job.status === "error") throw new Error(job.error || "AI 增强失败");
      await new Promise(resolve => setTimeout(resolve, 450));
    }
  };

  return { jobId, result, cancel };
}

globalThis.TerryDirectorAI = {
  ...(globalThis.TerryDirectorAI || {}),
  resolveLlamaState: directorLlamaState,
  startPromptEnhancement: startStandalonePromptEnhancement,
};

function pushAiConfig(node=activeNode, force=false) {
  if (!frameReady || !frame?.contentWindow || !node) return;
  const state = directorLlamaState(node);
  if (!force && state.signature === tdAiConfigSignature) return;
  tdAiConfigSignature = state.signature;
  frame.contentWindow.postMessage({
    type:"terrydirector:ai-config",
    config:state.config,
    status:state.status,
  }, location.origin);
}

function startAiConfigWatch() {
  if (tdAiConfigWatchTimer !== null) return;
  tdAiConfigWatchTimer = window.setInterval(() => {
    if (activeNode) pushAiConfig(activeNode);
  }, 250);
}

function stopAiConfigWatch() {
  if (tdAiConfigWatchTimer !== null) {
    window.clearInterval(tdAiConfigWatchTimer);
    tdAiConfigWatchTimer = null;
  }
  tdAiConfigSignature = "";
}
// Do not use writeConfig(): changing prompts during a running loop Queue
// must not reset activity, prompt ID or in-progress rerun/cache state.
function applyAiResultsWithoutReset(node, records) {
  if (!isDirector(node) || !records || typeof records !== "object") return false;
  const current = readConfig(node);
  let changed = false;
  for (const clip of current.document.clips || []) {
    const patch = records[String(clip.id)];
    if (!patch?.aiPrompt || !patch?.aiMetadata) continue;
    const seed = String(patch.aiMetadata.seed ?? "").trim();
    if (!/^\d+$/.test(seed)) continue;
    if (clip.aiPrompt && String(clip.aiMetadata?.seed ?? "").trim() === seed) continue;
    clip.aiPrompt = String(patch.aiPrompt);
    clip.aiMetadata = clone(patch.aiMetadata);
    if (!clip.aiOptOut) clip.promptMode = "ai";
    changed = true;
  }
  if (!changed) return false;
  const widget = configWidget(node);
  if (!widget) return false;
  widget.value = JSON.stringify(current);
  widget.callback?.(widget.value);
  markChanged(node);
  renderNode(node);
  return true;
}
async function restoreAiResultsFromDisk(node) {
  try {
    const response = await api.fetchApi("/terrydirector/api/ai-results?node_id="+encodeURIComponent(node.id));
    if (!response.ok) return;
    const json = await response.json();
    const changed = applyAiResultsWithoutReset(node,json.clips);
    if (changed && node === activeNode && frameReady && !editorDirty) {
      frame.contentWindow.postMessage({type:"terrydirector:ai-patch",clips:json.clips},location.origin);
    }
  } catch (_) { /* No cache exists, and normal editing must still work. */ }
}
function bindAiResultsSync() {
  if (api.__tdAiResultsBound) return;
  api.__tdAiResultsBound = true;
  api.addEventListener("terrydirector:ai-result", event => {
    const detail = event.detail || {};
    const node = directorNodeFromId(detail.node_id);
    if (!isDirector(node)) return;
    applyAiResultsWithoutReset(node, detail.clips);
    if (node === activeNode && frameReady) {
      frame.contentWindow.postMessage({
        type:"terrydirector:ai-patch",clips:detail.clips
      }, location.origin);
    }
  });
}

let overlay = null;
let frame = null;
let activeNode = null;
let returnFocus = null;
let frameReady = false;
let pendingDocument = null;
let editorDirty = false;

function ensureEditorOverlay() {
  if (overlay) return;
  ensureCss();

  overlay = document.createElement("div");
  overlay.className = "td-editor-overlay";
  overlay.innerHTML =
    '<iframe class="td-editor-frame" title="TerryDirector 导演台" allowtransparency="true"></iframe>';
  document.body.append(overlay);

  frame = overlay.querySelector("iframe");
  frame.src = "/terrydirector/editor?embed=1";

  window.addEventListener("message", event => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    const message = event.data || {};

    if (message.type === "terrydirector:ready") {
      frameReady = true;
      pushPreferences();
      if (pendingDocument) {
        frame.contentWindow.postMessage(
          { type: "terrydirector:load", document: pendingDocument },
          location.origin
        );
        pendingDocument = null;
      }
      if (activeNode) {pushActivity(activeNode);pushAiConfig(activeNode, true);}
    } else if (message.type === "terrydirector:queue-workflow" && activeNode) {
      const node = activeNode;
      const next = readConfig(node);
      next.document = message.document || defaultDocument();
      writeConfig(node, next);
      editorDirty = false;

      const rerunClipId = String(message.rerunClipId || "").trim();
      const resumePrevious = message.resumePrevious === true;
      void (async () => {
        const widget = node.widgets?.find(item => item.name === "rerun_clip_id");
        const resumeWidget = node.widgets?.find(item => item.name === "resume_previous");
        if (resumePrevious && (node.comfyClass !== LOOP_NODE_CLASS || !resumeWidget)) {
          throw new Error("只有 TerryDirector 循环器支持从已保存的 MOV 继续");
        }
        if (rerunClipId) {
          if (node.comfyClass !== LOOP_NODE_CLASS || !widget) {
            throw new Error("只有 TerryDirector 循环器支持单片段重跑");
          }
          const response = await fetch("/terrydirector/api/rerun-check", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              loop_id: String(node.id), clip_id: rerunClipId, document: next.document,
            }),
          });
          const checked = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(checked.error || "承接上下文预检查失败");
        }

        if (widget) widget.value = rerunClipId;
        if (resumeWidget) resumeWidget.value = resumePrevious;
        node.__tdLocalRunLock = true;
        node.__tdRunActivity = blankActivity(node);
        pushActivity(node);
        try {
          const queued = await queueDirectorNode(node);
          if (!queued && !node.__tdPromptId) {
            node.__tdLocalRunLock = false;
            pushActivity(node);
          }
        } finally {
          // The payload has been serialized for ComfyUI by this point.
          // Do not accidentally rerun this clip in the next ordinary Queue.
          if (widget) widget.value = "";
          if (resumeWidget) resumeWidget.value = false;
          node.setDirtyCanvas?.(true, true);
        }
      })().catch(error => {
        node.__tdLocalRunLock = false;
        pushActivity(node);
        frame?.contentWindow?.postMessage({
          type: "terrydirector:run-error",
          error: String(error?.message || "提交单片段重跑失败"),
        }, location.origin);
      });
    } else if (message.type === "terrydirector:save" && activeNode) {
      const next = readConfig(activeNode);
      next.document = message.document || defaultDocument();
      writeConfig(activeNode, next);
      editorDirty = false;
      closeEditor();
    } else if (message.type === "terrydirector:dirty") {
      editorDirty = !!message.dirty;
    } else if (message.type === "terrydirector:request-close") {
      requestDiscard();
    } else if (message.type === "terrydirector:discard-close") {
      closeEditor();
    }
  });
}

function openEditor(node, button, selectedClipId = null) {
  ensureEditorOverlay();
  activeNode = node;
  editorDirty = false;
  returnFocus = button || null;
  tdAiConfigSignature = "";
  startAiConfigWatch();

  const documentData = clone(readConfig(node).document);
  if (selectedClipId && documentData.clips?.some(clip => clip.id === selectedClipId)) {
    documentData.selected = selectedClipId;
  }
  overlay.classList.add("is-open");
  document.documentElement.style.overflow = "hidden";

  if (frameReady) {
    pushPreferences();
    frame.contentWindow.postMessage(
      { type: "terrydirector:load", document: documentData },
      location.origin
    );
    pushActivity(node);
    pushAiConfig(node, true);
  } else {
    pendingDocument = documentData;
  }
  void restoreAiResultsFromDisk(node);
  frame.focus();
}

function requestDiscard() {
  if (!activeNode || !editorDirty) {
    closeEditor();
    return;
  }
  if (frameReady) {
    frame.contentWindow.postMessage(
      { type: "terrydirector:confirm-close" },
      location.origin
    );
  }
}

function closeEditor() {
  overlay?.classList.remove("is-open");
  document.documentElement.style.overflow = "";
  stopAiConfigWatch();
  activeNode = null;
  pendingDocument = null;
  editorDirty = false;

  const focus = returnFocus;
  returnFocus = null;
  focus?.focus?.();
}

app.registerExtension({
  name: "TerryDirector.NodeUI",
  settings: [
    {
      id: TRANSITION_SETTING_ID,
      name: "默认镜头衔接",
      type: "combo",
      category: ["TerryDirector", "时间线", "默认镜头衔接"],
      defaultValue: "tail_reference",
      options: [
        { text: "尾帧参考", value: "tail_reference" },
        { text: "尾帧续接", value: "tail_continuation" },
        { text: "独立", value: "independent" },
      ],
      tooltip: "决定新建片段与上一片段首尾贴合时的默认关系。不会修改已有接缝。",
      onChange() {
        pushPreferences();
      },
    },
    {
      id: TAIL_REFERENCE_PROMPT_SETTING_ID,
      name: "尾帧参考提示词",
      type: tailReferencePromptSettingRenderer,
      category: ["TerryDirector", "时间线", "尾帧参考提示词"],
      defaultValue: DEFAULT_TAIL_REFERENCE_PROMPT,
      tooltip: "仅在“尾帧参考”模式生效。{picture} 会在编译时替换为尾帧实际占用的 <Picture N>；{picture_number} 会替换为实际编号。",
      onChange() {
        syncAllTailReferencePromptWidgets();
      },
    },
  ],
  async setup() {
    ensureCss();
    ensureEditorOverlay();
    installLoopRegionOverlay(app);
    bindDirectorPartialQueueGuard();
    bindExecutionActivity();
    bindLoopSegmentActivity();
    bindAiResultsSync();
  },
  nodeCreated(node) {
    applyNewLoopDefaultSize(node);
    queueMicrotask(() => bindLoopMemorySource(node));
    if (isDirector(node)) {
      queueMicrotask(() => mountNode(node));
    } else if (node.comfyClass === LOOP_CONDITION_NODE_CLASS) {
      queueMicrotask(() => mountLoopConditionNode(node));
    } else if (node.comfyClass === LOOP_END_NODE_CLASS) {
      queueMicrotask(() => mountOutputNode(node));
    }
  },
  loadedGraphNode(node) {
    queueMicrotask(() => bindLoopMemorySource(node));
    if (isDirector(node)) {
      queueMicrotask(() => mountNode(node));
    } else if (node.comfyClass === LOOP_CONDITION_NODE_CLASS) {
      queueMicrotask(() => mountLoopConditionNode(node));
    } else if (node.comfyClass === LOOP_END_NODE_CLASS) {
      queueMicrotask(() => mountOutputNode(node));
    }
  },
});
