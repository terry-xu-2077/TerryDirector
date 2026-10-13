"""TerryDirector external-loop performance reporting.

Observe real per-clip execution, ComfyUI native sampler progress, and resource
usage. This file does not modify any sampler or execute video decoding.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
import json
import math
import os
import re
import threading
import time
import platform
import sys
import statistics

GIB = 1024 ** 3
FIELDS = ("gpu_used", "torch_allocated", "torch_reserved", "ram_used", "process_rss",
          "swap_used", "gpu_util", "gpu_power", "proc_cpu_percent")
ACTIVE = {}
ACTIVE_LOCK = threading.RLock()
ITERATION = re.compile(r"(?:^|\.)(\d+)_([^.]+)$")
_NVML = None
_NVML_HANDLE = None
_NVML_TRIED = False


def _nvml_stats():
    """Optional NVML GPU utilization/power; initialization happens once."""
    global _NVML, _NVML_HANDLE, _NVML_TRIED
    if not _NVML_TRIED:
        _NVML_TRIED = True
        try:
            import pynvml
            pynvml.nvmlInit()
            _NVML = pynvml
            _NVML_HANDLE = pynvml.nvmlDeviceGetHandleByIndex(0)
        except Exception:
            _NVML = None
            _NVML_HANDLE = None
    if _NVML is None or _NVML_HANDLE is None:
        return {}
    try:
        util = _NVML.nvmlDeviceGetUtilizationRates(_NVML_HANDLE)
        result = {"gpu_util": float(util.gpu)}
        try:
            result["gpu_power"] = _NVML.nvmlDeviceGetPowerUsage(_NVML_HANDLE) / 1000.0
        except Exception:
            pass
        return result
    except Exception:
        return {}



def resource_snapshot():
    """No CUDA synchronization; all numbers are sampled rather than inferred."""
    result = {}
    try:
        import psutil
        ram = psutil.virtual_memory()
        result["ram_used"] = (ram.total - ram.available) / GIB
        result["ram_total"] = ram.total / GIB
        proc = psutil.Process(os.getpid())
        result["process_rss"] = proc.memory_info().rss / GIB
        cpu = proc.cpu_times()
        result["proc_cpu_seconds"] = cpu.user + cpu.system
        try:
            swap = psutil.swap_memory()
            result["swap_used"] = swap.used / GIB
            result["swap_total"] = swap.total / GIB
        except Exception:
            pass
        try:
            io = proc.io_counters()
            result["io_read_bytes"] = io.read_bytes
            result["io_write_bytes"] = io.write_bytes
        except Exception:
            pass
    except Exception:
        pass
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            result["gpu_used"] = (total - free) / GIB
            result["gpu_total"] = total / GIB
            result["torch_allocated"] = torch.cuda.memory_allocated() / GIB
            result["torch_reserved"] = torch.cuda.memory_reserved() / GIB
            result["gpu_name"] = torch.cuda.get_device_name()
    except Exception:
        pass
    result.update(_nvml_stats())
    return result


def is_sampler(node_type):
    name = str(node_type or "").lower()
    return "sampl" in name and not any(
        x in name for x in ("selector", "select", "scheduler", "loader", "config")
    )


def duration(seconds):
    if seconds is None:
        return "未采集"
    h, rem = divmod(max(0, int(round(seconds))), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def number(value, unit):
    return "未采集" if value is None else f"{value:.2f} {unit}"


def cell(text):
    return str(text or "").replace("|", "/").replace("\r", " ").replace("\n", " ")


class RunReport:
    def __init__(self, loop_id, items, clock=None, sample_interval=2.0, pipeline=None):
        if not items:
            raise ValueError("没有可采集的循环片段")
        self.loop_id = str(loop_id)
        self.signature = str(items[0]["_loop"]["run_signature"])
        self.clock = clock or time.perf_counter
        self.started = self.clock()
        self.started_wall = time.time()
        self.ended = None
        self.ended_wall = None
        self.status = "运行中"
        self.has_progress = False
        self.gpu_name = "未采集"
        self.sample_interval = max(1.0, float(sample_interval))
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = threading.RLock()
        self.global_peak = {}
        self.samples = 0
        self.sample_history = []
        self.events = []
        self.last_resource = None
        self.last_resource_time = None
        self.start_io = {}
        self.last_saved = self.started
        self.save_lock = threading.RLock()
        self.pipeline = pipeline or []
        self.source_log = {"status": "未检索日志", "files": [], "by_clip": []}
        self.environment = {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "cores": os.cpu_count(),
        }
        try:
            import torch
            self.environment["pytorch"] = str(torch.__version__)
            self.environment["cuda"] = str(getattr(torch.version, "cuda", "未知"))
        except Exception:
            pass
        self.clips = [
            {
                "id": str(item["id"]),
                "name": str(item.get("name") or ("片段 " + str(i + 1))),
                "frames": int(item.get("output_frames") or 0),
                "h3_frames": int(item.get("h3_frames") or 0),
                "seed": str(item.get("_loop", {}).get("seed", "")),
                "continuity": item.get("continuity", {}).get("kind", "未知"),
                "transition": item.get("transition_mode", ""),
                "gap_frames": int(item.get("assembly", {}).get("gap_before_frames") or 0),
                "trim_frames": int(item.get("assembly", {}).get("trim_head_frames") or 0),
                "start": None,
                "end": None,
                "wall_start": None,
                "wall_end": None,
                "status": "未开始",
                "peak": {},
                "samplers": {},
                "node_stages": {},
                "cache": {},
            }
            for i, item in enumerate(items)
        ]

    def sample(self):
        snapshot = resource_snapshot()
        now = self.clock()
        with self.lock:
            self.samples += 1
            if snapshot.get("gpu_name"):
                self.gpu_name = str(snapshot["gpu_name"])
            if self.last_resource is not None and self.last_resource_time is not None:
                span = now - self.last_resource_time
                prev = self.last_resource.get("proc_cpu_seconds")
                current = snapshot.get("proc_cpu_seconds")
                if span > 0 and prev is not None and current is not None:
                    # CPU usage may exceed 100% on multi-core workloads.
                    snapshot["proc_cpu_percent"] = max(0.0, (current - prev) / span * 100)
            self.last_resource = snapshot
            self.last_resource_time = now
            if not self.start_io:
                self.start_io = {key: snapshot[key] for key in ("io_read_bytes", "io_write_bytes")
                                 if key in snapshot}
            active = [i for i, c in enumerate(self.clips)
                      if c["start"] is not None and c["end"] is None]
            current_clip = active[-1] if active else None
            # Keep real chronological snapshots so stalls and memory trends
            # remain observable in the machine-readable companion JSON.
            sample = {"elapsed_s": round(now - self.started, 3),
                      "clip_index": current_clip}
            for key, value in snapshot.items():
                if isinstance(value, (int, float)) and math.isfinite(value):
                    sample[key] = round(float(value), 4)
            self.sample_history.append(sample)
            if len(self.sample_history) > 30000:
                self.sample_history.pop(0)
            for name, value in snapshot.items():
                if name not in FIELDS and name not in ("gpu_total", "ram_total", "swap_total"):
                    continue
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    continue
                self.global_peak[name] = max(self.global_peak.get(name, value), value)
                if current_clip is not None:
                    peak = self.clips[current_clip]["peak"]
                    peak[name] = max(peak.get(name, value), value)

    def start_monitor(self):
        self.sample()
        if self.thread is not None:
            return
        self.thread = threading.Thread(target=self._monitor, name="TDLoopProfiler", daemon=True)
        self.thread.start()

    def _monitor(self):
        while not self.stop_event.wait(self.sample_interval):
            try:
                self.sample()
                now = self.clock()
                if now - self.last_saved >= 90:
                    self.last_saved = now
                    _save(self)  # Periodic crash-resistant Markdown + JSON checkpoint.
            except Exception as exc:
                print("[TerryDirector Loop][Report] 后台采集或检查点失败：" + str(exc), flush=True)

    def clip_event(self, index, action):
        if not 0 <= index < len(self.clips):
            return
        if action == "end":
            self.sample()  # Capture the final active-segment memory snapshot.
        with self.lock:
            clip = self.clips[index]
            if action == "start" and clip["start"] is None:
                clip["start"] = self.clock()
                clip["wall_start"] = time.time()
                clip["status"] = "进行中"
            elif action == "end" and clip["start"] is not None and clip["end"] is None:
                clip["end"] = self.clock()
                clip["wall_end"] = time.time()
                clip["status"] = "已完成"
            self.events.append({"at": round(self.clock() - self.started, 3),
                                "clip_index": index, "kind": action})
        if action == "start":
            self.sample()
        elif action == "end":
            try:
                _save(self)  # Preserve each completed segment even on crash/abort.
            except Exception as exc:
                print("[TerryDirector Loop][Report] 片段检查点失败：" + str(exc), flush=True)

    def stage_event(self, index, node_id, node_type, action):
        if not 0 <= index < len(self.clips) or is_sampler(node_type):
            return
        # All copied loop-body nodes are measured, not just H3 or a specific
        # VAE. This allows identifying slow decoders and per-clip encoders.
        now = self.clock()
        with self.lock:
            stages = self.clips[index]["node_stages"]
            node = stages.get(str(node_id))
            if action == "start":
                if node is None:
                    stages[str(node_id)] = {"type": str(node_type), "start": now, "end": None}
            elif action == "end":
                if node is not None and node["end"] is None:
                    node["end"] = now
            self.events.append({"at": round(now - self.started, 3),
                                "clip_index": index, "kind": action,
                                "source": str(node_id), "type": str(node_type)})

    def sampler_event(self, index, node_id, node_type, action, value=None, maximum=None):
        if not 0 <= index < len(self.clips) or not is_sampler(node_type):
            return
        now = self.clock()
        with self.lock:
            nodes = self.clips[index]["samplers"]
            item = nodes.setdefault(str(node_id), {
                "type": str(node_type), "start": now, "end": None,
                "steps": 0, "step_seconds": 0.0, "intervals": [],
                "last_value": 0.0, "last_max": None, "last_time": now,
                "progress_timeline": [],
            })
            if action == "end":
                item["end"] = now
                self.events.append({"at": round(now - self.started, 3),
                                    "clip_index": index, "kind": "sampler_end",
                                    "source": str(node_id)})
                return
            if action != "progress":
                return
            try:
                progress = float(value)
                total = float(maximum)
            except (TypeError, ValueError):
                return
            if not math.isfinite(progress) or not math.isfinite(total) or total <= 0:
                return
            progress = max(0.0, min(progress, total))
            if len(item["progress_timeline"]) < 4096:
                item["progress_timeline"].append({
                    "elapsed_s": round(now - self.started, 3),
                    "step": progress, "total_steps": total,
                })
            if item["last_max"] is not None and (
                total != item["last_max"] or progress < item["last_value"]
            ):
                # Multi-pass samplers may reset progress between low/high passes.
                item["last_value"] = 0.0
                item["last_time"] = now
            step_delta = progress - item["last_value"]
            if step_delta >= 1.0:
                steps = int(step_delta)
                elapsed = max(0.0, now - item["last_time"])
                item["steps"] += steps
                item["step_seconds"] += elapsed
                if len(item["intervals"]) < 128:
                    item["intervals"].append(elapsed / steps)
            if progress != item["last_value"]:
                item["last_time"] = now
            item["last_value"] = progress
            item["last_max"] = total

    def close(self, status):
        with self.lock:
            if self.ended is not None:
                return
            self.ended = self.clock()
            self.ended_wall = time.time()
            self.status = status
        self.stop_event.set()
        if self.thread is not None and threading.current_thread() is not self.thread:
            self.thread.join(timeout=0.5)
        self.sample()

    def add_cache_result(self, index, *, elapsed=None, size_mb=None, frames=None):
        if not 0 <= index < len(self.clips):
            return
        with self.lock:
            clip = self.clips[index]
            clip["cache"] = {
                "time_s": None if elapsed is None else float(elapsed),
                "size_mb": None if size_mb is None else float(size_mb),
                "frames": None if frames is None else int(frames),
            }

    def raw(self):
        """Fully machine-readable diagnostic trace; never include prompt content."""
        with self.lock:
            payload = {
                "format": "terrydirector-loop-diagnostics",
                "version": 2,
                "loop_id": self.loop_id,
                "run_signature": self.signature,
                "status": self.status,
                "started_wall_unix": self.started_wall,
                "ended_wall_unix": self.ended_wall,
                "duration_seconds": (self.ended or self.clock()) - self.started,
                "sample_interval_seconds": self.sample_interval,
                "gpu_name": self.gpu_name,
                "environment": self.environment,
                "pipeline": self.pipeline,
                "global_peak": self.global_peak,
                "samples": self.sample_history,
                "events": self.events,
                "clips": self.clips,
                "source_log": self.source_log,
            }
            return json.loads(json.dumps(payload, ensure_ascii=False, allow_nan=False))

    @staticmethod
    def _log_phases(events):
        phases = {"low_step": [], "high_step": []}
        for event in events:
            kind = event.get("kind")
            if kind in ("low_step", "high_step"):
                phases[kind].append(event.get("seconds", 0))
            elif kind in ("low_total", "high_total", "upscale", "transition_total"):
                phases[kind] = event.get("seconds")
        return phases

    def _alerts(self):
        flags = []
        completed = [(i, c["end"] - c["start"]) for i, c in enumerate(self.clips)
                     if c["start"] is not None and c["end"] is not None]
        if len(completed) >= 3:
            typical = statistics.median(value for _, value in completed)
            if typical > 0:
                for i, seconds in completed:
                    if seconds > typical * 1.65:
                        flags.append(f"片段 {i + 1} 整段耗时 {duration(seconds)}，高于中位耗时 {seconds/typical:.2f} 倍。")
        gpu_peak, total = self.global_peak.get("gpu_used"), self.global_peak.get("gpu_total")
        if gpu_peak is not None and total and gpu_peak / total >= 0.9:
            flags.append(f"GPU 显存采样峰值达 {gpu_peak/total:.1%}（{gpu_peak:.2f}/{total:.2f} GiB），建议核对 WDDM/动态权重卸载。")
        ram_peak, total_ram = self.global_peak.get("ram_used"), self.global_peak.get("ram_total")
        if ram_peak is not None and total_ram and ram_peak / total_ram >= 0.85:
            flags.append(f"系统 RAM 峰值达 {ram_peak/total_ram:.1%}，需核查页面文件、解码缓冲及缓存。")
        for i, events in enumerate(self.source_log.get("by_clip") or []):
            phase = self._log_phases(events)
            if phase.get("upscale", 0) >= 90:
                flags.append(f"片段 {i + 1} Self-Lift Latent 升采样耗费 {phase['upscale']:.1f}s，明显偏长，可优先查显存交换。")
            if phase.get("high_total", 0) >= 300:
                flags.append(f"片段 {i + 1} Self-Lift 高清阶段耗费 {phase['high_total']:.1f}s。")
        missing = [i + 1 for i, c in enumerate(self.clips)
                   if c["end"] is not None and not any(s["steps"] for s in c["samplers"].values())]
        if missing:
            flags.append("这些已完成片段没有实测原生采样步数：" +
                         ", ".join(map(str, missing)) + "；请对照 Self-Lift 原生日志或提交 comfyui.log。")
        return flags[:30]

    def markdown(self, file_path=""):
        with self.lock:
            elapsed = (self.ended if self.ended is not None else self.clock()) - self.started
            started = datetime.fromtimestamp(self.started_wall).astimezone()
            ended = datetime.fromtimestamp(self.ended_wall).astimezone() if self.ended_wall else None
            lines = [
                "# TerryDirector 循环性能记录", "",
                "- 循环节点 ID：" + self.loop_id,
                "- 运行 ID：" + self.signature,
                "- 状态：" + self.status,
                "- 开始：" + started.isoformat(timespec="seconds"),
                "- 结束：" + (ended.isoformat(timespec="seconds") if ended else "未完成"),
                "- 总耗时：" + duration(elapsed),
                "- 片段完成数：" + str(sum(c["end"] is not None for c in self.clips)) + "/" + str(len(self.clips)),
                "- GPU：" + self.gpu_name,
                "- 资源采样：" + str(self.samples) + " 次（约每 " + str(self.sample_interval) + " 秒）",
            ]
            if file_path:
                lines.append("- Markdown 报告：" + file_path)
                lines.append("- 原始诊断 JSON：" + str(Path(file_path).with_suffix(".json")))
            lines.extend(["", "## 系统资源峰值", "", "| 指标 | 采集峰值 |", "| --- | ---: |"])
            fields = (
                ("gpu_used", "GPU 总占用（含其他进程）"),
                ("gpu_total", "GPU 总显存"),
                ("torch_allocated", "PyTorch 已分配显存"),
                ("torch_reserved", "PyTorch 已保留显存"),
                ("ram_used", "系统 RAM 已用"),
                ("ram_total", "系统 RAM 总量"),
                ("process_rss", "ComfyUI 进程 RSS"),
            )
            for key, label in fields:
                lines.append("| " + label + " | " + number(self.global_peak.get(key), "GiB") + " |")
            lines.extend([
                "", "## 逐片段汇总", "",
                "| 序号 | 片段 | 视频时长 | 整段耗时 | 采样器耗时 | 实测进度步数 | 实测 s/步 | GPU 占用峰值 | RAM 峰值 | 进程 RSS 峰值 |",
                "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ])
            completed_durations = []
            for i, clip in enumerate(self.clips):
                elapsed_clip = (
                    clip["end"] - clip["start"]
                    if clip["start"] is not None and clip["end"] is not None else None
                )
                if elapsed_clip is not None:
                    completed_durations.append(elapsed_clip)
                sampler_items = list(clip["samplers"].values())
                sampler_times = [s["end"] - s["start"] for s in sampler_items if s["end"] is not None]
                step_count = sum(s["steps"] for s in sampler_items)
                step_time = sum(s["step_seconds"] for s in sampler_items)
                step_speed = number(step_time / step_count, "s/步") if step_count else "未采集"
                values = [
                    str(i + 1),
                    cell(clip["name"]) + " (" + cell(clip["id"]) + ")",
                    number(clip["frames"] / 24.0, "s"),
                    duration(elapsed_clip),
                    number(sum(sampler_times), "s") if sampler_times else "未采集",
                    str(step_count) if step_count else "未采集",
                    step_speed,
                    number(clip["peak"].get("gpu_used"), "GiB"),
                    number(clip["peak"].get("ram_used"), "GiB"),
                    number(clip["peak"].get("process_rss"), "GiB"),
                ]
                lines.append("| " + " | ".join(values) + " |")
            lines.extend(["", "## 各段采样器、逐步速度与节点耗时", ""])
            for i, clip in enumerate(self.clips):
                lines.append("### " + str(i + 1) + ". " + cell(clip["name"]))
                if not clip["samplers"]:
                    lines.append("未收到采样器原生进度事件；不会推测采样每步速度。")
                for observation in clip["samplers"].values():
                    active_secs = (
                        observation["end"] - observation["start"]
                        if observation["end"] is not None else None
                    )
                    steps = observation["steps"]
                    speed = number(observation["step_seconds"] / steps, "s/步") if steps else "未采集"
                    lines.append("- " + cell(observation["type"]) + "：运行 " +
                                 number(active_secs, "s") + "；实测 " +
                                 (str(steps) if steps else "未采集") +
                                 " 步；平均 " + speed + "。")
                    if observation["intervals"]:
                        intervals = ", ".join(f"{x:.2f}" for x in observation["intervals"])
                        lines.append("  - 原生进度间隔（秒）：" + intervals)
                stage_times = []
                for node in clip["node_stages"].values():
                    if node["end"] is not None:
                        stage_times.append((max(0.0, node["end"] - node["start"]), node["type"]))
                if stage_times:
                    lines.append("- 其他节点执行时间（从慢到快，最多 12 项）：")
                    for seconds, node_type in sorted(stage_times, reverse=True)[:12]:
                        lines.append("  - " + cell(node_type) + "：" + number(seconds, "s"))
                lines.append("")
            lines.extend([
                "## 统计说明", "",
                "- 整段耗时：循环信息节点开始至内部循环缓存完成，包含外部采样器、VAE、用户额外输出、缓存，非单纯 GPU 采样时间。",
                "- 采样器耗时：ComfyUI 原生节点开始与结束事件测得，可能包含模型初始化、Self-Lift 多阶段与权重加载。",
                "- 每步速度：只根据原生采样进度实际增加的步数与时间间隔计算。未上报步数则显示未采集；第一步可能包含初始化。",
                "- GPU 总占用来自 CUDA 设备空闲量；PyTorch 显存仅包含 PyTorch 管理的当前进程内存。",
                "- 峰值为每约 2 秒非同步快照，可能漏掉更短暂的峰值。",
                "- 整个报告不包含循环之后由官方 SaveVideo 完成的最终编码时间。",
                "- 片段耗时合计：" + duration(sum(completed_durations)) +
                "；总耗时还包含首段前准备、片段衔接与结束处理。",
            ])
            if not self.has_progress:
                lines.append("- ComfyUI 原生进度接口未能接入，本次不提供实测步速。")
            return "\n".join(lines) + "\n"


def _save(report, include_logs=False):
    """Atomic MD + lossless JSON trace, same per-run filenames on checkpoint."""
    import folder_paths
    with report.save_lock:
        directory = Path(folder_paths.get_output_directory()) / "TerryDirector" / "reports"
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.fromtimestamp(report.started_wall).strftime("%Y%m%d_%H%M%S")
        path = directory / ("loop_" + stamp + "_" + report.signature[:10] + ".md")
        json_path = path.with_suffix(".json")
        if include_logs:
            try:
                from .director_loop_logmetrics import read_current_run_logs
            except ImportError:
                try:
                    from director_loop_logmetrics import read_current_run_logs
                except ImportError:
                    read_current_run_logs = None
            if read_current_run_logs is not None:
                with report.lock:
                    segments = [{"wall_start": x["wall_start"], "wall_end": x["wall_end"]}
                                for x in report.clips]
                logs = read_current_run_logs(segments)
                with report.lock:
                    report.source_log = logs
        content = report.markdown(str(path))
        raw = json.dumps(report.raw(), ensure_ascii=False, indent=2, allow_nan=False)
        for target, text in ((json_path, raw), (path, content)):
            temporary = target.with_name(target.name + ".tmp")
            try:
                temporary.write_text(text, encoding="utf-8")
                os.replace(temporary, target)
            finally:
                if temporary.exists():
                    temporary.unlink()
        return content


def _save_partial(report):
    with ACTIVE_LOCK:
        if ACTIVE.get(report.loop_id) is report:
            ACTIVE.pop(report.loop_id, None)
    report.close("中断或未完成")
    try:
        _save(report, include_logs=True)
    except Exception as exc:
        print("[TerryDirector Loop][Report] 保存未完成报告失败：" + str(exc), flush=True)


def _attach_native_handler(report):
    try:
        from comfy_execution.progress import ProgressHandler, add_progress_handler
    except Exception as exc:
        print("[TerryDirector Loop][Report] 原生采样进度接口不可用：" + str(exc), flush=True)
        return

    class Recorder(ProgressHandler):
        def __init__(self):
            super().__init__("td_loop_metrics_" + report.signature)
            self.registry = None

        def set_registry(self, registry):
            self.registry = registry

        def _event(self, node_id, kind, value=None, maximum=None):
            if report.ended is not None or self.registry is None:
                return
            match = ITERATION.search(str(node_id))
            if not match:
                return
            index = int(match.group(1))
            if index >= len(report.clips):
                return
            prompt = self.registry.dynprompt
            try:
                if str(prompt.get_real_node_id(node_id)) != report.loop_id:
                    return
                obj = prompt.get_node(node_id)
                node_type = obj.get("class_type", "") if isinstance(obj, dict) else ""
            except Exception:
                return
            if is_sampler(node_type):
                report.sampler_event(index, str(node_id), node_type, kind, value, maximum)
            elif kind in ("start", "end"):
                report.stage_event(index, str(node_id), node_type, kind)

        def start_handler(self, node_id, state, prompt_id):
            self._event(node_id, "start")

        def update_handler(self, node_id, value, max_value, state, prompt_id, image=None):
            self._event(node_id, "progress", value, max_value)

        def finish_handler(self, node_id, state, prompt_id):
            self._event(node_id, "end")

        def reset(self):
            if report.ended is None:
                _save_partial(report)

    try:
        add_progress_handler(Recorder())
        report.has_progress = True
    except Exception as exc:
        print("[TerryDirector Loop][Report] 注册进度处理器失败：" + str(exc), flush=True)


def start_report(loop_id, items):
    new = RunReport(loop_id, items)
    with ACTIVE_LOCK:
        old = ACTIVE.get(new.loop_id)
        ACTIVE[new.loop_id] = new
    if old is not None and old.ended is None:
        _save_partial(old)
    new.start_monitor()
    _attach_native_handler(new)


def mark_clip(loop_id, signature, index, status):
    with ACTIVE_LOCK:
        report = ACTIVE.get(str(loop_id))
    if report is not None and report.signature == str(signature):
        report.clip_event(int(index), "start" if status == "running" else "end")


def finish_report(loop_id, signature):
    with ACTIVE_LOCK:
        report = ACTIVE.get(str(loop_id))
        if report is not None and report.signature == str(signature):
            ACTIVE.pop(str(loop_id), None)
        else:
            report = None
    if report is None:
        return "# TerryDirector 循环性能记录\n\n未找到匹配的运行采样记录；视频输出不受影响。\n"
    report.close("已完成")
    try:
        return _save(report, include_logs=True)
    except Exception as exc:
        print("[TerryDirector Loop][Report] 保存报告失败：" + str(exc), flush=True)
        return report.markdown() + "\n自动保存失败：" + str(exc) + "\n"
