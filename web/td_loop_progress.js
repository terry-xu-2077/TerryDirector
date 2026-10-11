/**
 * Match native ComfyUI progress_state events to copied sampler nodes inside a
 * TerryDirector native-loop expansion.
 *
 * ComfyUI 0.39.0 provides:
 *   node_id          "loopId.call.graph.iteration_originalNodeId"
 *   display_node_id  original sampler node ID on the visible canvas
 *   real_node_id     owner of the expanded subgraph (the loop start)
 *   value/max        actual sampling progress, not estimated wall-clock time
 *
 * This module is pure so it can be tested with native event fixtures.
 */
function iterationFromExpandedId(nodeId) {
  if (typeof nodeId !== "string") return -1;
  // The loop builder names each copied node "<zero-based iteration>_<id>".
  // Other dynamic graphs may have dotted prefixes; require this copy marker.
  const match = nodeId.match(/(?:^|\.)(\d+)_([^.]*)/);
  if (!match || !match[2]) return -1;
  const iteration = Number(match[1]);
  return Number.isSafeInteger(iteration) ? iteration : -1;
}

function isGeneratingSampler(type, max) {
  const name = String(type || "");
  if (["SamplerCustomAdvanced", "KSampler", "KSamplerAdvanced", "TerryDirectorSelfLiftSampler"].includes(name)) {
    return true;
  }
  // Extensible for custom samplers with real multi-step progress; exclude the
  // "KSamplerSelect" selector (its startup progress is not generation).
  return /sampl/i.test(name) && !/select|scheduler|config|loader/i.test(name) && max > 1;
}

export function activeLoopClip(clips, iteration) {
  if (!Array.isArray(clips) || !Number.isSafeInteger(iteration) || iteration < 0) return null;
  return clips.filter(clip => !clip.suspended)[iteration] || null;
}

export function collectLoopSamplerProgress(detail, graph) {
  if (!detail?.prompt_id || !detail?.nodes || !Array.isArray(graph?._nodes)) return [];
  const graphNodes = new Map(graph._nodes.map(node => [String(node.id), node]));
  const updates = [];

  for (const state of Object.values(detail.nodes)) {
    if (state?.state !== "running") continue;
    const ownerId = String(state.real_node_id ?? state.parent_node_id ?? "");
    const owner = graphNodes.get(ownerId);
    if (owner?.comfyClass !== "TerryDirectorLooper") continue;

    const index = iterationFromExpandedId(state.node_id);
    if (index < 0) continue;
    const sourceNode = graphNodes.get(String(state.display_node_id ?? ""));
    const max = Number(state.max);
    const value = Number(state.value);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
    if (!sourceNode || !isGeneratingSampler(sourceNode.comfyClass || sourceNode.type, max)) continue;

    const step = Math.max(0, Math.min(max, value));
    updates.push({
      loopId: ownerId,
      iteration: index,
      sourceId: String(sourceNode.id),
      step,
      totalSteps: max,
      fraction: step / max,
    });
  }
  return updates;
}
