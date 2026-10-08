import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "TerryDirector";
const ADVANCED_NODE_CLASS = "TerryDirectorAdvanced";
const isDirector = node => node?.comfyClass === NODE_CLASS || node?.comfyClass === ADVANCED_NODE_CLASS;
const CONFIG_NODE_CLASS = "TerryDirectorConfig";
const CONFIG_ADVANCED_WIDGETS = new Set([
  "multiple",
  "sampler",
  "sigmas",
  "sigmas_denoise",
  "second_pass_method",
  "second_pass_model",
  "second_pass_high_ratio",
]);
const FPS = 24;
const DIRECTOR_MIN_WIDTH = 460;
const TRANSITION_SETTING_ID = "TerryDirector.DefaultTransitionMode";
const TAIL_REFERENCE_PROMPT_SETTING_ID = "TerryDirector.TailReferencePrompt";
const DEFAULT_TAIL_REFERENCE_PROMPT = "[镜头连续性参考]\n{picture} 为上一镜头最终帧。仅参考人物与场景状态、色彩、光线和整体基调；当前镜头按照本段描述重新构图与运镜。";
const TRANSITION_MODES = new Set(["tail_reference", "tail_continuation", "independent"]);
const cssHref = new URL("./terry_director.css", import.meta.url).href;

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

function b64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function restoreAdvancedState(node) {
  if (node?.comfyClass !== ADVANCED_NODE_CLASS || node.__tdStateRestoreInFlight) return;
  node.__tdStateRestoreInFlight = true;
  try {
    const response = await api.fetchApi(
      "/terrydirector/api/advanced-state?" +
      new URLSearchParams({ node_id: String(node.id) })
    );
    if (!response?.ok) return;
    const payload = await response.json();
    const state = payload?.state;
    const video = state?.video;
    if (!video?.filename) return;

    const activeClips = (readConfig(node).document.clips || []).filter(clip => !clip.suspended);
    const currentIds = activeClips.map(clip => String(clip.id));
    const savedIds = Array.isArray(state.segment_ids) ? state.segment_ids.map(String) : [];
    const sameSegments = currentIds.length === savedIds.length &&
      currentIds.every((id, index) => id === savedIds[index]);
    if (!sameSegments) return;

    const params = new URLSearchParams({
      filename: video.filename,
      subfolder: video.subfolder || "",
      type: video.type || "output",
    });
    node.__tdPreviewUrl = "/view?" + params.toString();
    node.__tdRerunCacheReady = true;
    node.__tdRunActivity = blankActivity(node);
    const completedAt = state.saved_at
      ? new Date(Number(state.saved_at) * 1000).toISOString()
      : new Date().toISOString();
    for (const clip of activeClips) {
      const record = node.__tdRunActivity[clip.id];
      if (!record) continue;
      record.status = RUN_COMPLETED;
      record.progress = 1;
      record.completedAt = completedAt;
      record.error = "";
    }
    renderNode(node);
  } catch (error) {
    console.warn("[TerryDirector] Failed to restore Advanced state", error);
  } finally {
    node.__tdStateRestoreInFlight = false;
  }
}

function revokeAdvancedLivePreviewUrl(node) {
  if (node?.__tdLivePreviewObjectUrl) {
    URL.revokeObjectURL(node.__tdLivePreviewObjectUrl);
    node.__tdLivePreviewObjectUrl = null;
  }
}

function beginAdvancedLivePreview(node) {
  if (node?.comfyClass !== ADVANCED_NODE_CLASS) return;
  const enabled = node.widgets?.find(w => w.name === "preview_enabled")?.value !== false;
  if (!enabled) return;
  revokeAdvancedLivePreviewUrl(node);
  node.__tdLivePreviewActive = true;
  node.__tdLivePreviewData = null;
}

function endAdvancedLivePreview(node) {
  if (node?.comfyClass !== ADVANCED_NODE_CLASS) return;
  revokeAdvancedLivePreviewUrl(node);
  node.__tdLivePreviewActive = false;
  node.__tdLivePreviewData = null;
}

