"""Best-effort, source-labeled extraction of Self-Lift timings from ComfyUI logs.

Only allowlisted performance messages are collected. Prompts and reference paths
are NEVER copied into the report. Missing or rotated logs are not fatal.
"""
from __future__ import annotations

from datetime import datetime
import os
from pathlib import Path
import re

STAMP = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\]\s+(.*)$")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
PATTERNS = (
    ("low_step", re.compile(r"\[selflift-Avatar timing\] low_resolution step (\d+)/(\d+)(?: \(includes setup\))?: ([\d.]+)s")),
    ("low_total", re.compile(r"\[selflift-Avatar timing\] low_resolution total: ([\d.]+)s")),
    ("upscale", re.compile(r"\[selflift-Avatar timing\] transition paired_lifts: ([\d.]+)s")),
    ("transition_total", re.compile(r"\[selflift-Avatar timing\] transition total: ([\d.]+)s")),
    ("high_step", re.compile(r"\[selflift-Avatar timing\] high_resolution step (\d+)/(\d+)(?: \(includes setup\))?: ([\d.]+)s")),
    ("high_total", re.compile(r"\[selflift-Avatar timing\] high_resolution total: ([\d.]+)s")),
    ("upscaler_config", re.compile(r"\[SelfLift upscaler\]\s*(.{0,400})")),
    ("ram_cleanup", re.compile(r"RAM清理完成\s*\[([^\]]+)\]")),
    ("cache_write", re.compile(r"\[TerryDirector Base\]\[Stream\] Segment ([^:]+): frames=(\d+) cache=([\d.]+)MB time=([\d.]+)s")),
    ("model_load", re.compile(r"Requested to load (MiniMaxH3(?:TEModel_|VideoVAE|AudioVAE)?|LatentResizer3D)")),
    ("model_staged", re.compile(r"Model (MiniMaxH3(?:TEModel_|VideoVAE|AudioVAE)?|LatentResizer3D) prepared for dynamic VRAM loading\. ([\d.]+)MB Staged")),
    ("compiler_breaks", re.compile(r"Comfy model compiler graph breaks: (\d+)")),
)


def extract_lines(text, clips, *, limit=7000):
    """Return only lines with known diagnostic signatures within clip timestamps.

    clips is a sequence with numeric wall_start and wall_end values. Timestamps
    in ComfyUI logging are local naive datetimes; .timestamp uses local time.
    The result contains no raw arbitrary log lines or generation prompts.
    """
    rows = [[] for _ in clips]
    if not clips:
        return rows
    for line in text.splitlines():
        match = STAMP.match(ANSI.sub("", line))
        if not match:
            continue
        message = match.group(2)
        signature = None
        for kind, expression in PATTERNS:
            signature = expression.search(message)
            if signature:
                break
        if signature is None:
            continue
        try:
            at = datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S.%f").timestamp()
        except (ValueError, OverflowError, OSError):
            continue
        owner = next(
            (i for i, clip in enumerate(clips)
             if clip.get("wall_start") is not None
             and clip["wall_start"] - 3 <= at
             and (clip.get("wall_end") or float("inf")) + 3 >= at),
            None,
        )
        if owner is None or len(rows[owner]) >= limit:
            continue
        values = signature.groups()
        event = {"at": match.group(1), "kind": kind}
        if kind in ("low_step", "high_step"):
            event.update(step=int(values[0]), total_steps=int(values[1]), seconds=float(values[2]))
        elif kind in ("low_total", "high_total", "upscale", "transition_total"):
            event["seconds"] = float(values[0])
        elif kind == "model_load":
            event["model"] = values[0]
        elif kind == "model_staged":
            event.update(model=values[0], staged_mb=float(values[1]))
        elif kind == "compiler_breaks":
            event["breaks"] = int(values[0])
        elif kind == "cache_write":
            event.update(clip_id=values[0], frames=int(values[1]),
                         cache_mb=float(values[2]), seconds=float(values[3]))
        elif kind == "ram_cleanup":
            event["summary"] = values[0][:150]
        elif kind == "upscaler_config":
            # Keep only numeric tuning flags, no arbitrary paths or prompt text.
            info = values[0]
            for key in ("mode", "chunk", "overlap", "windows", "estimated_workspace", "budget_window"):
                flag = re.search(r"(?:^|\s)" + key + r"=([^\s]+)", info)
                if flag:
                    event[key] = flag.group(1)[:60]
        rows[owner].append(event)
    return rows


def read_current_run_logs(clips):
    """Read up to 32 MiB from recent ComfyUI log files, never fail the run."""
    try:
        import folder_paths
        root = Path(folder_paths.get_user_directory())
        if not root.is_dir():
            return {"status": "未找到 ComfyUI user 日志目录", "files": [], "by_clip": [[] for _ in clips]}
        paths = sorted(
            root.glob("comfyui*.log"), key=lambda path: path.stat().st_mtime, reverse=True
        )[:4]
        if not paths:
            return {"status": "未找到 comfyui*.log", "files": [], "by_clip": [[] for _ in clips]}
        result = [[] for _ in clips]
        opened = []
        for path in paths:
            try:
                with path.open("rb") as stream:
                    stream.seek(0, os.SEEK_END)
                    stream.seek(max(0, stream.tell() - 32 * 1024 * 1024))
                    data = stream.read().decode("utf-8", errors="replace")
                parts = extract_lines(data, clips)
                for i, events in enumerate(parts):
                    result[i].extend(events)
                opened.append(path.name)
            except (OSError, PermissionError):
                continue
        for events in result:
            events.sort(key=lambda e: e["at"])
            # Reading multiple rotated logs should not duplicate the same line.
            seen = set()
            events[:] = [event for event in events
                         if not (tuple(sorted(event.items())) in seen or seen.add(tuple(sorted(event.items())))]
        return {
            "status": ("已关联 Self-Lift/模型/缓存日志" if any(result)
                       else "找到日志，但本轮没有可关联的性能记录"),
            "files": opened,
            "by_clip": result,
        }
    except Exception as exc:
        return {"status": "日志读取失败：" + str(exc), "files": [], "by_clip": [[] for _ in clips]}


def phase_summary(events):
    """Return durations from the external log, without inferring missing stages."""
    found = {}
    steps = {"low_step": [], "high_step": []}
    for event in events:
        kind = event.get("kind")
        if kind in ("low_step", "high_step"):
            steps[kind].append(event["seconds"])
        elif kind in ("low_total", "high_total", "upscale", "transition_total"):
            found[kind] = event["seconds"]
    found["low_steps"] = steps["low_step"]
    found["high_steps"] = steps["high_step"]
    return found
