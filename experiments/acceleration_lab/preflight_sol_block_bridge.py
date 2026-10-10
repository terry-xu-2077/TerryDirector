"""Zero-generation test of INSTALLED block dispatch code using synthetic CPU math.

Extract only the installed KJ/native forward and sparse dispatch functions. Never
import ComfyUI/KJ root modules, load weights, initialize CUDA, or submit /prompt.
Normalization/gating/attention/MLP here are synthetic: this is interface and routing
coverage, NOT a real H3 forward or Sol kernel/quality/performance validation.
"""
from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path
from types import MethodType


LAB = Path(__file__).resolve().parent


def extract(path, name, scope, owner=None):
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    body = tree.body
    if owner:
        body = next(x for x in body if isinstance(x, ast.ClassDef) and x.name == owner).body
    function = copy.deepcopy(next(x for x in body if isinstance(x, ast.FunctionDef) and x.name == name))
    function.decorator_list = []
    compiled = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), function], type_ignores=[])
    exec(compile(ast.fix_missing_locations(compiled), str(path), "exec"), scope)
    return scope[name]


def verify(comfy_root, kj_root):
    import torch
    spec = importlib.util.spec_from_file_location("lab_sol_bridge_preflight", LAB / "sol_lowvram_bridge.py")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    paths = {
        "kj": kj_root / "nodes/minimax_nodes.py",
        "native": comfy_root / "comfy/ldm/minimax/model.py",
        "sparse": comfy_root / "comfy_extras/nodes_sparse_attention.py",
    }
    # Real source control flow; deliberately small synthetic arithmetic.
    scope = {
        "_mod_scale_shift": lambda x, shift, scale, segments: x * (1 + scale) + shift,
        "_mod_gate": lambda x, gate, delta, segments: x + gate * delta,
    }
    old = extract(paths["kj"], "minimax_block_lowmem_forward", scope)
    native = extract(paths["native"], "forward", scope, owner="DiTBlock")
    if "attention" in inspect.signature(old).parameters:
        raise RuntimeError("Installed KJ already accepts attention; stop and reassess this pinned bridge")
    calls = {"dense": 0, "sparse": 0, "mlp": 0}

    class Block:
        def __init__(self):
            self.attn = self
        def adaln_proj(self, t):
            return tuple(torch.full((1, 4), value, dtype=torch.float32) for value in (.1, .2, .3, .4, .5, .6))
        def norm1(self, x): return x * .7
        def norm2(self, x): return x * .8
        def mlp(self, x):
            calls["mlp"] += 1
            return x * .9
        def __call__(self, h, rope_freqs=None, transformer_options=None):
            assert isinstance(h, list), "Dense KJ list hand-off was lost"
            calls["dense"] += 1
            return h.pop() * .25

    def sparse_attention(attn, h, rope, options, patch, block_index):
        assert isinstance(h, torch.Tensor), "Sparse producer received the KJ disposable list"
        calls["sparse"] += 1
        return h * .5

    scope["h3_eligible"] = lambda attn, x, rope, options, patch, index: options["test_sparse"]
    scope["h3_sparse_attention"] = sparse_attention
    factory = extract(paths["sparse"], "make_h3_block_patch", scope)
    block = Block()
    x, t, rope, segments = torch.arange(8, dtype=torch.float32).view(2, 4), object(), object(), object()
    rng = torch.random.get_rng_state().clone()
    bound = MethodType(old, block)
    try:
        bound(x.clone(), t, segments, rope, transformer_options={}, attention=None)
    except TypeError as exc:
        if "attention" not in str(exc): raise
        old_error = str(exc)
    else:
        raise AssertionError("The original failure did not reproduce")
    repaired = bridge.bridge_forward(bound, native)
    cases = []
    for name, sparse in (("dense_first_step", False), ("sparse_low", True), ("protected_dense_block", False), ("sparse_high", True)):
        calls.update(dense=0, sparse=0, mlp=0)
        options = {"test_sparse": sparse}
        args = {"img": x.clone(), "t_emb": t, "mod_segments": segments, "rope_freqs": rope, "transformer_options": options}
        def original_block(a):
            # Same attention keyword contract as the installed H3 block driver.
            return {"img": repaired(a["img"], a["t_emb"], a["mod_segments"], a["rope_freqs"],
                                     transformer_options=a["transformer_options"], attention=a.get("attention"))}
        result = factory(block, 2, object())(args, {"original_block": original_block})["img"]
        observed = dict(calls)
        if sparse:
            expected = native(block, x.clone(), t, segments, rope, transformer_options=options,
                              attention=lambda h, **kw: h * .5)
        else:
            expected = bound(x.clone(), t, segments, rope, transformer_options=options)
        assert torch.equal(result, expected), name
        assert observed == {"dense": int(not sparse), "sparse": int(sparse), "mlp": 1}, (name, observed)
        cases.append({"case": name, "calls": observed, "exact_synthetic_output_match": True})
    assert torch.equal(rng, torch.random.get_rng_state())
    return {
        "ok": True, "generation_submissions": 0, "h3_weighted_forwards": 0,
        "measurement_scope": "installed_source_dispatch_with_synthetic_cpu_ops",
        "old_error": old_error, "cases": cases,
        "source_sha256": {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in paths.items()},
        "source_paths": {key: str(path.resolve()) for key, path in paths.items()},
        "cuda_initialized": torch.cuda.is_initialized(),
        "limits": "No real model, sparse eligibility logic, kernel, model patch installation, or GPU memory/quality test.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-root", type=Path, required=True)
    parser.add_argument("--kj-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.comfy_root.resolve(), args.kj_root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in result.items() if k != "source_paths"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
