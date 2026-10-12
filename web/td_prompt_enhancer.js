import { app } from "/scripts/app.js";

const NODE_CLASS = "TerryDirectorPromptEnhancer";

function isTarget(node) {
  return String(node?.comfyClass || node?.type || "") === NODE_CLASS;
}

function widget(node, name) {
  return node?.widgets?.find(item => item?.name === name) || null;
}

function input(node, name) {
  return node?.inputs?.find(item => String(item?.name || "") === name) || null;
}

function inputConnected(node, name) {
  const slot = input(node, name);
  return Boolean(slot && (slot.link != null || (Array.isArray(slot.links) && slot.links.length)));
}

function hideNativePromptWidget(node) {
  const prompt = widget(node, "prompt");
  if (!prompt || prompt.__tdPromptEnhancerHidden) return prompt;
  prompt.__tdPromptEnhancerHidden = true;
  prompt.hidden = true;
  prompt.type = "hidden";
  prompt.options ||= {};
  prompt.options.hidden = true;
  prompt.options.canvasOnly = true;
  prompt.computeSize = () => [0, -4];
  if (prompt.element?.style) prompt.element.style.display = "none";
  if (prompt.inputEl?.style) prompt.inputEl.style.display = "none";
  return prompt;
}

function promptValue(node) {
  return String(widget(node, "prompt")?.value ?? "");
}

function setPromptValue(node, value, dirty = true) {
  const prompt = widget(node, "prompt");
  if (!prompt) return;
  prompt.value = String(value ?? "");
  if (prompt._state) prompt._state.value = prompt.value;
  prompt.callback?.(prompt.value);
  if (node.__tdPromptEnhancerTextarea &&
      node.__tdPromptEnhancerTextarea.value !== prompt.value) {
    node.__tdPromptEnhancerTextarea.value = prompt.value;
  }
  if (dirty) {
    node.setDirtyCanvas?.(true, true);
    node.graph?.change?.();
  }
}

function providerState(node) {
  const provider = globalThis.TerryDirectorAI;
  if (!provider?.resolveLlamaState) {
    return { status: "missing", config: null };
  }
  try {
    return provider.resolveLlamaState(node) || { status: "disconnected", config: null };
  } catch {
    return { status: "disconnected", config: null };
  }
}

function setStatus(node, text = "", tone = "") {
  const el = node.__tdPromptEnhancerStatus;
  if (!el) return;
  el.textContent = String(text || "");
  el.dataset.tone = tone || "";
}

function refreshButton(node) {
  const button = node.__tdPromptEnhancerButton;
  const textarea = node.__tdPromptEnhancerTextarea;
  if (!button || !textarea) return;

  const task = node.__tdPromptEnhancerTask;
  if (task) {
    button.disabled = false;
    button.classList.add("is-busy");
    button.title = "取消 AI 增强";
    button.setAttribute("aria-label", "取消 AI 增强");
    textarea.readOnly = true;
    return;
  }

  button.classList.remove("is-busy");
  textarea.readOnly = false;

  if (inputConnected(node, "prompt")) {
    button.disabled = true;
    button.title = "提示词来自上游连接时不支持编辑器内手动增强";
    button.setAttribute("aria-label", button.title);
    return;
  }

  const state = providerState(node);
  const text = String(textarea.value || "").trim();
  const unavailable = state.status === "missing"
    ? "TerryDirector AI Runtime 尚未加载"
    : state.status === "bypassed"
      ? "TerryDirector Llama 当前为 Bypassed"
      : state.status === "muted"
        ? "TerryDirector Llama 当前为 Never"
        : state.status !== "active"
          ? "请连接 TerryDirector Llama"
          : !text
            ? "请输入提示词"
            : "";

  button.disabled = Boolean(unavailable);
  button.title = unavailable || "AI 增强当前提示词";
  button.setAttribute("aria-label", button.title);
}

