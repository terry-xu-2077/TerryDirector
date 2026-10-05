import { app } from "/scripts/app.js";

const NODE_CLASS = "TerryDirector";
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
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function defaultDocument() {
  return {
    version: 1,
    fps: FPS,
    selected: "clip-1",
    clips: [{ id: "clip-1", name: "片段 01", start: 0, end: FPS * 10, prompt: "", refs: [] }],
    assets: [],
  };
}

function defaultConfig() {
  return {
    version: 2,
    params: {
      seed: 0,
      continue_audio_latent: true,
      ref_image_size: "match",
      second_pass: { method: "none", model: "", high_steps: 4 },
    },
    document: defaultDocument(),
  };
}

function normalizeConfig(value) {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { source = {}; }
  }

  const base = defaultConfig();
  const params = source?.params && typeof source.params === "object" ? source.params : {};
  const rawSecond = params.second_pass && typeof params.second_pass === "object" ? params.second_pass : null;
  const legacySelfLift = params.selflift && typeof params.selflift === "object" ? params.selflift : {};
  let method = rawSecond ? String(rawSecond.method || "none").toLowerCase() : (legacySelfLift.enabled ? "selflift" : "none");
  if (!["none", "selflift"].includes(method)) method = "none";
  const secondModel = String((rawSecond ? rawSecond.model : legacySelfLift.model) || "");
  const highSteps = Math.max(1, Math.floor(Number(rawSecond ? rawSecond.high_steps : legacySelfLift.high_steps) || 4));

  const rawDoc = source?.document && typeof source.document === "object" ? source.document : {};
  const clips = Array.isArray(rawDoc.clips) && rawDoc.clips.length ? rawDoc.clips.map((raw, index) => {
    const start = Math.max(0, Number.parseInt(raw?.start, 10) || 0);
    const end = Math.max(start + 1, Number.parseInt(raw?.end, 10) || start + FPS * 10);
    return {
      id: String(raw?.id || `clip-${index + 1}`),
      name: String(raw?.name || `片段 ${String(index + 1).padStart(2, "0")}`),
      start,
      end,
      prompt: String(raw?.prompt || ""),
      refs: Array.isArray(raw?.refs) ? raw.refs.map(String) : [],
    };
  }) : base.document.clips;

  const assets = Array.isArray(rawDoc.assets) ? rawDoc.assets
    .filter(asset => asset && ["image", "video", "audio"].includes(asset.kind) && asset.source?.path)
    .map(asset => ({
      id: String(asset.id),
      name: String(asset.name || asset.source.path),
      kind: asset.kind,
      number: Math.max(1, Number.parseInt(asset.number, 10) || 1),
      source: {
        type: "comfy-input",
        path: String(asset.source.path).replaceAll("\\", "/").replace(/^\/+/, ""),
      },
    })) : [];

  const selected = clips.some(clip => clip.id === rawDoc.selected) ? rawDoc.selected : clips[0].id;
  const validAssets = new Set(assets.map(asset => asset.id));
  for (const clip of clips) clip.refs = clip.refs.filter(id => validAssets.has(id));

  return {
    version: 2,
    params: {
      seed: Math.max(0, Math.floor(Number(params.seed) || 0)),
      continue_audio_latent: params.continue_audio_latent !== false,
      ref_image_size: params.ref_image_size === "max" ? "max" : "match",
      second_pass: {
        method,
        model: secondModel,
        high_steps: highSteps,
      },
    },
    document: { version: 1, fps: FPS, selected, clips, assets },
  };
}

