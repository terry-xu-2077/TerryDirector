const BATCH_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(批次\s*\d+.*?)(?:\*\*|__)?\s*$/gm;
const MEDIA_EXTENSIONS = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".svg"],
  audio: [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"],
  video: [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"],
};
const MEDIA_TYPE_NAMES = { picture: "image", audio: "audio", video: "video" };

function mediaKind(name) {
  const ext = (String(name || "").match(/\.[^./\\]+$/) || [])[0]?.toLowerCase();
  return Object.keys(MEDIA_EXTENSIONS).find(kind => MEDIA_EXTENSIONS[kind].includes(ext)) || null;
}

// Only [全局参考] has a special grammar. The rest of each batch remains untouched.
function parseGlobalReferences(body) {
  const lines = String(body || "").split(/\r?\n/);
  const references = [];
  const promptEntries = [];
  const parseErrors = [];
  const parseWarnings = [];
  const mediaFilePattern = /^(.+?\.(?:png|jpe?g|webp|bmp|gif|tif|tiff|svg|mp4|mov|mkv|webm|avi|m4v|wav|mp3|flac|ogg|m4a|aac|opus))\s*(?:[：:]|$)/i;
  let insideReferences = false;
  let activePrompt = null;

  for (const line of lines) {
    if (/^\s*\[全局参考\]\s*$/.test(line)) {
      insideReferences = true;
      activePrompt = null;
      continue;
    }
    if (insideReferences && /^\s*\[[^\]]+\]\s*$/.test(line)) {
      insideReferences = false;
      activePrompt = null;
      continue;
    }
    if (!insideReferences) continue;

    const value = line.trim().replace(/^(?:[-*+•]\s+|\d+[.)、]\s*)/, "");
    if (!value) {
      if (activePrompt) activePrompt.parts.push("");
      continue;
    }

    const tag = value.match(/^<\s*(Picture|Audio|Video|Prompt)\s+([^>]+?)\s*>\s*[:：]\s*(.*)$/i);
    if (tag) {
      const type = tag[1].toLowerCase();
      const name = tag[2].trim();
      const content = tag[3] || "";
      activePrompt = null;
      if (!name) {
        parseErrors.push("全局参考标签缺少名称：" + value);
        continue;
      }
      if (type === "prompt") {
        activePrompt = { name, type: "image", source: "tag", parts: [content] };
        promptEntries.push(activePrompt);
      } else {
        const kind = MEDIA_TYPE_NAMES[type];
        references.push({ name, displayName: name, kind, description: content.trim() });
      }
      continue;
    }

    if (/^<\s*(?:Picture|Audio|Video|Prompt)\b/i.test(value)) {
      activePrompt = null;
      parseErrors.push("全局参考标签格式无法识别：" + value);
      continue;
    }

    const oldGenerated = activePrompt?.source === "tag"
      ? null
      : value.match(/^待生成资产\s*[｜|:：]\s*(.*)$/);
    if (oldGenerated) {
      const payload = oldGenerated[1].trim();
      const split = payload.match(/^(.*?)\s+生图提示词\s*[:：]\s*(.*)$/);
      activePrompt = {
        name: (split ? split[1] : payload) || "未命名资产",
        type: "image",
        parts: [split ? split[2] : ""],
      };
      promptEntries.push(activePrompt);
      continue;
    }

    const legacyMedia = activePrompt?.source === "tag"
      ? null
      : value.match(mediaFilePattern);
    if (legacyMedia) {
      activePrompt = null;
      const name = legacyMedia[1].trim();
      const kind = mediaKind(name);
      if (kind) {
        references.push({
          name,
          kind,
          description: value.slice(name.length).replace(/^[：:]\s*/, "").trim(),
        });
      }
      continue;
    }

    if (activePrompt) activePrompt.parts.push(line.trimEnd());
  }

  const generatedAssets = promptEntries.map(entry => {
    const prompt = entry.parts.join("\n").trim();
    const pairedReference = references.find(ref => ref.name === entry.name);
    if (!prompt) parseWarnings.push("待生成资产「" + entry.name + "」缺少提示词内容。");
    return {
      type: pairedReference?.kind || entry.type || "image",
      name: entry.name,
      prompt,
    };
  });

  return {
    references,
    generatedAssets,
    parseErrors,
    parseWarnings,
    unparsedGeneratedAssets: [],
  };
}

