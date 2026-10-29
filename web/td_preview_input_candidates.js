/** Output-type-based input source choices for Preview Stage.
 *
 * Configuration is explicit: do not interpret H3 branches or traverse
 * intermediate switches, wireless buses, or pass-through nodes.
 * A selectable source must provide a compatible output type AND a local,
 * editable widget that can be overridden in the compiled API prompt.
 */
const supportedFields = {
  prompt: ["prompt", "text", "string", "value"],
  seed: ["seed", "noise_seed", "random_seed", "sampling_seed"],
};
const compatibleOutputs = {
  prompt: new Set(["STRING"]),
  seed: new Set(["INT"]),
};

function declaredTypes(output) {
  const type = output?.type;
  if (Array.isArray(type)) return type.map(String);
  return String(type ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

export function listPreviewInputCandidates(workflow, kind) {
  const fields = supportedFields[kind];
  const types = compatibleOutputs[kind];
  if (!fields || !types) return [];
  const candidates = [];
  for (const node of workflow?.nodes || []) {
    const compatible = (node.outputs || []).some(out =>
      declaredTypes(out).some(type => types.has(type)));
    if (!compatible) continue;

    const named = node.widgets_values_named || {};
    // One source entry per node: prefer its explicit prompt/seed widget.
    for (const field of fields) {
      const value = named[field];
      const expected = kind === "prompt" ? "string" : "number";
      if (typeof value !== expected) continue;
      const port = (node.inputs || []).find(input => input.name === field);
      if (port?.link != null) continue;
      if (kind === "seed" && (!Number.isSafeInteger(value) || value < 0)) continue;
      const dataType = kind === "prompt" ? "STRING" : "INT";
      candidates.push({
        node_id: node.id, widget_name: field,
        label: `[${dataType}] ${node.title || node.type} #${node.id} · ${field}`,
      });
      break;
    }
  }
  return candidates;
}
