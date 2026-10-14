const BRAND_MARK_URL = "/terrydirector/static/assets/mark.svg";

/**
 * Rough output-drive space guidance for encoded per-clip MOV/MP4.
 * Unlike the legacy .pt estimate, size cannot be predicted exactly:
 * spatial detail, encoding parameters and merge intermediates all matter.
 */
export function estimateLoopTempSpaceBytes(frames, width, height, fps = 24, format = "MOV · ProRes 422 HQ", merge = true) {
  if (![frames, width, height, fps].every(Number.isFinite) ||
      !Number.isSafeInteger(frames) || !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      frames <= 0 || width <= 0 || height <= 0 || fps <= 0) return null;
  // Generous per-frame planning factors, not contractual encoder bitrates.
  const mp4 = String(format).startsWith("MP4");
  const videoBytes = frames * width * height * (mp4 ? 0.2 : 0.9);
  const pcmBytes = frames * (48000 / fps) * 2 * 3;
  // The final merge can temporarily need a video-only file plus Final.
  const factor = merge ? (mp4 ? 3.0 : 2.5) : 1.25;
  const bytes = Math.ceil((videoBytes + pcmBytes) * factor);
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
export function createLoopOutputCheckCard(estimate, diskState = {}, options = {}) {
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
    ? estimateLoopTempSpaceBytes(
        frames, Number(estimate.width), Number(estimate.height), 24,
        options.segmentFormat, options.mergeFinal !== false,
      )
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
  const delivery = (options.segmentFormat || "MOV · ProRes 422 HQ") +
    (options.mergeFinal === false ? " · 只保存镜头" : " · 合并 Final");

  const free = disk
    ? formatLoopDiskSpace(disk.freeBytes)
    : diskState.failed ? "暂无法读取" : "正在检查…";
  const need = budget == null ? "暂无法估算" : formatLoopDiskSpace(budget);
  const diskSummary = "编码空间参考 " + need + " / 剩余 " + free;

  const title = '<div class="td-output-memory-title">' +
    brandMark() +
    '<strong>视频输出检查</strong></div>';
  const warning = status === "critical" || status === "warning";
  const diskExtra = warning
    ? ' class="is-warning" title="输出磁盘空间偏紧，编码文件大小会随内容波动。"'
    : ' title="粗略规划空间，含合并过程临时文件；不是精确文件体积。"';
  const html = title +
    row("视频规格", spec) +
    row("片段格式", delivery) +
    row("片段输出空间", diskSummary, diskExtra);
  return {
    className: "td-output-memory-card is-loop-check" +
      (status === "critical" ? " is-space-low" :
       status === "warning" ? " is-space-warning" : ""),
    html,
    status,
    requiredBytes: budget,
  };
}
