/**
 * Read H3's actual generation dimensions from the upstream graph where they
 * are statically knowable. This mirrors ComfyUI 0.39.0's ResolutionSelector
 * and supports fixed PrimitiveInt/Float values plus reroutes. Unsupported or
 * changing values remain unknown instead of reusing overridden H3 widgets.
 */
export function findLoopMemorySources(loopEnd, upstream) {
  const pending = [
    upstream?.(loopEnd, "images"),
    upstream?.(loopEnd, "audio"),
    upstream?.(loopEnd, "dependency"),
  ].filter(Boolean);

  const visited = new Set();
  const references = new Set();
  const loopers = new Set();

  while (pending.length && visited.size < 384) {
    const node = pending.shift();
    if (!node || visited.has(node)) continue;
    visited.add(node);

    if (node.comfyClass === "MiniMaxH3ReferenceToVideo") {
      references.add(node);
    }

    if (node.comfyClass === "TerryDirectorLoopInfo") {
      const looper = upstream?.(node, "loop_context");
      if (looper?.comfyClass === "TerryDirectorLooper") {
        loopers.add(looper);
      }
    }

    if (node.comfyClass === "TerryDirectorLooper") {
      loopers.add(node);
      continue;
    }

    // Keep walking through H3, sampler, condition, decode and utility nodes.
    // LoopEnd no longer exposes segment_data, so the loop owner must be
    // discovered from the actual media-generation graph.
    for (const input of node.inputs || []) {
      const parent = upstream?.(node, input.name);
      if (parent && !visited.has(parent)) pending.push(parent);
    }
  }

  // Multiple loop owners or H3 sources are ambiguous; never guess.
  return {
    looper: loopers.size === 1 ? [...loopers][0] : null,
    h3: references.size === 1 ? [...references][0] : null,
  };
}

function inputPort(node, name) {
  return node?.inputs?.find(input => input.name === name);
}

function widgetValue(node, name) {
  return node?.widgets?.find(widget => widget.name === name)?.value ?? null;
}

// Python's round() uses ties-to-even; Math.round() uses ties-to-positive.
// Using the former matches ComfyUI's official ResolutionSelector.execute.
function roundHalfEven(value) {
  const low = Math.floor(value);
  const fraction = value - low;
  if (fraction === 0.5) return low % 2 === 0 ? low : low + 1;
  return Math.round(value);
}

function selectedResolution(node, linkedOutput, visited, depth) {
  if (node?.comfyClass !== "ResolutionSelector" || depth > 12) return null;
  const ratioValue = readStaticInput(node, "aspect_ratio", linkedOutput, visited, depth + 1);
  const megapixels = Number(readStaticInput(node, "megapixels", linkedOutput, visited, depth + 1));
  const multiple = Number(readStaticInput(node, "multiple", linkedOutput, visited, depth + 1));
  const aspect = String(ratioValue || "").match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (!aspect || !Number.isFinite(megapixels) || !(megapixels > 0) ||
      !Number.isSafeInteger(multiple) || multiple <= 0) return null;
  const rw = Number(aspect[1]);
  const rh = Number(aspect[2]);
  if (!(rw > 0) || !(rh > 0)) return null;
  const scale = Math.sqrt(megapixels * 1024 * 1024 / (rw * rh));
  const width = roundHalfEven(rw * scale / multiple) * multiple;
  const height = roundHalfEven(rh * scale / multiple) * multiple;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0) return null;
  return { width, height };
}

