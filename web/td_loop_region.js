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

const topologyCache = new WeakMap();
const geometryCache = new WeakMap();

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
  const cached = topologyCache.get(graph);
  if (cached?.signature === signature) return cached.regions;

  const regions = [];
  for (const node of nodes) {
    if (nodeType(node) !== LOOP_START) continue;
    const region = collectLoopRegion(node, graph);
    if (region) regions.push(region);
  }
  topologyCache.set(graph, { signature, regions });
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

function geometrySignature(graph, region, scale) {
  const parts = [String(region.startId), String(region.endId), Number(scale).toFixed(3)];
  for (const id of region.nodeIds) {
    const node = graphNode(graph, id);
    if (!node) {
      parts.push(id, "missing");
      continue;
    }
    const [x, y, width, height] = nodeBounds(node);
    parts.push(
      id,
      x.toFixed(2),
      y.toFixed(2),
      width.toFixed(2),
      height.toFixed(2)
    );
  }
  return parts.join(":");
}

function pointKey(point) {
  return `${point[0].toFixed(3)},${point[1].toFixed(3)}`;
}

function convexHull(points) {
  if (points.length <= 1) return points.slice();

  const unique = [...new Map(points.map(point => [pointKey(point), point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length <= 2) return unique;

  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) -
    (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 &&
           cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 &&
           cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function hullBounds(points) {
  if (!points.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
}

function buildRegionGeometry(graph, region, scale) {
  let graphCache = geometryCache.get(graph);
  if (!graphCache) {
    graphCache = new Map();
    geometryCache.set(graph, graphCache);
  }

  const signature = geometrySignature(graph, region, scale);
  const cached = graphCache.get(region.startId);
  if (cached?.signature === signature) return cached;

  const pad = 26 / scale;
  const points = [];
  for (const id of region.nodeIds) {
    const node = graphNode(graph, id);
    if (!node) continue;
    const [x, y, width, height] = nodeBounds(node);
    const left = x - pad;
    const top = y - pad;
    const right = x + width + pad;
    const bottom = y + height + pad;
    points.push(
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom]
    );
  }

  const hull = convexHull(points);
  const bounds = hullBounds(hull);
  const geometry = { signature, hull, bounds };
  graphCache.set(region.startId, geometry);

  // Drop stale regions when a loop is removed/recreated with another start id.
  const liveIds = new Set(loopRegions(graph).map(item => item.startId));
  for (const id of graphCache.keys()) {
    if (!liveIds.has(id)) graphCache.delete(id);
  }

  return geometry;
}

function intersectsVisible(bounds, visible) {
  if (!bounds || !visible) return true;
  const [x, y, width, height] = bounds;
  const vx = Number(visible[0] ?? visible.x ?? 0);
  const vy = Number(visible[1] ?? visible.y ?? 0);
  const vw = Number(visible[2] ?? visible.width ?? Infinity);
  const vh = Number(visible[3] ?? visible.height ?? Infinity);
  return x <= vx + vw && x + width >= vx && y <= vy + vh && y + height >= vy;
}

function roundedPolygonPath(ctx, points, radius) {
  if (!points?.length) return false;
  if (points.length < 3) {
    const bounds = hullBounds(points);
    if (!bounds) return false;
    ctx.roundRect(bounds[0], bounds[1], bounds[2], bounds[3], radius);
    return true;
  }

  const count = points.length;
  const tangent = (from, vertex, amount) => {
    const dx = from[0] - vertex[0];
    const dy = from[1] - vertex[1];
    const distance = Math.hypot(dx, dy);
    if (distance <= 1e-6) return vertex.slice();
    const d = Math.min(amount, distance * 0.45);
    return [
      vertex[0] + dx / distance * d,
      vertex[1] + dy / distance * d,
    ];
  };

  const segments = points.map((vertex, index) => {
    const previous = points[(index - 1 + count) % count];
    const next = points[(index + 1) % count];
    const incoming = tangent(previous, vertex, radius);
    const outgoing = tangent(next, vertex, radius);
    return { vertex, incoming, outgoing };
  });

  ctx.moveTo(segments[0].outgoing[0], segments[0].outgoing[1]);
  for (let offset = 1; offset <= count; offset += 1) {
    const segment = segments[offset % count];
    ctx.lineTo(segment.incoming[0], segment.incoming[1]);
    ctx.quadraticCurveTo(
      segment.vertex[0], segment.vertex[1],
      segment.outgoing[0], segment.outgoing[1]
    );
  }
  ctx.closePath();
  return true;
}

function drawLoopRegion(ctx, canvas, graph, region, visibleArea) {
  const scale = Math.max(0.05, Number(canvas?.ds?.scale) || 1);
  const geometry = buildRegionGeometry(graph, region, scale);
  if (!geometry?.bounds || geometry.hull.length < 3) return;
  if (!intersectsVisible(geometry.bounds, visibleArea)) return;

  const radius = 20 / scale;
  ctx.save();

  // Subtle domain: solid contour, very low-opacity fill.
  ctx.beginPath();
  if (roundedPolygonPath(ctx, geometry.hull, radius)) {
    ctx.fillStyle = "rgba(183, 112, 46, 0.028)";
    ctx.strokeStyle = "rgba(229, 154, 78, 0.20)";
    ctx.lineWidth = 1.1 / scale;
    ctx.setLineDash([]);
    ctx.fill();
    ctx.stroke();
  }

  const [left, top] = geometry.bounds;
  const labelX = left + 10 / scale;
  const labelY = top + 8 / scale;
  const labelHeight = 22 / scale;
  const labelWidth = 132 / scale;

  ctx.fillStyle = "rgba(229, 154, 78, 0.105)";
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 8 / scale);
  ctx.fill();

  ctx.fillStyle = "rgba(242, 218, 193, 0.80)";
  ctx.font = `600 ${12 / scale}px Inter, Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(
    "TerryDirector 循环域",
    labelX + 10 / scale,
    labelY + labelHeight / 2
  );

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
