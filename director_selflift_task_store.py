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


_PREVIEW_STAGE_DIR = "preview_stage"
_TEMPLATE_LIMIT = 15 * 1024 * 1024


def _stage_dir() -> Path:
    return Path(folder_paths.get_output_directory()) / "TerryDirector" / _PREVIEW_STAGE_DIR


def load_preview_template() -> dict:
    """Load a compiled, isolated Preview Stage pipeline. Never access ComfyUI tabs."""
    directory = _stage_dir()
    config = directory / "config.json"
    workflow = directory / "workflow.json"
    compiled = directory / "api_prompt.json"
    if not all(path.is_file() for path in (config, workflow, compiled)):
        return {}
    value = json.loads(config.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != 2:
        return {}
    value["workflow"] = json.loads(workflow.read_text(encoding="utf-8"))
    value["api_prompt"] = json.loads(compiled.read_text(encoding="utf-8"))
    return value


def save_preview_template(value: dict) -> None:
    """Validate first, then atomically persist the API, UI, and I/O bindings.

    The API prompt is compiled once when the user configures the template;
    task submission only substitutes its owned inputs and output targets.
    """
    if not isinstance(value, dict) or value.get("schema") != 2:
        raise ValueError("预演工作流必须重新配置并编译为 API 版本")
    workflow = value.get("workflow")
    api_prompt = value.get("api_prompt")
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        raise ValueError("工作流缺少画布 JSON")
    if not isinstance(api_prompt, dict) or not api_prompt:
        raise ValueError("未编译 API 工作流，请重新配置")
    if not all(isinstance(node, dict) and isinstance(node.get("class_type"), str)
               and isinstance(node.get("inputs"), dict) for node in api_prompt.values()):
        raise ValueError("API 工作流节点数据不完整")
    pause = str(value.get("pause_node_id"))
    if not any(str(n.get("id")) == pause and
               n.get("type") == "TerryDirectorSelfLiftPauseResume"
               for n in workflow["nodes"] if isinstance(n, dict)):
        raise ValueError("工作流未选择有效的暂停/继续节点")
    if api_prompt.get(pause, {}).get("class_type") != "TerryDirectorSelfLiftPauseResume":
        raise ValueError("可执行工作流缺少所选暂停节点")
    for label, binding in (("提示词", value.get("prompt_binding")),
                           ("种子", value.get("seed_binding"))):
        if not isinstance(binding, dict):
            raise ValueError(f"{label}尚未指定输入节点")
        node_id = str(binding.get("node_id"))
        widget = binding.get("widget_name")
        if not isinstance(widget, str) or widget not in api_prompt.get(node_id, {}).get("inputs", {}):
            raise ValueError(f"{label}输入无法映射到可执行工作流：{node_id}.{widget}")
        if isinstance(api_prompt[node_id]["inputs"][widget], list):
            raise ValueError(f"{label}绑定仍指向连线终点，请选择实际输入源节点")
    for key in ("pause_target", "highres_target", "decoded_target"):
        node_id = value.get(key)
        if node_id is not None and str(node_id) not in api_prompt:
            raise ValueError(f"输出目标不存在：{key}={node_id}")
    if str(value.get("pause_target")) != pause:
        raise ValueError("首阶段输出目标必须是暂停检查点")
    if not value.get("highres_target"):
        raise ValueError("工作流缺少高清保存终点")
    if not isinstance(value.get("seed_min"), int) or not isinstance(value.get("seed_max"), int):
        raise ValueError("种子输入范围未定义")
    if value["seed_max"] < value["seed_min"]:
        raise ValueError("种子输入范围无效")
    raw = {
        "config.json": json.dumps({k: v for k, v in value.items() if k not in ("workflow", "api_prompt")}, ensure_ascii=False),
        "workflow.json": json.dumps(workflow, ensure_ascii=False),
        "api_prompt.json": json.dumps(api_prompt, ensure_ascii=False),
    }
    if sum(len(x.encode("utf-8")) for x in raw.values()) > _TEMPLATE_LIMIT:
        raise ValueError("预演台工作流配置超出 15 MB")
    directory = _stage_dir()
    directory.mkdir(parents=True, exist_ok=True)
    # Replace every artifact separately via atomic rename, not through tabs.
    for filename, content in raw.items():
        stage = directory / (filename + ".partial")
        stage.write_text(content, encoding="utf-8")
        stage.replace(directory / filename)


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
    from .director_preview_draft_store import list_drafts
    rows = list_drafts()
    by_checkpoint = {row["checkpoint_id"]: row for row in rows if row.get("checkpoint_id")}
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
        if cid in by_checkpoint:
            draft = by_checkpoint[cid]
            draft["media"] = media
            draft["low_video_shape"] = item.get("low_video_shape")
            draft["target_video_shape"] = item.get("target_video_shape")
            draft["transition_step"] = item.get("transition_step")
            draft["metadata"]["has_workflow"] = True
            continue
        rows.append({
            "id": cid, "kind": "checkpoint", "status": details.get("lifecycle_status", "low_complete"),
            "name": item.get("name", ""), "created_at": item.get("created_at"),
            "low_started_at": details.get("low_started_at"),
            "low_finished_at": details.get("low_finished_at") or item.get("created_at"),
            "high_started_at": details.get("high_started_at"),
            "high_finished_at": details.get("high_finished_at"),
            "queued_stage": details.get("queued_stage"),
            "error": details.get("error"), "checkpoint_id": cid,
            "seed": item.get("seed", ""), "transition_step": item.get("transition_step"),
            "low_video_shape": item.get("low_video_shape"), "target_video_shape": item.get("target_video_shape"),
            "media": media, "metadata": {
                "workflow_name": details.get("workflow_name", ""),
                "overrides": details.get("overrides", []),
                "pause_node_id": details.get("pause_node_id"),
                "preview_node_id": details.get("preview_node_id"),
                "preview_type": details.get("preview_type", "sampling"),
                "has_workflow": isinstance(details.get("workflow"), dict) and
                                isinstance(details.get("api_prompt"), dict),
            },
        })
    rows.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return rows


def save_metadata(checkpoint_id: str, metadata: dict) -> None:
    folder = checkpoint_dir(checkpoint_id)
    allowed = {"workflow_name", "overrides", "pause_node_id", "preview_node_id", "workflow",
               "prompt_binding", "seed_binding", "preview_type", "h3_properties", "api_prompt", "pause_target",
               "highres_target", "decoded_target", "seed_min", "seed_max", "draft_id",
               "lifecycle_status", "queued_stage", "low_started_at", "low_finished_at",
               "high_started_at", "high_finished_at", "error"}
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


def save_sampling_preview(checkpoint_id: str, mime: str, raw: bytes, duration_seconds: float | None = None) -> str:
    folder = checkpoint_dir(checkpoint_id)
    ext = _PREVIEW_EXT.get(mime)
    if ext is None or not raw or len(raw) > _MAX_PREVIEW:
        raise ValueError("不支持的预览媒体或文件过大（最大 48 MB）")
    if mime == "video/mp4":
        if len(raw) < 12 or raw[4:8] != b"ftyp":
            raise ValueError("采样预览不是 MP4 文件")
        # KJNodes encodes fragmented MP4 for its live websocket preview.
        # Normalize to a complete, fully-decoded/tested MP4 before exposing it.
        from .director_preview_mp4 import finalize_preview_mp4
        path = finalize_preview_mp4(raw, folder, duration_seconds)
    else:
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