function readStaticInput(node, name, linkedOutput, visited = new Set(), depth = 0) {
  if (!node || depth > 12) return null;
  const key = String(node.id) + ":" + name;
  if (visited.has(key)) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(key);
  const port = inputPort(node, name);
  const source = linkedOutput?.(node, name);
  if (port?.link != null && !source) return null;
  if (!source) return widgetValue(node, name);
  const parent = source.node;
  const slot = Number(source.outputIndex);
  if (!parent || !Number.isSafeInteger(slot) || slot < 0) return null;
  if (parent.comfyClass === "ResolutionSelector" && slot <= 1) {
    const dimensions = selectedResolution(parent, linkedOutput, nextVisited, depth + 1);
    return dimensions ? (slot === 0 ? dimensions.width : dimensions.height) : null;
  }
  if (slot === 0 && ["PrimitiveInt", "PrimitiveFloat", "PrimitiveString"].includes(parent.comfyClass)) {
    return readStaticInput(parent, "value", linkedOutput, nextVisited, depth + 1);
  }
  // A plain LiteGraph reroute does not change the upstream value.
  if (slot === 0 && parent.comfyClass === "Reroute") {
    return readStaticInput(parent, parent.inputs?.[0]?.name, linkedOutput, nextVisited, depth + 1);
  }
  return null;
}

/**
 * Return definite H3 width/height, or null. linkedOutput supplies
 * {node: originNode, outputIndex: originSlot} for connected inputs.
 * It is intentionally optional for legacy H3 widgets with no connections.
 */
export function readH3Resolution(node, linkedOutput) {
  if (node?.comfyClass !== "MiniMaxH3ReferenceToVideo") return null;
  const width = Number(readStaticInput(node, "width", linkedOutput));
  const height = Number(readStaticInput(node, "height", linkedOutput));
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0) return null;
  const result = { width, height };
  if (inputPort(node, "width")?.link != null || inputPort(node, "height")?.link != null) {
    result.source = "upstream";
  }
  return result;
}


const KNOWN_FAST_DECODE_VAE_SCALES = new Map([
  ["minimax-h3-x2-detail-v1.safetensors", 2],
]);

function basename(value) {
  return String(value || "").replaceAll("\\", "/").split("/").pop().toLowerCase();
}

function upstreamThroughReroutes(node, upstream, inputName = null) {
  let current = node;
  const visited = new Set();
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (visited.has(current)) return null;
    visited.add(current);
    if (current.comfyClass !== "Reroute") return current;
    const name = inputName || current.inputs?.[0]?.name;
    current = name ? upstream?.(current, name) : null;
    inputName = null;
  }
  return null;
}

function knownFastDecodeScale(decodeNode, upstream) {
  if (!["MiniMaxH3VAEDecodeFast", "TerryDirectorH3X2LowRAMDecode"].includes(decodeNode?.comfyClass)) return null;
  const vaeNode = upstreamThroughReroutes(upstream?.(decodeNode, "vae"), upstream);
  if (vaeNode?.comfyClass !== "VAELoader") return null;
  const vaeName = basename(widgetValue(vaeNode, "vae_name"));
  const scale = KNOWN_FAST_DECODE_VAE_SCALES.get(vaeName);
  if (!scale) return null;
  return { scale, vaeName };
}

/**
 * Resolve the LoopEnd's actual cached/output image size when it can be proven
 * from the static graph. Legacy H3 decode uses the generation resolution.
 * External Fast Decode only returns a definite size for explicitly known VAE
 * scaling contracts; unknown post-processing remains intentionally unknown.
 */
export function readLoopOutputResolution(loopEnd, h3, upstream, linkedOutput) {
  const base = readH3Resolution(h3, linkedOutput);
  if (!base) return null;

  const externalSource = upstreamThroughReroutes(
    upstream?.(loopEnd, "images"), upstream
  );
  if (!externalSource) {
    return {
      ...base,
      source: base.source || "h3",
      resolutionLabel: base.source === "upstream" ? "上游生成尺寸" : "H3 生成尺寸",
    };
  }

  const fastDecode = knownFastDecodeScale(externalSource, upstream);
  if (!fastDecode) return null;

  const width = base.width * fastDecode.scale;
  const height = base.height * fastDecode.scale;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  return {
    width,
    height,
    source: "fast_decode_known_scale",
    scale: fastDecode.scale,
    vaeName: fastDecode.vaeName,
    resolutionLabel: fastDecode.scale + "X VAE 推算",
  };
}
