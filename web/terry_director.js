import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "TerryDirector";
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
const cssHref = new URL("./terry_director.css", import.meta.url).href;


const RUN_IDLE = "idle";
const RUN_RUNNING = "running";
const RUN_COMPLETED = "completed";
const RUN_ERROR = "error";

function directorNodeFromId(value) {
  if (value == null) return null;
  const id = String(value);
  return (app.graph?._nodes || []).find(
    node => node?.comfyClass === NODE_CLASS && String(node.id) === id
  ) || null;
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

function finishPromptActivity(promptId, success, message = "") {
  let matched = false;
  for (const node of app.graph?._nodes || []) {
    if (node?.comfyClass !== NODE_CLASS || node.__tdPromptId !== promptId) continue;
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
}

function timelineHtml(documentData, activity = {}) {
  const clips = documentData.clips || [];
  if (!clips.length) {
    return '<div class="td-mini-empty">尚无片段 · 点击编辑</div>';
  }

  const total = Math.max(1, ...clips.map(clip => Number(clip.end) || 0));
  const activeClips = clips.filter(clip => !clip.suspended);
  const totalWork = activeClips.reduce(
    (sum, clip) => sum + Math.max(1, (Number(clip.end) || 0) - (Number(clip.start) || 0)),
    0
  );
  let completedWork = 0;
  let hasRunState = false;

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
      const durationFrames = Math.max(1, (Number(clip.end) || 0) - (Number(clip.start) || 0));
      if (running || completed || failed) hasRunState = true;
      if (!clip.suspended) completedWork += durationFrames * progress;

      const selected = clip.id === documentData.selected ? " is-selected" : "";
      const suspended = clip.suspended ? " is-suspended" : "";
      const runClass = running ? " is-running" : completed ? " is-completed" : failed ? " is-error" : "";
      const duration = timeText(Math.max(0, durationFrames));
      const percent = Math.round(progress * 100);
      const statusText = running
        ? (percent > 0 ? `生成中 ${percent}%` : "准备中")
        : completed
          ? "已完成"
          : failed
            ? "生成失败"
            : "";
      const title = statusText ? `${clip.name} · ${statusText}` : clip.name;
      const progressHtml = (running || completed)
        ? `<span class="td-mini-clip-progress"><i style="width:${percent}%"></i></span>`
        : "";

      return `<div class="td-mini-clip${selected}${suspended}${runClass}" style="left:${left}%;width:${width}%;z-index:${running ? 12 : clip.id === documentData.selected ? 4 : index + 1}" title="${escapeHtml(title)}"><span class="td-mini-label">${escapeHtml(clip.name)}</span><span class="td-mini-duration">${duration}</span>${progressHtml}</div>`;
    })
    .join("");

  const overall = totalWork > 0 ? clamp01(completedWork / totalWork) : 0;
  const overallHtml = hasRunState
    ? `<div class="td-mini-overall-progress" title="总生成进度 ${Math.round(overall * 100)}%"><i style="width:${Math.round(overall * 1000) / 10}%"></i></div>`
    : "";
  return clipHtml + overallHtml;
}

function renderNode(node) {
  const root = node.__tdRoot;
  if (!root) return;

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
}

function mountNode(node) {
  ensureActivity(node);

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
    renderNode(node);
    return;
  }

  ensureCss();
  const backing = configWidget(node);
  if (!backing) return;
  hideBackingWidget(backing);

  const root = document.createElement("div");
  root.className = "td-node-shell td-node-shell-director";
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

  const widget = node.addDOMWidget(
    "terrydirector_panel",
    "terrydirector",
    root,
    {
      hideOnZoom: false,
      getMinHeight: () => 92,
      getMaxHeight: () => 118,
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
  if ((node.size?.[1] || 0) > 290 || (node.size?.[1] || 0) < 175) {
    node.setSize?.([width, 215]);
  } else if ((node.size?.[0] || 0) < DIRECTOR_MIN_WIDTH) {
    node.setSize?.([DIRECTOR_MIN_WIDTH, node.size?.[1] || 215]);
  }

  renderNode(node);
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
  async setup() {
    ensureCss();
    ensureEditorOverlay();
    bindExecutionActivity();
  },
  nodeCreated(node) {
    if (node.comfyClass === NODE_CLASS) {
      queueMicrotask(() => mountNode(node));
    } else if (node.comfyClass === CONFIG_NODE_CLASS) {
      queueMicrotask(() => applyConfigAdvancedVisibility(node));
    }
  },
  loadedGraphNode(node) {
    if (node.comfyClass === NODE_CLASS) {
      queueMicrotask(() => mountNode(node));
    } else if (node.comfyClass === CONFIG_NODE_CLASS) {
      queueMicrotask(() => applyConfigAdvancedVisibility(node));
    }
  },
});
