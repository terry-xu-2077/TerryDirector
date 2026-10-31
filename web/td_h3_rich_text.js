// Vendored/adapted from TerryXu-nodes web/h3_rich_text.js @ 29f9399ecce093a7423e71d86fa85c3994b74530
// Preserve upstream H3 chip rendering, editable dialogue, numbering, and serialization.
import { app } from "/scripts/app.js";

const CARET = "\u200B";

export const H3_CAMERA_COMMANDS = [
  ["推进", "Push In", "镜头向主体推进", "The camera pushes in "],
  ["拉远", "Pull Out", "镜头向后拉远", "The camera pulls out "],
  ["左摇", "Pan Left", "镜头水平向左摇动", "The camera pans left "],
  ["右摇", "Pan Right", "镜头水平向右摇动", "The camera pans right "],
  ["左移", "Truck Left", "摄像机整体向左平移", "The camera trucks left "],
  ["右移", "Truck Right", "摄像机整体向右平移", "The camera trucks right "],
  ["上摇", "Tilt Up", "镜头向上俯仰摇动", "The camera tilts up "],
  ["下摇", "Tilt Down", "镜头向下俯仰摇动", "The camera tilts down "],
  ["升镜", "Pedestal Up", "摄像机整体向上升起", "The camera moves upward "],
  ["降镜", "Pedestal Down", "摄像机整体向下降低", "The camera moves downward "],
  ["环绕", "Arc Shot", "摄像机沿弧线环绕主体", "The camera moves in an arc around the subject "],
  ["跟拍", "Tracking Shot", "镜头跟随移动中的主体", "The camera follows the moving subject in a tracking shot "],
  ["固定镜头", "Static Shot", "摄像机保持固定不动", "The camera holds a static shot "],
  ["变焦推近", "Zoom In", "通过镜头变焦放大画面", "The camera zooms in "],
  ["变焦拉远", "Zoom Out", "通过镜头变焦缩小画面", "The camera zooms out "],
  ["第一人称视角", "POV", "使用角色的主观视角", "POV, "],
  ["顺时针旋转", "Roll Clockwise", "镜头沿光轴顺时针旋转", "The camera rolls clockwise "],
  ["逆时针旋转", "Roll Counterclockwise", "镜头沿光轴逆时针旋转", "The camera rolls counterclockwise "],
  ["轻微晃动", "Shake Slightly", "镜头产生轻微手持晃动", "The camera shakes slightly "],
  ["强烈晃动", "Shake Strongly", "镜头产生明显剧烈晃动", "The camera shakes strongly "],
];

const SECTION_LABELS = {
  subject_definitions: ["主体定义", "Subject Definitions"],
  summary: ["摘要", "Summary"],
  retention_analysis: ["保留关系分析", "Retention Analysis"],
  detailed_description: ["详细描述", "Detailed Description"],
  integrated_multimodal_description: ["综合多模态描述", "Integrated Multimodal Description"],
  overall_soundscape: ["整体声景", "Overall Soundscape"],
  non_diegetic_music: ["非剧情音乐", "Non-diegetic Music"],
};

const EXACT_LABELS = new Map([
  ["fully_preserved", ["完整保留", "Fully Preserved"]],
  ["partially_preserved", ["部分保留", "Partially Preserved"]],
  ["attribute_transfer", ["属性迁移", "Attribute Transfer"]],
  ["weak_reference", ["弱参考", "Weak Reference"]],
  ["fully_copy", ["完整复制", "Fully Copy"]],
  ["partially_copy", ["部分复制", "Partially Copy"]],
  ["reference", ["参考", "Reference"]],
  ["<scenetrans>", ["跨镜头连续", "Scene Transition"]],
  ["<cutoff>", ["结尾截断", "Cutoff"]],
  ["[reference generation]", ["参考生成", "Reference Generation"]],
  ["[keyframe completion]", ["关键帧补全", "Keyframe Completion"]],
  ["[video editing]", ["视频编辑", "Video Editing"]],
  ["[video continuation]", ["视频续写", "Video Continuation"]],
  ["[audio reuse]", ["音频复用", "Audio Reuse"]],
  ["[audio reference]", ["音频参考", "Audio Reference"]],
]);

