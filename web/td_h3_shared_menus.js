// Vendored/adapted from TerryXu-nodes web/h3_shared_menus.js @ 957ba74fa559d92c124a98607ed53e800a8c5453
// Reuse the full original H3 menus with a lightweight preview-task adapter.
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { createH3TokenNode, H3_CAMERA_COMMANDS } from "./td_h3_rich_text.js";

const PROMPT_LINKS = "terry_h3_virtual_media_links";
const TIMELINE_LINKS = "terry_h3_timeline_virtual_media_links";
const BINDINGS_PROP = "terry_h3_subject_bindings";
const FILTER_PROP = "terry_h3_asset_menu_filter";
const CARET = "\u200B";

const CATEGORY_META = [
  { id: "structure", label: "结构", icon: "§", detail: "H3 主字段与段落" },
  { id: "shot", label: "镜头", icon: "🎬", detail: "镜头标签、时间戳、说话人与镜头运动" },
  { id: "dialogue", label: "对白", icon: "💬", detail: "对白块与连续性标签" },
  { id: "retention", label: "保留关系", icon: "◎", detail: "视觉与音频引用关系" },
  { id: "task", label: "任务类型", icon: "▣", detail: "Summary 的任务类型前缀" },
];
const CAMERA_META = { id: "camera", label: "镜头运动", icon: "◉", detail: "常用运镜方式与镜头运动", parent: "shot" };

const controllers = new WeakMap();
let styleInstalled = false;

function linksProp(mode) { return mode === "timeline" ? TIMELINE_LINKS : PROMPT_LINKS; }
function links(node, mode) {
  node.properties ||= {};
  const value = node.properties[linksProp(mode)];
  return Array.isArray(value) ? value : [];
}
function graphNode(node, id) { return node?.graph?.getNodeById?.(Number(id)) || app.graph?.getNodeById?.(Number(id)) || null; }
function kindOf(src, slot, fallback = "") {
  const type = String(src?.outputs?.[slot]?.type || fallback || "").toUpperCase();
  if (type.includes("AUDIO")) return "audio";
  if (type.includes("VIDEO")) return "video";
  return "picture";
}
function resolveAssetSource(src, slot = 0, fallbackType = "") {
  let node = src;
  let resolvedSlot = Number(slot) || 0;
  try {
    const resolved = src?.resolveVirtualOutput?.(resolvedSlot);
    if (resolved?.node) {
      node = resolved.node;
      resolvedSlot = Number(resolved.slot) || 0;
    }
  } catch {}
  return {
    node,
    slot: resolvedSlot,
    type: String(node?.outputs?.[resolvedSlot]?.type || fallbackType || "*"),
  };
}
function filename(src, kind) {
  const preferred = kind === "picture"
    ? ["image", "filename", "file"]
    : kind === "video"
      ? ["video", "file", "filename", "video_file", "videofile"]
      : ["audio", "file", "filename", "audio_file", "audiofile"];
  for (const widget of src?.widgets || []) {
    const value = widget?.value;
    const file = typeof value === "object" ? (value?.filename || value?.name) : value;
    if (!file || /^(data:|blob:|https?:)/i.test(String(file))) continue;
    if (preferred.includes(String(widget?.name || "").toLowerCase()) || /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|mkv|avi|m4v|mp3|wav|flac|ogg|m4a|aac)$/i.test(String(file))) return String(file);
  }
  return "";
}
function preview(src, kind) {
  if (!src || kind === "audio") return "";
  const file = filename(src, kind);
  if (file) {
    const widget = (src.widgets || []).find((item) => {
      const value = item?.value;
      return String(typeof value === "object" ? (value?.filename || value?.name || "") : (value || "")) === file;
    });
    const value = widget?.value;
    const query = new URLSearchParams({ filename: file, type: typeof value === "object" ? String(value.type || "input") : "input" });
    if (typeof value === "object" && value.subfolder) query.set("subfolder", String(value.subfolder));
    return api.apiURL(`/view?${query.toString()}`);
  }
  return (src.imgs || []).find((item) => item?.src)?.src || "";
}
function assets(node, mode) {
  // H3 editor owns the expanded, execution-aware reference list. Reuse it for
  // @ menus and Subject bindings so Picture 2 points at list item 2.
  if (mode === "prompt" && typeof node?.__terryH3MediaOptions === "function") {
    return node.__terryH3MediaOptions().map((item) => ({
      key: item.key,
      kind: item.kind,
      index: item.index,
      raw: item.tag,
      label: item.label,
      displayLabel: (item.kind === "picture" ? "图片 " : item.kind === "video" ? "视频 " : "音频 ") + item.index,
      src: null,
      name: item.source,
      preview: item.preview,
    }));
  }
  const count = { picture: 0, video: 0, audio: 0 }, out = [], seen = new Set();
  for (const link of links(node, mode)) {
    const id = Number(link?.source_id), slot = Number(link?.source_slot) || 0, key = `${id}:${slot}`;
    if (!Number.isFinite(id) || seen.has(key)) continue;
    const displaySrc = graphNode(node, id);
    if (!displaySrc) continue;
    seen.add(key);
    const resolved = resolveAssetSource(displaySrc, slot, link.source_type);
    const src = resolved.node || displaySrc;
    const sourceSlot = Number(resolved.slot) || 0;
    const kind = kindOf(src, sourceSlot, resolved.type || link.source_type);
    count[kind] = (count[kind] || 0) + 1;
    const index = count[kind];
    const english = kind === "picture" ? `Picture ${index}` : kind === "video" ? `Video ${index}` : `Audio ${index}`;
    const chinese = kind === "picture" ? `图片 ${index}` : kind === "video" ? `视频 ${index}` : `音频 ${index}`;
    out.push({
      key,
      kind,
      index,
      raw: `<${english}>`,
      label: english,
      displayLabel: chinese,
      src,
      name: filename(src, kind).split(/[\\/]/).pop() || src.title || english,
      preview: preview(src, kind),
    });
  }
  return out;
}
function promptText(node, mode) {
  const names = mode === "timeline" ? ["compiled_prompt", "timeline_state"] : ["prompt"];
  return names.map((name) => String(node?.widgets?.find?.((w) => w?.name === name)?.value || "")).join("\n");
}
function bindings(node) {
  node.properties ||= {};
  const value = node.properties[BINDINGS_PROP];
  if (!value || typeof value !== "object" || Array.isArray(value)) node.properties[BINDINGS_PROP] = {};
  return node.properties[BINDINGS_PROP];
}
function allSubjectNumbers(node, mode) {
  const used = new Set();
  for (const match of promptText(node, mode).matchAll(/<Subject\s+(\d+)>/gi)) used.add(Number(match[1]));
  for (const list of Object.values(bindings(node))) for (const n of Array.isArray(list) ? list : []) if (Number.isFinite(Number(n))) used.add(Number(n));
  return [...used].filter(Number.isFinite).sort((a, b) => a - b);
}
function nextSubject(node, mode) {
  const used = new Set(allSubjectNumbers(node, mode));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}