function applyAdvancedLivePreview(node, data = node?.__tdLivePreviewData) {
  if (!node?.__tdRoot || !node.__tdLivePreviewActive) return;
  const root = node.__tdRoot;
  const player = root.querySelector(".td-adv-player");
  const finalVideo = root.querySelector(".td-adv-video");
  const liveImage = root.querySelector(".td-adv-live-image");
  const liveVideo = root.querySelector(".td-adv-live-video");
  const placeholder = root.querySelector(".td-adv-placeholder");
  const status = root.querySelector(".td-adv-live-status");
  const playButton = root.querySelector('[data-adv="play"]');
  if (!player || !liveImage || !liveVideo) return;

  player.classList.add("is-live-preview");
  player.classList.remove("has-final-video");
  if (finalVideo) {
    finalVideo.pause();
    finalVideo.hidden = true;
  }
  if (playButton) {
    playButton.disabled = true;
    playButton.textContent = "▶";
  }
  if (status) {
    const step = Number(data?.step);
    const total = Number(data?.total);
    status.hidden = false;
    status.textContent = Number.isFinite(step) && Number.isFinite(total) && total > 0
      ? `实时预览  ${step}/${total}`
      : "实时预览";
  }

  if (!data?.image) {
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.querySelector("span").textContent = "等待采样预览";
    }
    liveImage.hidden = true;
    liveVideo.hidden = true;
    return;
  }

  if (placeholder) placeholder.hidden = true;
  const mime = String(data.mime || "image/jpeg");
  if (mime === "video/mp4") {
    liveImage.hidden = true;
    liveVideo.hidden = false;
    revokeAdvancedLivePreviewUrl(node);
    const url = URL.createObjectURL(b64ToBlob(data.image, mime));
    node.__tdLivePreviewObjectUrl = url;
    liveVideo.src = url;
    liveVideo.currentTime = 0;
    void liveVideo.play().catch(() => {});
  } else {
    revokeAdvancedLivePreviewUrl(node);
    liveVideo.pause();
    liveVideo.removeAttribute("src");
    liveVideo.load();
    liveVideo.hidden = true;
    liveImage.hidden = false;
    liveImage.src = `data:${mime};base64,${data.image}`;
  }
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
  if (!frameReady || activeNode !== node || !frame?.contentWindow) return;
  frame.contentWindow.postMessage(
    { type: "terrydirector:activity", activity: activityPayload(node) },
    location.origin
  );
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
  if (node.comfyClass === ADVANCED_NODE_CLASS) beginAdvancedLivePreview(node);
  if (node.__tdRerunActiveClipId) {
    const activity = ensureActivity(node);
    const record = activity[node.__tdRerunActiveClipId];
    if (record) {
      record.status = RUN_RUNNING;
      record.progress = 0;
      record.elapsedSeconds = 0;
      record.completedAt = null;
      record.error = "";
      record.startedAt = performance.now();
    }
  } else {
    node.__tdRunActivity = blankActivity(node);
  }
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
      if (node.__tdRerunActiveClipId && clip.id !== node.__tdRerunActiveClipId) continue;
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
    if (node.comfyClass === ADVANCED_NODE_CLASS) endAdvancedLivePreview(node);
    if (node.__tdRerunActiveClipId) {
      const widget = node.widgets?.find(w => w.name === "rerun_clip_id");
      if (widget) {
        widget.value = "";
        widget.callback?.("");
      }
      node.__tdRerunActiveClipId = null;
    }
    pushActivity(node);
  }
  return matched;
}