const DIALOGUE_LANGUAGES = [
  "English", "Chinese", "Cantonese", "Japanese", "Korean", "Spanish", "French",
  "German", "Italian", "Portuguese", "Russian", "Arabic", "Hindi", "Thai",
  "Vietnamese", "Indonesian", "Turkish", "Polish", "Dutch", "Other",
];

const LANGUAGE_ZH = {
  English: "英语", Chinese: "中文", Cantonese: "粤语", Japanese: "日语", Korean: "韩语",
  Spanish: "西班牙语", French: "法语", German: "德语", Italian: "意大利语",
  Portuguese: "葡萄牙语", Russian: "俄语", Arabic: "阿拉伯语", Hindi: "印地语",
  Thai: "泰语", Vietnamese: "越南语", Indonesian: "印尼语", Turkish: "土耳其语",
  Polish: "波兰语", Dutch: "荷兰语", Other: "其他",
};

const BASE_TOKEN_PATTERN = /<d>\[[^\]]+\][\s\S]*?<\/d>|<(?:Subject|Picture|Video|Audio)\s+\d+>|\[Shot\s+\d+\]|\(S\d+\)|<scenetrans>|<cutoff>|\b(?:fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference)\b|\[\d{2}:\d{2}\]|^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):|\[(?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference)(?:\s*\+[^\]]+)?\]/gmi;
const CAMERA_TOKEN_PATTERN = H3_CAMERA_COMMANDS
  .map(([, , , raw]) => raw.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((left, right) => right.length - left.length)
  .join("|");
export const H3_TOKEN_PATTERN = new RegExp(
  `${BASE_TOKEN_PATTERN.source}|(?:${CAMERA_TOKEN_PATTERN})(?![\\w])`,
  BASE_TOKEN_PATTERN.flags,
);

function cameraCommand(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return H3_CAMERA_COMMANDS.find(([, , , phrase]) => phrase.trim().toLowerCase() === value) || null;
}

export function h3LocaleIsZh() {
  try {
    const value = app?.ui?.settings?.getSettingValue?.("Comfy.Locale");
    const fallback = document?.documentElement?.lang || navigator.language || "en";
    const locale = String(value || fallback).trim().toLowerCase().replaceAll("_", "-");
    return locale === "zh" || locale.startsWith("zh-");
  } catch {
    return String(navigator.language || "en").toLowerCase().startsWith("zh");
  }
}

function pickLabel(pair) {
  return pair?.[h3LocaleIsZh() ? 0 : 1] || "";
}

export function h3TokenType(raw) {
  const value = String(raw || "").trim();
  if (/^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):$/i.test(value)) return "section";
  if (/^<Subject\s+\d+>$/i.test(value)) return "subject";
  if (/^<Picture\s+\d+>$/i.test(value)) return "picture";
  if (/^<Video\s+\d+>$/i.test(value)) return "video";
  if (/^<Audio\s+\d+>$/i.test(value)) return "audio";
  if (/^\[Shot\s+\d+\]$/i.test(value)) return "shot";
  if (/^\(S\d+\)$/i.test(value)) return "speaker";
  if (/^<d>\[/i.test(value)) return "dialogue";
  if (/^(fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference)$/i.test(value)) return "retention";
  if (/^\[\d{2}:\d{2}\]$/.test(value)) return "time";
  if (/^<(scenetrans|cutoff)>$/i.test(value)) return "transition";
  if (/^\[(reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference)(\s*\+[^\]]+)?\]$/i.test(value)) return "task";
  if (cameraCommand(value)) return "camera";
  return "plain";
}

