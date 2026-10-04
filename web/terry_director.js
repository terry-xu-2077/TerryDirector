import { app } from "/scripts/app.js";

const NODE_CLASS = "TerryDirector";
const FPS = 24;
const cssHref = new URL("./terry_director.css", import.meta.url).href;
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
const ASPECT_VALUES = Object.fromEntries(ASPECTS.map(value => value.split(":").map(Number)).map(([w,h],i)=>[ASPECTS[i],[w,h]]));

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
    version: 1,
    params: {
      resolution: { aspect_ratio: "16:9", megapixels: 1.2, multiple: 32 },
      seed: 0,
      continue_audio_latent: true,
      ref_image_size: "match",
      preview_enabled: true,
      selflift: { enabled: false, model: "", high_steps: 4 },
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
  const res = params.resolution && typeof params.resolution === "object" ? params.resolution : {};
  const sl = params.selflift && typeof params.selflift === "object" ? params.selflift : {};
  const ratio = ASPECTS.includes(String(res.aspect_ratio)) ? String(res.aspect_ratio) : "16:9";
  const mp = Math.min(16, Math.max(.1, Number(res.megapixels) || 1.2));
  let multiple = Number.parseInt(res.multiple, 10) || 32;
  multiple = Math.min(128, Math.max(8, multiple));
  multiple = Math.round(multiple / 4) * 4;
  const rawDoc = source?.document && typeof source.document === "object" ? source.document : {};
  const clips = Array.isArray(rawDoc.clips) && rawDoc.clips.length ? rawDoc.clips.map((raw, index) => {
    const start = Math.max(0, Number.parseInt(raw?.start, 10) || 0);
    const end = Math.max(start + 1, Number.parseInt(raw?.end, 10) || start + FPS * 10);
    return {
      id: String(raw?.id || `clip-${index + 1}`),
      name: String(raw?.name || `片段 ${String(index + 1).padStart(2,"0")}`),
      start, end,
      prompt: String(raw?.prompt || ""),
      refs: Array.isArray(raw?.refs) ? raw.refs.map(String) : [],
    };
  }) : base.document.clips;
  const assets = Array.isArray(rawDoc.assets) ? rawDoc.assets.filter(a => a && ["image","video","audio"].includes(a.kind) && a.source?.path).map(a => ({
    id: String(a.id), name: String(a.name || a.source.path), kind: a.kind,
    number: Math.max(1, Number.parseInt(a.number, 10) || 1),
    source: { type: "comfy-input", path: String(a.source.path).replaceAll("\\","/").replace(/^\/+/, "") },
  })) : [];
  const selected = clips.some(c => c.id === rawDoc.selected) ? rawDoc.selected : clips[0].id;
  const validAssets = new Set(assets.map(a => a.id));
  for (const clip of clips) clip.refs = clip.refs.filter(id => validAssets.has(id));
  return {
    version: 1,
    params: {
      resolution: { aspect_ratio: ratio, megapixels: mp, multiple },
      seed: Math.max(0, Math.floor(Number(params.seed) || 0)),
      continue_audio_latent: params.continue_audio_latent !== false,
      ref_image_size: params.ref_image_size === "max" ? "max" : "match",
      preview_enabled: params.preview_enabled !== false,
      selflift: {
        enabled: !!sl.enabled,
        model: String(sl.model || ""),
        high_steps: Math.max(1, Math.floor(Number(sl.high_steps) || 4)),
      },
    },
    document: { version: 1, fps: FPS, selected, clips, assets },
  };
}

function resolution(settings) {
  const [aw, ah] = ASPECT_VALUES[settings.aspect_ratio] || [16, 9];
  const scale = Math.sqrt(settings.megapixels * 1024 * 1024 / (aw * ah));
  const roundEven = value => {
    const floor = Math.floor(value), fraction = value - floor;
    return fraction === .5 ? floor + floor % 2 : Math.round(value);
  };
  return {
    width: roundEven(aw * scale / settings.multiple) * settings.multiple,
    height: roundEven(ah * scale / settings.multiple) * settings.multiple,
  };
}