function boundSubjects(node, asset) {
  const list = bindings(node)[asset.key];
  return Array.isArray(list) ? [...new Set(list.map(Number).filter(Number.isFinite))].sort((a, b) => a - b) : [];
}
function bindSubject(node, asset, number) {
  number = Number(number);
  if (!Number.isFinite(number) || number < 1) return;
  const map = bindings(node);
  const list = Array.isArray(map[asset.key]) ? map[asset.key] : [];
  if (!list.map(Number).includes(number)) list.push(number);
  map[asset.key] = list;
  app.graph?.change?.();
}
function subjectSources(node, mode, number) {
  return assets(node, mode).filter((asset) => boundSubjects(node, asset).includes(Number(number)));
}
function isDirectUsed(node, mode, asset) { return new RegExp(`<${asset.label.replace(/\s+/g, "\\s+")}>`, "i").test(promptText(node, mode)); }
function cleanDefinition(text) { return String(text || "").replace(/\r\n?/g, "\n").replace(/^[\s:：,，.。;；-]+/, "").replace(/\s+/g, " ").trim(); }
function definitionMap(node, mode) {
  const source = promptText(node, mode).replace(/\r\n?/g, "\n");
  const map = new Map();
  const re = /<(Subject|Picture|Video|Audio)\s+(\d+)>\s*(?:is\b|[:：-])?\s*([\s\S]*?)(?=\n\s*<(?:Subject|Picture|Video|Audio)\s+\d+>|\n\s*(?:summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:|$)/gi;
  for (const match of source.matchAll(re)) {
    const key = `${match[1].toLowerCase()}:${Number(match[2])}`;
    const description = cleanDefinition(match[3]);
    if (description) map.set(key, description);
  }
  return map;
}
function isEditableTextNode(node, editor) {
  if (!node || node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return false;
  let parent = node.parentElement;
  while (parent && parent !== editor) {
    const editable = parent.getAttribute?.("contenteditable");
    if (editable === "true") return true;
    if (editable === "false") return false;
    parent = parent.parentElement;
  }
  return parent === editor;
}

function edgeTextBoundary(node, fromEnd, editor) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    if (!isEditableTextNode(node, editor)) return null;
    return { node, offset: fromEnd ? String(node.textContent || "").length : 0 };
  }
  if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === "BR"
      || node.getAttribute?.("contenteditable") === "false") return null;
  const children = Array.from(node.childNodes || []);
  if (fromEnd) children.reverse();
  for (const child of children) {
    const boundary = edgeTextBoundary(child, fromEnd, editor);
    if (boundary) return boundary;
  }
  return null;
}

function caretTextBoundary(editor, container, offset) {
  if (container?.nodeType === Node.TEXT_NODE) {
    if (!isEditableTextNode(container, editor)) return null;
    const length = String(container.textContent || "").length;
    return { node: container, offset: Math.max(0, Math.min(length, Number(offset) || 0)) };
  }
  if (container?.nodeType !== Node.ELEMENT_NODE || !editor.contains(container)) return null;
  const children = container.childNodes || [];
  const previous = offset > 0 ? children[offset - 1] : null;
  const next = offset < children.length ? children[offset] : null;
  // A BR is a hard line boundary; prefer the text after it, never match a
  // trigger on the previous line.
  if (previous?.nodeType === Node.ELEMENT_NODE && previous.tagName === "BR") {
    return edgeTextBoundary(next, false, editor);
  }
  return edgeTextBoundary(previous, true, editor) || edgeTextBoundary(next, false, editor);
}