function bindExecutionActivity() {
  if (bindExecutionActivity.bound) return;
  bindExecutionActivity.bound = true;

  api.addEventListener("progress_state", event => applyProgressState(event.detail));

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

  api.addEventListener("kj_preview_override", event => {
    const data = event.detail || {};
    const node = directorNodeFromExecutionId(data.node_id);
    if (!node || node.comfyClass !== ADVANCED_NODE_CLASS) return;
    if (node.widgets?.find(w => w.name === "preview_enabled")?.value === false) return;
    node.__tdLivePreviewActive = true;
    node.__tdLivePreviewData = data;
    applyAdvancedLivePreview(node, data);
  });

  // Native video save reports its file metadata through the normal ComfyUI
  // execution event. The expanded graph's node_id may be namespaced.
  api.addEventListener("executed", event => {
    const detail = event.detail || {};
    const nodeId = String(detail.node ?? "");
    if (!nodeId.includes("td_advanced_finish") && !nodeId.includes("td_advanced_save_video") && !directorNodeFromId(nodeId)) return;
    const displayId = detail.display_node_id ?? detail.display_node ?? detail.parent_node_id;
    let owningNode = directorNodeFromId(displayId) || directorNodeFromExecutionId(nodeId);
    if (!owningNode || owningNode.comfyClass !== ADVANCED_NODE_CLASS) return;
    const video = detail.output?.video?.[0] ||
      detail.output?.td_saved_video?.[0] ||
      detail.output?.images?.[0] || detail.output?.videos?.[0] ||
      detail.output?.gifs?.[0];
    if (!video?.filename) return;
    const params = new URLSearchParams({
      filename: video.filename,
      subfolder: video.subfolder || "",
      type: video.type || "output",
    });
    endAdvancedLivePreview(owningNode);
    owningNode.__tdPreviewUrl = "/view?" + params.toString();
    renderNode(owningNode);
  });

  api.addEventListener("execution_success", event => {
    finishPromptActivity(event.detail?.prompt_id, true);
  });
  api.addEventListener("execution_error", event => {
    finishPromptActivity(
      event.detail?.prompt_id,
      false,
      event.detail?.exception_message || "生成失败"
    );
  });
  api.addEventListener("execution_interrupted", event => {
    const matched = finishPromptActivity(
      event.detail?.prompt_id,
      false,
      "生成已取消"
    );
    if (matched) {
      void api.freeMemory({ freeExecutionCache: true });
    }
  });
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
    clips: [
      {
        id: "clip-1",
        name: "片段 01",
        start: 0,
        end: FPS * 10,
        prompt: "",
        refs: [],
        useGlobalPrompt: true,
        transitionMode: "tail_reference",
        suspended: false,
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
          start,
          end,
          prompt: String(raw?.prompt || ""),
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

function authoredAssetIds(documentData) {
  const assets = documentData.assets || [];
  const ids = referencedAssetIds(documentData.globalPrompt, assets);
  for (const clip of documentData.clips || []) {
    for (const id of referencedAssetIds(clip.prompt, assets)) ids.add(id);
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
    if (node.comfyClass === ADVANCED_NODE_CLASS) node.__tdRerunCacheReady = false;
  }
  widget.value = nextValue;
  widget.callback?.(widget.value);
  markChanged(node);
  if (render) renderNode(node);
}

function miniRulerHtml(totalFrames) {
  const totalSeconds = Math.max(0, totalFrames / FPS);
  const desired = totalSeconds / 6;
  const candidates = [1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 300, 600];
  const step = candidates.find(value => value >= desired) || candidates.at(-1);
  const ticks = [];
  for (let seconds = 0; seconds <= totalSeconds + 0.0001; seconds += step) {
    const left = totalSeconds ? (seconds / totalSeconds) * 100 : 0;
    const minutes = Math.floor(seconds / 60);
    const remain = Math.round(seconds % 60);
    const label = `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
    const edgeClass = seconds === 0 ? " is-first" : Math.abs(seconds - totalSeconds) < 0.001 ? " is-last" : "";
    ticks.push(`<span class="td-mini-ruler-tick${edgeClass}" style="left:${left}%"><b>${label}</b><i></i></span>`);
  }
  return `<div class="td-mini-ruler" aria-hidden="true">${ticks.join("")}</div>`;
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
      const statusText = visualCompleted
        ? "已完成"
        : running
          ? (percent > 0 ? `生成中 ${percent}%` : "准备中")
          : failed
            ? "生成失败"
            : "";
      const title = statusText ? `${clip.name} · ${statusText}` : clip.name;
      const progressHtml = (running || visualCompleted)
        ? `<span class="td-mini-clip-progress"><i style="width:${visualCompleted ? 100 : percent}%"></i></span>`
        : "";

      return `<div class="td-mini-clip${suspended}${runClass}" style="left:${left}%;width:${width}%;z-index:${running && !visualCompleted ? 12 : index + 1}" title="${escapeHtml(title)}"><div class="td-mini-clip-meta"><span class="td-mini-index">片段 ${index + 1}</span><span class="td-mini-duration">${duration}</span></div><span class="td-mini-label">${escapeHtml(clip.name)}</span>${progressHtml}</div>`;
    })
    .join("");

  return miniRulerHtml(total) + clipHtml;
}

function renderNode(node) {
  const root = node.__tdRoot;
  if (!root) return;
  if (node.comfyClass === ADVANCED_NODE_CLASS) return renderAdvancedNode(node);

  const config = readConfig(node);
  const doc = config.document;
  const total = Math.max(0, ...doc.clips.map(clip => clip.end || 0));
  const usedAssetIds = authoredAssetIds(doc);
  const usedAssets = doc.assets.filter(asset => usedAssetIds.has(asset.id)).length;
  const activity = ensureActivity(node);
  const totalSeconds = Number((total / FPS).toFixed((total / FPS) % 1 ? 2 : 0));

  root.innerHTML = `<div class="td-node-card td-node-card-director">
    <div class="td-mini-wrap td-mini-wrap-director">
      <div class="td-mini-head">
        <strong>时间线</strong>
        <span class="td-mini-stats">
          总时长：<b>${totalSeconds}</b>s
          <i></i>
          片段数：<b>${doc.clips.length}</b>
          <i></i>
          导入资产：<b>${doc.assets.length}</b><em>（<b>${usedAssets}</b> 个被使用）</em>
        </span>
        <span class="td-node-spacer"></span>
        <button class="td-mini-edit" data-action="edit">✦ 编辑</button>
      </div>
      <div class="td-mini-timeline" data-action="edit" title="打开时间线编辑器">${timelineHtml(doc, activity)}</div>
    </div>
  </div>`;

  root.querySelectorAll('[data-action="edit"]').forEach(button => {
    button.addEventListener("click", () => openEditor(node, button));
  });
}



// Advanced review is intentionally independent of the full editor timeline.
// Persist UI selection in memory, never in the creative document.
function advancedAspectRatio(node) {
  const input = node.inputs?.find(item => item.name === "director_config");
  const link = input?.link != null ? app.graph?.links?.[input.link] : null;
  const configNode = link ? app.graph?.getNodeById?.(link.origin_id) : null;
  if (configNode?.comfyClass !== CONFIG_NODE_CLASS) return 16 / 9;
  const value = String(configNode.widgets?.find(widget => widget.name === "aspect_ratio")?.value ?? "");
  const match = value.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (!match) return 16 / 9;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

function syncAdvancedAspect(node) {
  if (node?.comfyClass !== ADVANCED_NODE_CLASS || !node.__tdRoot) return;
  // Landscape uses its true aspect ratio; portrait is letterboxed inside
  // a square viewport so the node never becomes unusually tall.
  const ratio = advancedAspectRatio(node);
  const viewportRatio = Math.max(1, ratio);
  const previousViewportRatio = node.__tdViewportRatio || 1;
  node.__tdAspectRatio = ratio;
  node.__tdViewportRatio = viewportRatio;
  const player = node.__tdRoot.querySelector(".td-adv-player");
  if (player) {
    player.style.setProperty("--td-viewport-ratio", String(viewportRatio));
    player.classList.toggle("is-landscape", ratio >= 1);
  }
  const video = node.__tdRoot.querySelector(".td-adv-video");
  if (video) video.style.aspectRatio = String(ratio);
  if (Math.abs(viewportRatio - previousViewportRatio) > 0.0001 && Array.isArray(node.size)) {
    const width = Math.max(200, (node.size[0] || 460) - 40);
    const delta = width / viewportRatio - width / previousViewportRatio;
    node.setSize?.([node.size[0], Math.max(300, Math.round(node.size[1] + delta))]);
  }
}

function syncLinkedAdvancedNodes(configNode) {
  for (const node of app.graph?._nodes || []) {
    if (node?.comfyClass !== ADVANCED_NODE_CLASS) continue;
    const input = node.inputs?.find(item => item.name === "director_config");
    const link = input?.link != null ? app.graph?.links?.[input.link] : null;
    if (link && String(link.origin_id) === String(configNode.id)) syncAdvancedAspect(node);
  }
}

function renderAdvancedNode(node) {
  const root = node.__tdRoot;
  if (!root) return;
  const doc = readConfig(node).document;
  const clips = (doc.clips || []).filter(clip => !clip.suspended);
  const totalFrames = Math.max(1, ...clips.map(clip => Number(clip.end) || 0));
  const totalSeconds = totalFrames / FPS;
  const state = node.__tdReview ||= { selected: doc.selected, time: 0, manualScroll: false };
  state.rerunSeedCustom ||= {};
  if (!clips.some(c => c.id === state.selected)) state.selected = clips[0]?.id || null;
  const globalSeed = String(node.widgets?.find(w => w.name === "seed")?.value ?? 0);
  const selectedRerunSeed = state.selected && state.rerunSeedCustom[state.selected] != null
    ? String(state.rerunSeedCustom[state.selected])
    : globalSeed;
  const previousTrack = root.querySelector(".td-adv-scroll");
  const previousScroll = previousTrack?.scrollLeft || 0;
  const oldVideo = root.querySelector(".td-adv-video");
  if (oldVideo && !node.__tdLivePreviewActive && Number.isFinite(oldVideo.currentTime)) {
    state.time = oldVideo.currentTime;
    oldVideo.pause();
  }
  const format = seconds => {
    const value = Math.max(0, seconds || 0);
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  };
  const shortestFrames = Math.max(1, Math.min(...clips.map(c => Math.max(1, Number(c.end) - Number(c.start)))));
  // One proportional scale for every clip: preserve time mapping while guaranteeing click targets.
  const pixelsPerSecond = Math.max(14, 64 * FPS / shortestFrames);
  const px = frames => Math.max(1, Math.round(frames / FPS * pixelsPerSecond));
  const trackWidth = Math.max(1, px(totalFrames));
  const activity = ensureActivity(node);
  const allSegmentsCompleted = clips.length > 0 &&
    clips.every(clip => activity[clip.id]?.status === RUN_COMPLETED);
  if (allSegmentsCompleted) node.__tdRerunCacheReady = true;
  const rerunHasCache = !!node.__tdRerunCacheReady;
  const rerunBusy = !!node.__tdPromptId || !!node.__tdLocalRunLock;
  const tickStep = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(v => v * pixelsPerSecond >= 72) || 600;
  const rulerHtml = Array.from({ length: Math.min(300, Math.floor(totalSeconds / tickStep) + 1) }, (_, i) => {
    const seconds = i * tickStep;
    return `<span class="td-mini-ruler-tick${i === 0 ? " is-first" : ""}" style="left:${Math.round(seconds * pixelsPerSecond)}px"><b>${format(seconds)}</b><i></i></span>`;
  }).join("");
  const clipHtml = clips.map((clip, index) => {
    const left = px(Number(clip.start));
    const width = px(Number(clip.end) - Number(clip.start));
    const record = activity[clip.id] || {};
    const running = record.status === RUN_RUNNING;
    const completed = record.status === RUN_COMPLETED;
    const failed = record.status === RUN_ERROR;
    const percent = completed ? 100 : Math.round(clamp01(record.progress) * 100);
    const classes = [clip.suspended ? "is-suspended" : "", running ? "is-running" : "", completed ? "is-completed" : "", failed ? "is-error" : "", clip.id === state.selected ? "is-selected" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="td-mini-clip td-adv-clip ${classes}" style="left:${left}px;width:${width}px" data-clip="${escapeHtml(clip.id)}" title="${escapeHtml(clip.name)}">
      <div class="td-mini-clip-meta"><span class="td-mini-index">片段 ${index + 1}</span><span class="td-mini-duration">${timeText(Number(clip.end)-Number(clip.start))}</span></div>
      <span class="td-mini-label">${escapeHtml(clip.name)}</span>
      ${running || completed ? `<span class="td-mini-clip-progress"><i style="width:${percent}%"></i></span>` : ""}
    </button>`;
  }).join("");
  const saveDir = node.widgets?.find(w => w.name === "save_subfolder")?.value || "TerryDirector";
  const prefix = node.widgets?.find(w => w.name === "filename_prefix")?.value || "video/TerryDirector";
  const videoFormat = node.widgets?.find(w => w.name === "video_format")?.value || "auto";
  const videoCodec = node.widgets?.find(w => w.name === "video_codec")?.value || "auto";
  const previewEnabled = node.widgets?.find(w => w.name === "preview_enabled")?.value !== false;
  const previewFrameMode = node.widgets?.find(w => w.name === "preview_frame_mode")?.value || "half";
  const previewTinyWidget = node.widgets?.find(w => w.name === "preview_tiny_vae");
  const previewTinyVae = previewTinyWidget?.value || "none";
  const previewModeOptions = [
    ["first", "首帧"],
    ["half", "半数帧"],
    ["all", "所有帧"],
  ];
  const nativeValues = typeof previewTinyWidget?.options?.values === "function"
    ? previewTinyWidget.options.values(previewTinyWidget)
    : previewTinyWidget?.options?.values;
  const tinyVaeValues = Array.isArray(nativeValues) && nativeValues.length
    ? nativeValues
    : ["none"];
  const formats = ["auto", "mp4", "mkv", "webm"];
  const codecs = videoFormat === "webm" ? ["auto", "av1"] : ["auto", "h264", "av1"];
  const options = (items, current) => items.map(v => `<option value="${v}"${v === current ? " selected" : ""}>${v}</option>`).join("");
  root.innerHTML = `<div class="td-node-card td-node-card-advanced">
    <div class="td-adv-player${advancedAspectRatio(node) >= 1 ? " is-landscape" : ""}${node.__tdLivePreviewActive ? " is-live-preview" : ""}" style="--td-viewport-ratio:${Math.max(1, advancedAspectRatio(node))}" aria-label="视频预览">
      <video class="td-adv-video" style="aspect-ratio:${advancedAspectRatio(node)}" playsinline preload="metadata"></video>
      <img class="td-adv-live-image" alt="实时采样预览" hidden/>
      <video class="td-adv-live-video" muted loop autoplay playsinline hidden></video>
      <div class="td-adv-live-status" hidden>实时预览</div>
      <div class="td-adv-placeholder">▶<span>${node.__tdLivePreviewActive ? "等待采样预览" : "等待生成视频"}</span></div>
    </div>
    <div class="td-adv-controls">
      <button type="button" data-adv="play" aria-label="播放或暂停" disabled>▶</button>
      <span class="td-adv-clock">${format(state.time)} / ${format(totalSeconds)}</span>
      <span class="td-adv-spacer"></span>
      <label class="td-adv-preview-toggle"><input type="checkbox" data-adv="preview-enabled" ${previewEnabled ? "checked" : ""}/>启用预览</label><button type="button" class="td-mini-edit td-adv-locate" data-adv="follow" title="定位当前播放头">⌖ 定位</button>
    </div>
    <div class="td-adv-timeline-panel">
      <div class="td-mini-head td-adv-head"><strong>时间线</strong><span class="td-mini-stats">总时长：<b>${Number(totalSeconds.toFixed(2))}</b>s <i></i> 片段数：<b>${clips.length}</b> <i></i> 导入资产：<b>${doc.assets.length}</b></span><span class="td-node-spacer"></span><button class="td-mini-edit" data-action="edit">✦ 编辑</button></div>
      <div class="td-adv-scroll td-mini-timeline" tabindex="0" aria-label="横向滚动时间线">
        <div class="td-adv-track" style="width:${trackWidth}px">
          <div class="td-mini-ruler">${rulerHtml}</div>
          ${clipHtml}
          <div class="td-adv-playhead" style="left:${Math.min(totalSeconds,state.time)*pixelsPerSecond}px" role="slider" tabindex="0" aria-label="播放头" aria-valuemin="0" aria-valuemax="${totalSeconds}" aria-valuenow="${state.time}"><span class="td-adv-playhead-label">${format(state.time)}</span><i class="td-adv-playhead-grip"></i></div>
        </div>
      </div>
    </div>
    <div class="td-adv-actions"><span class="td-adv-selected">已选中：${escapeHtml(clips.find(c => c.id === state.selected)?.name || "无")}</span>
      ${rerunHasCache ? `<div class="td-adv-rerun-tools${rerunBusy ? " is-busy" : ""}">
        <label class="td-adv-rerun-seed-label">重跑 Seed
          <span class="td-adv-rerun-seed-box">
            <input class="td-adv-rerun-seed" type="text" inputmode="numeric" value="${escapeHtml(selectedRerunSeed)}" title="默认跟随顶部全局 Seed；修改后仅用于当前选中片段" ${rerunBusy ? "disabled" : ""}/>
            <button type="button" class="td-adv-seed-random" data-adv="seed-random" title="为当前片段随机一个重跑 Seed" aria-label="随机重跑 Seed" ${rerunBusy ? "disabled" : ""}>🎲</button>
          </span>
        </label>
        <button type="button" data-adv="rerun" title="只重新采样当前片段，其他片段复用缓存" ${rerunBusy ? "disabled" : ""}>↻ 重跑此片段</button>
      </div>` : ""}
    </div>
    ${previewEnabled ? `<details class="td-adv-preview-settings"><summary>视频预览 <small>KJ Preview Override</small></summary>
      <label>最大分辨率<input data-widget="preview_max_resolution" type="number" value="${Number(node.widgets?.find(w => w.name === "preview_max_resolution")?.value ?? 1024)}"/></label>
      <label>JPEG 质量<input data-widget="preview_jpeg_quality" type="number" min="30" max="100" value="${Number(node.widgets?.find(w => w.name === "preview_jpeg_quality")?.value ?? 80)}"/></label>
      <label>预览帧<select data-widget="preview_frame_mode">${previewModeOptions.map(([value,label]) => `<option value="${value}"${value === previewFrameMode ? " selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>预览 FPS<input data-widget="preview_fps" type="number" min="1" value="${Number(node.widgets?.find(w => w.name === "preview_fps")?.value ?? 12)}"/></label>
      <label>Tiny VAE<select data-widget="preview_tiny_vae">${tinyVaeValues.map(value => `<option value="${escapeHtml(String(value))}"${String(value) === String(previewTinyVae) ? " selected" : ""}>${escapeHtml(String(value))}</option>`).join("")}</select></label>
      <label class="td-adv-preview-toggle"><input type="checkbox" data-widget="preview_suppress_default" ${node.widgets?.find(w => w.name === "preview_suppress_default")?.value === true ? "checked" : ""}/>屏蔽默认预览</label>
    </details>` : ""}<details class="td-adv-export"><summary>文件保存 <small>ComfyUI 原生编码</small></summary>
      <label>文件名前缀<input data-widget="filename_prefix" value="${escapeHtml(prefix)}"/></label>
      <label>格式<select data-widget="video_format">${options(formats, videoFormat)}</select></label>
      <label>编解码器<select data-widget="video_codec">${options(codecs, videoCodec)}</select></label>
    </details>
    
  </div>`;
  const video = root.querySelector(".td-adv-video");
  const player = root.querySelector(".td-adv-player");
  const playButton = root.querySelector('[data-adv="play"]');
  const source = node.__tdPreviewUrl;
  const syncPlaybackButton = () => {
    if (!playButton) return;
    const canPlay = !!source && !node.__tdLivePreviewActive;
    playButton.disabled = !canPlay;
    const playing = canPlay && !video.paused && !video.ended;
    playButton.textContent = playing ? "⏸" : "▶";
    playButton.setAttribute("aria-label", playing ? "暂停" : "播放");
    player?.classList.toggle("is-playing", playing);
  };
  if (source && !node.__tdLivePreviewActive) {
    video.hidden = false;
    video.src = source;
    player?.classList.add("has-final-video");
    root.querySelector(".td-adv-placeholder").hidden = true;
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(state.time, video.duration || 0);
      syncPlaybackButton();
    });
  } else if (node.__tdLivePreviewActive) {
    applyAdvancedLivePreview(node);
  }
  video.addEventListener("play", syncPlaybackButton);
  video.addEventListener("pause", syncPlaybackButton);
  video.addEventListener("ended", syncPlaybackButton);
  syncPlaybackButton();
  const scroller = root.querySelector(".td-adv-scroll");
  scroller.scrollLeft = previousScroll;
  const playhead = root.querySelector(".td-adv-playhead");
  const updateHead = () => {
    playhead.style.left = `${state.time * pixelsPerSecond}px`;
    playhead.setAttribute("aria-valuenow", String(state.time));
    playhead.querySelector(".td-adv-playhead-label").textContent = format(state.time);
  };
  const clock = root.querySelector(".td-adv-clock");
  const follow = () => {
    const position = Math.round(state.time * pixelsPerSecond);
    scroller.scrollLeft = Math.max(0, position - scroller.clientWidth * .35);
  };
  const setTime = value => {
    state.time = Math.max(0, Math.min(totalSeconds, Number(value) || 0));
    clock.textContent = `${format(state.time)} / ${format(totalSeconds)}`;
    updateHead();
    if (source && Number.isFinite(video.duration)) video.currentTime = Math.min(state.time, video.duration);
  };
  let draggingHead = false;
  const track = root.querySelector(".td-adv-track");
  const seekPointer = event => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    setTime(Math.round(Math.max(0, Math.min(totalSeconds, ((event.clientX - rect.left) * (track.offsetWidth / rect.width)) / pixelsPerSecond)) * FPS) / FPS);
  };
  track.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("[data-clip]")) return;
    draggingHead = true;
    track.setPointerCapture(event.pointerId);
    seekPointer(event);
    event.stopPropagation();
  });
  track.addEventListener("pointermove", event => { if (draggingHead) seekPointer(event); });
  track.addEventListener("pointerup", () => { draggingHead = false; });
  track.addEventListener("pointercancel", () => { draggingHead = false; });
  playhead.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    setTime(state.time + (event.key === "ArrowRight" ? 1 : -1) / FPS);
    event.preventDefault();
  });
  scroller.addEventListener("wheel", event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) && !event.shiftKey) return;
    scroller.scrollLeft += event.deltaY + event.deltaX;
    state.manualScroll = true;
    event.preventDefault();
  }, { passive: false });
  scroller.addEventListener("scroll", () => { state.manualScroll = true; }, { passive: true });
  root.querySelectorAll("[data-clip]").forEach(button => button.addEventListener("click", () => {
    const clip = clips.find(c => c.id === button.dataset.clip);
    if (!clip) return;
    state.selected = clip.id;
    setTime(Number(clip.start) / FPS);
    root.querySelectorAll("[data-clip]").forEach(item => item.classList.toggle("is-selected", item === button));
    root.querySelector(".td-adv-selected").textContent = `已选中：${clip.name}`;
    const seedInput = root.querySelector(".td-adv-rerun-seed");
    if (seedInput) {
      seedInput.value = state.rerunSeedCustom[clip.id] != null
        ? String(state.rerunSeedCustom[clip.id])
        : String(node.widgets?.find(w => w.name === "seed")?.value ?? 0);
    }
  }));
  root.querySelector('[data-adv="follow"]').addEventListener("click", () => { state.manualScroll = false; follow(); });
  const toggleFinalPlayback = () => {
    if (!source || node.__tdLivePreviewActive) return;
    if (video.ended) video.currentTime = 0;
    if (video.paused) void video.play(); else video.pause();
  };
  playButton?.addEventListener("click", toggleFinalPlayback);
  player?.addEventListener("click", event => {
    if (node.__tdLivePreviewActive || !source) return;
    if (event.button != null && event.button !== 0) return;
    toggleFinalPlayback();
  });
  video.addEventListener("timeupdate", () => {
    state.time = video.currentTime;
    updateHead();
    clock.textContent = `${format(state.time)} / ${format(totalSeconds)}`;
    if (!state.manualScroll) follow();
  });
  root.querySelector('[data-action="edit"]').addEventListener("click", e => openEditor(node, e.currentTarget));
  const rerunSeedInput = root.querySelector(".td-adv-rerun-seed");
  rerunSeedInput?.addEventListener("change", () => {
    if (!state.selected) return;
    const raw = String(rerunSeedInput.value || "").trim();
    if (!/^\d+$/.test(raw)) {
      rerunSeedInput.value = state.rerunSeedCustom[state.selected] != null
        ? String(state.rerunSeedCustom[state.selected])
        : String(node.widgets?.find(w => w.name === "seed")?.value ?? 0);
      return;
    }
    state.rerunSeedCustom[state.selected] = raw;
  });
  root.querySelector('[data-adv="seed-random"]')?.addEventListener("click", event => {
    if (!rerunHasCache || rerunBusy || event.currentTarget.disabled || !state.selected || !rerunSeedInput) return;
    const words = new Uint32Array(2);
    crypto.getRandomValues(words);
    // Keep the generated value within JS's exact integer range so the hidden
    // ComfyUI INT widget receives the same seed that the user sees.
    const randomSeed = ((words[0] & 0x1fffff) * 0x100000000) + words[1];
    const value = String(randomSeed);
    state.rerunSeedCustom[state.selected] = value;
    rerunSeedInput.value = value;
  });
  root.querySelector('[data-adv="rerun"]')?.addEventListener("click", buttonEvent => {
    if (!rerunHasCache || rerunBusy || buttonEvent.currentTarget.disabled || !state.selected || node.__tdPromptId || node.__tdLocalRunLock) return;
    const rawSeed = String(rerunSeedInput?.value ?? node.widgets?.find(w => w.name === "seed")?.value ?? 0).trim();
    if (!/^\d+$/.test(rawSeed)) return;
    const numericSeed = Number(rawSeed);
    if (!Number.isFinite(numericSeed) || numericSeed < 0) return;

    const clipWidget = node.widgets?.find(w => w.name === "rerun_clip_id");
    const seedWidget = node.widgets?.find(w => w.name === "rerun_seed");
    if (!clipWidget || !seedWidget) return;
    clipWidget.value = state.selected;
    clipWidget.callback?.(state.selected);
    seedWidget.value = numericSeed;
    seedWidget.callback?.(numericSeed);

    node.__tdRerunActiveClipId = state.selected;
    node.__tdLocalRunLock = true;
    beginAdvancedLivePreview(node);
    const activity = ensureActivity(node);
    const record = activity[state.selected];
    if (record) {
      record.status = RUN_RUNNING;
      record.progress = 0;
      record.elapsedSeconds = 0;
      record.completedAt = null;
      record.error = "";
      record.startedAt = performance.now();
    }
    pushActivity(node);

    void app.queuePrompt(0, 1, [String(node.id)]).then(queued => {
      if (!queued && !node.__tdPromptId) {
        node.__tdLocalRunLock = false;
        node.__tdRerunActiveClipId = null;
        clipWidget.value = "";
        clipWidget.callback?.("");
        pushActivity(node);
      }
    }).catch(() => {
      node.__tdLocalRunLock = false;
      node.__tdRerunActiveClipId = null;
      clipWidget.value = "";
      clipWidget.callback?.("");
      pushActivity(node);
    });
  });

  root.querySelector('[data-adv="preview-enabled"]')?.addEventListener("change", event => {
    const widget = node.widgets?.find(w => w.name === "preview_enabled");
    if (!widget) return;
    widget.value = event.target.checked;
    widget.callback?.(widget.value);
    markChanged(node);
    if (!widget.value) endAdvancedLivePreview(node);
    renderNode(node);
  });
  root.querySelectorAll("[data-widget]").forEach(input => input.addEventListener("change", () => {
    const widget = node.widgets?.find(w => w.name === input.dataset.widget);
    if (widget) { widget.value = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value; widget.callback?.(widget.value); markChanged(node); }
    if (input.dataset.widget === "video_format") {
      const codecInput = root.querySelector('[data-widget="video_codec"]');
      const allowed = input.value === "webm" ? ["auto", "av1"] : ["auto", "h264", "av1"];
      if (!allowed.includes(codecInput.value)) {
        codecInput.value = "auto";
        const codecWidget = node.widgets?.find(w => w.name === "video_codec");
        if (codecWidget) codecWidget.value = "auto";
      }
      codecInput.innerHTML = allowed.map(v => `<option value="${v}">${v}</option>`).join("");
      codecInput.value = node.widgets?.find(w => w.name === "video_codec")?.value || "auto";
    }
  }));
}

function setNativeWidgetHidden(widget, hidden) {
  if (!widget?.options) return;
  widget.options.hidden = !!hidden;
  widget.syncLiveVisibilityOptions?.();
}

function syncSecondPassWidgets(node) {
  const method = node.widgets?.find(widget => widget.name === "second_pass_method");
  const model = node.widgets?.find(widget => widget.name === "second_pass_model");
  const ratio = node.widgets?.find(widget => widget.name === "second_pass_high_ratio");
  const showSelfLift = method?.value === "SelfLift";

  setNativeWidgetHidden(model, !showSelfLift);
  setNativeWidgetHidden(ratio, !showSelfLift);

  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function applyConfigAdvancedVisibility(node) {
  if (!node || node.comfyClass !== CONFIG_NODE_CLASS) return;

  for (const widget of node.widgets || []) {
    if (!CONFIG_ADVANCED_WIDGETS.has(widget.name)) continue;

    // Keep the actual ComfyUI widgets and let the native advanced-input
    // visibility system own their collapsed/expanded state.
    widget.advanced = true;
    if (widget.options) widget.options.advanced = true;
    widget.syncLiveVisibilityOptions?.();
  }

  const method = node.widgets?.find(widget => widget.name === "second_pass_method");
  if (method && !method.__tdSecondPassConditional) {
    const originalCallback = method.callback;
    method.callback = value => {
      originalCallback?.(value);
      queueMicrotask(() => syncSecondPassWidgets(node));
    };
    method.__tdSecondPassConditional = true;
  }

  syncSecondPassWidgets(node);
  const ratio = node.widgets?.find(widget => widget.name === "aspect_ratio");
  if (ratio && !ratio.__tdAdvancedAspectBound) {
    const original = ratio.callback;
    ratio.callback = function(...args) {
      const result = original?.apply(this, args);
      queueMicrotask(() => syncLinkedAdvancedNodes(node));
      return result;
    };
    ratio.__tdAdvancedAspectBound = true;
  }
}

function mountNode(node) {
  ensureActivity(node);
  syncTailReferencePromptWidget(node);

  if (!node.__tdMinWidthBound) {
    const originalOnResize = node.onResize;
    node.onResize = function(size) {
      if (Array.isArray(size) && size[0] < DIRECTOR_MIN_WIDTH) {
        size[0] = DIRECTOR_MIN_WIDTH;
      }
      originalOnResize?.call(this, size);
    };
    node.__tdMinWidthBound = true;
  }
  if (Array.isArray(node.size) && node.size[0] < DIRECTOR_MIN_WIDTH) {
    node.size[0] = DIRECTOR_MIN_WIDTH;
  }
  if (node.__tdRoot) {
    hideBackingWidget(configWidget(node));
    hideBackingWidget(tailReferencePromptWidget(node));
    if (node.comfyClass === ADVANCED_NODE_CLASS) {
      hideBackingWidget(node.widgets?.find(w => w.name === "save_subfolder"));
      hideBackingWidget(node.widgets?.find(w => w.name === "filename_prefix"));
      hideBackingWidget(node.widgets?.find(w => w.name === "video_format"));
      hideBackingWidget(node.widgets?.find(w => w.name === "video_codec"));
      for (const name of ["preview_enabled","preview_max_resolution","preview_jpeg_quality","preview_frames","preview_fps","preview_suppress_default","rerun_clip_id","rerun_seed","preview_frame_mode","preview_tiny_vae"]) hideBackingWidget(node.widgets?.find(w => w.name === name));
    }
    renderNode(node);
    if (node.comfyClass === ADVANCED_NODE_CLASS) void restoreAdvancedState(node);
    return;
  }

  ensureCss();
  const backing = configWidget(node);
  if (!backing) return;
  hideBackingWidget(backing);
  hideBackingWidget(tailReferencePromptWidget(node));
  if (node.comfyClass === ADVANCED_NODE_CLASS) {
    hideBackingWidget(node.widgets?.find(w => w.name === "save_subfolder"));
    hideBackingWidget(node.widgets?.find(w => w.name === "filename_prefix"));
    hideBackingWidget(node.widgets?.find(w => w.name === "video_format"));
    hideBackingWidget(node.widgets?.find(w => w.name === "video_codec"));
    for (const name of ["preview_enabled","preview_max_resolution","preview_jpeg_quality","preview_frames","preview_fps","preview_suppress_default","rerun_clip_id","rerun_seed","preview_frame_mode","preview_tiny_vae"]) hideBackingWidget(node.widgets?.find(w => w.name === name));
  }

  const root = document.createElement("div");
  root.className = "td-node-shell td-node-shell-director" + (node.comfyClass === ADVANCED_NODE_CLASS ? " td-node-shell-advanced" : "");
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

  const widget = node.addDOMWidget(
    "terrydirector_panel",
    "terrydirector",
    root,
    {
      hideOnZoom: false,
      getMinHeight: () => node.comfyClass === ADVANCED_NODE_CLASS ? 455 : 118,
      getMaxHeight: () => node.comfyClass === ADVANCED_NODE_CLASS ? 540 : 148,
      margin: 3,
    }
  );
  widget.serialize = false;
  widget.options.serialize = false;

  node.__tdRoot = root;
  node.__tdDomWidget = widget;

  const originalCallback = backing.callback;
  backing.callback = value => {
    originalCallback?.(value);
    queueMicrotask(() => {
      hideBackingWidget(backing);
      renderNode(node);
    });
  };

  const width = Math.max(DIRECTOR_MIN_WIDTH, Math.min(520, node.size?.[0] || 470));
  if (node.comfyClass === ADVANCED_NODE_CLASS) {
    if ((node.size?.[1] || 0) < 590) node.setSize?.([width, 620]);
  } else if ((node.size?.[1] || 0) > 320 || (node.size?.[1] || 0) < 205) {
    node.setSize?.([width, 245]);
  } else if ((node.size?.[0] || 0) < DIRECTOR_MIN_WIDTH) {
    node.setSize?.([DIRECTOR_MIN_WIDTH, node.size?.[1] || 245]);
  }

  renderNode(node);
  if (node.comfyClass === ADVANCED_NODE_CLASS) {
    const previousConnection = node.onConnectionsChange;
    if (!node.__tdAspectConnectionBound) {
      node.onConnectionsChange = function(...args) {
        const result = previousConnection?.apply(this, args);
        queueMicrotask(() => syncAdvancedAspect(this));
        return result;
      };
      node.__tdAspectConnectionBound = true;
    }
    queueMicrotask(() => syncAdvancedAspect(node));
    void restoreAdvancedState(node);
  }
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
      if (activeNode) pushActivity(activeNode);
    } else if (message.type === "terrydirector:queue-workflow" && activeNode) {
      const node = activeNode;
      const next = readConfig(node);
      next.document = message.document || defaultDocument();
      writeConfig(node, next);
      editorDirty = false;

      node.__tdLocalRunLock = true;
      if (node.comfyClass === ADVANCED_NODE_CLASS) beginAdvancedLivePreview(node);
      node.__tdRunActivity = blankActivity(node);
      pushActivity(node);

      void app.queuePrompt(0, 1, [String(node.id)]).then(queued => {
        if (!queued && !node.__tdPromptId) {
          node.__tdLocalRunLock = false;
          pushActivity(node);
        }
      }).catch(() => {
        node.__tdLocalRunLock = false;
        pushActivity(node);
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

function openEditor(node, button) {
  ensureEditorOverlay();
  activeNode = node;
  editorDirty = false;
  returnFocus = button || null;

  const documentData = clone(readConfig(node).document);
  overlay.classList.add("is-open");
  document.documentElement.style.overflow = "hidden";

  if (frameReady) {
    pushPreferences();
    frame.contentWindow.postMessage(
      { type: "terrydirector:load", document: documentData },
      location.origin
    );
    pushActivity(node);
  } else {
    pendingDocument = documentData;
  }
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
    bindExecutionActivity();
  },
  nodeCreated(node) {
    if (isDirector(node)) {
      queueMicrotask(() => mountNode(node));
    } else if (node.comfyClass === CONFIG_NODE_CLASS) {
      queueMicrotask(() => applyConfigAdvancedVisibility(node));
    }
  },
  loadedGraphNode(node) {
    if (isDirector(node)) {
      queueMicrotask(() => mountNode(node));
    } else if (node.comfyClass === CONFIG_NODE_CLASS) {
      queueMicrotask(() => applyConfigAdvancedVisibility(node));
    }
  },
});