export function h3VisibleLabel(raw) {
  const value = String(raw || "").trim();
  const zh = h3LocaleIsZh();
  const section = value.match(/^([a-z_]+):$/i);
  if (section && SECTION_LABELS[section[1].toLowerCase()]) return pickLabel(SECTION_LABELS[section[1].toLowerCase()]);
  if (EXACT_LABELS.has(value)) return pickLabel(EXACT_LABELS.get(value));
  const camera = cameraCommand(value);
  if (camera) return zh ? camera[0] : camera[1];
  let m = value.match(/^<Subject\s+(\d+)>$/i);
  if (m) return zh ? `主体 ${m[1]}` : `Subject ${m[1]}`;
  m = value.match(/^<Picture\s+(\d+)>$/i);
  if (m) return zh ? `图片 ${m[1]}` : `Picture ${m[1]}`;
  m = value.match(/^<Video\s+(\d+)>$/i);
  if (m) return zh ? `视频 ${m[1]}` : `Video ${m[1]}`;
  m = value.match(/^<Audio\s+(\d+)>$/i);
  if (m) return zh ? `音频 ${m[1]}` : `Audio ${m[1]}`;
  m = value.match(/^\[Shot\s+(\d+)\]$/i);
  if (m) return zh ? `镜头 ${m[1]}` : `Shot ${m[1]}`;
  m = value.match(/^\(S(\d+)\)$/i);
  if (m) return zh ? `说话人 S${m[1]}` : `Speaker S${m[1]}`;
  m = value.match(/^\[(\d{2}:\d{2})\]$/);
  if (m) return zh ? `时间 ${m[1]}` : `Time ${m[1]}`;
  return value;
}

function appendText(container, text) {
  String(text || "").split("\n").forEach((part, index) => {
    if (index) container.append(document.createElement("br"));
    if (part) container.append(document.createTextNode(part));
  });
}

function baseChip(raw, type, options = {}) {
  const chip = document.createElement("span");
  chip.className = `terry-h3-chip terry-h3-type-${type}${options.extraChipClass ? ` ${options.extraChipClass}` : ""}`;
  chip.contentEditable = "false";
  chip.dataset.raw = raw;
  return chip;
}

function dialogueChip(raw, onChange, options = {}) {
  const match = String(raw || "").match(/^<d>\[([^\]]+)\]\s*([\s\S]*?)<\/d>$/i);
  const chip = baseChip(raw, "dialogue", options);
  chip.classList.add("terry-h3-dialogue", "terry-h3-dialogue-editor");
  if (!match) { chip.textContent = raw; return chip; }

  const select = document.createElement("select");
  select.className = "terry-h3-dialogue-language";
  select.setAttribute("aria-label", h3LocaleIsZh() ? "对白语言" : "Dialogue language");
  const current = match[1] || "English";
  const languages = DIALOGUE_LANGUAGES.includes(current) ? DIALOGUE_LANGUAGES : [current, ...DIALOGUE_LANGUAGES];
  for (const language of languages) {
    const option = document.createElement("option");
    option.value = language;
    option.textContent = h3LocaleIsZh() ? (LANGUAGE_ZH[language] || language) : language;
    if (language === current) option.selected = true;
    select.append(option);
  }

  const body = document.createElement("span");
  body.className = "terry-h3-dialogue-text";
  body.contentEditable = "true";
  body.spellcheck = false;
  body.dataset.placeholder = h3LocaleIsZh() ? "输入对白…" : "Dialogue…";
  body.textContent = match[2] || "";

  const update = () => {
    const value = String(body.innerText ?? body.textContent ?? "").replace(/\r?\n/g, " ");
    chip.dataset.raw = `<d>[${select.value || "English"}] ${value}</d>`;
    onChange?.();
  };
  select.addEventListener("change", update);
  select.addEventListener("pointerdown", (event) => event.stopPropagation());
  select.addEventListener("keydown", (event) => event.stopPropagation());
  body.addEventListener("input", update);
  body.addEventListener("pointerdown", (event) => event.stopPropagation());
  body.addEventListener("keydown", (event) => { event.stopPropagation(); if (event.key === "Enter") event.preventDefault(); });
  body.addEventListener("paste", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const value = String(event.clipboardData?.getData("text/plain") || "")
      .replace(/\r\n?/g, "\n")
      .replaceAll("\n", " ");
    if (!value) return;

    const selection = window.getSelection?.();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && body.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      const text = document.createTextNode(value);
      range.insertNode(text);
      range.setStartAfter(text);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      body.textContent += value;
    }
    update();
  });
  chip.append(select, body);
  return chip;
}