function caretRange(editor, trigger) {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount) return null;
  const caret = selection.getRangeAt(0);
  if (!editor.contains(caret.commonAncestorContainer)) return null;
  // IMEs can leave the selection at an element boundary instead of a text
  // node. For a temporary non-collapsed IME selection, use its committed end.
  const container = selection.isCollapsed ? caret.startContainer : caret.endContainer;
  const offset = selection.isCollapsed ? caret.startOffset : caret.endOffset;
  const boundary = caretTextBoundary(editor, container, offset);
  if (!boundary) return null;
  const before = String(boundary.node.textContent || "").slice(0, boundary.offset);
  const match = before.match(trigger === "@" ? /[@＠]([^@＠\n]*)$/ : /[\/／]([^\/／\n]*)$/);
  if (!match) return null;
  const range = document.createRange();
  range.setStart(boundary.node, boundary.offset - match[0].length);
  range.setEnd(boundary.node, boundary.offset);
  return { range, query: String(match[1] || "").trim().toLowerCase() };
}
function createToken(controller, raw, asset = null) {
  return createH3TokenNode(raw, {
    onChange: controller.onChange,
    ...(controller.mode === "timeline" ? { extraChipClass: "terry-tl-chip" } : {}),
    ...(asset ? {
      resolveMedia(kind, index) {
        return asset.kind === kind && asset.index === Number(index) ? { preview: asset.preview, source: asset.name } : null;
      },
    } : {}),
  });
}
function insertAt(editor, range, content, onChange) {
  range.deleteContents();
  const marker = document.createTextNode(CARET), fragment = document.createDocumentFragment();
  if (Array.isArray(content)) content.forEach((item) => fragment.append(item));
  else fragment.append(content);
  fragment.append(marker);
  range.insertNode(fragment);
  const selection = window.getSelection?.();
  if (selection) {
    const next = document.createRange();
    next.setStart(marker, marker.textContent.length);
    next.collapse(true);
    selection.removeAllRanges();
    selection.addRange(next);
  }
  onChange?.();
  editor.dispatchEvent(new Event("terrychange", { bubbles: true }));
  editor.focus({ preventScroll: true });
}
function menuButton(label, title = "", className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `terry-h3-role-action${className ? ` ${className}` : ""}`;
  button.textContent = label;
  button.title = title;
  return button;
}
function placeMenu(menu, editor, width = 470, maxHeight = 560) {
  if (menu.parentElement !== document.body) document.body.append(menu);
  const selection = window.getSelection?.();
  const caretRect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
  const editorRect = editor.getBoundingClientRect();
  const rect = caretRect && (caretRect.width || caretRect.height) ? caretRect : editorRect;
  const measuredHeight = Math.min(maxHeight, menu.offsetHeight || 400);
  let left = rect.left, top = rect.bottom + 6;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (top + measuredHeight > window.innerHeight - 8) top = Math.max(8, rect.top - measuredHeight - 6);
  Object.assign(menu.style, { position: "fixed", left: `${Math.max(8, Math.round(left))}px`, top: `${Math.max(8, Math.round(top))}px`, zIndex: "2147483000", isolation: "isolate", pointerEvents: "auto" });
}
function closeMenu(controller) { controller.menu?.remove?.(); controller.menu = null; controller.menuType = null; controller.commandState = null; }
function currentFilter(node) { return String(node?.properties?.[FILTER_PROP] || "subject"); }
function setFilter(node, value) { node.properties ||= {}; node.properties[FILTER_PROP] = value; app.graph?.change?.(); }
function insertMediaReference(controller, hit, asset) { insertAt(controller.editor, hit.range, createToken(controller, asset.raw, asset), controller.onChange); closeMenu(controller); }
function insertSubjectToken(controller, hit, subjectNumber) {
  const number = Number(subjectNumber);
  if (!Number.isFinite(number)) return;
  insertAt(controller.editor, hit.range, createToken(controller, `<Subject ${number}>`), controller.onChange);
  closeMenu(controller);
}
function insertSubjectWithSource(controller, hit, asset, subjectNumber) {
  const number = Number(subjectNumber);
  if (!Number.isFinite(number)) return;
  bindSubject(controller.node, asset, number);
  insertSubjectToken(controller, hit, number);
}
function assetRoleDetail(asset) {
  if (asset.kind === "picture") return "仅当图片本身作为首帧、关键帧、末帧、编辑关键帧、构图或 Storyboard 锚点时使用";
  if (asset.kind === "video") return "用于被直接编辑/续写的视频源，或提供整段镜头、剪辑、节奏与时序结构";
  return "用于复制或参考音频信号、音色、节奏、对白、歌词、音效或连续性";
}
function makeAssetRow(asset, metaText, onClick, extraClass = "") {
  const row = document.createElement("div");
  row.className = `terry-h3-role-row is-selectable${extraClass ? ` ${extraClass}` : ""}`;
  const thumb = document.createElement("div");
  thumb.className = `terry-h3-role-thumb is-${asset.kind}`;
  if (asset.preview && asset.kind !== "audio") {
    const img = document.createElement("img"); img.src = asset.preview; img.alt = ""; thumb.append(img);
  } else thumb.textContent = asset.kind === "audio" ? "♪" : asset.kind === "video" ? "▶" : "▧";
  const info = document.createElement("div"); info.className = "terry-h3-role-info";
  const name = document.createElement("b"); name.textContent = asset.name; name.title = asset.name;
  const meta = document.createElement("small"); meta.textContent = metaText;
  info.append(name, meta); row.append(thumb, info);
  row.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); onClick?.(event); });
  return row;
}
function makeSubjectRow(controller, hit, number, definitions, showSourceButton = true) {
  const row = document.createElement("div");
  row.className = "terry-h3-subject-row is-selectable";
  const info = document.createElement("div"); info.className = "terry-h3-role-info";
  const name = document.createElement("b"); name.textContent = `主体 ${number}`;
  const sources = subjectSources(controller.node, controller.mode, number);
  const sourceText = sources.length ? sources.map((asset) => asset.displayLabel).join("、") : "未关联参考来源";
  const desc = definitions.get(`subject:${number}`) || "";
  const meta = document.createElement("small"); meta.textContent = desc ? `${desc} · 来源：${sourceText}` : `来源：${sourceText}`;
  info.append(name, meta);
  row.append(info);
  row.addEventListener("pointerdown", (event) => {
    if (event.target?.closest?.("button")) return;
    event.preventDefault(); event.stopPropagation(); insertSubjectToken(controller, hit, number);
  });
  if (showSourceButton) {
    const manage = menuButton("来源", "管理此 Subject 的 Picture / Video 来源");
    manage.classList.add("terry-h3-subject-source-button");
    manage.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); openSubjectSourceMenu(controller, hit, number); });
    row.append(manage);
  }
  return row;
}
function openSubjectSourceMenu(controller, hit, subjectNumber) {
  const menu = controller.menu;
  if (!menu) return;
  menu.replaceChildren();
  const head = document.createElement("div"); head.className = "terry-h3-role-legend";
  const title = document.createElement("div"); title.className = "terry-h3-role-title";
  title.innerHTML = `<b>主体 ${subjectNumber} · 选择参考来源</b><span>这里选择的是来源资产，不是 Subject 本身</span>`;
  head.append(title); menu.append(head);
  const visualAssets = assets(controller.node, controller.mode).filter((asset) => asset.kind !== "audio");
  const currentKeys = new Set(subjectSources(controller.node, controller.mode, subjectNumber).map((asset) => asset.key));
  for (const asset of visualAssets) {
    const prefix = currentKeys.has(asset.key) ? "已关联 · " : "";
    menu.append(makeAssetRow(asset, `${prefix}${asset.displayLabel} · 作为主体 ${subjectNumber} 的参考来源`, () => insertSubjectWithSource(controller, hit, asset, subjectNumber), currentKeys.has(asset.key) ? "is-defined" : ""));
  }
  if (!visualAssets.length) {
    const empty = document.createElement("div"); empty.className = "terry-h3-role-empty"; empty.textContent = "没有可作为 Subject 来源的图片或视频资产。"; menu.append(empty);
  }
  const back = menuButton("‹ 返回主体列表");
  back.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); openAssetMenu(controller); });
  menu.append(back);
  placeMenu(menu, controller.editor, 470, 560);
}

