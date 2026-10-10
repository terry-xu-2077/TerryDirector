"""Opt-in, two-window H3 operator attribution for an existing trace run.

No model or CUDA imports occur unless both diagnostic switches are enabled.
The original forward and every leaf are invoked exactly once. Captures contain
scalar metadata only; tensors never leave the call stack.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
import hashlib
import inspect
import json
import os
from pathlib import Path
import threading
import time

_PHASE = ContextVar("td_op_phase", default=None)
_CALLBACK = ContextVar("td_op_callback", default=None)
_COUNTS = {}
_LOCK = threading.RLock()
_INSTALLED = False
_ORIGINAL = None
_TRACE = None
_MODE = None
_PATH = None


def enabled():
    return os.environ.get("TERRYDIRECTOR_OP_PROFILE") == "1" and os.environ.get("TERRYDIRECTOR_TRACE") == "1"


def scalar_tensor(value):
    if not hasattr(value, "shape"):
        return None
    return {"shape": [int(x) for x in value.shape], "dtype": str(value.dtype),
            "device": str(value.device), "stride": [int(x) for x in value.stride()]}


def file_path():
    global _PATH
    if _PATH is None:
        import folder_paths
        root = Path(os.environ.get("TERRYDIRECTOR_OP_PROFILE_DIR") or
                    (Path(folder_paths.get_output_directory()) / ".terrydirector_op_profile"))
        root.mkdir(parents=True, exist_ok=True)
        _PATH = root / f"op-{os.getpid()}.jsonl"
    return _PATH


def write(record):
    with _LOCK:
        with file_path().open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")


@contextmanager
def sampling_phase(name, callback_count):
    a = _PHASE.set(name)
    b = _CALLBACK.set(callback_count)
    try:
        yield
    finally:
        _CALLBACK.reset(b)
        _PHASE.reset(a)


def _source_name(function):
    function = inspect.unwrap(function)
    return f"{function.__module__}.{function.__qualname__}"


class Window:
    def __init__(self, phase, forward_index, callback_index, model, x, timestep, options):
        self.phase, self.forward_index, self.callback_index = phase, forward_index, callback_index
        self.model, self.x, self.timestep, self.options = model, x, timestep, options
        self.rows, self.hooks, self.scopes, self.patches = [], [], [], []
        self.counts = {"attention": 0, "mlp": 0, "sage_leaf": 0, "qkv_proj": 0, "out_proj": 0, "fc1": 0, "fc2": 0}
        self.host_begin_ns = time.perf_counter_ns()
        self.profiler = None
        self.torch = None
        self.device = None
        self.profiler_error = None

    def _events(self, input_value):
        import torch
        item = input_value[0] if isinstance(input_value, (list, tuple)) else input_value
        if not hasattr(item, "device") or item.device.type != "cuda":
            return None
        device = item.device
        begin = torch.cuda.Event(enable_timing=True)
        end = torch.cuda.Event(enable_timing=True)
        begin.record(torch.cuda.current_stream(device))
        return (begin, end, device)

    def _begin(self, kind, input_value, *, extra=None):
        from torch.profiler import record_function
        row = {"kind": kind, "host_start_ns": time.perf_counter_ns(),
               "input": scalar_tensor(input_value[0] if isinstance(input_value, (list, tuple)) else input_value)}
        if extra:
            row.update(extra)
        row["events"] = self._events(input_value)
        scope = record_function("td_op." + kind)
        scope.__enter__()
        self.scopes.append(scope)
        return row

    def _end(self, row):
        row["host_end_ns"] = time.perf_counter_ns()
        if row["events"] is not None:
            row["events"][1].record(self.torch.cuda.current_stream(row["events"][2]))
        self.rows.append(row)
        self.counts[row["kind"]] += 1
        self.scopes.pop().__exit__(None, None, None)

    def _hook(self, module, kind, block_index):
        stack = []
        def pre(_module, args):
            stack.append(self._begin(kind, args, extra={"block_index": block_index}))
        def post(_module, args, output):
            if stack:
                self._end(stack.pop())
        self.hooks.append(module.register_forward_pre_hook(pre))
        self.hooks.append(module.register_forward_hook(post, always_call=True))

    def _install_hooks(self):
        for index, block in enumerate(self.model.blocks):
            for name in ("attn", "mlp"):
                if hasattr(block, name):
                    self._hook(getattr(block, name), "attention" if name == "attn" else "mlp", index)
            for owner, names in ((getattr(block, "attn", None), ("qkv_proj", "out_proj")),
                                 (getattr(block, "mlp", None), ("fc1", "fc2"))):
                for name in names:
                    if owner is not None and hasattr(owner, name):
                        self._hook(getattr(owner, name), name, index)

    def _install_leaf(self):
        # The installed sageattn dispatcher looks up these globals at call time.
        # Only candidate leaves are wrapped. No extra attention call is made.
        import sageattention.core as core
        for name in ("sageattn_qk_int8_pv_fp16_cuda", "sageattn_qk_int8_pv_fp16_triton",
                     "sageattn_qk_int8_pv_fp8_cuda", "sageattn_qk_int8_pv_fp8_cuda_sm90"):
            original = getattr(core, name, None)
            if original is None:
                continue
            @wraps(original)
            def leaf(*args, __original=original, __name=name, **kwargs):
                inputs = [scalar_tensor(x) for x in args[:3]]
                row = self._begin("sage_leaf", args, extra={"function": "sageattention.core." + __name,
                    "qkv": inputs, "tensor_layout": kwargs.get("tensor_layout"),
                    "is_causal": kwargs.get("is_causal"), "has_attn_mask": kwargs.get("attn_mask") is not None,
                    "pv_accum_dtype": kwargs.get("pv_accum_dtype")})
                try:
                    return __original(*args, **kwargs)
                finally:
                    self._end(row)
            setattr(core, name, leaf)
            self.patches.append((core, name, original))

    def __enter__(self):
        try:
            import torch
            self.torch = torch
            self.device = self.x[0].device
            self._install_hooks()
            self._install_leaf()
            activities = [torch.profiler.ProfilerActivity.CPU]
            if _MODE == "cpu_cuda":
                activities.append(torch.profiler.ProfilerActivity.CUDA)
            self.profiler = torch.profiler.profile(activities=activities, record_shapes=False,
                profile_memory=False, with_stack=False, with_flops=False)
            self.profiler.__enter__()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, kind, error, tb):
        cleanup_begin = time.perf_counter_ns()
        for handle in self.hooks:
            handle.remove()
        for owner, name, original in reversed(self.patches):
            setattr(owner, name, original)
        for scope in reversed(self.scopes):
            scope.__exit__(kind, error, tb)
        if self.profiler is not None:
            try:
                self.profiler.__exit__(kind, error, tb)
            except Exception as exc:
                self.profiler_error = type(exc).__name__ + ": " + str(exc)
        self.cleanup_ms = (time.perf_counter_ns() - cleanup_begin) / 1e6
        return False

    def result(self, original_error=None):
        resolve_begin = time.perf_counter_ns()
        rows = []
        chrome_file = None
        gpu_kernels = []
        copies_waits = []
        try:
            self.torch.cuda.synchronize(self.device)
            for row in self.rows:
                pair = row.pop("events")
                row["host_wall_ms"] = (row["host_end_ns"] - row["host_start_ns"]) / 1e6
                row["cuda_event_ms"] = pair[0].elapsed_time(pair[1]) if pair else None
                rows.append(row)
            top = []
            if self.profiler is not None and self.profiler_error is None:
                averages = list(self.profiler.key_averages())
                def operator(item):
                    device_us = getattr(item, "self_device_time_total", None)
                    return {"name": item.key, "calls": item.count,
                            "self_cpu_ms": item.self_cpu_time_total / 1000,
                            "self_device_ms": device_us / 1000 if device_us is not None and _MODE == "cpu_cuda" else None}
                top = [operator(x) for x in sorted(averages, key=lambda x: x.self_cpu_time_total, reverse=True)[:20]]
                copies_waits = [operator(x) for x in averages if any(k in x.key.lower() for k in
                                 ("copy", "memcpy", "synchroniz", "wait", "aten::to"))]
                if _MODE == "cpu_cuda":
                    chrome_file = file_path().with_name(f"op-{os.getpid()}-{self.phase}-{self.forward_index}.chrome.json")
                    self.profiler.export_chrome_trace(str(chrome_file))
                    chrome = json.loads(chrome_file.read_text(encoding="utf-8"))
                    gpu_kernels = [{"name": e.get("name"), "duration_us": e.get("dur")}
                                   for e in chrome.get("traceEvents", [])
                                   if e.get("cat", "").lower() in ("kernel", "gpu_kernel")]
        except Exception as exc:
            self.profiler_error = self.profiler_error or type(exc).__name__ + ": " + str(exc)
            top = []
        result = {"event": "operator_window", "utc": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                  "prompt_id": _TRACE.identity()["prompt_id"], "segment_id": _TRACE.identity()["segment_id"],
                  "phase": self.phase, "forward_index": self.forward_index, "callback_index_at_start": self.callback_index,
                  "sigma_timestep": scalar_tensor(self.timestep), "sigma_timestep_values":
                  [float(v) for v in self.timestep.detach().flatten()[:4].cpu().tolist()],
                   "latents": [scalar_tensor(v) for v in self.x], "block_count": len(self.model.blocks),
                   "effective_head_chunks": self.options.get("minimax_head_chunks") if isinstance(self.options, dict) else None,
                   "effective_override": _source_name(self.options["optimized_attention_override"])
                   if isinstance(self.options, dict) and callable(self.options.get("optimized_attention_override")) else "NOT_OBSERVED",
                  "counts": self.counts, "mode": _MODE, "module_calls": rows, "top20": top,
                  "copy_wait_operators": copies_waits,
                  "gpu_kernel_trace_count": len(gpu_kernels), "gpu_kernel_top20":
                  sorted(gpu_kernels, key=lambda x: x.get("duration_us") or 0, reverse=True)[:20],
                  "chrome_trace_local": str(chrome_file) if chrome_file else None,
                  "host_window_ms": (time.perf_counter_ns() - self.host_begin_ns) / 1e6,
                  "cleanup_ms": self.cleanup_ms, "resolve_ms": (time.perf_counter_ns() - resolve_begin) / 1e6,
                  "profiler_error": self.profiler_error, "forward_error": type(original_error).__name__ if original_error else None}
        result["capture_ok"] = (self.counts["attention"] > 0 and self.counts["mlp"] > 0 and
                                self.counts["sage_leaf"] > 0 and any(x["cuda_event_ms"] is not None for x in rows)
                                and self.profiler_error is None and original_error is None)
        write(result)
        _TRACE.event("operator_window", phase=self.phase, forward_index=self.forward_index,
                     capture_ok=result["capture_ok"], counts=self.counts, mode=_MODE,
                     operator_file=str(file_path()))
        return result


def wrap_forward(function):
    @wraps(function)
    def call(*args, **kwargs):
        phase = _PHASE.get()
        if not enabled() or phase not in ("low_sampling", "high_sampling"):
            return function(*args, **kwargs)
        ident = _TRACE.identity()
        key = (ident["prompt_id"], ident["segment_id"], phase)
        with _LOCK:
            index = _COUNTS.get(key, 0) + 1
            _COUNTS[key] = index
        target = 2 if phase == "low_sampling" else 1
        if index != target:
            return function(*args, **kwargs)
        bound = inspect.signature(function).bind(*args, **kwargs).arguments
        capture = Window(phase, index, _CALLBACK.get()(), bound["self"], bound["x"],
                         bound["timestep"], bound.get("transformer_options", {}))
        try:
            with capture:
                value = function(*args, **kwargs)
        except BaseException as exc:
            try:
                capture.result(exc)
            except Exception:
                pass  # Preserve the original generation error and traceback.
            raise
        result = capture.result()
        if not result["capture_ok"]:
            _TRACE.event("diagnostic_incomplete", phase=phase, forward_index=index,
                         profiler_error=result["profiler_error"], counts=result["counts"])
            raise RuntimeError("TerryDirector operator profile: diagnostic_incomplete; stop without retry")
        return value
    return call


def install(trace, mode):
    global _INSTALLED, _ORIGINAL, _TRACE, _MODE
    if not enabled() or _INSTALLED:
        return False
    if mode not in ("cpu_cuda", "cpu_events"):
        raise ValueError("TerryDirector operator profile: invalid capability mode")
    import comfy.ldm.minimax.model as h3
    _TRACE, _MODE = trace, mode
    _ORIGINAL = h3.MiniMaxH3Model.forward
    h3.MiniMaxH3Model.forward = wrap_forward(_ORIGINAL)
    _INSTALLED = True
    trace.event("op_profile_ready", adapter_version=1, mode=mode,
                module_path=str(Path(h3.__file__).resolve()), adapter_path=str(Path(__file__).resolve()),
                windows=[{"phase": "low_sampling", "forward_index": 2},
                         {"phase": "high_sampling", "forward_index": 1}],
                cuda_synchronize="once_after_each_window")
    return True


def uninstall():
    global _INSTALLED
    if not _INSTALLED:
        return
    import comfy.ldm.minimax.model as h3
    h3.MiniMaxH3Model.forward = _ORIGINAL
    _INSTALLED = False