function mediaChip(raw, type, resolveMedia, options = {}) {
  const match = raw.match(/^<(Picture|Video|Audio)\s+(\d+)>$/i);
  const index = Number(match?.[2]) || 1;
  const info = resolveMedia?.(type, index) || null;
  const chip = baseChip(raw, type, options);
  chip.classList.add("terry-h3-media-chip");
  if (info?.preview && type !== "audio") {
    const image = document.createElement("img");
    image.src = info.preview;
    image.alt = "";
    image.draggable = false;
    chip.append(image);
  } else {
    const icon = document.createElement("span");
    icon.className = "terry-h3-media-icon";
    icon.textContent = type === "audio" ? "♪" : type === "video" ? "▶" : "▧";
    chip.append(icon);
  }
  const label = document.createElement("span");
  label.textContent = h3VisibleLabel(raw);
  chip.append(label);
  chip.title = info?.source || raw;
  return chip;
}

export function createH3TokenNode(raw, options = {}) {
  const type = h3TokenType(raw);
  if (type === "plain") return document.createTextNode(raw);
  if (type === "dialogue") return dialogueChip(raw, options.onChange, options);
  if (["picture", "video", "audio"].includes(type)) return mediaChip(raw, type, options.resolveMedia, options);
  const chip = baseChip(raw, type, options);
  const label = document.createElement("span");
  label.textContent = h3VisibleLabel(raw);
  chip.append(label);
  if (type === "shot") chip.title = h3LocaleIsZh() ? "点击切换镜头序号" : "Click to change shot number";
  if (type === "speaker") chip.title = h3LocaleIsZh() ? "点击切换说话人序号" : "Click to change speaker number";
  if (type === "time") chip.title = h3LocaleIsZh() ? "点击编辑时间戳" : "Click to edit timestamp";
  if (type === "camera") chip.title = h3LocaleIsZh() ? "点击切换镜头运动" : "Click to change camera movement";
  return chip;
}

function freshTokenRegex() {
  return new RegExp(H3_TOKEN_PATTERN.source, H3_TOKEN_PATTERN.flags);
}

export function renderH3RichText(editor, raw, options = {}) {
  if (!editor) return;
  editor.replaceChildren();
  const source = String(raw || "");
  const regex = freshTokenRegex();
  let last = 0;
  let match;
  while ((match = regex.exec(source))) {
    appendText(editor, source.slice(last, match.index));
    editor.append(createH3TokenNode(match[0], options));
    last = regex.lastIndex;
  }
  appendText(editor, source.slice(last));
}

export function renderH3RawText(editor, raw) {
  if (!editor) return;
  editor.replaceChildren();
  appendText(editor, raw);
}

export function serializeH3RichText(editor) {
  let out = "";
  const blockTags = new Set(["DIV", "P", "LI"]);
  const walk = (root) => {
    let previousWasBlock = false;
    for (const child of root?.childNodes || []) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += String(child.nodeValue || "").replaceAll(CARET, "");
        previousWasBlock = false;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.dataset?.raw != null) {
        out += child.dataset.raw;
        previousWasBlock = false;
        continue;
      }
      if (child.tagName === "BR") {
        out += "\n";
        previousWasBlock = false;
        continue;
      }

      const block = blockTags.has(child.tagName);
      if (block && (previousWasBlock || (out && !out.endsWith("\n")))) out += "\n";

      const children = [...(child.childNodes || [])];
      const placeholder = block && children.length === 1
        && children[0]?.nodeType === Node.ELEMENT_NODE
        && children[0]?.tagName === "BR";
      if (!placeholder) walk(child);
      previousWasBlock = block;
    }
  };
  walk(editor);
  return out.replace(/\r\n?/g, "\n");
}

export function insertH3RichTextAtSelection(editor, text, options = {}) {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!editor?.contains?.(range.commonAncestorContainer)) return false;
  range.deleteContents();
  const temp = document.createElement("div");
  renderH3RichText(temp, text, options);
  const fragment = document.createDocumentFragment();
  while (temp.firstChild) fragment.append(temp.firstChild);
  const marker = document.createTextNode(CARET);
  fragment.append(marker);
  range.insertNode(fragment);
  const next = document.createRange();
  next.setStart(marker, marker.textContent.length);
  next.collapse(true);
  selection.removeAllRanges();
  selection.addRange(next);
  return true;
}

function maxNumber(source, pattern) {
  let max = 0;
  for (const match of String(source || "").matchAll(pattern)) max = Math.max(max, Number(match[1]) || 0);
  return Math.max(1, max);
}

