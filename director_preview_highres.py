"""Resolve a Preview Stage high-resolution result from its exact ComfyUI job.

The output is produced by SaveVideo/VHS_VideoCombine in the normal ComfyUI
output directory, not inside the SelfLift checkpoint. Keep a small validated
file reference in task.json; never copy potentially multi-GB videos.
"""
from __future__ import annotations

from pathlib import Path

import folder_paths

_VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


def validated_video_result(value: dict) -> dict | None:
    """Only accept existing regular video files inside ComfyUI's output root."""
    if not isinstance(value, dict) or value.get("type") != "output":
        return None
    filename = value.get("filename")
    subfolder = value.get("subfolder", "")
    if not isinstance(filename, str) or not isinstance(subfolder, str):
        return None
    if not filename or filename in (".", "..") or len(filename) > 240:
        return None
    if not subfolder and filename.startswith(("/", "\\")):
        return None
    if Path(filename).name != filename or "/" in filename or "\\" in filename:
        return None
    if Path(filename).suffix.lower() not in _VIDEO_EXT:
        return None
    if "\\" in subfolder or len(subfolder) > 500:
        return None
    root = Path(folder_paths.get_output_directory()).resolve()
    relative = Path(subfolder)
    if relative.is_absolute() or ".." in relative.parts or "." in relative.parts:
        return None
    candidate = (root / relative / filename).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return {"filename": filename, "subfolder": subfolder, "type": "output"}


def highres_video_path(video: dict) -> Path:
    clean = validated_video_result(video)
    if clean is None:
        raise FileNotFoundError("高清成片不存在或不在 ComfyUI 输出目录")
    return (Path(folder_paths.get_output_directory()).resolve() /
            clean["subfolder"] / clean["filename"]).resolve()


def highres_from_history(history: dict, prompt_id: str, target_id: str) -> dict | None:
    """Use exactly this submitted prompt's high-res output node, never guesses."""
    if not isinstance(history, dict) or not isinstance(prompt_id, str):
        return None
    record = history.get(prompt_id)
    if not isinstance(record, dict) or not isinstance(record.get("outputs"), dict):
        return None
    output = record["outputs"].get(str(target_id))
    if not isinstance(output, dict):
        return None
    # Core SaveVideo uses images+animated for its saved video; VHS uses gifs.
    for key in ("images", "gifs", "videos"):
        values = output.get(key)
        if not isinstance(values, list):
            continue
        for value in values:
            valid = validated_video_result(value)
            if valid is not None:
                return valid
    return None


def recover_highres_videos(rows: list[dict], queue) -> None:
    """Backfill completed tasks from ComfyUI history while it is available.

    The recovered file pointer is persisted in checkpoint/task.json so playback
    survives later ComfyUI history clearing and page reloads.
    """
    if queue is None:
        return
    from .director_selflift_task_store import load_metadata, save_metadata
    for row in rows:
        if row.get("status") != "high_complete" or not row.get("checkpoint_id"):
            continue
        if row.get("media", {}).get("highres"):
            continue
        prompt_id = row.get("prompt_id") or row.get("metadata", {}).get("highres_prompt_id")
        checkpoint_id = row["checkpoint_id"]
        if not isinstance(prompt_id, str) or not prompt_id:
            continue
        try:
            metadata = load_metadata(checkpoint_id)
            target = metadata.get("highres_target")
            if target is None:
                continue
            history = queue.get_history(prompt_id=prompt_id)
            video = highres_from_history(history, prompt_id, str(target))
            if video is None:
                continue
            save_metadata(checkpoint_id, {**metadata,
                                          "highres_video": video,
                                          "highres_prompt_id": prompt_id})
            row["media"]["highres"] = video["filename"]
            row.setdefault("metadata", {})["highres_video"] = video
        except (FileNotFoundError, OSError, ValueError, TypeError, KeyError):
            # Old jobs may have had their history cleared; never associate a
            # different job's video based merely on matching a file name.
            continue
