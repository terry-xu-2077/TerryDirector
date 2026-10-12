const BRAND_MARK_URL = "/terrydirector/static/assets/mark.svg";

/**
 * A practical output check for TerryDirector's always-streamed LoopEnd.
 * The generated MP4 size cannot be inferred from duration or resolution;
 * this checks the space needed for lossless per-segment .pt cache instead.
 */

// The Base cache stores float32 RGB frames plus (usually) 32k stereo audio.
// 25% overhead covers temporary writes and small PCM/container differences.
// This is advisory, not a guaranteed upper bound for arbitrary H3 sources.
export function estimateLoopTempSpaceBytes(frames, width, height, fps = 24) {
  if (![frames, width, height, fps].every(Number.isFinite) ||
      !Number.isSafeInteger(frames) || !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      frames <= 0 || width <= 0 || height <= 0 || fps <= 0) return null;
  const rgb = frames * width * height * 3 * 4;
  const audio = Math.ceil(frames / fps * 32000) * 2 * 4;
  const bytes = Math.ceil((rgb + audio) * 1.25);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function loopDiskHeadroom(need, free) {
  if (!Number.isFinite(need) || need <= 0 ||
      !Number.isFinite(free) || free < 0) return "unknown";
  if (free < need) return "critical";
  const reserve = Math.max(512 * 1024 * 1024, need * 0.2);
  return free < need + reserve ? "warning" : "ok";
}

export function formatLoopDiskSpace(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "无法估算";
  if (bytes < 100000000) return Math.round(bytes / 1e6) + " MB";
  return (bytes / 1e9).toFixed(1) + " GB";
}

function plainText(value) {
  return String(value ?? "").replace(/[<>&"'`]/g, function(c) {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;",
      '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c];
  });
}

function row(label, value, extra) {
  return '<div class="td-output-check-row"' + (extra || "") + '>' +
    '<span>' + plainText(label) + '</span><strong>' +
    plainText(value) + '</strong></div>';
}

function brandMark() {
  return '<img class="td-mini-brand" src="' + BRAND_MARK_URL +
    '" alt="" aria-hidden="true">';
}

/** Return node card data, no DOM dependencies or network calls. */
export function createLoopOutputCheckCard(estimate, diskState = {}) {
  const connected = estimate && estimate.state !== "disconnected";
  if (!connected) return {
    className: "td-output-memory-card is-loop-check is-idle",
    html: '<div class="td-output-memory-title">' + brandMark() +
      '<strong>视频输出检查</strong></div>' +
      '<div class="td-output-check-help">连接循环信息和生成节点后显示输出检查。</div>',
    status: "disconnected",
  };

  const frames = Number(estimate.frames) || 0;
  const seconds = frames / 24;
  const count = Number(estimate.activeClips) || 0;
  const ready = estimate.state === "ready";
  const budget = ready
    ? estimateLoopTempSpaceBytes(frames, Number(estimate.width), Number(estimate.height))
    : null;
  const disk = diskState.info || null;
  const status = disk && budget != null
    ? loopDiskHeadroom(budget, disk.freeBytes)
    : "unknown";

  const resolutionText = ready
    ? estimate.width + "×" + estimate.height +
      (estimate.resolutionLabel ? " · " + estimate.resolutionLabel : "")
    : "分辨率待确定";
  const spec = count + "段 · " + (Number(seconds.toFixed(1))) + " 秒 · " +
    resolutionText + " · 24 帧/秒";

  const free = disk
    ? formatLoopDiskSpace(disk.freeBytes)
    : diskState.failed ? "暂无法读取" : "正在检查…";
  const need = budget == null ? "暂无法估算" : formatLoopDiskSpace(budget);
  const diskSummary = "预计使用 " + need + " / 磁盘剩余 " + free;

  const title = '<div class="td-output-memory-title">' +
    brandMark() +
    '<strong>视频输出检查</strong></div>';
  const warning = status === "critical" || status === "warning";
  const diskExtra = warning
    ? ' class="is-warning" title="临时磁盘空间偏紧，请预留足够空间。"'
    : ' title="预计使用量包含余量；不是最终视频文件大小。"';
  const html = title +
    row("视频规格", spec) +
    row("磁盘临时空间", diskSummary, diskExtra);
  return {
    className: "td-output-memory-card is-loop-check" +
      (status === "critical" ? " is-space-low" :
       status === "warning" ? " is-space-warning" : ""),
    html,
    status,
    requiredBytes: budget,
  };
}