function closePicker(state) {
  state.menu?.remove?.();
  state.menu = null;
  state.abort?.abort?.();
  state.abort = null;
}

function openNumberPicker(editor, chip, type, options, state) {
  closePicker(state);
  const current = Number(String(chip.dataset.raw || "").match(/\d+/)?.[0] || 1);
  const source = options.getSourceText?.() || serializeH3RichText(editor);
  const max = type === "speaker"
    ? maxNumber(source, /\(S(\d+)\)/gi)
    : maxNumber(source, /\[Shot\s+(\d+)\]/gi);
  const menu = document.createElement("div");
  menu.className = "terry-h3-number-picker";
  const head = document.createElement("div");
  head.className = "terry-h3-number-picker-head";
  head.textContent = type === "speaker"
    ? (h3LocaleIsZh() ? "切换说话人序号" : "Change speaker number")
    : (h3LocaleIsZh() ? "切换镜头序号" : "Change shot number");
  menu.append(head);
  const grid = document.createElement("div");
  grid.className = "terry-h3-number-picker-grid";
  const applyNumber = (number) => {
    number = Math.max(1, Math.floor(Number(number) || 1));
    chip.dataset.raw = type === "speaker" ? `(S${number})` : `[Shot ${number}]`;
    const label = [...chip.children].reverse().find((item) => item.tagName === "SPAN") || chip;
    label.textContent = h3VisibleLabel(chip.dataset.raw);
    options.onChange?.();
    closePicker(state);
  };
  for (let index = 1; index <= Math.max(max + 1, current, 6); index++) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = type === "speaker" ? `S${index}` : String(index);
    if (index === current) button.classList.add("is-current");
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); applyNumber(index); });
    grid.append(button);
  }
  menu.append(grid);
  document.body.append(menu);
  state.menu = menu;
  const rect = chip.getBoundingClientRect();
  const width = 230;
  let left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + 170 > innerHeight - 8) top = Math.max(8, rect.top - 176);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  const abort = new AbortController();
  state.abort = abort;
  setTimeout(() => document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target) && !chip.contains(event.target)) closePicker(state);
  }, { capture: true, signal: abort.signal }), 0);
}

function openTimePicker(editor, chip, options, state) {
  closePicker(state);
  const current = String(chip.dataset.raw || "[00:00]").match(/^\[(\d{2}):(\d{2})\]$/);
  const menu = document.createElement("div");
  menu.className = "terry-h3-number-picker terry-h3-time-picker";

  const head = document.createElement("div");
  head.className = "terry-h3-number-picker-head";
  head.textContent = h3LocaleIsZh() ? "编辑时间戳" : "Edit timestamp";
  menu.append(head);

  const row = document.createElement("div");
  row.className = "terry-h3-time-picker-row";
  const minutes = document.createElement("input");
  const seconds = document.createElement("input");
  for (const field of [minutes, seconds]) {
    field.type = "number";
    field.min = "0";
    field.max = field === seconds ? "59" : "99";
    field.step = "1";
    field.inputMode = "numeric";
  }
  minutes.value = String(Number(current?.[1] || 0));
  seconds.value = String(Number(current?.[2] || 0));
  const colon = document.createElement("span");
  colon.textContent = ":";
  row.append(minutes, colon, seconds);

  const apply = () => {
    const mm = Math.max(0, Math.min(99, Math.floor(Number(minutes.value) || 0)));
    const ss = Math.max(0, Math.min(59, Math.floor(Number(seconds.value) || 0)));
    chip.dataset.raw = `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}]`;
    const label = [...chip.children].reverse().find((item) => item.tagName === "SPAN") || chip;
    label.textContent = h3VisibleLabel(chip.dataset.raw);
    options.onChange?.();
    editor.dispatchEvent?.(new Event("terrychange", { bubbles: true }));
    closePicker(state);
  };

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "terry-h3-time-picker-confirm";
  confirm.textContent = h3LocaleIsZh() ? "确定" : "Apply";
  confirm.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); apply(); });
  const onKey = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); apply(); }
    else if (event.key === "Escape") { event.preventDefault(); closePicker(state); }
  };
  minutes.addEventListener("keydown", onKey);
  seconds.addEventListener("keydown", onKey);
  row.append(confirm);
  menu.append(row);
  document.body.append(menu);
  state.menu = menu;

  const rect = chip.getBoundingClientRect();
  const width = 230;
  const left = Math.max(8, Math.min(rect.left, (window.innerWidth || 1280) - width - 8));
  let top = rect.bottom + 6;
  if (top + 100 > (window.innerHeight || 720) - 8) top = Math.max(8, rect.top - 106);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  const abort = new AbortController();
  state.abort = abort;
  setTimeout(() => document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target) && !chip.contains(event.target)) closePicker(state);
  }, { capture: true, signal: abort.signal }), 0);
  setTimeout(() => { minutes.focus(); minutes.select(); }, 0);
}