function buildAssetMenu(controller, query = "", onSelect = null) {
  const { node, mode } = controller;
  const allAssets = assets(node, mode);
  const visible = allAssets.filter((asset) =>
    !query || `${asset.name} ${asset.label} ${asset.displayLabel} ${asset.kind}`.toLowerCase().includes(query)
  );

  const menu = document.createElement("div");
  menu.className = "terry-h3-role-menu terry-h3-shared-module-menu";
  controller.menu = menu;
  controller.menuType = "asset";
  document.body.append(menu);

  const legend = document.createElement("div");
  legend.className = "terry-h3-role-legend";
  const title = document.createElement("div");
  title.className = "terry-h3-role-title";
  title.innerHTML = "<b>引用参考</b>";
  legend.append(title);
  menu.append(legend);

  for (const asset of visible) {
    menu.append(makeAssetRow(asset, asset.displayLabel, () => onSelect?.(asset)));
  }
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "terry-h3-role-empty";
    empty.textContent = allAssets.length ? "没有匹配的参考资产。" : "还没有连接图片、视频或音频参考。";
    menu.append(empty);
  }
  return menu;
}

function placeAssetMenuAtElement(menu, anchor) {
  const rect = anchor?.getBoundingClientRect?.();
  if (!rect) return;
  const width = 295;
  const measuredHeight = Math.min(520, menu.offsetHeight || 400);
  let left = rect.left, top = rect.bottom + 6;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (top + measuredHeight > window.innerHeight - 8) top = Math.max(8, rect.top - measuredHeight - 6);
  Object.assign(menu.style, { position: "fixed", left: `${Math.max(8, Math.round(left))}px`, top: `${Math.max(8, Math.round(top))}px`, zIndex: "2147483000", isolation: "isolate", pointerEvents: "auto" });
}

function openAssetMenu(controller, knownHit = null) {
  const { editor } = controller;
  const hit = knownHit || caretRange(editor, "@");
  if (!hit) { closeMenu(controller); return false; }
  closeMenu(controller);
  const menu = buildAssetMenu(controller, hit.query, (asset) => insertMediaReference(controller, hit, asset));
  placeMenu(menu, editor, 295, 520);
  return true;
}

export function openH3AssetMenuForChip(editor, chip) {
  const controller = controllers.get(editor);
  if (!controller || !chip || !editor?.contains?.(chip)) return false;
  closeMenu(controller);
  const menu = buildAssetMenu(controller, "", (asset) => {
    const token = createToken(controller, asset.raw, asset);
    chip.replaceWith(token);
    controller.onChange?.();
    editor.dispatchEvent(new Event("terrychange", { bubbles: true }));
    editor.focus({ preventScroll: true });
    closeMenu(controller);
  });
  placeAssetMenuAtElement(menu, chip);
  return true;
}

