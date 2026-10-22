"""Visible, flat output allocation for TerryDirector loop renders.

The downstream ComfyUI SaveVideo prefix defines the task's output location.
Each fresh loop reserves a human-readable numbered manifest beside the final
video; clips, recovery state and the optional merged movie use that stem.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

import folder_paths


DEFAULT_PREFIX = "video/TerryDirector/timeline"


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_component(value: str, fallback: str = "timeline") -> str:
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or ""))
    return clean.strip(" ._") or fallback


def _downstream_save_nodes(prompt: dict, end_id: str) -> list[tuple[int, str, dict]]:
    """Find SaveVideo nodes reached from LoopEnd output 0, nearest first."""
    end_id = str(end_id)
    queue = [(end_id, 0)]
    visited = {end_id}
    found = []
    while queue:
        source_id, distance = queue.pop(0)
        for node_id, node in prompt.items():
            node_id = str(node_id)
            if node_id in visited or not isinstance(node, dict):
                continue
            inputs = node.get("inputs") or {}
            links = [value for value in inputs.values()
                     if isinstance(value, (list, tuple)) and len(value) == 2
                     and str(value[0]) == source_id]
            if not links:
                continue
            visited.add(node_id)
            if (node.get("class_type") == "SaveVideo"
                    and isinstance(inputs.get("video"), (list, tuple))
                    and str(inputs["video"][0]) == source_id):
                found.append((distance + 1, node_id, node))
                continue
            queue.append((node_id, distance + 1))
    return sorted(found, key=lambda row: (row[0], row[1]))


def output_profile_from_prefix(prefix: str, *, save_node_id=None,
                               save_settings=None) -> dict:
    if not isinstance(prefix, str) or not prefix.strip():
        raise ValueError("SaveVideo 的 filename_prefix 必须是固定文本")
    output_root = Path(folder_paths.get_output_directory()).resolve()
    folder, filename, _counter, subfolder, resolved_prefix = (
        folder_paths.get_save_image_path(str(prefix), str(output_root), 0, 0)
    )
    directory = Path(folder).resolve()
    if not _within(directory, output_root):
        raise ValueError("循环输出路径必须位于 ComfyUI output 文件夹内")
    return {
        "filename_prefix": str(prefix).replace("\\", "/"),
        "resolved_prefix": str(resolved_prefix).replace("\\", "/"),
        "subfolder": Path(subfolder).as_posix() if subfolder else "",
        "filename": _safe_component(filename),
        "save_node_id": save_node_id,
        "save_settings": dict(save_settings or {}),
        "schema": 1,
    }


def resolve_output_profile(prompt: dict, end_id: str) -> dict:
    """Resolve a safe output profile from the connected downstream SaveVideo."""
    candidates = _downstream_save_nodes(prompt or {}, str(end_id))
    if not candidates:
        return output_profile_from_prefix(DEFAULT_PREFIX)
    nearest = candidates[0][0]
    peers = [row for row in candidates if row[0] == nearest]
    if len(peers) > 1:
        raise ValueError("循环结束连接了多个同级 SaveVideo，无法确定分段保存位置")
    _, save_node_id, node = peers[0]
    inputs = node.get("inputs") or {}
    prefix = inputs.get("filename_prefix", DEFAULT_PREFIX)
    save_settings = {
        key: inputs.get(key)
        for key in ("format", "codec")
        if key in inputs and not isinstance(inputs.get(key), (list, tuple))
    }
    return output_profile_from_prefix(
        prefix, save_node_id=save_node_id, save_settings=save_settings,
    )


def profile_directory(profile: dict) -> Path:
    output_root = Path(folder_paths.get_output_directory()).resolve()
    directory = (output_root / str(profile.get("subfolder") or "")).resolve()
    if not _within(directory, output_root):
        raise ValueError("循环输出目录越过了 ComfyUI output 文件夹")
    return directory


def manifest_glob(profile: dict) -> str:
    return f"{_safe_component(profile.get('filename'))}_segments_[0-9][0-9][0-9][0-9][0-9].json"


def allocate_run(profile: dict, *, fingerprint: str, segment_format: str,
                 loop_id: str) -> dict:
    """Atomically reserve a fresh Comfy-style numbered loop output group."""
    directory = profile_directory(profile)
    directory.mkdir(parents=True, exist_ok=True)
    base = _safe_component(profile.get("filename")) + "_segments"
    prefix = f"{profile.get('subfolder')}/{base}" if profile.get("subfolder") else base
    _folder, _name, counter, _subfolder, _resolved = folder_paths.get_save_image_path(
        prefix, folder_paths.get_output_directory(), 0, 0
    )
    run_signature = uuid.uuid4().hex
    while True:
        stem = f"{base}_{int(counter):05d}"
        manifest = directory / f"{stem}.json"
        initial = {
            "version": 3,
            "status": "in_progress",
            "fps": 24,
            "audio_sample_rate": 48000,
            "plan_fingerprint": str(fingerprint),
            "segment_format": str(segment_format),
            "run_signature": run_signature,
            "loop_id": str(loop_id),
            "output_profile": dict(profile),
            "clips": [],
        }
        try:
            with open(manifest, "x", encoding="utf-8") as output:
                json.dump(initial, output, ensure_ascii=False, indent=2)
                output.flush()
                os.fsync(output.fileno())
            return {
                "run_signature": run_signature,
                "manifest": str(manifest),
                "directory": str(directory),
                "stem": stem,
            }
        except FileExistsError:
            counter += 1


def storage_from_manifest(manifest: str | Path, state: dict | None = None) -> dict:
    path = Path(manifest).resolve()
    payload = state or json.loads(path.read_text(encoding="utf-8"))
    return {
        "run_signature": str(payload.get("run_signature") or ""),
        "manifest": str(path),
        "directory": str(path.parent),
        "stem": path.stem,
    }


def recovery_path(manifest: str | Path) -> Path:
    path = Path(manifest).resolve()
    return path.with_name(f".{path.stem}_recovery.npz")