function openCameraPicker(editor, chip, options, state) {
  closePicker(state);
  const menu = document.createElement("div");
  menu.className = "terry-h3-number-picker terry-h3-camera-picker";
  const head = document.createElement("div");
  head.className = "terry-h3-number-picker-head";
  head.textContent = h3LocaleIsZh() ? "切换镜头运动" : "Change camera movement";
  menu.append(head);

  const list = document.createElement("div");
  list.className = "terry-h3-camera-picker-list";
  const current = cameraCommand(chip.dataset.raw);
  for (const [chinese, english, detail, raw] of H3_CAMERA_COMMANDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = h3LocaleIsZh() ? detail : raw.trim();
    if (current?.[3] === raw) button.classList.add("is-current");
    const label = document.createElement("span");
    label.textContent = h3LocaleIsZh() ? chinese : english;
    const secondary = document.createElement("small");
    secondary.textContent = h3LocaleIsZh() ? english : "";
    button.append(label, secondary);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const trailing = String(chip.dataset.raw || "").match(/\s+$/)?.[0] || "";
      chip.dataset.raw = `${raw.trimEnd()}${trailing}`;
      const text = [...chip.children].reverse().find((item) => item.tagName === "SPAN") || chip;
      text.textContent = h3VisibleLabel(chip.dataset.raw);
      options.onChange?.();
      editor.dispatchEvent?.(new Event("terrychange", { bubbles: true }));
      closePicker(state);
    });
    list.append(button);
  }
  menu.append(list);
  document.body.append(menu);
  state.menu = menu;

  const rect = chip.getBoundingClientRect();
  const width = 260;
  const availableWidth = window.innerWidth || globalThis.innerWidth || 1280;
  const availableHeight = window.innerHeight || globalThis.innerHeight || 720;
  const height = Math.min(380, Number(menu.offsetHeight) || 380);
  const left = Math.max(8, Math.min(rect.left, availableWidth - width - 8));
  const top = rect.bottom + height + 6 > availableHeight - 8
    ? Math.max(8, rect.top - height - 6)
    : rect.bottom + 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  const abort = new AbortController();
  state.abort = abort;
  setTimeout(() => document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target) && !chip.contains(event.target)) closePicker(state);
  }, { capture: true, signal: abort.signal }), 0);
}

function boundaryTag(node, backward) {
  if (!node) return undefined;
  if (node.nodeType === Node.TEXT_NODE) {
    return String(node.nodeValue ?? node.textContent ?? "").replaceAll(CARET, "") ? null : undefined;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === "BR") return null;
  if (node.dataset?.raw != null) return node;
  const children = [...(node.childNodes || [])];
  if (backward) children.reverse();
  for (const child of children) {
    const result = boundaryTag(child, backward);
    if (result !== undefined) return result;
  }
  return null;
}

function adjacentTag(editor, range, backward) {
  let current = range.startContainer;
  const offset = Number(range.startOffset) || 0;
  if (!current || !editor.contains(current)) return null;

  if (current.nodeType === Node.TEXT_NODE) {
    const text = String(current.nodeValue ?? current.textContent ?? "");
    const nearby = backward ? text.slice(0, offset) : text.slice(offset);
    if (nearby.replaceAll(CARET, "")) return null;
  } else {
    const children = [...(current.childNodes || [])];
    const index = backward ? offset - 1 : offset;
    for (let at = index; at >= 0 && at < children.length; at += backward ? -1 : 1) {
      const result = boundaryTag(children[at], backward);
      if (result !== undefined) return result;
    }
  }

  while (current && current !== editor) {
    let sibling = backward ? current.previousSibling : current.nextSibling;
    while (sibling) {
      const result = boundaryTag(sibling, backward);
      if (result !== undefined) return result;
      sibling = backward ? sibling.previousSibling : sibling.nextSibling;
    }
    current = current.parentNode || current.parentElement;
    if (current !== editor && /^(DIV|P|LI)$/.test(String(current?.tagName || ""))) return null;
  }
  return null;
}