function nextSpeaker(node, mode) { let max = 0; for (const match of promptText(node, mode).matchAll(/\(S(\d+)\)/gi)) max = Math.max(max, Number(match[1]) || 0); return max + 1; }
function nextShot(node, mode) { let max = 0; for (const match of promptText(node, mode).matchAll(/\[\s*Shot\s+(\d+)\s*\]/gi)) max = Math.max(max, Number(match[1]) || 0); return max + 1; }
function defaultDialogueLanguage() {
  let locale = "en";
  try { locale = app?.ui?.settings?.getSettingValue?.("Comfy.Locale") || document?.documentElement?.lang || navigator.language || locale; } catch {}
  const code = String(locale).trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  return { ar: "Arabic", de: "German", en: "English", es: "Spanish", fr: "French", hi: "Hindi", id: "Indonesian", it: "Italian", ja: "Japanese", ko: "Korean", nl: "Dutch", pl: "Polish", pt: "Portuguese", ru: "Russian", th: "Thai", tr: "Turkish", vi: "Vietnamese", yue: "Cantonese", zh: "Chinese" }[code] || "English";
}
function commands(node, mode) {
  const shot = nextShot(node, mode), speaker = nextSpeaker(node, mode);
  const list = [
    { category: "structure", label: "subject_definitions", detail: "定义 Subject 内容单元，以及必要的 Picture / Video / Audio 资产角色", raw: "subject_definitions:" },
    { category: "structure", label: "summary", detail: "任务类型与主要引用关系摘要", raw: "summary:" },
    { category: "structure", label: "retention_analysis", detail: "逐项说明引用内容如何被保留、迁移、复制或参考", raw: "retention_analysis:" },
    { category: "structure", label: "detailed_description", detail: "逐镜头详细描述", raw: "detailed_description:" },
    { category: "structure", label: "integrated_multimodal_description", detail: "T2VA / I2VA / FL2VA / L2VA 主字段", raw: "integrated_multimodal_description:" },
    { category: "structure", label: "overall_soundscape", detail: "环境声、动作声与非语言人声汇总", raw: "overall_soundscape:" },
    { category: "structure", label: "non_diegetic_music", detail: "非剧情内音乐", raw: "non_diegetic_music:", defaultBody: "N/A" },
    { category: "shot", label: `[Shot ${shot}]`, detail: `插入第 ${shot} 个镜头分段标签`, raw: `[Shot ${shot}]`, kind: "shot-label" },
    { category: "shot", label: "时间戳", detail: "插入秒级时间标签 [00:00]", raw: "[00:00]", kind: "timestamp" },
    { category: "shot", label: `说话人 S${speaker}`, detail: "插入下一个全局说话人编号", raw: `(S${speaker})`, kind: "speaker" },
    { category: "dialogue", label: "对白块", detail: "插入可编辑对白块", raw: `<d>[${defaultDialogueLanguage()}] </d>`, kind: "dialogue" },
    { category: "dialogue", label: "scenetrans", detail: "对白或音频跨镜头连续", raw: "<scenetrans>" },
    { category: "dialogue", label: "cutoff", detail: "对白被镜头或剪辑截断", raw: "<cutoff>" },
    ...[["fully_preserved","定义的视觉引用角色被完整保留"],["partially_preserved","仍使用引用内容，但部分定义特征被改变"],["attribute_transfer","把引用特征迁移到另一个可识别主体"],["weak_reference","仅保留宽泛风格、类别、构图或氛围"],["fully_copy","完整复制源音频信号"],["partially_copy","只复制部分时间或音频层"],["reference","不复制信号，仅参考音色、节奏、内容或声音质感"]].map(([raw, detail]) => ({ category: "retention", label: raw, detail, raw })),
    ...[["reference generation","参考生成"],["keyframe completion","图片作为具体首帧/关键帧/末帧等帧锚点"],["video editing","直接编辑已有视频"],["video continuation","从已有视频继续生成"],["audio reuse","直接复用同一音频信号"],["audio reference","只参考音频特征而不复制信号"]].map(([raw, detail]) => ({ category: "task", label: raw, detail, raw: `[${raw}]` })),
    ...H3_CAMERA_COMMANDS.map(([chinese, english, detail, raw]) => ({ category: "camera", label: `${chinese} · ${english}`, detail, raw })),
  ];
  return mode === "timeline" ? list.filter((item) => !["shot-label", "timestamp"].includes(item.kind)) : list;
}
function category(id) { return id === "camera" ? CAMERA_META : CATEGORY_META.find((item) => item.id === id) || { id, label: id, icon: "›", detail: "" }; }
function parentCategory(id) { return id === "camera" ? "shot" : null; }
function categoryCount(id, list) { if (id === "shot") return list.filter((item) => item.category === "shot" || item.category === "camera").length; return list.filter((item) => item.category === id).length; }
function categoryOptions(state) {
  if (!state.category) return CATEGORY_META.map((meta) => ({ type: "category", meta, count: categoryCount(meta.id, state.list) })).filter((item) => item.count > 0);
  if (state.category === "shot") {
    const direct = state.list.filter((item) => item.category === "shot").map((command) => ({ type: "command", command }));
    const cameraCount = state.list.filter((item) => item.category === "camera").length;
    if (cameraCount) direct.push({ type: "category", meta: CAMERA_META, count: cameraCount });
    return direct;
  }
  return state.list.filter((item) => item.category === state.category).map((command) => ({ type: "command", command }));
}
function goBack(state) { state.category = parentCategory(state.category); state.active = 0; }
function enterCategory(state, id) { state.category = id; state.active = 0; }
function chooseCommand(controller, state, command) {
  const token = createToken(controller, command.raw || "");
  const content = command.defaultBody == null ? token : [token, document.createElement("br"), document.createTextNode(String(command.defaultBody))];
  insertAt(controller.editor, state.range, content, controller.onChange);
  closeMenu(controller);
  if (command.kind !== "dialogue") return;
  const body = token.querySelector?.(".terry-h3-dialogue-text");
  if (!body) return;
  body.focus?.({ preventScroll: true });
  const selection = window.getSelection?.();
  if (selection) { const range = document.createRange(); range.selectNodeContents(body); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); }
}
function renderCommandMenu(controller, state) {
  const menu = controller.menu;
  if (!menu) return;
  menu.replaceChildren();
  const search = Boolean(state.query);
  const head = document.createElement("div"); head.className = "terry-h3-command-head";
  const title = document.createElement("div"); title.className = "terry-h3-command-head-title";
  if (state.category && !search) {
    const back = document.createElement("button"); back.type = "button"; back.className = "terry-h3-command-back"; back.textContent = "‹";
    back.addEventListener("pointerdown", (event) => { event.preventDefault(); goBack(state); renderCommandMenu(controller, state); }); title.append(back);
  }
  const bold = document.createElement("b"); bold.textContent = search ? "搜索 H3 语法" : state.category ? category(state.category).label : "H3 语法"; title.append(bold);
  const hint = document.createElement("span"); hint.textContent = search ? `“${state.query}”` : state.category ? "← 返回 · ↑↓ 选择" : "选择分类 · 也可继续输入关键词";
  head.append(title, hint); menu.append(head);
  state.options = search ? state.list.map((command) => ({ type: "command", command })) : categoryOptions(state);
  state.active = Math.min(state.active, Math.max(0, state.options.length - 1));
  state.options.forEach((option, index) => {
    const item = document.createElement("button"); item.type = "button";
    item.className = `terry-h3-command-item${index === state.active ? " is-active" : ""}${option.type === "category" ? " is-category" : ""}`;
    if (option.type === "category") {
      const icon = document.createElement("span"); icon.className = "terry-h3-command-category-icon"; icon.textContent = option.meta.icon;
      const text = document.createElement("span"); text.className = "terry-h3-command-text"; text.innerHTML = `<b>${option.meta.label}</b><small>${option.meta.detail}</small>`;
      const count = document.createElement("span"); count.className = "terry-h3-command-count"; count.textContent = `${option.count} ›`;
      item.append(icon, text, count);
      item.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); enterCategory(state, option.meta.id); renderCommandMenu(controller, state); });
    } else {
      const cat = document.createElement("span"); cat.className = "terry-h3-command-category"; cat.textContent = category(option.command.category).label;
      const text = document.createElement("span"); text.className = "terry-h3-command-text"; text.innerHTML = `<b>${option.command.label}</b><small>${option.command.detail || option.command.raw}</small>`;
      item.append(cat, text);
      item.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); chooseCommand(controller, state, option.command); });
    }
    item.addEventListener("pointermove", () => { if (state.active !== index) { state.active = index; renderCommandMenu(controller, state); } });
    menu.append(item);
  });
  placeMenu(menu, controller.editor, 340, 380);
}
function openCommandMenu(controller, knownHit = null) {
  const hit = knownHit || caretRange(controller.editor, "/");
  if (!hit) { closeMenu(controller); return false; }
  closeMenu(controller);
  let list = commands(controller.node, controller.mode);
  if (hit.query) list = list.filter((item) => `${item.label} ${category(item.category).label} ${item.detail} ${item.raw}`.toLowerCase().includes(hit.query));
  const menu = document.createElement("div"); menu.className = "terry-h3-command-menu terry-h3-shared-module-menu"; document.body.append(menu);
  controller.menu = menu; controller.menuType = "command";
  const state = { range: hit.range, query: hit.query, category: null, active: 0, options: [], list }; controller.commandState = state;
  renderCommandMenu(controller, state); return true;
}
function refreshOpenMenu(controller) { if (controller.menuType === "asset") openAssetMenu(controller); else if (controller.menuType === "command") openCommandMenu(controller); }
function handleCommandKey(controller, event) {
  const state = controller.commandState;
  if (!state || controller.menuType !== "command") return false;
  if (event.key === "Escape") { closeMenu(controller); return true; }
  if (event.key === "ArrowLeft" && state.category && !state.query) { goBack(state); renderCommandMenu(controller, state); return true; }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (state.options.length) { state.active = (state.active + (event.key === "ArrowDown" ? 1 : -1) + state.options.length) % state.options.length; renderCommandMenu(controller, state); controller.menu?.querySelector?.(".is-active")?.scrollIntoView?.({ block: "nearest" }); }
    return true;
  }
  if (["ArrowRight", "Enter", "Tab"].includes(event.key)) {
    const option = state.options[state.active]; if (!option) return false;
    if (option.type === "category") { enterCategory(state, option.meta.id); renderCommandMenu(controller, state); } else chooseCommand(controller, state, option.command);
    return true;
  }
  return false;
}

