"""Disk-backed SelfLift review task inventory. Never reads tensors for the UI."""
from __future__ import annotations

import json
import re
from pathlib import Path

import folder_paths

from .director_selflift_checkpoint import list_checkpoints, read_manifest

_ID = re.compile(r"^[0-9a-f]{32}$")
_PREVIEW_EXT = {"video/mp4": ".mp4", "image/webp": ".webp", "image/jpeg": ".jpg"}
_MAX_PREVIEW = 48 * 1024 * 1024
_MAX_METADATA = 5 * 1024 * 1024


def checkpoint_dir(checkpoint_id: str) -> Path:
    if not isinstance(checkpoint_id, str) or not _ID.fullmatch(checkpoint_id):
        raise ValueError("非法检查点 ID")
    path = (Path(folder_paths.get_output_directory()) / "TerryDirector" /
            "checkpoints" / checkpoint_id)
    if not path.joinpath("state.safetensors").is_file():
        raise FileNotFoundError("检查点文件不存在")
    # Confirm the ID matches a readable trusted checkpoint manifest.
    read_manifest(checkpoint_id)
    return path


def list_tasks() -> list[dict]:
    rows = []
    for item in list_checkpoints():
        cid = item["checkpoint_id"]
        folder = checkpoint_dir(cid)
        details = {}
        try:
            details = json.loads((folder / "task.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, ValueError, TypeError):
            pass
        media = {
            "decoded": "review.mp4" if (folder / "review.mp4").is_file() else None,
            "sampling": next((f"sampling_preview{ext}" for ext in (".mp4", ".webp", ".jpg")
                              if (folder / f"sampling_preview{ext}").is_file()), None),
        }
        rows.append({
            "id": cid, "name": item.get("name", ""), "created_at": item.get("created_at"),
            "seed": item.get("seed", ""), "transition_step": item.get("transition_step"),
            "low_video_shape": item.get("low_video_shape"), "target_video_shape": item.get("target_video_shape"),
            "media": media, "metadata": {
                "workflow_name": details.get("workflow_name", ""),
                "overrides": details.get("overrides", []),
                "pause_node_id": details.get("pause_node_id"),
                "preview_node_id": details.get("preview_node_id"),
            },
        })
    return rows


def save_metadata(checkpoint_id: str, metadata: dict) -> None:
    folder = checkpoint_dir(checkpoint_id)
    allowed = {"workflow_name", "overrides", "pause_node_id", "preview_node_id", "workflow"}
    safe = {k: v for k, v in metadata.items() if k in allowed}
    if not isinstance(safe.get("overrides", []), list):
        raise ValueError("无效的输入覆盖配置")
    value = json.dumps(safe, ensure_ascii=False)
    if len(value.encode("utf-8")) > _MAX_METADATA:
        raise ValueError("任务配置超出限制")
    stage = folder / "task.partial"
    stage.write_text(value, encoding="utf-8")
    stage.replace(folder / "task.json")


def load_metadata(checkpoint_id: str) -> dict:
    path = checkpoint_dir(checkpoint_id) / "task.json"
    return json.loads(path.read_text(encoding="utf-8"))


def save_sampling_preview(checkpoint_id: str, mime: str, raw: bytes) -> str:
    folder = checkpoint_dir(checkpoint_id)
    ext = _PREVIEW_EXT.get(mime)
    if ext is None or not raw or len(raw) > _MAX_PREVIEW:
        raise ValueError("不支持的预览媒体或文件过大（最大 48 MB）")
    if mime == "video/mp4" and not (len(raw) >= 12 and raw[4:8] == b"ftyp"):
        raise ValueError("无效 MP4")
    if mime == "image/webp" and not (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"):
        raise ValueError("无效 WebP")
    if mime == "image/jpeg" and not raw.startswith(bytes((0xff, 0xd8, 0xff))):
        raise ValueError("无效 JPEG")
    for old in folder.glob("sampling_preview.*"):
        if old.suffix in {".mp4", ".webp", ".jpg"}:
            old.unlink(missing_ok=True)
    path = folder / ("sampling_preview" + ext)
    stage = folder / ("sampling_preview.partial" + ext)
    stage.write_bytes(raw)
    stage.replace(path)
    return path.name


def media_path(checkpoint_id: str, kind: str) -> Path:
    folder = checkpoint_dir(checkpoint_id)
    if kind == "decoded":
        path = folder / "review.mp4"
    elif kind == "sampling":
        path = next((folder / ("sampling_preview" + ext)
                     for ext in (".mp4", ".webp", ".jpg")
                     if (folder / ("sampling_preview" + ext)).is_file()), None)
    else:
        raise ValueError("未知的预览类型")
    if path is None or not path.is_file():
        raise FileNotFoundError("此任务尚无对应预览")
    return path