function deleteAdjacentTag(editor, event, options) {
  if (!new Set(["Backspace", "Delete"]).has(event.key)
    || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  const selection = window.getSelection?.();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (range.collapsed === false || selection.isCollapsed === false) return;
  const tag = adjacentTag(editor, range, event.key === "Backspace");
  if (!tag) return;

  const parent = tag.parentNode || tag.parentElement;
  if (!parent) return;
  const offset = [...(parent.childNodes || [])].indexOf(tag);
  event.preventDefault();
  event.stopPropagation();
  tag.remove();

  const caret = document.createRange();
  caret.setStart(parent, Math.max(0, offset));
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  options.onChange?.();
  editor.dispatchEvent?.(new Event("terrychange", { bubbles: true }));
}

export function bindH3TagInteractions(editor, options = {}) {
  if (!editor || editor.__terryH3RichTextInteractions) return;
  editor.__terryH3RichTextInteractions = true;
  const state = { menu: null, abort: null };
  editor.addEventListener("pointerdown", (event) => {
    const chip = event.target?.closest?.(".terry-h3-chip");
    if (!chip || !editor.contains(chip)) return;
    const type = h3TokenType(chip.dataset.raw);
    if (type !== "shot" && type !== "speaker" && type !== "time" && type !== "camera") return;
    event.preventDefault();
    event.stopPropagation();
    if (type === "camera") openCameraPicker(editor, chip, options, state);
    else if (type === "time") openTimePicker(editor, chip, options, state);
    else openNumberPicker(editor, chip, type, options, state);
  });
  editor.addEventListener("keydown", (event) => deleteAdjacentTag(editor, event, options));
  editor.addEventListener("copy", (event) => {
    const selection = window.getSelection?.();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    const fragment = range.cloneContents();
    const text = serializeH3RichText(fragment);
    if (!text) return;

    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
  });
}

export function installH3RichTextStyles() {
  if (document.getElementById("terry-h3-rich-text-style")) return;
  const style = document.createElement("style");
  style.id = "terry-h3-rich-text-style";
  style.textContent = `
.terry-h3-chip{display:inline-flex;align-items:center;gap:4px;margin:1px 2px;padding:1px 5px;border-radius:4px;border:1px solid transparent;background:rgba(255,255,255,.08);font-size:10px;white-space:nowrap;vertical-align:middle;transition:background .12s,border-color .12s,color .12s,box-shadow .12s}
.terry-h3-chip img{width:24px;height:24px;object-fit:cover;border-radius:3px}
.terry-h3-type-section{display:inline!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;color:rgba(218,218,218,.76)!important;font-weight:700!important;font-size:13px!important;letter-spacing:.1px!important}
.terry-h3-type-subject{background:rgba(180,140,255,.13)!important;color:rgb(220,202,255)!important;box-shadow:inset 0 0 0 1px rgba(180,140,255,.25)!important}
.terry-h3-type-picture{background:rgba(0,210,180,.12)!important;color:rgb(184,255,242)!important;box-shadow:inset 0 0 0 1px rgba(0,210,180,.24)!important}
.terry-h3-type-video{background:rgba(76,170,255,.13)!important;color:rgb(194,226,255)!important;box-shadow:inset 0 0 0 1px rgba(76,170,255,.25)!important}
.terry-h3-type-audio{background:rgba(255,174,70,.12)!important;color:rgb(255,224,183)!important;box-shadow:inset 0 0 0 1px rgba(255,174,70,.24)!important}
.terry-h3-type-shot{background:rgba(255,215,75,.13)!important;color:rgb(255,236,166)!important;box-shadow:inset 0 0 0 1px rgba(255,215,75,.25)!important;cursor:pointer!important}
.terry-h3-type-speaker{background:rgba(255,120,160,.12)!important;color:rgb(255,203,219)!important;box-shadow:inset 0 0 0 1px rgba(255,120,160,.24)!important;cursor:pointer!important}
.terry-h3-type-camera{background:rgba(102,164,255,.13)!important;color:rgb(185,217,255)!important;box-shadow:inset 0 0 0 1px rgba(102,164,255,.25)!important;cursor:pointer!important}
.terry-h3-type-dialogue{background:rgba(0,226,187,.13)!important;color:rgb(190,255,244)!important;box-shadow:inset 0 0 0 1px rgba(0,226,187,.22)!important}
.terry-h3-type-retention{background:rgba(145,155,175,.12)!important;color:rgb(220,225,235)!important;box-shadow:inset 0 0 0 1px rgba(170,180,200,.2)!important}
.terry-h3-type-time{background:rgba(110,190,255,.1)!important;color:rgb(196,229,255)!important;box-shadow:inset 0 0 0 1px rgba(110,190,255,.2)!important;cursor:pointer!important}
.terry-h3-type-transition{background:rgba(255,145,95,.11)!important;color:rgb(255,213,191)!important;box-shadow:inset 0 0 0 1px rgba(255,145,95,.22)!important}
.terry-h3-type-task{background:rgba(128,205,125,.11)!important;color:rgb(207,245,205)!important;box-shadow:inset 0 0 0 1px rgba(128,205,125,.22)!important}
.terry-h3-dialogue-editor{white-space:normal!important}.terry-h3-dialogue-language{height:22px;min-width:66px;max-width:92px;padding:0 4px;border:1px solid rgba(255,255,255,.12)!important;border-radius:4px;outline:none;background:#24272d!important;color:#d8dde6!important;color-scheme:dark;font:10px/1 system-ui,sans-serif;cursor:pointer}.terry-h3-dialogue-language option{color:#d8dde6!important;background:#24272d!important}.terry-h3-dialogue-text{outline:none;min-width:72px;max-width:360px;white-space:normal}
.terry-h3-number-picker{position:fixed;z-index:10140;width:230px;padding:7px;border:1px solid rgba(255,255,255,.15);border-radius:9px;background:var(--comfy-menu-bg,#202225);box-shadow:0 16px 38px rgba(0,0,0,.48);color:var(--input-text,#ddd)}
.terry-h3-number-picker-head{padding:3px 4px 7px;font:600 11px/1.2 system-ui,sans-serif;opacity:.75}.terry-h3-number-picker-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}.terry-h3-number-picker-grid button{height:28px;border:0;border-radius:5px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer}.terry-h3-number-picker-grid button:hover,.terry-h3-number-picker-grid button.is-current{background:rgba(255,215,75,.2);color:rgb(255,236,166)}
.terry-h3-time-picker-row{display:flex;align-items:center;gap:6px}.terry-h3-time-picker-row input{width:58px;height:28px;box-sizing:border-box;border:1px solid rgba(255,255,255,.14);border-radius:5px;background:rgba(255,255,255,.06);color:inherit;text-align:center;outline:none}.terry-h3-time-picker-row input:focus{border-color:rgba(110,190,255,.6)}.terry-h3-time-picker-row>span{font-weight:700;opacity:.7}.terry-h3-time-picker-confirm{height:28px;padding:0 10px;border:0;border-radius:5px;background:rgba(110,190,255,.18);color:inherit;cursor:pointer}.terry-h3-time-picker-confirm:hover{background:rgba(110,190,255,.28)}
.terry-h3-camera-picker{width:260px}.terry-h3-camera-picker-list{display:flex;flex-direction:column;gap:3px;max-height:330px;overflow-y:auto}.terry-h3-camera-picker-list button{display:flex;align-items:center;justify-content:space-between;min-height:28px;padding:4px 7px;border:0;border-radius:5px;background:rgba(255,255,255,.05);color:inherit;font:11px/1.2 system-ui,sans-serif;cursor:pointer}.terry-h3-camera-picker-list button small{font-size:10px;opacity:.56}.terry-h3-camera-picker-list button:hover,.terry-h3-camera-picker-list button.is-current{background:rgba(102,164,255,.2);color:rgb(185,217,255)}
`;
  document.head.append(style);
}
