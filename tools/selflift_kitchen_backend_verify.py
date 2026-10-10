"""Opt-in identity and call-count verification for the actual Kitchen MODEL path.

No profiler, CUDA events, synchronization, model evaluation, or tensor copies.
Only small scalar metadata and the existing CPU sigma schedule are recorded.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
import inspect
import json
import os
from pathlib import Path
import threading

_ACTIVE = ContextVar("td_kitchen_verify_active", default=None)
_IN_ALIAS = ContextVar("td_kitchen_verify_inside_model_alias", default=False)
_LOCK = threading.RLock()
_TRACE = None
_PATH = None
_PATCHES = []
_PINNED_PROMPT = None
_INSTALLED = False
_REGISTRY_FUNCTION = None
_TARGET_DIRECTOR = None
_TARGET_SEGMENT = None


def enabled():
    return os.environ.get("TERRYDIRECTOR_TRACE") == "1" and os.environ.get("TERRYDIRECTOR_BACKEND_VERIFY") == "1"


def source(function):
    value = inspect.unwrap(function)
    return f"{getattr(value, '__module__', type(value).__module__)}.{getattr(value, '__qualname__', type(value).__qualname__)}"


def tensor_meta(value):
    if not hasattr(value, "shape"):
        return None
    return {"shape": [int(v) for v in value.shape], "dtype": str(value.dtype),
            "stride": [int(v) for v in value.stride()], "device": str(value.device)}


def output_file():
    global _PATH
    if _PATH is None:
        import folder_paths
        root = Path(os.environ.get("TERRYDIRECTOR_BACKEND_VERIFY_DIR") or
                    (Path(folder_paths.get_output_directory()) / ".terrydirector_backend_verify"))
        root.mkdir(parents=True, exist_ok=True)
        _PATH = root / f"kitchen-{os.getpid()}.jsonl"
    return _PATH


def write(record):
    with _LOCK:
        with output_file().open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")


def _patch(owner, name, replacement):
    original = owner[name] if isinstance(owner, dict) else getattr(owner, name)
    if isinstance(owner, dict):
        owner[name] = replacement
    else:
        setattr(owner, name, replacement)
    _PATCHES.append((owner, name, original))
    return original


def _restore_to(size):
    while len(_PATCHES) > size:
        owner, name, original = _PATCHES.pop()
        if isinstance(owner, dict):
            owner[name] = original
        else:
            setattr(owner, name, original)


def _record(kind, function, args, kwargs):
    state = _ACTIVE.get()
    if state is None or (kind not in ("kj_optimized_attention_alias", "fallback_missing_or_changed_override")
                         and not _IN_ALIAS.get()):
        return
    state["counts"][kind] = state["counts"].get(kind, 0) + 1
    if kind not in state["first_calls"]:
        state["first_calls"][kind] = {
            "function": source(function),
            "qkv": [tensor_meta(v) for v in args[:3]] if kind.startswith("kitchen_api") else None,
            "mask_present": kwargs.get("attn_mask") is not None if kind.startswith("kitchen_api") else None,
        }


def _wrap(kind, function):
    @wraps(function)
    def call(*args, **kwargs):
        _record(kind, function, args, kwargs)
        return function(*args, **kwargs)
    return call


def _wrap_alias(function):
    @wraps(function)
    def call(*args, **kwargs):
        state = _ACTIVE.get()
        if state is not None:
            _record("kj_optimized_attention_alias", function, args, kwargs)
            options = kwargs.get("transformer_options")
            if not isinstance(options, dict) or options.get("optimized_attention_override") is not state["override_object"]:
                _record("fallback_missing_or_changed_override", function, args, kwargs)
        token = _IN_ALIAS.set(True)
        try:
            return function(*args, **kwargs)
        finally:
            _IN_ALIAS.reset(token)
    return call


def _model_state(model):
    import comfy.ldm.modules.attention as attention
    options = model.model_options["transformer_options"]
    override = options.get("optimized_attention_override")
    if not callable(override):
        raise RuntimeError("Kitchen verify: final MODEL has no attention override")
    closure = inspect.getclosurevars(override).nonlocals
    inner = closure.get("optimized_attention")
    if inner is not _REGISTRY_FUNCTION or inner is not attention.get_attention_function("comfy_kitchen_int8", None):
        raise RuntimeError("Kitchen verify: final MODEL override is not registered Kitchen function")
    if options.get("minimax_head_chunks") != 4:
        raise RuntimeError("Kitchen verify: final MODEL head_chunks is not 4")
    patches = model.object_patches
    block = next((v for k, v in patches.items() if k == "diffusion_model.blocks.0.attn.forward"), None)
    if block is None:
        raise RuntimeError("Kitchen verify: LowVRAM attention patch missing")
    alias_globals = getattr(block, "__func__", block).__globals__
    if "optimized_attention" not in alias_globals:
        raise RuntimeError("Kitchen verify: real LowVRAM from-import attention alias unavailable")
    attn_count = sum(k.startswith("diffusion_model.blocks.") and k.endswith(".attn.forward") for k in patches)
    ffn_count = sum(k.startswith("diffusion_model.blocks.") and k.endswith(".mlp.forward") for k in patches)
    if attn_count != 50 or ffn_count != 50:
        raise RuntimeError(f"Kitchen verify: expected 50 LowVRAM and FFN patches, got {attn_count}/{ffn_count}")
    return override, alias_globals, {"override": source(override), "inner": source(inner),
        "head_chunks": options["minimax_head_chunks"], "attention_patches": attn_count,
        "ffn_patches": ffn_count, "alias": source(alias_globals["optimized_attention"])}


@contextmanager
def sampling_phase(phase, values):
    global _PINNED_PROMPT
    if not enabled() or phase not in ("low_sampling", "high_sampling"):
        yield
        return
    ident = _TRACE.identity()
    if str(ident.get("director_id")) != _TARGET_DIRECTOR or ident.get("segment_id") != _TARGET_SEGMENT:
        yield
        return
    with _LOCK:
        if _PINNED_PROMPT is None:
            _PINNED_PROMPT = ident.get("prompt_id")
        is_target_prompt = ident.get("prompt_id") == _PINNED_PROMPT
    if not is_target_prompt:
        yield
        return
    override, alias_globals, model_info = _model_state(values["model"])
    sigmas = values["sigmas"]
    sigma_values = [float(v) for v in sigmas.detach().tolist()] if sigmas.device.type == "cpu" else None
    state = {"event": "backend_phase", "utc_start": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
             "prompt_id": ident["prompt_id"], "director_id": ident["director_id"],
             "segment_id": ident["segment_id"], "phase": phase, "model": model_info,
             "sigma_values": sigma_values, "sigma_device": str(sigmas.device), "counts": {},
             "first_calls": {}, "callback_count": 0, "first_callback_check_ok": None,
             "override_object": override}
    mark = len(_PATCHES)
    original_alias = alias_globals["optimized_attention"]
    _patch(alias_globals, "optimized_attention", _wrap_alias(original_alias))
    token = _ACTIVE.set(state)
    original_error = None
    try:
        yield
        if state["callback_count"] == 0 or not state["first_callback_check_ok"]:
            raise RuntimeError("Kitchen verify: diagnostic_incomplete; no valid first callback")
    except BaseException as exc:
        original_error = exc
        raise
    finally:
        _ACTIVE.reset(token)
        _restore_to(mark)
        state.pop("override_object")
        state["utc_end"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        state["error"] = type(original_error).__name__ + ": " + str(original_error) if original_error else None
        try:
            write(state)
            _TRACE.event("backend_phase", phase=phase, counts=state["counts"],
                         first_callback_check_ok=state["first_callback_check_ok"],
                         error=state["error"], verifier_file=str(output_file()))
        except Exception:
            if original_error is None:
                raise


def on_callback(count):
    state = _ACTIVE.get()
    if state is None:
        return
    state["callback_count"] = count
    if count != 1:
        return
    calls = state["counts"]
    api = calls.get("kitchen_api_regular", 0) + calls.get("kitchen_api_prequantize", 0)
    ext = calls.get("kitchen_extension_sdpa", 0) + calls.get("kitchen_extension_prequantized", 0)
    fallback = sum(v for k, v in calls.items() if k.startswith("fallback_"))
    ok = api > 0 and ext > 0 and calls.get("kj_optimized_attention_alias", 0) > 0 and fallback == 0
    state["first_callback_check_ok"] = ok
    _TRACE.event("backend_callback_check", phase=state["phase"], callback_index=1,
                 ok=ok, api_calls=api, extension_calls=ext, fallback_calls=fallback)
    if not ok:
        _TRACE.event("diagnostic_incomplete", phase=state["phase"], counts=calls)
        raise RuntimeError("Kitchen verify: diagnostic_incomplete or fallback; stop without retry")


def install(trace):
    global _TRACE, _INSTALLED, _REGISTRY_FUNCTION, _TARGET_DIRECTOR, _TARGET_SEGMENT
    if not enabled() or _INSTALLED:
        return False
    import comfy.ldm.modules.attention as attention
    import comfy_kitchen
    import comfy_kitchen.sage_attention as sage
    import torch.nn.functional as functional
    if not attention.COMFY_KITCHEN_INT8_ATTENTION_IS_AVAILABLE:
        raise RuntimeError("Kitchen verify: Kitchen attention unavailable")
    registered = attention.get_attention_function("comfy_kitchen_int8", None)
    if registered is None or registered is not attention.attention_comfy_kitchen_int8:
        raise RuntimeError("Kitchen verify: registered attention function mismatch")
    if comfy_kitchen.int8_attention is not sage.int8_attention:
        raise RuntimeError("Kitchen verify: Kitchen package API alias mismatch")
    _TARGET_DIRECTOR = os.environ.get("TERRYDIRECTOR_BACKEND_VERIFY_DIRECTOR")
    _TARGET_SEGMENT = os.environ.get("TERRYDIRECTOR_BACKEND_VERIFY_SEGMENT", "clip-1")
    if not _TARGET_DIRECTOR:
        raise RuntimeError("Kitchen verify: missing target director ID")
    _TRACE, _REGISTRY_FUNCTION = trace, registered
    try:
        for owner, name, kind in (
            (comfy_kitchen, "int8_attention", "kitchen_api_regular"),
            (sage, "int8_attention", "kitchen_api_regular"),
            (comfy_kitchen, "prequantize_int8_attention", "kitchen_api_prequantize"),
            (sage, "prequantize_int8_attention", "kitchen_api_prequantize"),
            (comfy_kitchen, "int8_attention_from_prequantized", "kitchen_api_from_prequantized"),
            (sage, "int8_attention_from_prequantized", "kitchen_api_from_prequantized"),
            (sage._cuda_backend._C, "sage_sdpa", "kitchen_extension_sdpa"),
            (sage._cuda_backend._C, "sage_sdpa_quantize", "kitchen_extension_quantize"),
            (sage._cuda_backend._C, "sage_sdpa_prequantized", "kitchen_extension_prequantized"),
            (attention, "attention_pytorch", "fallback_attention_pytorch"),
            (attention, "attention_sage", "fallback_attention_sage"),
            (functional, "scaled_dot_product_attention", "fallback_torch_sdpa"),
        ):
            _patch(owner, name, _wrap(kind, getattr(owner, name)))
    except BaseException:
        _restore_to(0)
        raise
    _INSTALLED = True
    trace.event("backend_verify_ready", adapter_version=1, target_director=_TARGET_DIRECTOR,
                target_segment=_TARGET_SEGMENT, registered_function=source(registered),
                kitchen_api=source(sage.int8_attention),
                extension_module=str(Path(sage._cuda_backend._C.__file__).resolve()),
                attention_module=str(Path(attention.__file__).resolve()),
                observer_module=str(Path(__file__).resolve()),
                covered=["real KJ optimized_attention alias", "Kitchen regular/prequantized APIs",
                         "Kitchen CUDA extension sage_sdpa/quantize/prequantized",
                         "Comfy PyTorch/Sage and torch SDPA fallback entrants"],
                heavy_profiler=False, cuda_synchronize=False)
    return True


def uninstall():
    global _INSTALLED
    _restore_to(0)
    _INSTALLED = False