async function runEnhancement(node) {
  if (node.__tdPromptEnhancerTask) {
    await node.__tdPromptEnhancerTask.cancel?.();
    setStatus(node, "正在取消…");
    return;
  }

  const textarea = node.__tdPromptEnhancerTextarea;
  if (!textarea) return;
  setPromptValue(node, textarea.value, false);

  const provider = globalThis.TerryDirectorAI;
  if (!provider?.startPromptEnhancement) {
    setStatus(node, "TerryDirector AI Runtime 不可用", "error");
    refreshButton(node);
    return;
  }

  try {
    const task = await provider.startPromptEnhancement(node, textarea.value);
    node.__tdPromptEnhancerTask = task;
    setStatus(node, "AI 增强中…", "busy");
    refreshButton(node);

    const result = await task.result();
    if (node.__tdPromptEnhancerTask !== task) return;
    setPromptValue(node, result.prompt, true);
    setStatus(node, "增强完成", "success");
  } catch (error) {
    const message = String(error?.message || "AI 增强失败");
    setStatus(node, message === "AI 增强已取消" ? "已取消" : message,
      message === "AI 增强已取消" ? "" : "error");
  } finally {
    node.__tdPromptEnhancerTask = null;
    refreshButton(node);
    window.setTimeout(() => {
      if (!node.__tdPromptEnhancerTask) setStatus(node, "");
    }, 2200);
  }
}

function ensureStyles() {
  if (document.getElementById("td-prompt-enhancer-style")) return;
  const style = document.createElement("style");
  style.id = "td-prompt-enhancer-style";
  style.textContent = `
.td-prompt-enhancer-wrap{
  position:relative;width:100%;height:100%;min-height:210px;box-sizing:border-box;
  overflow:hidden;border-radius:7px;background:var(--comfy-input-bg,#222);
}
.td-prompt-enhancer-textarea{
  display:block;width:100%;height:100%;min-height:210px;box-sizing:border-box;
  resize:none;padding:10px 42px 32px 10px;border:0;outline:none;
  background:transparent;color:var(--input-text,#ddd);
  font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
}
.td-prompt-enhancer-textarea:read-only{opacity:.78}
.td-prompt-enhancer-ai{
  position:absolute;right:8px;bottom:7px;width:28px;height:28px;padding:0;
  display:grid;place-items:center;border:1px solid rgba(155,120,255,.34);
  border-radius:7px;background:rgba(155,120,255,.10);color:#c9bbff;
  cursor:pointer;font:600 18px/1 Georgia,serif;
}
.td-prompt-enhancer-ai:hover:not(:disabled){
  border-color:rgba(155,120,255,.62);background:rgba(155,120,255,.18);
}
.td-prompt-enhancer-ai:disabled{opacity:.30;cursor:default}
.td-prompt-enhancer-ai.is-busy{opacity:1;cursor:pointer}
.td-prompt-enhancer-ai.is-busy > span{
  animation:td-prompt-enhancer-spin .8s linear infinite;
}
.td-prompt-enhancer-status{
  position:absolute;left:10px;right:45px;bottom:8px;overflow:hidden;
  color:rgba(190,185,198,.56);font:10px/1.2 Inter,ui-sans-serif,system-ui,sans-serif;
  text-overflow:ellipsis;white-space:nowrap;pointer-events:none;
}
.td-prompt-enhancer-status[data-tone="error"]{color:#ff9c8f}
.td-prompt-enhancer-status[data-tone="success"]{color:#9acda5}
.td-prompt-enhancer-status[data-tone="busy"]{color:#c9bbff}
@keyframes td-prompt-enhancer-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){
  .td-prompt-enhancer-ai.is-busy > span{animation:none}
}
`;
  document.head.append(style);
}

