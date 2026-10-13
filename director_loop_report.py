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

GIB = 1024 ** 3
FIELDS = ("gpu_used", "torch_allocated", "torch_reserved", "ram_used", "process_rss")
ACTIVE = {}
ACTIVE_LOCK = threading.RLock()
ITERATION = re.compile(r"(?:^|\.)(\d+)_([^.]+)$")


def resource_snapshot():
    """No CUDA synchronization; all numbers are sampled rather than inferred."""
    result = {}
    try:
        import psutil
        ram = psutil.virtual_memory()
        result["ram_used"] = (ram.total - ram.available) / GIB
        result["ram_total"] = ram.total / GIB
        result["process_rss"] = psutil.Process(os.getpid()).memory_info().rss / GIB
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
    def __init__(self, loop_id, items, clock=None, sample_interval=2.0):
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
        self.clips = [
            {
                "id": str(item["id"]),
                "name": str(item.get("name") or ("片段 " + str(i + 1))),
                "frames": int(item.get("output_frames") or 0),
                "start": None,
                "end": None,
                "status": "未开始",
                "peak": {},
                "samplers": {},
                "node_stages": {},
            }
            for i, item in enumerate(items)
        ]

    def sample(self):
        snapshot = resource_snapshot()
        with self.lock:
            self.samples += 1
            if snapshot.get("gpu_name"):
                self.gpu_name = str(snapshot["gpu_name"])
            for name, value in snapshot.items():
                if name not in FIELDS and name not in ("gpu_total", "ram_total"):
                    continue
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    continue
                self.global_peak[name] = max(self.global_peak.get(name, value), value)
                for clip in self.clips:
                    if clip["start"] is not None and clip["end"] is None:
                        peak = clip["peak"]
                        peak[name] = max(peak.get(name, value), value)

    def start_monitor(self):
        self.sample()
        if self.thread is not None:
            return
        self.thread = threading.Thread(target=self._monitor, name="TDLoopProfiler", daemon=True)
        self.thread.start()

    def _monitor(self):
        while not self.stop_event.wait(self.sample_interval):
            self.sample()

    def clip_event(self, index, action):
        if not 0 <= index < len(self.clips):
            return
        if action == "end":
            self.sample()  # Capture the final active-segment memory snapshot.
        with self.lock:
            clip = self.clips[index]
            if action == "start" and clip["start"] is None:
                clip["start"] = self.clock()
                clip["status"] = "进行中"
            elif action == "end" and clip["start"] is not None and clip["end"] is None:
                clip["end"] = self.clock()
                clip["status"] = "已完成"
        if action == "start":
            self.sample()

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
            })
            if action == "end":
                item["end"] = now
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
                lines.append("- 自动保存：" + file_path)
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


def _save(report):
    import folder_paths
    directory = Path(folder_paths.get_output_directory()) / "TerryDirector" / "reports"
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.fromtimestamp(report.started_wall).strftime("%Y%m%d_%H%M%S")
    path = directory / ("loop_" + stamp + "_" + report.signature[:10] + ".md")
    result = report.markdown(str(path))
    temporary = path.with_suffix(".md.tmp")
    try:
        temporary.write_text(result, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return result


def _save_partial(report):
    with ACTIVE_LOCK:
        if ACTIVE.get(report.loop_id) is report:
            ACTIVE.pop(report.loop_id, None)
    report.close("中断或未完成")
    try:
        _save(report)
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
        return _save(report)
    except Exception as exc:
        print("[TerryDirector Loop][Report] 保存报告失败：" + str(exc), flush=True)
        return report.markdown() + "\n自动保存失败：" + str(exc) + "\n"
