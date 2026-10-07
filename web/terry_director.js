import { app } from "/scripts/app.js";

const NODE_CLASS = "TerryDirector";
const CONFIG_NODE_CLASS = "TerryDirectorConfig";
const CONFIG_ADVANCED_WIDGETS = new Set([
  "multiple",
  "sampler",
  "sigmas",
  "sigmas_denoise",
  "second_pass_method",
  "second_pass_model",
  "second_pass_high_steps",
]);
const FPS = 24;
const cssHref = new URL("./terry_director.css", import.meta.url).href;

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
    version: 1,
    fps: FPS,
    selected: "clip-1",
    clips: [
      {
        id: "clip-1",
        name: "片段 01",
        start: 0,
        end: FPS * 10,
        prompt: "",
        refs: [],
      },
    ],
    assets: [],
  };
}

function defaultConfig() {
  return {
    version: 3,
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
  const rawDoc = source?.document && typeof source.document === "object"
    ? source.document
    : source && typeof source === "object" && (Array.isArray(source.clips) || Array.isArray(source.assets))
      ? source
      : {};

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
    version: 3,
    document: {
      version: 1,
      fps: FPS,
      selected,
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
  widget.value = JSON.stringify(normalized);
  widget.callback?.(widget.value);
  markChanged(node);
  if (render) renderNode(node);
}

function timelineHtml(documentData) {
  const clips = documentData.clips || [];
  if (!clips.length) {
    return '<div class="td-mini-empty">尚无片段 · 点击编辑</div>';
  }

  const total = Math.max(1, ...clips.map(clip => Number(clip.end) || 0));
  return clips
    .map((clip, index) => {
      const left = Math.max(0, Math.min(100, (clip.start / total) * 100));
      const width = Math.max(
        0.8,
        Math.min(100 - left, ((clip.end - clip.start) / total) * 100)
      );
      const selected = clip.id === documentData.selected ? " is-selected" : "";
      const duration=timeText(Math.max(0,(Number(clip.end)||0)-(Number(clip.start)||0)));
      return `<div class="td-mini-clip${selected}" style="left:${left}%;width:${width}%;z-index:${clip.id === documentData.selected ? 4 : index + 1}"><span class="td-mini-label">${escapeHtml(clip.name)}</span><span class="td-mini-duration">${duration}</span></div>`;
    })
    .join("");
}

function renderNode(node) {
  const root = node.__tdRoot;
  if (!root) return;

  const config = readConfig(node);
  const doc = config.document;
  const total = Math.max(0, ...doc.clips.map(clip => clip.end || 0));

  root.innerHTML = `<div class="td-node-card td-node-card-director">
    <div class="td-mini-wrap td-mini-wrap-director">
      <div class="td-mini-head">
        <strong>时间线</strong>
        <span class="td-mini-stats">总时长：${timeText(total)} <i></i> 导入资产：${doc.assets.length}</span>
        <span class="td-node-spacer"></span>
        <button class="td-mini-edit" data-action="edit">✦ 编辑</button>
      </div>
      <div class="td-mini-timeline" data-action="edit" title="打开时间线编辑器">${timelineHtml(doc)}</div>
    </div>
  </div>`;

  root.querySelectorAll('[data-action="edit"]').forEach(button => {
    button.addEventListener("click", () => openEditor(node, button));
  });
}

function applyConfigAdvancedVisibility(node) {
  if (!node || node.comfyClass !== CONFIG_NODE_CLASS) return;

  for (const widget of node.widgets || []) {
    if (!CONFIG_ADVANCED_WIDGETS.has(widget.name)) continue;

    // Use ComfyUI's own widget visibility contract. Do not hide DOM/canvas
    // controls ourselves; setting the native widget's advanced state makes
    // the built-in "显示高级输入" footer own visibility on every surface.
    widget.advanced = true;
    if (widget.options) widget.options.advanced = true;
    widget.syncLiveVisibilityOptions?.();
  }

  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function mountNode(node) {
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

  const width = Math.max(430, Math.min(520, node.size?.[0] || 470));
  if ((node.size?.[1] || 0) > 290 || (node.size?.[1] || 0) < 175) {
    node.setSize?.([width, 215]);
  } else if ((node.size?.[0] || 0) < 430) {
    node.setSize?.([430, node.size?.[1] || 215]);
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
