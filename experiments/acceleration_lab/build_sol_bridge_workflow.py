"""Insert the lab bridge in a COPY of report04's B1 API/UI; no server requests."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

SOURCE_API_SHA256 = "64cfdf3584e74272d9efc504eb25995d230576a9d672186577c79b78f31eaccc"
SOURCE_UI_SHA256 = "243cbdf85289a7e1dfbf87be3ac460bc9c6842f85420d9c5ec50ec36850bde8b"
BRIDGE = "TerryAccelLabSolLowVRAMBridge"


def add_bridge(api, ui):
    api, ui = copy.deepcopy(api), copy.deepcopy(ui)
    graph = api["prompt"]
    if ui.get("extra", {}).get("acceleration_lab_api") != graph:
        raise ValueError("Source UI embedded API differs from source API")
    found = [key for key, node in graph.items() if node["class_type"] == "BlockSparseAttention"]
    if len(found) != 1 or any(n["class_type"] == BRIDGE for n in graph.values()):
        raise ValueError("Expected exactly one sparse node and no existing lab bridge")
    sparse_id = found[0]
    settings = graph[sparse_id]["inputs"]
    if settings.get("selection") != "sol-attn" or settings.get("selection.tau") != 1.0:
        raise ValueError("Source must be report04's corrected Sol DynamicCombo format")
    source_id, source_slot = settings["model"]
    if graph[source_id]["class_type"] != "MiniMaxChunkFeedForward" or source_slot != 0:
        raise ValueError("Sparse MODEL must come from the original FFN node")
    by_id = {n["id"]: n for n in ui["nodes"]}
    sparse_ui, source_ui = by_id[int(sparse_id)], by_id[int(source_id)]
    ports = [(i, p) for i, p in enumerate(sparse_ui["inputs"]) if p["name"] == "model"]
    if len(ports) != 1:
        raise ValueError("Expected one sparse MODEL input socket")
    socket_index, socket = ports[0]
    edges = [e for e in ui["links"] if e[0] == socket["link"]]
    expected = [socket["link"], int(source_id), 0, int(sparse_id), socket_index, "MODEL"]
    if len(edges) != 1 or edges[0] != expected:
        raise ValueError("Source UI MODEL edge differs from API")
    old_edge = edges[0]
    producer_links = source_ui["outputs"][0].get("links") or []
    if producer_links.count(old_edge[0]) != 1:
        raise ValueError("Source UI producer link is missing or duplicated")
    bridge_id = max(int(k) for k in graph) + 1
    edge_id = max([int(e[0]) for e in ui["links"]] + [int(ui.get("last_link_id", 0))]) + 1
    graph[str(bridge_id)] = {"class_type": BRIDGE, "inputs": {"model": [source_id, 0]}}
    settings["model"] = [str(bridge_id), 0]
    old_edge[1], old_edge[2] = bridge_id, 0
    source_ui["outputs"][0]["links"] = [edge_id if x == old_edge[0] else x for x in producer_links]
    ui["links"].append([edge_id, int(source_id), 0, bridge_id, 0, "MODEL"])
    pos = sparse_ui.get("pos", [0, 0])
    ui["nodes"].append({
        "id": bridge_id, "type": BRIDGE, "pos": [pos[0] - 340, pos[1] + 200],
        "size": [300, 70], "flags": {}, "order": len(graph) - 1, "mode": 0,
        "inputs": [{"name": "model", "type": "MODEL", "link": edge_id}],
        "outputs": [{"name": "MODEL", "type": "MODEL", "links": [old_edge[0]]}],
        "properties": {"Node name for S&R": BRIDGE}, "widgets_values": [],
        "widgets_values_named": {},
    })
    ui["last_node_id"] = max(int(ui.get("last_node_id", 0)), bridge_id)
    ui["last_link_id"] = edge_id
    ui["extra"]["acceleration_lab_api"] = copy.deepcopy(graph)
    return api, ui, {"added_node": str(bridge_id), "rewired_sparse_node": sparse_id,
                     "previous_model": [source_id, 0], "new_model": [str(bridge_id), 0]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", type=Path, required=True)
    parser.add_argument("--ui", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    files = [(args.api, SOURCE_API_SHA256), (args.ui, SOURCE_UI_SHA256)]
    for path, expected in files:
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Source report04 file hash mismatch: {path}")
    if args.output_dir.exists():
        raise FileExistsError("Use a NEW output directory; old evidence must not be overwritten")
    api, ui, diff = add_bridge(json.loads(args.api.read_text(encoding="utf-8")),
                              json.loads(args.ui.read_text(encoding="utf-8")))
    args.output_dir.mkdir(parents=True, exist_ok=False)
    for name, value in (("Lab_B1_SolAttn_Clip1.api.json", api),
                        ("Lab_B1_SolAttn_Clip1.json", ui), ("bridge_diff.json", diff)):
        (args.output_dir / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"written": str(args.output_dir), "generation_submissions": 0, **diff}, ensure_ascii=False))


if __name__ == "__main__":
    main()