export function installH3MenuStyles() {
  if (styleInstalled || document.getElementById("terry-h3-shared-menu-module-style")) return;
  styleInstalled = true;
  const style = document.createElement("style"); style.id = "terry-h3-shared-menu-module-style";
  style.textContent = `
.terry-h3-shared-module-menu{position:fixed!important;z-index:2147483000!important;isolation:isolate!important;pointer-events:auto!important;box-sizing:border-box;color:var(--input-text,#ddd);font-family:Inter,system-ui,sans-serif}
.terry-h3-role-menu{width:295px;max-height:560px;overflow:auto;padding:10px;border:1px solid rgba(255,255,255,.14);border-radius:9px;background:var(--comfy-menu-bg,#17191c);box-shadow:0 18px 48px rgba(0,0,0,.52)}
.terry-h3-role-legend{padding:0 2px 10px;border-bottom:1px solid rgba(255,255,255,.10)}
.terry-h3-role-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.terry-h3-role-title>b{font-size:13px}.terry-h3-role-title>span{font-size:10px;opacity:.5}
.terry-h3-role-tabs{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}.terry-h3-role-action{display:block;width:auto;min-height:28px;margin:5px 2px;padding:3px 9px;border:1px solid rgba(255,255,255,.13);border-radius:6px;background:rgba(255,255,255,.05);color:inherit;cursor:pointer;font-size:11px;white-space:nowrap}.terry-h3-role-tabs .terry-h3-role-action{display:inline-block;margin:0}.terry-h3-role-action.is-active{border-color:rgba(0,226,187,.38);background:rgba(0,226,187,.12);color:rgba(205,255,246,.98)}
.terry-h3-role-subhead{padding:10px 4px 4px;font-size:9.5px;opacity:.55}
.terry-h3-role-row{display:grid;grid-template-columns:54px minmax(0,1fr);gap:10px;align-items:center;padding:9px 7px;border-bottom:1px solid rgba(255,255,255,.055);border-radius:7px}.terry-h3-role-row.is-selectable{cursor:pointer}.terry-h3-role-row.is-selectable:hover{background:rgba(255,255,255,.07)}.terry-h3-role-thumb{width:52px;height:52px;border-radius:7px;overflow:hidden;background:rgba(255,255,255,.07);display:grid;place-items:center}.terry-h3-role-thumb img{width:100%;height:100%;object-fit:cover}.terry-h3-role-info{min-width:0}.terry-h3-role-info b,.terry-h3-role-info small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.terry-h3-role-info b{font-size:11px}.terry-h3-role-row .terry-h3-role-info b{width:100%;max-width:none}.terry-h3-role-info small{margin-top:3px;font-size:9.5px;opacity:.52;white-space:normal;line-height:1.35}.terry-h3-role-row.is-defined .terry-h3-role-info small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.terry-h3-role-empty{padding:18px 8px;text-align:center;font-size:11px;opacity:.55}
.terry-h3-subject-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 7px;border-bottom:1px solid rgba(255,255,255,.055);border-radius:7px}.terry-h3-subject-row.is-selectable{cursor:pointer}.terry-h3-subject-row.is-selectable:hover{background:rgba(255,255,255,.07)}.terry-h3-subject-source-button{margin:0!important;min-width:44px!important}
.terry-h3-command-menu{width:340px;max-height:380px;overflow:auto;padding:6px;border:1px solid rgba(255,255,255,.14);border-radius:9px;background:var(--comfy-menu-bg,#17191c);box-shadow:0 18px 48px rgba(0,0,0,.52)}
.terry-h3-command-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 6px 8px;border-bottom:1px solid rgba(255,255,255,.08)}.terry-h3-command-head-title{display:flex;align-items:center;gap:5px}.terry-h3-command-head span{font-size:9px;opacity:.48}.terry-h3-command-back{border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer}.terry-h3-command-item{display:grid;grid-template-columns:70px minmax(0,1fr);gap:7px;align-items:center;width:100%;padding:7px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer}.terry-h3-command-item.is-category{grid-template-columns:28px minmax(0,1fr) auto}.terry-h3-command-item.is-active{background:rgba(255,255,255,.09)}.terry-h3-command-category,.terry-h3-command-category-icon,.terry-h3-command-count{font-size:9px;opacity:.55}.terry-h3-command-text{min-width:0}.terry-h3-command-text b,.terry-h3-command-text small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.terry-h3-command-text b{font-size:11px}.terry-h3-command-text small{margin-top:2px;font-size:9px;opacity:.5}
`;
  document.head.append(style);
}

