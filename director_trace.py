"""Opt-in host-wall diagnostics for TerryDirector; no forced CUDA synchronization.

Enable TERRYDIRECTOR_TRACE=1 before starting ComfyUI. Disabled startup installs
nothing. Runtime wrappers use this extension's actual objects and the live node
registry, not a second imported copy of a custom-node package.
"""
from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
import importlib
import inspect
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid

_PARENT = ContextVar("td_trace_parent", default=None)
_ENGINE = ContextVar("td_trace_engine", default=None)
_LOCK = threading.RLock()
_SESSION = uuid.uuid4().hex
_PATH = None
_INSTALLED = False
_NATIVE_READY = False
_PLANS = OrderedDict()  # At most 16 prompts; contains identifiers only, no tensors.
_INDEX = re.compile(r"(?:^|\.)td_s(\d+)_")


def enabled():
    return os.environ.get("TERRYDIRECTOR_TRACE", "0") == "1"


def identity():
    from comfy_execution.utils import get_executing_context
    context = get_executing_context()
    prompt, node, index = (str(context.prompt_id), str(context.node_id), context.list_index) if context else (None, None, None)
    match = _INDEX.search(node or "")
    number = int(match[1]) if match else None
    owner = segment = None
    with _LOCK:
        candidates = _PLANS.get(prompt, {})
        for root in sorted(candidates, key=len, reverse=True):
            if node == root or (node or "").startswith(root + "."):
                owner = root
                segment = candidates[root]["segments"].get(number)
                break
    return dict(prompt_id=prompt, node_id=node, list_index=index,
                director_id=owner, segment_index=number, segment_id=segment)


def trace_path():
    global _PATH
    if _PATH is None:
        directory = os.environ.get("TERRYDIRECTOR_TRACE_DIR")
        if not directory:
            import folder_paths
            directory = str(Path(folder_paths.get_output_directory()) / ".terrydirector_trace")
        root = Path(directory).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        _PATH = root / f"trace-{os.getpid()}-{_SESSION}.jsonl"
    return _PATH


