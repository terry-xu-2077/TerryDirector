"""One tiny CUDA profiler/Event capability check; never loads a model."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    import torch
    result = {"python": sys.version, "torch": importlib.metadata.version("torch"),
              "cuda_available": torch.cuda.is_available(), "cuda_events_ms": None,
              "profiler_table_device_us": None, "gpu_kernel_trace_count": 0,
              "mode": "blocked", "errors": []}
    if not result["cuda_available"]:
        Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
        return 2
    device = torch.device("cuda:0")
    result["device"] = torch.cuda.get_device_name(device)
    result["capability"] = list(torch.cuda.get_device_capability(device))
    a = torch.arange(256 * 256, device=device, dtype=torch.float32).reshape(256, 256) / 65536
    b = torch.empty_like(a)
    start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
    try:
        activities = [torch.profiler.ProfilerActivity.CPU, torch.profiler.ProfilerActivity.CUDA]
        with torch.profiler.profile(activities=activities, record_shapes=False, profile_memory=False,
                                    with_stack=False, with_flops=False) as profile:
            start.record()
            b.copy_(a)
            c = b @ a
            end.record()
        end.synchronize()
        result["cuda_events_ms"] = start.elapsed_time(end)
        result["profiler_table_device_us"] = sum(float(getattr(x, "self_device_time_total", 0) or 0)
                                                  for x in profile.key_averages())
        trace = Path(args.output).with_suffix(".chrome.json")
        profile.export_chrome_trace(str(trace))
        data = json.loads(trace.read_text(encoding="utf-8"))
        events = data.get("traceEvents", [])
        kernels = [x for x in events if x.get("cat", "").lower() in ("kernel", "gpu_kernel")]
        result["gpu_kernel_trace_count"] = len(kernels)
        result["gpu_kernel_examples"] = [x.get("name") for x in kernels[:4]]
        result["chrome_trace_local"] = str(trace)
    except Exception as exc:
        result["errors"].append(type(exc).__name__ + ": " + str(exc))
        try:
            start.record(); b.copy_(a); c = b @ a; end.record(); end.synchronize()
            result["cuda_events_ms"] = start.elapsed_time(end)
        except Exception as second:
            result["errors"].append(type(second).__name__ + ": " + str(second))
    if result["cuda_events_ms"] is not None and result["cuda_events_ms"] > 0:
        result["mode"] = "cpu_cuda" if result["gpu_kernel_trace_count"] > 0 else "cpu_events"
    result["tensor_bytes_upper_bound"] = 3 * 256 * 256 * 4
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "chrome_trace_local"}, indent=2))
    return 0 if result["mode"] != "blocked" else 2


if __name__ == "__main__":
    raise SystemExit(main())
