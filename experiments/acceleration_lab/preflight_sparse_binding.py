"""Zero-generation check of a B1 API using the installed ComfyUI V3 parser.

Run with ComfyUI's Python. Does not import execution/server, submit a prompt,
resolve the MODEL link, invoke the node, load weights, or run a GPU forward.
A signature bind proves argument presence, not sparse-kernel compatibility.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib
import inspect
import json
from pathlib import Path
import sys


def normalized_arguments(io, node_class, inputs):
    declared = io.create_input_dict_v1(node_class.define_schema().inputs)
    expanded, _hidden, v3_data = io.get_finalized_class_inputs(declared, inputs)
    accepted = {**expanded.get("required", {}), **expanded.get("optional", {})}
    # The executor only forwards inputs in the finalized schema.
    received = {key: value for key, value in inputs.items() if key in accepted}
    nested = io.build_nested_inputs(received, v3_data)
    return nested, expanded, v3_data


def check_binding(io, node_class, inputs):
    before = copy.deepcopy(inputs)
    if inputs.get("selection") != "sol-attn" or inputs.get("selection.tau") != 1.0:
        raise ValueError("B1 API must use selection='sol-attn' and selection.tau=1.0")
    nested, expanded, v3_data = normalized_arguments(io, node_class, inputs)
    accepted = {**expanded.get("required", {}), **expanded.get("optional", {})}
    unknown = sorted(set(inputs) - set(accepted))
    missing = sorted(set(expanded.get("required", {})) - set(inputs))
    if unknown or missing:
        raise ValueError(f"Finalized schema mismatch: unknown={unknown}, missing={missing}")
    signature = inspect.signature(node_class.execute)
    signature.bind(**nested)
    if nested.get("selection") != {"selection": "sol-attn", "tau": 1.0}:
        raise ValueError("Installed V3 parser did not reconstruct the expected selection dict")

    # Negative control: reproduce the submitted old dict through the SAME parser.
    old_inputs = copy.deepcopy(inputs)
    old_inputs.pop("selection.tau")
    old_inputs["selection"] = {"selection": "sol-attn", "tau": 1.0}
    old_nested, _expanded, _data = normalized_arguments(io, node_class, old_inputs)
    try:
        signature.bind(**old_nested)
    except TypeError as exc:
        if "selection" not in str(exc):
            raise
        rejected = str(exc)
    else:
        raise RuntimeError("Old-format negative control no longer fails; inspect this ComfyUI version")
    if inputs != before:
        raise AssertionError("Binding preflight mutated the API input")
    return {
        "ok": True, "generation_submissions": 0, "node_execute_called": False,
        "normalized_selection": nested["selection"],
        "normalized_argument_names": sorted(nested),
        "dynamic_paths": v3_data.get("dynamic_paths", {}),
        "old_format_rejection": rejected,
        "old_format_normalized_argument_names": sorted(old_nested),
        "scope": "Installed V3 normalization and signature binding only; no MODEL resolution or GPU execution",
    }


def source_record(obj):
    file = Path(inspect.getsourcefile(obj)).resolve()
    return {"filename": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-root", required=True, type=Path)
    parser.add_argument("--api", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        root = args.comfy_root.resolve(strict=True)
        if not (root / "comfy_api" / "latest" / "_io.py").is_file():
            raise ValueError("--comfy-root must point to the actual ComfyUI source tree")
        graph = json.loads(args.api.read_text(encoding="utf-8"))["prompt"]
        matches = [(key, node) for key, node in graph.items()
                   if node.get("class_type") == "BlockSparseAttention"]
        if len(matches) != 1:
            raise ValueError("Expected exactly one native BlockSparseAttention in the B1 API")
        sys.path.insert(0, str(root))
        argv = sys.argv
        try:
            # Do not leak this utility's options into ComfyUI's CLI parser.
            sys.argv = [str(Path(__file__))]
            io = importlib.import_module("comfy_api.latest._io")
            sparse = importlib.import_module("comfy_extras.nodes_sparse_attention")
        finally:
            sys.argv = argv
        for module in (io, sparse):
            if not Path(module.__file__).resolve().is_relative_to(root):
                raise RuntimeError("Imported ComfyUI module is outside --comfy-root")
        result = check_binding(io, sparse.BlockSparseAttention, matches[0][1]["inputs"])
        result.update(node_id=matches[0][0],
                      api_sha256=hashlib.sha256(args.api.read_bytes()).hexdigest(),
                      parser_source=source_record(io.get_finalized_class_inputs),
                      node_source=source_record(sparse.BlockSparseAttention))
        if args.output:
            with args.output.open("x", encoding="utf-8") as stream:
                json.dump(result, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "generation_submissions": 0,
                          "error_type": type(exc).__name__, "error": str(exc)},
                         ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
