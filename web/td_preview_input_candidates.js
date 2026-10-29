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
    // Standard ComfyUI exports can contain widgets_values without the named
    // extension. Resolve only widgets explicitly declared on node.inputs.
    const readField = field => {
      if (Object.prototype.hasOwnProperty.call(named,field)) return named[field];
      if (node.widgets_values && !Array.isArray(node.widgets_values))
        return node.widgets_values[field];
      const names=(node.inputs||[]).filter(input => input.widget && input.link == null)
        .map(input => input.widget.name || input.name);
      const i=names.indexOf(field);
      if (i>=0 && Array.isArray(node.widgets_values)) return node.widgets_values[i];
      // rgthree Seed serializes its seed as the first widget value and has
      // no node.inputs slot for it in standard ComfyUI workflow exports.
      if (kind === "seed" && field === "seed" &&
          /^(?:SeedNode|Seed \(rgthree\))$/i.test(String(node.type)) &&
          Array.isArray(node.widgets_values))
        return node.widgets_values[0];
      return undefined;
    };
    // One source entry per node: prefer its explicit prompt/seed widget.
    for (const field of fields) {
      const value = readField(field);
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
