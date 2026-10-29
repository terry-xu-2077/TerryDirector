"""Disk-backed SelfLift review task inventory. Never reads tensors for the UI."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import folder_paths

from .director_selflift_checkpoint import list_checkpoints, read_manifest

_ID = re.compile(r"^[0-9a-f]{32}$")
_PREVIEW_EXT = {"video/mp4": ".mp4", "image/webp": ".webp", "image/jpeg": ".jpg"}
_MAX_PREVIEW = 48 * 1024 * 1024
_MAX_METADATA = 5 * 1024 * 1024


_TEMPLATE_FILE = "preview_stage_template.json"


def load_preview_template() -> dict:
    """Shared workflow/template configuration, separate from generated tasks."""
    root = Path(folder_paths.get_output_directory()) / "TerryDirector"
    path = root / _TEMPLATE_FILE
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != 1:
        return {}
    return value


def save_preview_template(value: dict) -> None:
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise ValueError("预演工作流配置格式不正确")
    workflow = value.get("workflow")
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        raise ValueError("需要 ComfyUI 完整工作流")
    pause = value.get("pause_node_id")
    if not any(str(n.get("id")) == str(pause) and
               n.get("type") == "TerryDirectorSelfLiftPauseResume"
               for n in workflow["nodes"] if isinstance(n, dict)):
        raise ValueError("工作流中没有所选的暂停/继续节点")
    prompt = value.get("prompt_binding")
    seed = value.get("seed_binding")
    for label, binding in (("提示词", prompt), ("种子", seed)):
        if (not isinstance(binding, dict) or
            not any(str(n.get("id")) == str(binding.get("node_id"))
                    for n in workflow["nodes"] if isinstance(n, dict)) or
            not isinstance(binding.get("widget_name"), str)):
            raise ValueError(f"{label}输入节点未正确配置")
    raw = json.dumps(value, ensure_ascii=False)
    if len(raw.encode("utf-8")) > _MAX_METADATA:
        raise ValueError("工作流配置大于 5 MB")
    root = Path(folder_paths.get_output_directory()) / "TerryDirector"
    root.mkdir(parents=True, exist_ok=True)
    stage = root / (_TEMPLATE_FILE + ".partial")
    stage.write_text(raw, encoding="utf-8")
    stage.replace(root / _TEMPLATE_FILE)


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
                "preview_type": details.get("preview_type", "sampling"),
            },
        })
    return rows


def save_metadata(checkpoint_id: str, metadata: dict) -> None:
    folder = checkpoint_dir(checkpoint_id)
    allowed = {"workflow_name", "overrides", "pause_node_id", "preview_node_id", "workflow", "prompt_binding", "seed_binding", "preview_type"}
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
    path = folder / ("sampling_preview" + ext)
    stage = folder / ("sampling_preview.partial" + ext)
    stage.write_bytes(raw)
    stage.replace(path)
    for old in folder.glob("sampling_preview.*"):
        if old != path and old.suffix in {".mp4", ".webp", ".jpg"}:
            old.unlink(missing_ok=True)
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


def checkpoint_ids_in_queue(queue_items: list, selected_ids: set[str], *,
                            running: bool = False) -> set[str]:
    """Find selected checkpoints referenced by ComfyUI queued/running prompts.

    A running first-stage job may have just written an ID that is not yet in its
    input prompt. Represent that with the sentinel '*': do not delete during
    an active checkpoint-writing job.
    """
    occupied = set()
    for item in queue_items:
        prompt = item[2] if isinstance(item, (tuple, list)) and len(item) > 2 else None
        if not isinstance(prompt, dict):
            continue
        for node in prompt.values():
            if not isinstance(node, dict):
                continue
            kind = node.get("class_type")
            inputs = node.get("inputs", {})
            if not isinstance(inputs, dict):
                continue
            if running and kind in ("TerryDirectorSelfLiftPauseResume",
                                    "TerryDirectorSaveLowresCheckpoint"):
                mode = inputs.get("mode")
                if mode == "暂停并保存" or kind == "TerryDirectorSaveLowresCheckpoint":
                    occupied.add("*")
            if kind == "TerryDirectorSelfLiftPauseResume":
                checkpoint_id = inputs.get("checkpoint_id")
                if isinstance(checkpoint_id, str) and checkpoint_id in selected_ids:
                    occupied.add(checkpoint_id)
            elif kind == "TerryDirectorReadLowresCheckpoint":
                task_name = str(inputs.get("task") or "")
                for cid in selected_ids:
                    if cid[:8] in task_name:
                        occupied.add(cid)
    return occupied


def delete_checkpoints(checkpoint_ids: list[str]) -> list[str]:
    """Permanently delete validated checkpoint-owned directories only.

    Verify the complete batch before removing anything. Never follow symlinks
    or accept filesystem paths from the client.
    """
    if not isinstance(checkpoint_ids, list) or not 1 <= len(checkpoint_ids) <= 500:
        raise ValueError("请选择 1–500 个预演任务进行删除")
    if len(set(checkpoint_ids)) != len(checkpoint_ids):
        raise ValueError("删除任务包含重复检查点 ID")
    base = (Path(folder_paths.get_output_directory()) /
            "TerryDirector" / "checkpoints").resolve()
    verified = []
    for checkpoint_id in checkpoint_ids:
        if not isinstance(checkpoint_id, str) or not _ID.fullmatch(checkpoint_id):
            raise ValueError("非法检查点 ID")
        folder = base / checkpoint_id
        if folder.is_symlink() or not folder.is_dir() or folder.resolve().parent != base:
            raise ValueError(f"无效的预演任务目录：{checkpoint_id[:8]}")
        checkpoint_dir(checkpoint_id)
        # A task owns files inside its folder; never delete external targets.
        if any(item.is_symlink() for item in folder.rglob("*")):
            raise ValueError(f"预演任务含符号链接，拒绝删除：{checkpoint_id[:8]}")
        verified.append(folder)
    deleted = []
    for checkpoint_id, folder in zip(checkpoint_ids, verified):
        shutil.rmtree(folder)
        deleted.append(checkpoint_id)
    return deleted
