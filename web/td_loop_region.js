const LOOP_START = "TerryDirectorLooper";
const LOOP_END = "TerryDirectorLoopEnd";

function nodeType(node) {
  return String(
    node?.comfyClass ||
    node?.type ||
    node?.constructor?.comfyClass ||
    node?.constructor?.type ||
    ""
  );
}

function graphLink(graph, id) {
  if (!graph || id == null) return null;
  if (typeof graph.getLink === "function") {
    const hit = graph.getLink(id);
    if (hit) return hit;
  }
  for (const bag of [graph.links, graph._links]) {
    if (!bag) continue;
    if (typeof bag.get === "function") {
      const hit = bag.get(id) ?? bag.get(String(id));
      if (hit) return hit;
    }
    const hit = bag[id] ?? bag[String(id)];
    if (hit) return hit;
  }
  return null;
}

function graphNode(graph, id) {
  return graph?.getNodeById?.(id)
    || (graph?._nodes || graph?.nodes || []).find(node => String(node?.id) === String(id))
    || null;
}

function downstreamNode(graph, linkId) {
  const link = graphLink(graph, linkId);
  if (!link) return null;
  const targetId = link.target_id ?? link.targetId ?? link.to_id ?? link.toId;
  return graphNode(graph, targetId);
}

function collectLoopRegion(start, graph) {
  const queue = [start];
  const visited = new Set();
  const nodeIds = [];
  const endIds = [];

  while (queue.length) {
    const node = queue.shift();
    if (!node || visited.has(String(node.id))) continue;
    visited.add(String(node.id));
    nodeIds.push(String(node.id));

    if (nodeType(node) === LOOP_END) {
      endIds.push(String(node.id));
      continue;
    }

    for (const output of node.outputs || []) {
      for (const linkId of output.links || []) {
        const next = downstreamNode(graph, linkId);
        if (next && !visited.has(String(next.id))) queue.push(next);
      }
    }
  }

  if (endIds.length !== 1) return null;
  return {
    startId: String(start.id),
    endId: endIds[0],
    nodeIds,
  };
}

const regionCache = new WeakMap();

function loopRegions(graph) {
  if (!graph) return [];
  const nodes = graph._nodes || graph.nodes || [];
  const version = Number(graph._version ?? 0);
  const startIds = nodes
    .filter(node => nodeType(node) === LOOP_START)
    .map(node => String(node.id))
    .sort()
    .join("|");
  const signature = `${version}:${nodes.length}:${startIds}`;
  const cached = regionCache.get(graph);
  if (cached?.signature === signature) return cached.regions;

  const regions = [];
  for (const node of nodes) {
    if (nodeType(node) !== LOOP_START) continue;
    const region = collectLoopRegion(node, graph);
    if (region) regions.push(region);
  }
  regionCache.set(graph, { signature, regions });
  return regions;
}

function nodeBounds(node) {
  const rect = node?.boundingRect;
  if (rect && Number.isFinite(Number(rect[0])) && Number.isFinite(Number(rect[1]))) {
    return [
      Number(rect[0]),
      Number(rect[1]),
      Math.max(0, Number(rect[2]) || 0),
      Math.max(0, Number(rect[3]) || 0),
    ];
  }
  const x = Number(node?.pos?.[0]) || 0;
  const y = Number(node?.pos?.[1]) || 0;
  const width = Math.max(0, Number(node?.size?.[0]) || 0);
  const height = Math.max(0, Number(node?.size?.[1]) || 0);
  return [x, y, width, height];
}

function regionBounds(graph, region) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const id of region.nodeIds) {
    const node = graphNode(graph, id);
    if (!node) continue;
    const [x, y, width, height] = nodeBounds(node);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }

  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
}

function intersectsVisible(bounds, visible) {
  if (!visible) return true;
  const [x, y, width, height] = bounds;
  const vx = Number(visible[0] ?? visible.x ?? 0);
  const vy = Number(visible[1] ?? visible.y ?? 0);
  const vw = Number(visible[2] ?? visible.width ?? Infinity);
  const vh = Number(visible[3] ?? visible.height ?? Infinity);
  return x <= vx + vw && x + width >= vx && y <= vy + vh && y + height >= vy;
}

function drawLoopRegion(ctx, canvas, graph, region, visibleArea) {
  const raw = regionBounds(graph, region);
  if (!raw) return;

  const scale = Math.max(0.05, Number(canvas?.ds?.scale) || 1);
  const pad = 28 / scale;
  const header = 26 / scale;
  const radius = 14 / scale;
  const bounds = [
    raw[0] - pad,
    raw[1] - pad - header,
    raw[2] + pad * 2,
    raw[3] + pad * 2 + header,
  ];
  if (!intersectsVisible(bounds, visibleArea)) return;

  const [x, y, width, height] = bounds;
  ctx.save();

  ctx.fillStyle = "rgba(183, 112, 46, 0.055)";
  ctx.strokeStyle = "rgba(229, 154, 78, 0.34)";
  ctx.lineWidth = 1.25 / scale;
  ctx.setLineDash([7 / scale, 5 / scale]);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(229, 154, 78, 0.16)";
  const labelX = x + 12 / scale;
  const labelY = y + 8 / scale;
  const labelHeight = 22 / scale;
  const labelWidth = 132 / scale;
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 8 / scale);
  ctx.fill();

  ctx.fillStyle = "rgba(242, 218, 193, 0.88)";
  ctx.font = `600 ${12 / scale}px Inter, Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText("TerryDirector 循环域", labelX + 10 / scale, labelY + labelHeight / 2);

  ctx.restore();
}

export function installLoopRegionOverlay(app) {
  const canvas = app?.canvas;
  if (!canvas || canvas.__tdLoopRegionOverlayInstalled) return;
  canvas.__tdLoopRegionOverlayInstalled = true;

  const previous = canvas.onDrawBackground;
  canvas.onDrawBackground = function(ctx, visibleArea) {
    previous?.call(this, ctx, visibleArea);
    const graph = this.graph || app.graph;
    if (!graph) return;
    for (const region of loopRegions(graph)) {
      drawLoopRegion(ctx, this, graph, region, visibleArea);
    }
  };
}