function timeText(frames) {
  const seconds = Math.max(0, frames) / FPS;
  return `${Number(seconds.toFixed(seconds % 1 ? 2 : 0))}s`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}

function configWidget(node) {
  return node.widgets?.find(widget => widget.name === "config_json") || null;
}

function hideBackingWidget(widget) {
  if (!widget || widget.__tdHidden) return;
  widget.__tdHidden = true;
  widget.__tdOriginalType = widget.type;
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
}

function readConfig(node) {
  const widget = configWidget(node);
  return normalizeConfig(widget?.value || "");
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
  if (!clips.length) return '<div class="td-mini-empty">尚无片段 · 点击打开导演台</div>';
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
  const res = resolution(params.resolution);
  const total = Math.max(0, ...doc.clips.map(clip => clip.end || 0));
  const models = upscalerModels || [];
  const modelOptions = ['<option value="">自动选择兼容模型</option>', ...models.map(name => `<option value="${escapeHtml(name)}"${name === params.selflift.model ? " selected" : ""}>${escapeHtml(name)}</option>`)].join("");

  root.innerHTML = `<div class="td-node-card">
    <div class="td-node-summary">
      <strong>生成设置</strong>
      <small>${doc.assets.length} 个资产</small>
      <span class="td-node-spacer"></span>
      <span class="td-node-pill">${doc.clips.length} 片段 · ${timeText(total)}</span>
    </div>

    <section class="td-node-section">
      <div class="td-node-section-head"><span>Resolution</span><span>${res.width} × ${res.height}</span></div>
      <div class="td-node-grid">
        <div class="td-node-field"><label>比例</label><select data-field="aspect_ratio">${ASPECTS.map(value => `<option${value===params.resolution.aspect_ratio?" selected":""}>${value}</option>`).join("")}</select></div>
        <div class="td-node-field"><label>MP</label><input data-field="megapixels" type="number" min="0.1" max="16" step="0.1" value="${params.resolution.megapixels}"></div>
        <div class="td-node-field"><label>倍数</label><input data-field="multiple" type="number" min="8" max="128" step="4" value="${params.resolution.multiple}"></div>
      </div>
      <div class="td-node-two-col">
        <div class="td-node-field"><label>Seed</label><div class="td-node-inline"><input class="td-node-seed" data-field="seed" type="number" min="0" step="1" value="${params.seed}"><button class="td-node-icon-button" data-action="random-seed" title="随机 Seed">⚄</button></div></div>
        <div class="td-node-field"><label>参考图尺寸</label><select data-field="ref_image_size"><option value="match"${params.ref_image_size==="match"?" selected":""}>match</option><option value="max"${params.ref_image_size==="max"?" selected":""}>max</option></select></div>
      </div>
    </section>

    <section class="td-node-section">
      <div class="td-node-section-head"><span>Runtime</span><span>节点参数</span></div>
      <div class="td-node-two-col">
        <button class="td-node-toggle-row${params.continue_audio_latent?" is-on":""}" data-toggle="continue_audio_latent"><span class="td-node-toggle"></span><strong>音频连续</strong><small>${params.continue_audio_latent?"开启":"关闭"}</small></button>
        <button class="td-node-toggle-row${params.preview_enabled?" is-on":""}" data-toggle="preview_enabled"><span class="td-node-toggle"></span><strong>生成预览</strong><small>${params.preview_enabled?"开启":"关闭"}</small></button>
      </div>
      <button class="td-node-toggle-row${params.selflift.enabled?" is-on":""}" style="margin-top:6px;width:100%" data-toggle="selflift"><span class="td-node-toggle"></span><strong>二次潜空间放大 · SelfLift</strong><small>${params.selflift.enabled?"开启":"关闭"}</small></button>
      <div class="td-node-selflift" ${params.selflift.enabled?"":"hidden"}>
        <div class="td-node-field"><label>放大模型</label><select data-field="selflift_model">${modelOptions}</select></div>
        <div class="td-node-field"><label>高清步数</label><input data-field="selflift_high_steps" type="number" min="1" step="1" value="${params.selflift.high_steps}"></div>
      </div>
    </section>

    <div class="td-mini-wrap">
      <div class="td-mini-head"><strong>时间线</strong><span class="td-node-pill">${timeText(total)}</span><small>只读</small></div>
      <div class="td-mini-timeline" data-action="edit" title="打开时间线编辑器">${timelineHtml(doc)}</div>
    </div>

    <div class="td-node-actions">
      <button class="td-node-button primary" data-action="edit">✦　编辑时间线</button>
      <div class="td-node-warning">保存编辑只更新工作流，不会自动开始生成</div>
    </div>
  </div>`;

  root.querySelectorAll("input[data-field],select[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const next = readConfig(node);
      const field = input.dataset.field;
      if (field === "aspect_ratio") next.params.resolution.aspect_ratio = input.value;
      else if (field === "megapixels") next.params.resolution.megapixels = Math.min(16, Math.max(.1, Number(input.value) || 1.2));
      else if (field === "multiple") next.params.resolution.multiple = Math.round(Math.min(128, Math.max(8, Number(input.value) || 32)) / 4) * 4;
      else if (field === "seed") next.params.seed = Math.max(0, Math.floor(Number(input.value) || 0));
      else if (field === "ref_image_size") next.params.ref_image_size = input.value === "max" ? "max" : "match";
      else if (field === "selflift_model") next.params.selflift.model = input.value;
      else if (field === "selflift_high_steps") next.params.selflift.high_steps = Math.max(1, Math.floor(Number(input.value) || 4));
      writeConfig(node, next);
    });
  });
  root.querySelectorAll("[data-toggle]").forEach(button => {
    button.addEventListener("click", () => {
      const next = readConfig(node);
      if (button.dataset.toggle === "selflift") next.params.selflift.enabled = !next.params.selflift.enabled;
      else next.params[button.dataset.toggle] = !next.params[button.dataset.toggle];
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
  root.querySelectorAll('[data-action="edit"]').forEach(button => button.addEventListener("click", () => openEditor(node, button)));
}

function mountNode(node) {
  if (node.__tdRoot) { renderNode(node); return; }
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
    getMinHeight: () => 365,
    getMaxHeight: () => 430,
    margin: 4,
  });
  widget.options.serialize = false;
  node.__tdRoot = root;
  node.__tdDomWidget = widget;
  const originalCallback = backing.callback;
  backing.callback = value => {
    originalCallback?.(value);
    queueMicrotask(() => renderNode(node));
  };
  if (node.size?.[0] < 430) node.setSize?.([430, Math.max(node.size?.[1] || 0, 520)]);
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
  overlay.innerHTML = '<button class="td-editor-discard" type="button" title="关闭并放弃未保存更改" aria-label="关闭并放弃未保存更改">×</button><iframe class="td-editor-frame" title="TerryDirector 导演台"></iframe>';
  document.body.append(overlay);
  frame = overlay.querySelector("iframe");
  frame.src = "/terrydirector/editor?embed=1";
  overlay.querySelector(".td-editor-discard").addEventListener("click", () => requestDiscard());
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
  const doc = clone(readConfig(node).document);
  overlay.classList.add("is-open");
  document.documentElement.style.overflow = "hidden";
  if (frameReady) frame.contentWindow.postMessage({ type: "terrydirector:load", document: doc }, location.origin);
  else pendingDocument = doc;
  frame.focus();
}

function requestDiscard() {
  if (!activeNode || !editorDirty) { closeEditor(); return; }
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
