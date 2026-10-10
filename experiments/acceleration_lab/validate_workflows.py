"""Read-only schema and link validation against the actual isolated instance."""
import argparse
import json
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


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
                source_kind = graph[source_id]["class_type"]
                source_schema = registry.get(source_kind)
                if source_schema is None:
                    errors.append(f"{node_id}.{name}: source {source_id} is unregistered: {source_kind}")
                    continue
                source = source_schema["output"]
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


def lab_server_url(value):
    """This experiment uses 8190 only; never substitute the production 8188."""
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.port != 8190 or parsed.username is not None or parsed.password is not None
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("Use the isolated http://127.0.0.1:8190 instance. "
                         "Do not validate lab workflows against production 8188.")
    return value.rstrip("/")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise URLError("Lab registry redirects are refused; do not change the target instance")


def read_lab_registry(server, required_lab_nodes):
    server = lab_server_url(server)
    # No proxy or redirect can silently route validation to another server.
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    with opener.open(server + "/object_info", timeout=20) as stream:
        registry = json.load(stream)
    if not isinstance(registry, dict):
        raise ValueError("Lab object_info is not a node registry")
    missing = sorted(set(required_lab_nodes) - set(registry))
    if missing:
        raise ValueError("Lab nodes are not loaded in this 8190 process: " + ", ".join(missing)
                         + ". Check its PID, module paths and startup log; "
                           "do not install lab nodes into production.")
    return registry


def main(argv=None):
    parser = argparse.ArgumentParser(description=(
        "Read-only workflow validation AFTER starting the isolated lab. "
        "This tool neither starts a server nor submits generation."))
    parser.add_argument("--server", default="http://127.0.0.1:8190")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--directory", type=Path, help="Validate the four original lab file pairs")
    source.add_argument("--api", type=Path, help="Validate only this API; requires --ui")
    parser.add_argument("--ui", type=Path, help="Matching UI file for --api")
    args = parser.parse_args(argv)
    if bool(args.api) != bool(args.ui):
        parser.error("--api and --ui must be supplied together; --ui cannot accompany --directory")
    result = {"generation_submissions": 0, "runtime_identity_verified": False,
              "scope": "Registry/schema/link validation only; verify PID, interpreter and Sol gate separately"}
    try:
        server = lab_server_url(args.server)
    except ValueError as exc:
        result.update(status="WRONG_INSTANCE", error=str(exc))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2
    result["server"] = server
    if args.api:
        pairs = [(args.api, args.ui)]
    else:
        names = ("Lab_B0_Dense_Clip1", "Lab_B1_SolAttn_Clip1",
                 "Lab_V0_CurrentVAE_Decode", "Lab_V1_INT8VAE_Decode")
        pairs = [(args.directory / (name + ".api.json"), args.directory / (name + ".json"))
                 for name in names]
    try:
        required_lab_nodes = set()
        for api, ui in pairs:
            if not ui.is_file():
                raise FileNotFoundError(ui)
            graph = json.loads(api.read_text(encoding="utf-8"))["prompt"]
            required_lab_nodes.update(node["class_type"] for node in graph.values()
                                      if node["class_type"].startswith("TerryAccelLab"))
        registry = read_lab_registry(server, required_lab_nodes)
        result["workflows"] = {str(api): validate(api, ui, registry) for api, ui in pairs}
        passed = not any(result["workflows"].values())
        result["status"] = "SCHEMA_VALIDATED" if passed else "VALIDATION_FAILED"
    except (URLError, TimeoutError, ConnectionError) as exc:
        result.update(status="LAB_UNREACHABLE_OR_NOT_READY", error=str(exc), next_action=(
            "After offline checks and confirming port 8190 is free, start start_lab.ps1 "
            "-Port 8190 -RunName <new_unique_name>. Verify that PID finishes initialization, "
            "then repeat this read-only check on 8190. Never substitute 8188."))
        passed = False
    except (OSError, ValueError, KeyError, TypeError) as exc:
        result.update(status="PRECHECK_BLOCKED", error=str(exc))
        passed = False
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