def event(kind, **data):
    if not enabled():
        return
    record = dict(version=1, session=_SESSION, pid=os.getpid(), thread_id=threading.get_ident(),
                  utc=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                  monotonic_ns=time.perf_counter_ns(), **identity(), event=kind, **data)
    with _LOCK:
        with trace_path().open("a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
    # Low-volume stage boundaries are also visible in the real backend console.
    if kind in {"begin", "end"} and data.get("name") in {
        "conditioning", "low_sampling", "latent_upscale", "high_sampling", "decode_cache", "final_output"
    }:
        print(f"[TerryDirector Trace] {record['node_id']} {data['name']} {kind} "
              f"{data.get('elapsed_s', '')}", flush=True)


def memory_snapshot():
    """Current-device snapshots, not interval peaks; never initialize CUDA."""
    try:
        import torch
        if not torch.cuda.is_initialized():
            return {"cuda_initialized": False}
        device = torch.cuda.current_device()
        free, total = torch.cuda.mem_get_info(device)
        return dict(device=device, allocated_bytes=torch.cuda.memory_allocated(device),
                    reserved_bytes=torch.cuda.memory_reserved(device),
                    cuda_free_bytes=free, cuda_total_bytes=total)
    except Exception as exc:
        return {"memory_error": type(exc).__name__}


@contextmanager
def span(name, **details):
    if not enabled():
        yield None
        return
    key, parent = uuid.uuid4().hex, _PARENT.get()
    event("begin", span_id=key, parent_id=parent, name=name, memory=memory_snapshot(), **details)
    token = _PARENT.set(key)
    start = time.perf_counter_ns()
    error = None
    try:
        yield key
    except BaseException as exc:
        error = exc
        raise
    finally:
        end = time.perf_counter_ns()
        _PARENT.reset(token)
        try:
            event("end", span_id=key, parent_id=parent, name=name,
                  start_ns=start, end_ns=end, elapsed_s=(end-start)/1e9,
                  status="error" if error is not None else "ok",
                  error_type=type(error).__name__ if error is not None else None,
                  memory=memory_snapshot())
        except Exception:
            if error is None:
                raise
            # Never mask the original OOM/interruption with a trace-write error.


def source(function):
    function = inspect.unwrap(function)
    return dict(module=function.__module__, qualname=function.__qualname__,
                file=inspect.getsourcefile(function))


def bind(function, args, kwargs):
    return inspect.signature(function).bind(*args, **kwargs).arguments


def model_info(values):
    try:
        models = list(values.get("models") or [])
        if "model" in values:
            models.append(values["model"])
        if "self" in values and hasattr(values["self"], "model"):
            models.append(values["self"].model)
        return [dict(patcher=type(m).__name__, model=type(m.model).__name__,
                     device=str(m.load_device), loaded_bytes=int(m.loaded_size()))
                for m in models if m is not None]
    except Exception as exc:
        return [{"snapshot_error": type(exc).__name__}]


def wrap(function, name, *, node=False, native=False, compile_node=False):
    if getattr(function, "_td_trace", False):
        return function

    @wraps(function)
    def call(*args, **kwargs):
        if not enabled():
            return function(*args, **kwargs)
        info = identity()
        if native and _PARENT.get() is None and info["segment_id"] is None:
            return function(*args, **kwargs)
        if not node and not native and _PARENT.get() is None:
            return function(*args, **kwargs)
        if compile_node:
            if info["prompt_id"] is None:
                raise RuntimeError("TerryDirector trace: no execution context; abort diagnostic run")
            install_native()
        values = bind(function, args, kwargs)
        details = {k: values[k] for k in ("cache_key", "run_signature") if k in values}
        # Encode/decode identify the video/audio VAE by its actual implementation.
        if name.startswith("vae_"):
            vae = values.get("self")
            details["vae_model"] = type(getattr(vae, "first_stage_model", None)).__name__
        if name.startswith("model_"):
            details["models_before"] = model_info(values)
        with span(name, implementation=source(function), **details) as key:
            result = function(*args, **kwargs)
            if name.startswith("model_"):
                event("model_return", span_id=key, name=name, models_after=model_info(values),
                      complete_unload=result if name == "model_unload_call" and isinstance(result, bool) else None)
        if name == "conditioning" and info["director_id"] is not None:
            with _LOCK:
                _PLANS[info["prompt_id"]][info["director_id"]]["conditioned"].add(info["segment_index"])
        return result
    call._td_trace = True
    return call


def patch(owner, name, label, **options):
    raw = inspect.getattr_static(owner, name)
    if isinstance(raw, classmethod):
        setattr(owner, name, classmethod(wrap(raw.__func__, label, **options)))
    else:
        setattr(owner, name, wrap(getattr(owner, name), label, **options))


def close_transition(state, error=None):
    pending = state.pop("transition", None)
    if pending is not None:
        pending.__exit__(type(error) if error is not None else None, error,
                         error.__traceback__ if error is not None else None)


def wrap_selflift(function):
    @wraps(function)
    def call(*args, **kwargs):
        if not enabled():
            return function(*args, **kwargs)
        if _INSTALLED:
            info = identity()
            plan = _PLANS.get(info["prompt_id"], {}).get(info["director_id"], {})
            if info["segment_index"] not in plan.get("conditioned", set()):
                raise RuntimeError("TerryDirector trace: missing fresh conditioning event; stop before sampling")
        state = {"calls": 0}
        token = _ENGINE.set(state)
        error = None
        try:
            with span("selflift", implementation=source(function)):
                try:
                    return function(*args, **kwargs)
                except BaseException as exc:
                    error = exc
                    raise
                finally:
                    close_transition(state, error)
        finally:
            _ENGINE.reset(token)
    call._td_trace = True
    return call


def wrap_sampler(function):
    @wraps(function)
    def call(*args, **kwargs):
        state = _ENGINE.get()
        if not enabled() or state is None:
            return function(*args, **kwargs)
        values = bind(function, args, kwargs)
        state["calls"] += 1
        phase = {1: "low_sampling", 2: "high_sampling"}.get(state["calls"], "extra_sampling")
        close_transition(state)
        original = values["callback"]
        count, last = 0, time.perf_counter_ns()
        with span(phase, sigma_count=int(values["sigmas"].numel()),
                  implementation=source(function)) as key:
            def callback(*cb_args, **cb_kwargs):
                nonlocal count, last
                now = time.perf_counter_ns()
                count += 1
                event("step_callback", span_id=key, name=phase, callback_index=count,
                      delta_s=(now-last)/1e9, first_includes_setup=count == 1,
                      boundary="callback_entry")
                last = now
                return original(*cb_args, **cb_kwargs)
            values["callback"] = callback
            result = function(**values)
            event("sampler_return", span_id=key, name=phase, callbacks=count,
                  tail_since_callback_s=(time.perf_counter_ns()-last)/1e9)
        if state["calls"] == 1:
            state["transition"] = span("resolution_transition")
            state["transition"].__enter__()
        return result
    call._td_trace = True
    return call


def wrap_plan(function):
    @wraps(function)
    def call(*args, **kwargs):
        if enabled():
            values, info = bind(function, args, kwargs), identity()
            segments = [{"id": s["id"], "index": s["index"]+1,
                         "h3_frames": s["h3_frames"], "output_frames": s["output_frames"]}
                        for s in values["plan"]["segments"]]
            with _LOCK:
                owners = _PLANS.setdefault(info["prompt_id"], {})
                owners[info["node_id"]] = {"segments": {s["index"]: s["id"] for s in segments}, "conditioned": set()}
                _PLANS.move_to_end(info["prompt_id"])
                while len(_PLANS) > 16:
                    _PLANS.popitem(last=False)
            event("plan", segments=segments)
        return function(*args, **kwargs)
    return call


def install_native():
    global _NATIVE_READY
    if _NATIVE_READY:
        return
    import nodes
    import comfy.model_management as mm
    import comfy.sd
    import torch
    for key, label in (("MiniMaxH3ReferenceToVideo", "conditioning"), ("MiniMaxH3AddGuide", "continuity_guide")):
        patch(nodes.NODE_CLASS_MAPPINGS[key], "execute", label, native=True)
    patch(comfy.sd.VAE, "encode", "vae_encode")
    patch(comfy.sd.VAE, "decode", "vae_decode")
    patch(mm, "load_models_gpu", "model_load_request")
    patch(mm.LoadedModel, "model_load", "model_load_call")
    patch(mm.LoadedModel, "model_unload", "model_unload_call")
    patch(torch, "save", "tensor_save")
    patch(torch, "load", "tensor_load")
    _NATIVE_READY = True
    event("native_trace_ready", source="live NODE_CLASS_MAPPINGS", cuda_synchronize=False)


def install(package, node_classes):
    global _INSTALLED
    if not enabled() or _INSTALLED:
        return
    engine = importlib.import_module(f"{package}.director_selflift")
    engine_node = importlib.import_module(f"{package}.director_selflift_node")
    lifter = importlib.import_module(f"{package}.director_selflift_upscaler")
    director = importlib.import_module(f"{package}.director_node")
    wrapped = wrap_selflift(engine.sample_selflift)
    engine.sample_selflift = wrapped
    engine_node.sample_selflift = wrapped  # Also replace the existing from-import alias.
    engine.ComfyBackend.sample = wrap_sampler(engine.ComfyBackend.sample)
    patch(lifter, "learned_lift", "latent_upscale")
    patch(lifter, "_load", "upscaler_weights")
    patch(lifter, "_offload_owned", "upscaler_offload")
    director.build_timeline_graph = wrap_plan(director.build_timeline_graph)
    targets = {"TerryDirector": "compile", "TerryDirectorAdvanced": "compile",
               "TerryDirectorCacheLatent": "latent_checkpoint",
               "TerryDirectorDecodeSegmentToCache": "decode_cache",
               "TerryDirectorDecodeAdvancedSegmentToCache": "decode_cache",
               "TerryDirectorMaterializeTimeline": "final_materialize",
               "TerryDirectorAdvancedLosslessFinish": "final_output"}
    for cls in node_classes:
        if cls.__name__ in targets:
            label = targets[cls.__name__]
            patch(cls, "execute", label, node=True, compile_node=label == "compile")
    event("trace_ready", clock="perf_counter_ns + timezone-aware UTC",
          timing="host_wall_no_forced_cuda_sync", trace_file=str(trace_path()),
          modules={m.__name__: m.__file__ for m in (engine, engine_node, lifter, director)})
    print(f"[TerryDirector Trace] enabled: {trace_path()}", flush=True)
    _INSTALLED = True
