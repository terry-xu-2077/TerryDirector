"""Read-only schema and link validation against the actual isolated instance."""
import argparse
import json
from pathlib import Path
from urllib.request import urlopen


def validate(api, ui, registry):
    graph = json.loads(Path(api).read_text(encoding="utf-8"))["prompt"]
    workflow = json.loads(Path(ui).read_text(encoding="utf-8"))
    errors = []
    if len(workflow["nodes"]) != len(graph):
        errors.append("UI/API node count differs")
    if not all(str(node["id"]) in graph and node["type"] == graph[str(node["id"])]["class_type"] for node in workflow["nodes"]):
        errors.append("UI/API node identity differs")
    outputs = [node for node in graph.values() if registry.get(node["class_type"], {}).get("output_node")]
    if len(outputs) != 1 or outputs[0]["class_type"] != "TerryAccelLabSaveVideo":
        errors.append("Expected one lab output node")
    for node_id, node in graph.items():
        kind = node["class_type"]
        schema = registry.get(kind)
        if schema is None:
            errors.append(f"{node_id}: unregistered {kind}")
            continue
        definitions = schema["input"]
        required = definitions.get("required", {})
        optional = definitions.get("optional", {})
        inputs = node["inputs"]
        missing = set(required) - set(inputs)
        if missing:
            errors.append(f"{node_id}: missing {sorted(missing)}")
        for name, value in inputs.items():
            definition = required.get(name) or optional.get(name)
            if definition is None and kind == "TerryAccelLabCondition" and name.startswith("ref_image_"):
                definition = required.get(name)
            if definition is None:
                errors.append(f"{node_id}: unknown input {name}")
                continue
            expected = definition[0]
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] in graph:
                source_id, slot = value
                source = registry[graph[source_id]["class_type"]]["output"]
                if not isinstance(slot, int) or slot < 0 or slot >= len(source):
                    errors.append(f"{node_id}.{name}: invalid source slot")
                elif isinstance(expected, str) and source[slot] != expected:
                    errors.append(f"{node_id}.{name}: {source[slot]} -> {expected}")
            elif isinstance(expected, list) and value not in expected:
                errors.append(f"{node_id}.{name}: enum value invalid")
            elif expected == "COMFY_DYNAMICCOMBO_V3":
                if not isinstance(value, dict) or not any(option["key"] == value.get(name) for option in definition[1]["options"]):
                    errors.append(f"{node_id}.{name}: dynamic combo invalid")
                elif kind == "BlockSparseAttention" and value.get("tau") != 1.0:
                    errors.append(f"{node_id}.{name}: Sol tau missing")
    edges = {edge[0] for edge in workflow["links"]}
    if len(edges) != len(workflow["links"]):
        errors.append("Duplicate UI link IDs")
    return errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default="http://127.0.0.1:8190")
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    with urlopen(args.server + "/object_info", timeout=20) as stream:
        registry = json.load(stream)
    names = ("Lab_B0_Dense_Clip1", "Lab_B1_SolAttn_Clip1",
             "Lab_V0_CurrentVAE_Decode", "Lab_V1_INT8VAE_Decode")
    result = {}
    for name in names:
        result[name] = validate(args.directory / (name + ".api.json"),
                                args.directory / (name + ".json"), registry)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not any(result.values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())
