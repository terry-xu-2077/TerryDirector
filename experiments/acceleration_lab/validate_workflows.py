"""Read-only schema and link validation against the actual isolated instance."""
import argparse
import json
from pathlib import Path
from urllib.request import urlopen


def expand_dynamic_definitions(definitions, live_inputs, errors, prefix=""):
    """Validate API wire form, not the dict passed to execute after V3 nesting.

    Only expand the selected branch. The real ComfyUI binding preflight is in
    preflight_sparse_binding.py; this static check does not replace it.
    """
    expanded = {"required": {}, "optional": {}}
    for group in ("required", "optional"):
        for name, definition in definitions.get(group, {}).items():
            key = prefix + name
            if definition[0] != "COMFY_DYNAMICCOMBO_V3":
                expanded[group][key] = definition
                continue
            options = definition[1]["options"]
            allowed = [option["key"] for option in options]
            expanded[group][key] = (allowed, {})
            if key not in live_inputs:
                continue  # Required-root check below reports this.
            value = live_inputs[key]
            if not isinstance(value, str) or value not in allowed:
                errors.append(f"{key}: DynamicCombo requires a string option; "
                              "send child values as dotted keys, not an execute-time dict")
                continue
            option = next(item for item in options if item["key"] == value)
            children = expand_dynamic_definitions(option["inputs"], live_inputs, errors, key + ".")
            for child_group in expanded:
                expanded[child_group].update(children[child_group])
    return expanded


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
        inputs = node["inputs"]
        dynamic_errors = []
        definitions = expand_dynamic_definitions(schema["input"], inputs, dynamic_errors)
        errors.extend(f"{node_id}: {error}" for error in dynamic_errors)
        required = definitions["required"]
        optional = definitions["optional"]
        if kind == "BlockSparseAttention":
            if inputs.get("selection") != "sol-attn" or inputs.get("selection.tau") != 1.0:
                errors.append(f"{node_id}: expected lab Sol preset selection=sol-attn, selection.tau=1.0")
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
    # The generated UI carries named values and an API snapshot; stale nested
    # DynamicCombo metadata must not pass just because node counts match.
    if workflow.get("extra", {}).get("acceleration_lab_api") != graph:
        errors.append("UI embedded API differs from submitted API")
    for ui_node in workflow["nodes"]:
        node = graph.get(str(ui_node["id"]))
        if node and node["class_type"] == "BlockSparseAttention":
            named = ui_node.get("widgets_values_named", {})
            for key in ("selection", "selection.tau"):
                if key not in named or named[key] != node["inputs"].get(key):
                    errors.append(f"{ui_node['id']}: UI/API dynamic widget differs: {key}")
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