function ensureEditor(node) {
  if (!isTarget(node) || node.__tdPromptEnhancerWrap) return;
  const prompt = hideNativePromptWidget(node);
  if (!prompt || typeof node.addDOMWidget !== "function") return;

  ensureStyles();

  const wrap = document.createElement("div");
  wrap.className = "td-prompt-enhancer-wrap";

  const textarea = document.createElement("textarea");
  textarea.className = "comfy-multiline-input td-prompt-enhancer-textarea";
  textarea.spellcheck = false;
  textarea.value = promptValue(node);
  textarea.placeholder = "输入需要增强的提示词…";
  textarea.addEventListener("pointerdown", event => event.stopPropagation());
  textarea.addEventListener("keydown", event => event.stopPropagation());
  textarea.addEventListener("input", () => {
    setPromptValue(node, textarea.value, true);
    refreshButton(node);
  });
  textarea.addEventListener("blur", () => setPromptValue(node, textarea.value, true));

  const status = document.createElement("div");
  status.className = "td-prompt-enhancer-status";
  status.setAttribute("aria-live", "polite");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "td-prompt-enhancer-ai";
  button.innerHTML = "<span>✦</span>";
  button.addEventListener("pointerdown", event => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    void runEnhancement(node);
  });

  wrap.append(textarea, status, button);
  wrap.addEventListener("pointerdown", event => event.stopPropagation());
  wrap.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

  const dom = node.addDOMWidget(
    "terrydirector_prompt_enhancer_editor",
    "terrydirector_prompt_enhancer_editor",
    wrap,
    {
      serialize: false,
      margin: 8,
      getMinHeight: () => 210,
      getMaxHeight: () => 720,
      getValue: () => promptValue(node),
      setValue: value => {
        setPromptValue(node, value, false);
        textarea.value = promptValue(node);
        refreshButton(node);
      },
    }
  );
  if (!dom) return;
  dom.serialize = false;

  node.__tdPromptEnhancerWrap = wrap;
  node.__tdPromptEnhancerTextarea = textarea;
  node.__tdPromptEnhancerStatus = status;
  node.__tdPromptEnhancerButton = button;
  node.__tdPromptEnhancerDomWidget = dom;

  const originalCallback = prompt.callback;
  prompt.callback = value => {
    originalCallback?.(value);
    if (document.activeElement !== textarea) textarea.value = String(value ?? "");
    refreshButton(node);
  };

  if ((node.size?.[0] || 0) < 420 || (node.size?.[1] || 0) < 300) {
    node.setSize?.([Math.max(420, Number(node.size?.[0]) || 0),
      Math.max(300, Number(node.size?.[1]) || 0)]);
  }

  refreshButton(node);
  node.__tdPromptEnhancerTimer = window.setInterval(() => refreshButton(node), 400);
}

function installNode(nodeType, nodeData) {
  if (nodeData?.name !== NODE_CLASS || nodeType.prototype.__tdPromptEnhancerInstalled) return;
  nodeType.prototype.__tdPromptEnhancerInstalled = true;

  const created = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function() {
    const result = created?.apply(this, arguments);
    queueMicrotask(() => ensureEditor(this));
    return result;
  };

  const configured = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function() {
    const result = configured?.apply(this, arguments);
    queueMicrotask(() => {
      ensureEditor(this);
      if (this.__tdPromptEnhancerTextarea) {
        this.__tdPromptEnhancerTextarea.value = promptValue(this);
        refreshButton(this);
      }
    });
    return result;
  };

  const connections = nodeType.prototype.onConnectionsChange;
  nodeType.prototype.onConnectionsChange = function() {
    const result = connections?.apply(this, arguments);
    queueMicrotask(() => refreshButton(this));
    return result;
  };

  const removed = nodeType.prototype.onRemoved;
  nodeType.prototype.onRemoved = function() {
    if (this.__tdPromptEnhancerTimer) {
      window.clearInterval(this.__tdPromptEnhancerTimer);
      this.__tdPromptEnhancerTimer = null;
    }
    this.__tdPromptEnhancerTask?.cancel?.();
    return removed?.apply(this, arguments);
  };
}

app.registerExtension({
  name: "TerryDirector.PromptEnhancer",
  setup() {
    ensureStyles();
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    installNode(nodeType, nodeData);
  },
});
