/**
 * Keep ComfyUI's native widgets, but make the sampler settings clearly inactive
 * while the optional TerryDirector second-pass configuration socket is linked.
 *
 * This is presentation state only: widget values, sockets, sampler schedules,
 * workflow serialization and the second-pass runtime are never rewritten.
 */
const ORDINARY_SAMPLING_WIDGETS = new Map([
  ["sampler", "采样器"],
  ["sigmas", "调度器"],
  ["sigmas_steps", "总步数"],
  ["sigmas_denoise", "Denoise"],
]);

const TAKEOVER_SUFFIX = "（二采接管）";
const TAKEOVER_HINT =
  "已接入二采配置：普通采样参数已由二采配置接管。" +
  "当前参数仅供普通采样使用，断开二采配置后恢复生效。";

export function hasSecondPassConnection(node) {
  const input = node?.inputs?.find(slot => slot.name === "second_pass_config");
  // `0` is a valid link ID. Only null/undefined means disconnected.
  return input?.link != null;
}

export function updateSecondPassTakeover(node) {
  if (!node) return false;
  const connected = hasSecondPassConnection(node);
  let changed = false;

  for (const widget of node.widgets || []) {
    const defaultLabel = ORDINARY_SAMPLING_WIDGETS.get(widget.name);
    if (!defaultLabel) continue;

    if (connected) {
      if (widget.__tdSecondPassOriginal) continue;
      widget.__tdSecondPassOriginal = {
        label: widget.label,
        tooltip: widget.tooltip,
        disabled: widget.disabled,
      };
      const label = widget.label || defaultLabel;
      widget.label = `${label}${TAKEOVER_SUFFIX}`;
      widget.tooltip = `${TAKEOVER_HINT}${widget.tooltip ? `\n${widget.tooltip}` : ""}`;
      widget.disabled = true;
      changed = true;
    } else if (widget.__tdSecondPassOriginal) {
      const original = widget.__tdSecondPassOriginal;
      widget.label = original.label;
      widget.tooltip = original.tooltip;
      widget.disabled = original.disabled;
      delete widget.__tdSecondPassOriginal;
      changed = true;
    }
  }

  if (changed) {
    // LiteGraph computes the actual clickable/greyed state from widget.disabled.
    node.updateComputedDisabled?.();
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
  }
  return connected;
}

export function bindSecondPassTakeover(node) {
  if (!node || node.__tdSecondPassTakeoverBound) {
    updateSecondPassTakeover(node);
    return;
  }
  const previous = node.onConnectionsChange;
  node.onConnectionsChange = function(...args) {
    const result = previous?.apply(this, args);
    // Graph restoration and link removal may finish after the callback returns.
    queueMicrotask(() => updateSecondPassTakeover(this));
    return result;
  };
  node.__tdSecondPassTakeoverBound = true;
  updateSecondPassTakeover(node);
}
