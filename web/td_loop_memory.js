/**
 * Determine the loop's actual H3 canvas without relying on a fake resolution
 * value. The generation node belongs to the graph feeding End.samples.
 *
 * Pure data traversal: frontend node/link access is provided as a callback so
 * this stays testable without ComfyUI, Vue or DOM.
 */
export function findLoopMemorySources(loopEnd, upstream) {
  const info = upstream?.(loopEnd, "segment_data");
  if (info?.comfyClass !== "TerryDirectorLoopInfo") {
    return { looper: null, h3: null };
  }
  const looper = upstream(info, "loop_context");
  if (looper?.comfyClass !== "TerryDirectorLooper") {
    return { looper: null, h3: null };
  }

  const pending = [upstream(loopEnd, "samples")];
  const visited = new Set();
  const references = new Set();
  while (pending.length && visited.size < 256) {
    const node = pending.shift();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    if (node.comfyClass === "MiniMaxH3ReferenceToVideo") {
      references.add(node);
      continue;
    }
    if (node.comfyClass === "TerryDirectorLooper") continue;
    for (const input of node.inputs || []) {
      const parent = upstream(node, input.name);
      if (parent && !visited.has(parent)) pending.push(parent);
    }
  }
  // Multiple H3 conditioning nodes may use different resolutions. Without an
  // unambiguous source, do not display a misleading memory estimate.
  return { looper, h3: references.size === 1 ? [...references][0] : null };
}

export function readH3Resolution(node) {
  if (node?.comfyClass !== "MiniMaxH3ReferenceToVideo") return null;
  const values = [];
  for (const name of ["width", "height"]) {
    const input = node.inputs?.find(item => item.name === name);
    // A connected width/height input overrides the saved widget value.
    // There is no dependable static numeric resolution in that case.
    if (!input || input.link != null) return null;
    const widget = node.widgets?.find(item => item.name === name);
    const numeric = Number(widget?.value);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
    values.push(numeric);
  }
  return { width: values[0], height: values[1] };
}
