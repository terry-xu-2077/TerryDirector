import { app } from "/scripts/app.js";

const CLASS_NAME = "TerryDirectorDualSamplingResolutionSelector";
const STYLE_ID = "td-dual-sampling-resolution-style";

function ratioFromLabel(label) {
  const match = String(label || "16:9").match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (!match) return 16 / 9;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

function dimensions(megapixels, ratio) {
  const mp = Number(megapixels);
  if (!Number.isFinite(mp) || mp <= 0 || !Number.isFinite(ratio) || ratio <= 0) return null;
  const roundUp = value => Math.max(32, Math.ceil(value / 32 - 1e-12) * 32);
  const pixels = mp * 1000000;
  return {
    width: roundUp(Math.sqrt(pixels * ratio)),
    height: roundUp(Math.sqrt(pixels / ratio)),
    targetMp: mp,
  };
}

function findWidget(node, names) {
  return (node?.widgets || []).find(widget => names.includes(widget.name));
}

function graphLink(graph, id) {
  if (id == null) return null;
  const links = graph?.links || graph?._links;
  if (Array.isArray(links)) return links.find(link => Number(link?.id) === Number(id)) || null;
  return links?.[id] || links?.[String(id)] || null;
}

function graphNode(graph, id) {
  return graph?.getNodeById?.(Number(id)) ||
    graph?._nodes_by_id?.[id] ||
    graph?._nodes?.find(item => Number(item.id) === Number(id)) ||
    null;
}

function readWidgetNumber(node, preferredNames = []) {
  const widgets = node?.widgets || [];
  const preferred = widgets.find(widget =>
    preferredNames.includes(widget.name) && typeof widget.value === "number");
  if (preferred && Number.isFinite(Number(preferred.value))) return Number(preferred.value);
  const fallback = widgets.find(widget =>
    typeof widget.value === "number" && Number.isFinite(Number(widget.value)));
  return fallback ? Number(fallback.value) : null;
}

// A tiny arithmetic parser is used only to preview common scalar expression nodes.
// It deliberately supports arithmetic and a small allowlist of functions, never eval().
function evaluateExpression(source, variables) {
  const compact = String(source || "").replace(/\s+/g, "");
  const tokens = compact.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|[()+\-*/%^,]/g);
  if (!tokens || tokens.join("") !== compact) return null;
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];

  function primary() {
    const token = take();
    if (token === undefined) throw new Error("missing value");
    if (token === "(") {
      const value = add();
      if (take() !== ")") throw new Error("missing closing parenthesis");
      return value;
    }
    if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) return Number(token);
    if (/^[A-Za-z_]\w*$/.test(token)) {
      const name = token.toLowerCase();
      if (peek() === "(") {
        take();
        const args = [];
        if (peek() !== ")") {
          do {
            args.push(add());
            if (peek() !== ",") break;
            take();
          } while (index < tokens.length);
        }
        if (take() !== ")") throw new Error("missing function parenthesis");
        const functions = {
          round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
          sqrt: Math.sqrt, min: Math.min, max: Math.max, pow: Math.pow,
          sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log,
          exp: Math.exp,
        };
        if (!Object.prototype.hasOwnProperty.call(functions, name)) throw new Error("unknown function");
        return functions[name](...args);
      }
      if (name === "pi") return Math.PI;
      if (name === "e") return Math.E;
      if (!Object.prototype.hasOwnProperty.call(variables, name)) throw new Error("unknown variable");
      return variables[name];
    }
    throw new Error("unexpected token");
  }

  function unary() {
    if (peek() === "+") { take(); return unary(); }
    if (peek() === "-") { take(); return -unary(); }
    return primary();
  }

  function power() {
    const left = unary();
    if (peek() === "^") { take(); return Math.pow(left, power()); }
    return left;
  }

  function multiply() {
    let value = power();
    while (["*", "/", "%"].includes(peek())) {
      const operator = take();
      const right = power();
      if (operator === "*") value *= right;
      else if (operator === "/") value /= right;
      else value %= right;
    }
    return value;
  }

  function add() {
    let value = multiply();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const right = multiply();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  try {
    const result = add();
    if (index !== tokens.length || !Number.isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

function expressionWidget(node) {
  const widgets = node?.widgets || [];
  return widgets.find(widget =>
    typeof widget.value === "string" &&
    /[()+\-*/^]/.test(widget.value) &&
    /[A-Za-z]/.test(widget.value)) || null;
}

function inputValue(node, name, visited = new Set()) {
  if (!node) return null;
  const key = String(node.id) + ":" + name;
  if (visited.has(key)) return null;
  visited.add(key);
  const input = (node.inputs || []).find(item => item.name === name);
  if (input?.link != null) {
    const link = graphLink(node.graph || app.graph, input.link);
    if (!link) return null;
    const source = graphNode(node.graph || app.graph, link.origin_id ?? link.originId);
    return outputValue(source, link.origin_slot ?? link.originSlot, visited);
  }
  const widget = findWidget(node, [name]);
  if (typeof widget?.value === "number" && Number.isFinite(Number(widget.value))) return Number(widget.value);
  if (typeof input?.widget?.value === "number" && Number.isFinite(Number(input.widget.value))) {
    return Number(input.widget.value);
  }
  if (typeof input?.value === "number" && Number.isFinite(Number(input.value))) return Number(input.value);
  return null;
}

function outputValue(source, outputSlot, visited) {
  if (!source) return null;
  const type = String(source.comfyClass || source.type || source.title || "");
  if (/math.*expression|expression.*math/i.test(type) || expressionWidget(source)) {
    const expression = expressionWidget(source);
    if (expression) {
      const variables = {};
      for (const input of source.inputs || []) {
        const value = inputValue(source, input.name, new Set(visited));
        if (value != null) variables[String(input.name).split(".").pop().toLowerCase()] = value;
      }
      return evaluateExpression(expression.value, variables);
    }
  }
  const widgetValue = readWidgetNumber(source, ["value", "number", "float", "int"]);
  if (widgetValue != null) return widgetValue;
  const output = source.outputs?.[Number(outputSlot)];
  if (typeof output?.value === "number" && Number.isFinite(Number(output.value))) return Number(output.value);
  return null;
}

function selectorInputValue(node, name) {
  return inputValue(node, name, new Set());
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ".td-dual-resolution-preview{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;padding:7px 8px;margin:3px 0 5px;border-radius:7px;background:rgba(255,255,255,.045);font-family:inherit;}",
    ".td-dual-resolution-row{display:flex;align-items:center;gap:8px;min-height:22px;}",
    ".td-dual-resolution-label{flex:0 0 68px;color:#a9adb8;font-size:11px;}",
    ".td-dual-resolution-value{flex:1;min-width:0;text-align:right;color:#e7edf5;font-size:12px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;}",
    ".td-dual-resolution-value.is-waiting{color:#8e96a4;font-size:11px;font-weight:500;}",
    ".td-dual-resolution-value .td-dual-resolution-mp{margin-left:6px;color:#9fa8b6;font-size:11px;font-weight:500;}",
  ].join("");
  document.head.append(style);
}

function setPreviewRow(row, mp, ratio) {
  const value = row.querySelector(".td-dual-resolution-value");
  if (!value) return;
  const result = mp == null ? null : dimensions(mp, ratio);
  if (!result) {
    const text = mp == null ? "等待上游数值" : "输入值无效";
    if (value.dataset.rendered !== text) {
      value.textContent = text;
      value.classList.add("is-waiting");
      value.title = mp == null
        ? "此输入由上游节点提供；若无法静态解析，将在执行后由下游输出确认。"
        : "百万像素必须是大于零的有限数值。";
      value.dataset.rendered = text;
    }
    return;
  }
  const actualMp = result.width * result.height / 1000000;
  const text = result.width + " × " + result.height + " " + result.targetMp.toFixed(2) + " MP";
  if (value.dataset.rendered !== text) {
    value.textContent = "";
    value.classList.remove("is-waiting");
    const dimensionsText = document.createElement("span");
    dimensionsText.textContent = result.width + " × " + result.height;
    const mpText = document.createElement("span");
    mpText.className = "td-dual-resolution-mp";
    mpText.textContent = result.targetMp.toFixed(2) + " MP";
    value.append(dimensionsText, mpText);
    value.title = "目标：" + result.targetMp.toFixed(3) + " MP；取整后实际像素面积：" + actualMp.toFixed(3) + " MP。";
    value.dataset.rendered = text;
  }
}

function refresh(node) {
  if (!node?.__tdDualResolutionRoot) return;
  watchAncestors(node);
  const ratioWidget = findWidget(node, ["aspect_ratio"]);
  const ratio = ratioFromLabel(ratioWidget?.value || "16:9 (Widescreen)");
  setPreviewRow(
    node.__tdDualResolutionRoot.querySelector('[data-resolution="low"]'),
    selectorInputValue(node, "lowres_megapixels"),
    ratio,
  );
  setPreviewRow(
    node.__tdDualResolutionRoot.querySelector('[data-resolution="high"]'),
    selectorInputValue(node, "highres_megapixels"),
    ratio,
  );
}

function refreshAll() {
  for (const node of app.graph?._nodes || []) {
    if (node.comfyClass === CLASS_NAME) refresh(node);
  }
}

function scheduleRefreshAll() {
  queueMicrotask(refreshAll);
}

function watchNode(node) {
  if (!node || node.__tdDualResolutionWatched) return;
  node.__tdDualResolutionWatched = true;
  for (const widget of node.widgets || []) {
    if (typeof widget.callback !== "function" || widget.__tdDualResolutionWrapped) continue;
    const original = widget.callback;
    widget.callback = function (...args) {
      const result = original.apply(this, args);
      scheduleRefreshAll();
      return result;
    };
    widget.__tdDualResolutionWrapped = true;
  }
  if (typeof node.onWidgetChanged === "function" && !node.__tdDualResolutionWidgetChangedWrapped) {
    const original = node.onWidgetChanged;
    node.onWidgetChanged = function (...args) {
      const result = original.apply(this, args);
      scheduleRefreshAll();
      return result;
    };
    node.__tdDualResolutionWidgetChangedWrapped = true;
  }
  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = typeof originalConnectionsChange === "function"
      ? originalConnectionsChange.apply(this, args) : undefined;
    scheduleRefreshAll();
    return result;
  };
}

function watchAncestors(node, visited = new Set()) {
  if (!node || visited.has(String(node.id))) return;
  visited.add(String(node.id));
  watchNode(node);
  for (const input of node.inputs || []) {
    if (input.link == null) continue;
    const link = graphLink(node.graph || app.graph, input.link);
    if (!link) continue;
    const source = graphNode(node.graph || app.graph, link.origin_id ?? link.originId);
    watchAncestors(source, visited);
  }
}

function attach(node) {
  if (node?.comfyClass !== CLASS_NAME) return;
  watchNode(node);
  if (!node.__tdDualResolutionRoot) {
    ensureStyle();
    const root = document.createElement("div");
    root.className = "td-dual-resolution-preview";
    root.innerHTML =
      '<div class="td-dual-resolution-row" data-resolution="low">' +
        '<span class="td-dual-resolution-label">低清采样</span>' +
        '<span class="td-dual-resolution-value is-waiting">等待上游数值</span>' +
      '</div>' +
      '<div class="td-dual-resolution-row" data-resolution="high">' +
        '<span class="td-dual-resolution-label">高清采样</span>' +
        '<span class="td-dual-resolution-value is-waiting">等待上游数值</span>' +
      '</div>';
    root.addEventListener("pointerdown", event => event.stopPropagation());
    root.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
    const widget = node.addDOMWidget("td_dual_sampling_resolution_preview", "td_dual_sampling_resolution_preview", root, {
      hideOnZoom: false,
      getMinHeight: () => 58,
      getMaxHeight: () => 66,
      margin: 3,
    });
    widget.serialize = false;
    widget.options.serialize = false;
    node.__tdDualResolutionRoot = root;
    const width = Math.max(Number(node.size?.[0]) || 0, 310);
    node.setSize?.([width, Math.max(Number(node.size?.[1]) || 0, Number(node.computeSize?.()?.[1]) || 0)]);
    const originalDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
      if (typeof originalDraw === "function") originalDraw.call(this, ctx, ...args);
      refresh(this);
    };
  }
  refresh(node);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "TerryDirector.DualSamplingResolutionSelector",
  nodeCreated(node) { queueMicrotask(() => attach(node)); },
  loadedGraphNode(node) { queueMicrotask(() => attach(node)); },
});
