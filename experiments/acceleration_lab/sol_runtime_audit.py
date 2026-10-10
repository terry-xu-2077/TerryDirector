"""Read-only Sol capability audit. Never enables a backend or runs a model/kernel.

CLI: compare import-only Kitchen with the same process after Comfy quant_ops.
Opt-in lab startup: capture the objects already loaded in that server process.
An audit success is NOT permission to queue video, nor a kernel smoke result.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import sys
import traceback


SCHEMA = "terry_accel_sol_runtime_audit_v1"


def _fingerprint(path):
    if not path:
        return None
    path = Path(path).resolve()
    try:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return {"path": str(path), "sha256": digest.hexdigest()}
    except OSError as exc:
        return {"path": str(path), "error": f"{type(exc).__name__}: {exc}"}


def _function_info(function):
    if function is None:
        return None
    original = inspect.unwrap(function)
    try:
        path = inspect.getsourcefile(original)
        _lines, first_line = inspect.getsourcelines(original)
    except (OSError, TypeError):
        path, first_line = None, None
    return {"module": getattr(original, "__module__", None),
            "name": getattr(original, "__qualname__", type(original).__name__),
            "source": _fingerprint(path), "first_line": first_line}


def _version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def snapshot(torch, ck, label, *, modules=None):
    """Query only: CUDA device discovery may initialize its runtime, not tensors."""
    modules = sys.modules if modules is None else modules
    errors = []

    def query(name, function):
        try:
            return function()
        except Exception as exc:
            errors.append({"query": name, "error": f"{type(exc).__name__}: {exc}"})
            return None

    cuda_available = query("torch.cuda.is_available", torch.cuda.is_available)
    device = None
    capability = None
    device_name = None
    if cuda_available:
        index = query("cuda.current_device", torch.cuda.current_device)
        if index is not None:
            device = torch.device(f"cuda:{index}")
            capability = query("cuda.capability", lambda: list(torch.cuda.get_device_capability(device)))
            device_name = query("cuda.device_name", lambda: torch.cuda.get_device_name(device))
    registry = getattr(ck, "registry", None)
    backends = query("ck.list_backends", ck.list_backends)
    registered_available = query("registry.is_available(cuda)", lambda: bool(registry.is_available("cuda")))
    rules = query("registry.get_constraints(cuda,sol_attn)", lambda: registry.get_constraints("cuda", "sol_attn"))
    minimum = query("rules.min_compute_capability", lambda: list(rules.min_compute_capability)) if rules is not None else None
    cuda_module = getattr(ck, "_cuda_backend", None)
    ext = getattr(cuda_module, "_C", None)
    check = getattr(ck, "sol_attn_is_available", None)
    available = query("ck.sol_attn_is_available", lambda: bool(check(device))) if callable(check) else None
    if not callable(check):
        errors.append({"query": "ck.sol_attn_is_available", "error": "API missing"})
    cuda_state = (backends or {}).get("cuda", {})
    gates = {
        "torch_cuda_available": cuda_available,
        "registry_cuda_available_and_enabled": registered_available,
        "extension_loaded": getattr(cuda_module, "_EXT_AVAILABLE", None),
        "extension_has_sol_attn": hasattr(ext, "sol_attn"),
        "sol_constraints_present": rules is not None,
        "device_meets_minimum": (tuple(capability) >= tuple(minimum)) if capability is not None and minimum is not None else None,
    }
    failed = [name for name, value in gates.items() if value is False]
    # A diagnostic label, not a claim about the historical process or compiled binary.
    if available is True:
        status = "AVAILABLE_BY_CURRENT_PROCESS_CHECK_ONLY"
    elif cuda_state.get("disabled") is True:
        status = "CUDA_REGISTRY_DISABLED"
    elif available is False:
        status = "UNAVAILABLE_REVIEW_GATE_FIELDS"
    else:
        status = "AUDIT_INCOMPLETE"
    source_names = ("torch", "comfy_kitchen", "comfy_kitchen.registry", "comfy.quant_ops",
                    "comfy_extras.nodes_sparse_attention")
    sources = {name: _fingerprint(getattr(modules.get(name), "__file__", None)) for name in source_names}
    return {
        "label": label, "pid": os.getpid(), "utc": datetime.now(timezone.utc).isoformat(),
        "executable": sys.executable, "torch_version": str(getattr(torch, "__version__", "unknown")),
        "torch_cuda_build": getattr(torch.version, "cuda", None),
        "kitchen_distribution_version": _version("comfy-kitchen"),
        "device": str(device) if device is not None else None, "device_name": device_name,
        "compute_capability": capability, "sol_minimum_compute_capability": minimum,
        "quant_ops_loaded": modules.get("comfy.quant_ops") is not None,
        "backend_states": backends, "gate_fields": gates, "failed_gate_fields": failed,
        "sol_available": available, "status": status, "errors": errors,
        "sources": sources, "availability_function": _function_info(check),
        "chunked_function": _function_info(getattr(ck, "sol_attn_chunked", None)),
        "cuda_extension": _fingerprint(getattr(ext, "__file__", None)),
        "generation_allowed": False, "model_forwards": 0, "kernel_smoke_executed": False,
    }


def write_new(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Preserve old evidence. Callers must supply a new output name.
    with path.open("x", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def startup_audit_if_enabled():
    """Run in the explicitly installed LAB extension, never in production root."""
    if os.environ.get("TERRY_ACCEL_LAB_SOL_AUDIT") != "1":
        return None
    torch = sys.modules.get("torch")
    ck = sys.modules.get("comfy_kitchen")
    # Do not import dependencies here and accidentally change what is being observed.
    if torch is None or ck is None or sys.modules.get("comfy.quant_ops") is None:
        raise RuntimeError("Sol audit needs the server's already-loaded torch, Kitchen and quant_ops")
    import folder_paths
    current = snapshot(torch, ck, "live_lab_extension_registration_after_quant_ops")
    payload = {"schema": SCHEMA, "mode": "live_lab_registration", "generation_submissions": 0,
               "snapshots": [current], "generation_allowed": False,
               "scope": "Actual server objects at extension registration; later mutations are not observed."}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = Path(folder_paths.get_output_directory()) / ".acceleration_lab" / f"sol-runtime-audit-{os.getpid()}-{stamp}.json"
    write_new(path, payload)
    print(f"[TerryAccelLab] sol_runtime_audit pid={os.getpid()} status={current['status']} "
          f"sol_available={current['sol_available']} file={path} generation_allowed=false", flush=True)
    return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    root = args.comfy_root.resolve()
    if not (root / "comfy" / "quant_ops.py").is_file():
        parser.error("--comfy-root must contain comfy/quant_ops.py")
    if args.output.exists():
        parser.error("Output already exists; choose a new evidence filename")
    payload = {"schema": SCHEMA, "mode": "import_order_reproduction_not_full_server",
               "generation_submissions": 0, "generation_allowed": False, "snapshots": [],
               "scope": "Fresh child process: import Kitchen, then Comfy quant_ops; no server or model execution."}
    old_argv, old_path = sys.argv[:], sys.path[:]
    try:
        if sys.modules.get("comfy.quant_ops") is not None:
            raise RuntimeError("Use a fresh Python process; quant_ops was already loaded")
        sys.path.insert(0, str(root))
        # The script's private CLI flags must not leak into Comfy's own parser.
        sys.argv = [str(root / "main.py")]
        torch = importlib.import_module("torch")
        ck = importlib.import_module("comfy_kitchen")
        if sys.modules.get("comfy.quant_ops") is not None:
            raise RuntimeError("Kitchen import already loaded quant_ops; cannot capture a clean before state")
        payload["snapshots"].append(snapshot(torch, ck, "before_comfy_quant_ops_import"))
        importlib.import_module("comfy.quant_ops")
        payload["snapshots"].append(snapshot(torch, ck, "after_comfy_quant_ops_import"))
        before, after = payload["snapshots"]
        payload["availability_changed"] = before["sol_available"] != after["sol_available"]
        payload["cuda_disabled_changed"] = before["backend_states"]["cuda"]["disabled"] != after["backend_states"]["cuda"]["disabled"] if all(s["backend_states"] and "cuda" in s["backend_states"] for s in (before, after)) else None
        payload["audit_completed"] = not any(s["errors"] for s in payload["snapshots"])
    except Exception:
        payload["audit_completed"] = False
        payload["traceback"] = traceback.format_exc()
    finally:
        sys.argv, sys.path[:] = old_argv, old_path
    write_new(args.output, payload)
    print(json.dumps({"audit_completed": payload["audit_completed"], "output": str(args.output),
                      "generation_allowed": False, "availability_changed": payload.get("availability_changed")}, ensure_ascii=False))
    return 0 if payload["audit_completed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