// Document-level [待生成资产] prompts must be kept out of the video prompt.
function parseDocumentGeneratedAssets(preamble) {
  const lines = String(preamble || "").split("\n");
  const cleanLines = [], generatedAssets = [], parseWarnings = [], parseErrors = [];
  let inSection = false, activePrompt = null;
  const finishPrompt = () => {
    if (!activePrompt) return;
    const prompt = activePrompt.parts.join("\n").trim();
    if (!prompt) parseWarnings.push("待生成资产「" + activePrompt.name + "」缺少提示词内容。");
    generatedAssets.push({ type: "image", name: activePrompt.name, prompt });
    activePrompt = null;
  };
  for (const line of lines) {
    const value = line.trim();
    if (!inSection) {
      if (/^\s*(?:#{1,6}\s*)?\[待生成资产\]\s*$/.test(line)) inSection = true;
      else cleanLines.push(line);
      continue;
    }
    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(value) ||
        /^#{1,6}\s+/.test(value) ||
        /^\[[^\]]+\]$/.test(value)) {
      finishPrompt();
      inSection = false;
      cleanLines.push(line);
      continue;
    }
    const match = value.match(/^<\s*Prompt\s+([^>]+?)\s*>\s*[:：]\s*(.*)$/i);
    if (match) {
      finishPrompt();
      const name = match[1].trim();
      if (!name) parseErrors.push("待生成资产标签缺少名称：" + value);
      else activePrompt = { name, parts: [match[2] || ""] };
      continue;
    }
    if (/^<\s*Prompt\b/i.test(value)) {
      finishPrompt();
      parseErrors.push("待生成资产标签格式无法识别：" + value);
      continue;
    }
    if (activePrompt) activePrompt.parts.push(line.trimEnd());
    else if (value) parseWarnings.push("待生成资产区域含未归属的文字：" + value);
  }
  finishPrompt();
  return { preamble: cleanLines.join("\n").trim(), generatedAssets, parseWarnings, parseErrors };
}

function extractGlobalRules(text) {
  const lines = String(text || "").split("\n");
  const firstBatch = lines.findIndex(line =>
    /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?批次\s*\d+/.test(line)
  );
  const limit = firstBatch < 0 ? lines.length : firstBatch;
  const start = lines.findIndex((line, index) =>
    index < limit && /^(?:#\s+)?全局规则\s*$/.test(line.trim())
  );
  if (start < 0) return null;
  return lines.slice(start + 1, limit).join("\n").trim();
}

function legacyPreamble(text, firstBatchIndex) {
  return String(text || "").slice(0, firstBatchIndex)
    .replace(/^\s*#\s*[^\n]*\n?/, "").trim();
}

export function parsePreviewBatches(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n");
  const headings = [...text.matchAll(BATCH_HEADING)];
  if (!headings.length) {
    return {
      preamble: "",
      batches: [],
      error: "未识别到批次标题。请使用“批次01｜名称”单独占一行。",
    };
  }

  const globalRules = extractGlobalRules(text);
  const documentAssets = parseDocumentGeneratedAssets(legacyPreamble(text, headings[0].index));
  const preamble = globalRules === null
    ? documentAssets.preamble
    : parseDocumentGeneratedAssets(globalRules).preamble;

  const batches = headings.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const body = text.slice(start, end).trim();
    const heading = match[1].trim();
    const durationMatch = heading.match(/[（(]?\s*建议\s*(\d+)\s*秒\s*[）)]?\s*$/);
    const name = durationMatch ? heading.slice(0, durationMatch.index).trim() : heading;
    const parsed = parseGlobalReferences(body);

    return {
      name,
      heading,
      body,
      sourceBody: body,
      duration_seconds: durationMatch
        ? Math.max(4, Math.min(20, Number(durationMatch[1])))
        : 15,
      references: parsed.references,
      generatedAssets: parsed.generatedAssets,
      parseErrors: parsed.parseErrors,
      parseWarnings: parsed.parseWarnings,
      unparsedGeneratedAssets: parsed.unparsedGeneratedAssets,
    };
  }).filter(batch => batch.body.length > 0);

  return {
    preamble,
    generatedAssets: documentAssets.generatedAssets,
    parseWarnings: documentAssets.parseWarnings,
    parseErrors: documentAssets.parseErrors,
    batches,
    error: batches.length ? "" : "已识别标题，但没有找到包含正文的批次",
  };
}