function timeText(frames) {
  const seconds = Math.max(0, frames) / FPS;
  return `${Number(seconds.toFixed(seconds % 1 ? 2 : 0))}s`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function configWidget(node) {
  return node.widgets?.find(widget => widget.name === "config_json") || null;
}

function hideBackingWidget(widget) {
  if (!widget || widget.__tdHidden) return;
  widget.__tdHidden = true;
  widget.__tdOriginalType = widget.type;
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

let upscalerModels = null;
async function loadUpscalers() {
  if (upscalerModels) return upscalerModels;
  try {
    const response = await fetch("/terrydirector/api/latent-upscalers", { cache: "no-store" });
    const payload = await response.json();
    upscalerModels = Array.isArray(payload.models) ? payload.models.map(String) : [];
  } catch {
    upscalerModels = [];
  }
  return upscalerModels;
}

function timelineHtml(documentData) {
  const clips = documentData.clips || [];
  if (!clips.length) return '<div class="td-mini-empty">尚无片段 · 点击编辑</div>';
  const total = Math.max(1, ...clips.map(clip => Number(clip.end) || 0));
  return clips.map((clip, index) => {
    const left = Math.max(0, Math.min(100, clip.start / total * 100));
    const width = Math.max(.8, Math.min(100 - left, (clip.end - clip.start) / total * 100));
    const selected = clip.id === documentData.selected ? " is-selected" : "";
    return `<div class="td-mini-clip${selected}" style="left:${left}%;width:${width}%;z-index:${clip.id === documentData.selected ? 4 : index + 1}"><span class="td-mini-label">${escapeHtml(clip.name)}</span></div>`;
  }).join("");
}

function renderNode(node) {
  const root = node.__tdRoot;
  if (!root) return;

  const config = readConfig(node);
  const params = config.params;
  const doc = config.document;
  const total = Math.max(0, ...doc.clips.map(clip => clip.end || 0));
  const models = upscalerModels || [];
  const modelOptions = [
    '<option value="">自动选择兼容模型</option>',
    ...models.map(name => `<option value="${escapeHtml(name)}"${name === params.second_pass.model ? " selected" : ""}>${escapeHtml(name)}</option>`),
  ].join("");

  root.innerHTML = `<div class="td-node-card">
    <section class="td-node-section td-node-compact-section">
      <div class="td-node-compact-row">
        <div class="td-node-field td-node-seed-field">
          <label>Seed</label>
          <div class="td-node-inline">
            <input class="td-node-seed" data-field="seed" type="number" min="0" step="1" value="${params.seed}">
            <button class="td-node-icon-button" data-action="random-seed" title="随机 Seed">⚄</button>
          </div>
        </div>

        <div class="td-node-field">
          <label>参考图尺寸</label>
          <select data-field="ref_image_size">
            <option value="match"${params.ref_image_size === "match" ? " selected" : ""}>match</option>
            <option value="max"${params.ref_image_size === "max" ? " selected" : ""}>max</option>
          </select>
        </div>

        <div class="td-node-field">
          <label>二采方案</label>
          <select data-field="second_pass_method">
            <option value="none"${params.second_pass.method === "none" ? " selected" : ""}>无</option>
            <option value="selflift"${params.second_pass.method === "selflift" ? " selected" : ""}>SelfLift</option>
          </select>
        </div>

        <button class="td-node-compact-toggle${params.continue_audio_latent ? " is-on" : ""}" data-toggle="continue_audio_latent" title="是否在相邻片段间延续音频 latent">
          <span class="td-node-toggle"></span>
          <span>音频连续</span>
        </button>
      </div>

      <div class="td-node-selflift" ${params.second_pass.method === "selflift" ? "" : "hidden"}>
        <div class="td-node-field">
          <label>SelfLift 放大模型</label>
          <select data-field="second_pass_model">${modelOptions}</select>
        </div>
        <div class="td-node-field td-node-high-steps">
          <label>高清步数</label>
          <input data-field="second_pass_high_steps" type="number" min="1" step="1" value="${params.second_pass.high_steps}">
        </div>
      </div>
    </section>

    <div class="td-mini-wrap">
      <div class="td-mini-head">
        <strong>时间线</strong>
        <span class="td-node-pill">${timeText(total)}</span>
        <small>只读</small>
        <span class="td-node-spacer"></span>
        <button class="td-mini-edit" data-action="edit">✦ 编辑</button>
      </div>
      <div class="td-mini-timeline" data-action="edit" title="打开时间线编辑器">${timelineHtml(doc)}</div>
    </div>
  </div>`;

  root.querySelectorAll("input[data-field], select[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const next = readConfig(node);
      const field = input.dataset.field;
      if (field === "seed") next.params.seed = Math.max(0, Math.floor(Number(input.value) || 0));
      else if (field === "ref_image_size") next.params.ref_image_size = input.value === "max" ? "max" : "match";
      else if (field === "second_pass_method") next.params.second_pass.method = input.value === "selflift" ? "selflift" : "none";
      else if (field === "second_pass_model") next.params.second_pass.model = input.value;
      else if (field === "second_pass_high_steps") next.params.second_pass.high_steps = Math.max(1, Math.floor(Number(input.value) || 4));
      writeConfig(node, next);
    });
  });

  root.querySelectorAll("[data-toggle]").forEach(button => {
    button.addEventListener("click", () => {
      const next = readConfig(node);
      if (button.dataset.toggle === "continue_audio_latent") {
        next.params.continue_audio_latent = !next.params.continue_audio_latent;
      }
      writeConfig(node, next);
    });
  });

  root.querySelector('[data-action="random-seed"]')?.addEventListener("click", () => {
    const next = readConfig(node);
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    next.params.seed = random[0];
    writeConfig(node, next);
  });

  root.querySelectorAll('[data-action="edit"]').forEach(button => {
    button.addEventListener("click", () => openEditor(node, button));
  });

  const desiredHeight = params.second_pass.method === "selflift" ? 400 : 345;
  if (Math.abs((node.size?.[0] || 0) - 560) > 1 || Math.abs((node.size?.[1] || 0) - desiredHeight) > 1) {
    node.setSize?.([560, desiredHeight]);
  }
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
  root.className = "td-node-shell";
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

  const widget = node.addDOMWidget("terrydirector_panel", "terrydirector", root, {
    hideOnZoom: false,
    getMinHeight: () => 170,
    getMaxHeight: () => 245,
    margin: 3,
  });
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

  renderNode(node);
  loadUpscalers().then(() => node.__tdRoot && renderNode(node));
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
  overlay.innerHTML = '<iframe class="td-editor-frame" title="TerryDirector 导演台" allowtransparency="true"></iframe>';
  document.body.append(overlay);

  frame = overlay.querySelector("iframe");
  frame.src = "/terrydirector/editor?embed=1";

  window.addEventListener("message", event => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    const message = event.data || {};

    if (message.type === "terrydirector:ready") {
      frameReady = true;
      if (pendingDocument) {
        frame.contentWindow.postMessage({ type: "terrydirector:load", document: pendingDocument }, location.origin);
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
    frame.contentWindow.postMessage({ type: "terrydirector:load", document: documentData }, location.origin);
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
  if (window.confirm("关闭导演台将放弃本次未保存的编辑，确定关闭吗？")) closeEditor();
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
    if (node.comfyClass === NODE_CLASS) queueMicrotask(() => mountNode(node));
  },
  loadedGraphNode(node) {
    if (node.comfyClass === NODE_CLASS) queueMicrotask(() => mountNode(node));
  },
});