export function attachH3Menus({ node, editor, mode = "prompt", onChange = null }) {
  if (!node || !editor) return null;
  detachH3Menus(editor); installH3MenuStyles();
  const controller = { node, editor, mode, onChange, menu: null, menuType: null, commandState: null }; controllers.set(editor, controller);
  let composing = false;
  const currentController = () => controllers.get(editor) === controller;
  const triggerFromInput = (event) => {
    const type = String(event?.inputType || "");
    if (type && !["insertText", "insertFromComposition", "insertCompositionText", "insertReplacementText"].includes(type)) return null;
    const data = String(event?.data || "");
    if (!data) return null;
    const assetAt = Math.max(data.lastIndexOf("@"), data.lastIndexOf("＠"));
    const commandAt = Math.max(data.lastIndexOf("/"), data.lastIndexOf("／"));
    const last = Math.max(assetAt, commandAt);
    if (last < 0 || last !== data.length - 1) return null;
    return assetAt > commandAt ? "@" : "/";
  };
  const triggerFromKey = (event) => {
    const key = String(event?.key || "");
    if (key === "@" || key === "＠") return "@";
    if (key === "/" || key === "／") return "/";
    // Some IMEs report Process/Unidentified for Shift+2 rather than "@"
    // even though the browser will insert the character after keydown.
    if (event?.shiftKey && event?.code === "Digit2"
        && ["2", "Process", "Unidentified", ""].includes(key)) return "@";
    return null;
  };
  const openTypedTrigger = (trigger = null, allowQuery = false) => {
    if (!currentController() || composing || controller.menu) return false;
    const tryOpen = (symbol) => {
      const hit = caretRange(editor, symbol);
      if (!hit || (!allowQuery && hit.query)) return false;
      return symbol === "@" ? openAssetMenu(controller, hit) : openCommandMenu(controller, hit);
    };
    if (trigger === "@") return tryOpen("@");
    if (trigger === "/") return tryOpen("/");
    return tryOpen("@") || tryOpen("/");
  };
  const scheduleTypedTrigger = (trigger = null, allowQuery = false) => {
    // Some IMEs commit the DOM after compositionend/key events. A second,
    // short retry covers that ordering without intercepting native text input.
    setTimeout(() => openTypedTrigger(trigger, allowQuery), 0);
    setTimeout(() => openTypedTrigger(trigger, allowQuery), 40);
  };
  const lastTrigger = (text) => {
    const last = String(text || "").slice(-1);
    if (last === "@" || last === "＠") return "@";
    if (last === "/" || last === "／") return "/";
    return null;
  };
  const insertedText = (before, after) => {
    before = String(before || "");
    after = String(after || "");
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let beforeEnd = before.length, afterEnd = after.length;
    while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd--; afterEnd--;
    }
    return after.slice(prefix, afterEnd);
  };
  let suppressPasteMutations = false;
  const onPaste = () => {
    suppressPasteMutations = true;
    // MutationObserver runs before this timer, so only the paste transaction
    // is suppressed; normal typing immediately afterwards remains observable.
    setTimeout(() => { suppressPasteMutations = false; }, 0);
  };
  const onMutations = (records) => {
    if (!currentController() || composing || suppressPasteMutations || controller.menu) return;
    for (const record of records) {
      let trigger = null;
      if (record.type === "characterData") {
        trigger = lastTrigger(insertedText(record.oldValue, record.target?.textContent));
      } else if (record.type === "childList") {
        for (const added of record.addedNodes || []) {
          if (added?.nodeType === Node.TEXT_NODE) {
            trigger = lastTrigger(added.textContent);
            if (trigger) break;
          }
        }
      }
      if (trigger) {
        // This path works even if the browser/IME omitted beforeinput and
        // input events, as long as the trigger character reached the DOM.
        scheduleTypedTrigger(trigger, true);
        return;
      }
    }
  };
  const mutationObserver = typeof MutationObserver === "function"
    ? new MutationObserver(onMutations)
    : null;
  mutationObserver?.observe(editor, {
    subtree: true, childList: true, characterData: true, characterDataOldValue: true,
  });
  const onBeforeInput = (event) => {
    const trigger = triggerFromInput(event);
    if (trigger) scheduleTypedTrigger(trigger, true);
  };
  const onInput = (event) => {
    if (composing || event.isComposing) return;
    const type = String(event.inputType || "");
    const trigger = triggerFromInput(event);
    if (trigger) {
      scheduleTypedTrigger(trigger, true);
      return;
    }
    queueMicrotask(() => {
      if (!currentController() || composing) return;
      if (controller.menu) { refreshOpenMenu(controller); return; }
      // Some IMEs omit inputType. Only open when the caret itself is directly
      // after a bare trigger, so deletion/paste/undo won't summon the menu.
      if (!type || ["insertText", "insertFromComposition", "insertCompositionText", "insertReplacementText"].includes(type)) {
        openTypedTrigger();
      }
    });
  };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = (event) => {
    composing = false;
    const trigger = triggerFromInput(event);
    scheduleTypedTrigger(trigger, Boolean(trigger));
    setTimeout(() => {
      if (currentController() && controller.menu) refreshOpenMenu(controller);
    }, 0);
  };
  const onKeyDown = (event) => {
    const trigger = triggerFromKey(event);
    if (trigger) scheduleTypedTrigger(trigger, true);
    // Enter/Escape/arrow keys belong to the IME candidate list while composing.
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (handleCommandKey(controller, event)) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === "Escape" && controller.menu) { closeMenu(controller); event.preventDefault(); event.stopPropagation(); }
  };
  const onKeyUp = (event) => {
    const trigger = triggerFromKey(event);
    if (trigger) scheduleTypedTrigger(trigger, true);
  };
  const onTextInput = (event) => {
    const trigger = triggerFromInput(event);
    if (trigger) scheduleTypedTrigger(trigger, true);
  };
  const onPointer = (event) => event.stopPropagation();
  const onDocumentPointer = (event) => {
    const menu = controller.menu;
    if (!menu || menu.contains(event.target)) return;
    closeMenu(controller);
  };
  editor.addEventListener("beforeinput", onBeforeInput);
  editor.addEventListener("input", onInput);
  editor.addEventListener("textInput", onTextInput);
  editor.addEventListener("paste", onPaste);
  editor.addEventListener("compositionstart", onCompositionStart);
  editor.addEventListener("compositionend", onCompositionEnd);
  editor.addEventListener("keydown", onKeyDown);
  editor.addEventListener("keyup", onKeyUp);
  editor.addEventListener("pointerdown", onPointer);
  document.addEventListener("pointerdown", onDocumentPointer, true);
  controller.cleanup = () => {
    closeMenu(controller);
    mutationObserver?.disconnect?.();
    editor.removeEventListener("beforeinput", onBeforeInput);
    editor.removeEventListener("input", onInput);
    editor.removeEventListener("textInput", onTextInput);
    editor.removeEventListener("paste", onPaste);
    editor.removeEventListener("compositionstart", onCompositionStart);
    editor.removeEventListener("compositionend", onCompositionEnd);
    editor.removeEventListener("keydown", onKeyDown);
    editor.removeEventListener("keyup", onKeyUp);
    editor.removeEventListener("pointerdown", onPointer);
    document.removeEventListener("pointerdown", onDocumentPointer, true);
  };
  return controller;
}
export function detachH3Menus(editor) { const controller = controllers.get(editor); controller?.cleanup?.(); controllers.delete(editor); }
