"""Persistent pre-run preview tasks. Saving a draft NEVER queues a ComfyUI prompt.

Drafts and checkpoints are separate entities. Draft JSON stays inside
output/TerryDirector/preview_stage/drafts/ and includes its compiled workflow
snapshot, so a configured template can change without corrupting an old task.
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

import folder_paths

_LOCK = threading.RLock()
_ID = re.compile(r"^draft_[0-9a-f]{32}$")
_MAX_DRAFT = 15 * 1024 * 1024
# Six display states; queued/failed are separate internal flags.
_STATUSES = {"low_pending", "low_running", "low_complete",
             "high_pending", "high_running", "high_complete"}
_STAGE = {"low": ("low_pending", "low_running", "low_complete"),
          "high": ("high_pending", "high_running", "high_complete")}

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _folder() -> Path:
    return Path(folder_paths.get_output_directory()) / "TerryDirector" / "preview_stage" / "drafts"


def _path(draft_id: str) -> Path:
    if not isinstance(draft_id, str) or not _ID.fullmatch(draft_id):
        raise ValueError("非法预演任务 ID")
    root = _folder()
    path = root / (draft_id + ".json")
    if path.is_symlink() or path.resolve().parent != root.resolve():
        raise ValueError("预演任务文件路径异常")
    return path


def _write(draft_id: str, payload: dict) -> None:
    path = _path(draft_id)
    raw = json.dumps(payload, ensure_ascii=False)
    if len(raw.encode("utf-8")) > _MAX_DRAFT:
        raise ValueError("预演任务快照超过 15 MB")
    path.parent.mkdir(parents=True, exist_ok=True)
    stage = path.with_suffix(".partial")
    stage.write_text(raw, encoding="utf-8")
    stage.replace(path)


def get_draft(draft_id: str) -> dict:
    with _LOCK:
        data = json.loads(_path(draft_id).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("id") != draft_id:
        raise ValueError("预演任务数据损坏")
    return data


def _validate_content(data: dict) -> None:
    if not isinstance(data, dict):
        raise ValueError("任务数据应为对象")
    if not isinstance(data.get("name"), str) or not data["name"].strip() or len(data["name"]) > 120:
        raise ValueError("请填写 1～120 字的任务名称")
    if data.get("previewType") not in ("sampling", "decoded"):
        raise ValueError("请选择有效的预览类型")
    if not isinstance(data.get("prompt"), str):
        raise ValueError("提示词必须是字符串")
    if not isinstance(data.get("assets"), list):
        raise ValueError("参考资产格式错误")
    if not isinstance(data.get("workflow"), dict) or not isinstance(data.get("api_prompt"), dict):
        raise ValueError("工作流尚未编译，无法保存任务")
    for field in ("prompt_binding", "seed_binding"):
        if not isinstance(data.get(field), dict):
            raise ValueError("任务缺少" + field + "输入映射")
    try:
        seed = int(str(data.get("seed", "")))
        minimum = int(data["seed_min"])
        maximum = int(data["seed_max"])
    except (ValueError, TypeError, KeyError):
        raise ValueError("种子范围不正确") from None
    if str(seed) != str(data["seed"]).strip() or seed < minimum or seed > maximum or seed < 0:
        raise ValueError(f"种子必须在 {minimum}～{maximum} 范围内")


def save_draft(data: dict, draft_id: str | None = None) -> dict:
    _validate_content(data)
    with _LOCK:
        if draft_id:
            existing = get_draft(draft_id)
            if existing.get("status") not in ("pending", "failed"):
                raise ValueError("任务已提交运行，不能修改；请从该任务新建")
            created_at = existing["created_at"]
        else:
            draft_id = "draft_" + uuid.uuid4().hex
            created_at = datetime.now(timezone.utc).isoformat()
        # Never let clients overwrite lifecycle fields.
        clean = {k: v for k, v in data.items() if k not in (
            "id", "status", "prompt_id", "checkpoint_id", "created_at", "updated_at", "error")}
        payload = {
            **clean, "id": draft_id, "status": "pending",
            "created_at": created_at,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        _write(draft_id, payload)
        return {"id": draft_id, "status": "pending"}


def set_draft_status(draft_id: str, status: str, *,
                     prompt_id: str | None = None, checkpoint_id: str | None = None,
                     error: str | None = None) -> dict:
    if status not in _STATUSES - {"pending"}:
        raise ValueError("不支持的任务状态")
    with _LOCK:
        value = get_draft(draft_id)
        previous = value["status"]
        if status == "submitting" and previous not in ("pending", "failed"):
            raise ValueError("任务已经提交，不能重复入队")
        if status == "queued" and previous != "submitting":
            raise ValueError("任务没有获得运行许可")
        if status == "completed" and previous not in ("queued", "submitting"):
            raise ValueError("任务尚未入队")
        if status == "failed" and previous not in ("queued", "submitting"):
            raise ValueError("任务并未运行")
        value["status"] = status
        if prompt_id is not None:
            value["prompt_id"] = str(prompt_id)
        if checkpoint_id is not None:
            value["checkpoint_id"] = str(checkpoint_id)
        if error is not None:
            value["error"] = str(error)[:2000]
        if status == "submitting":
            value.pop("error", None)
        value["updated_at"] = datetime.now(timezone.utc).isoformat()
        _write(draft_id, value)
        return {"id": draft_id, "status": status}


def delete_drafts(ids: list[str]) -> list[str]:
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500 or len(ids) != len(set(ids)):
        raise ValueError("请选择 1～500 个不同任务")
    with _LOCK:
        for draft_id in ids:
            draft = get_draft(draft_id)
            if draft["status"] not in ("pending", "failed"):
                raise ValueError("已提交运行的任务不能删除，请先完成或取消运行")
        for draft_id in ids:
            _path(draft_id).unlink()
    return ids


def draft_checkpoint_ids() -> set[str]:
    """Used to avoid duplicate entries after a draft creates its checkpoint."""
    return {x["checkpoint_id"] for x in list_drafts() if x.get("checkpoint_id")}


def list_drafts() -> list[dict]:
    root = _folder()
    if not root.is_dir():
        return []
    items = []
    with _LOCK:
        for path in root.glob("draft_*.json"):
            if path.is_symlink() or not _ID.fullmatch(path.stem):
                continue
            try:
                value = get_draft(path.stem)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
            items.append({
                "id": value["id"], "kind": "draft",
                "status": value.get("status", "low_pending"),
                "queued_stage": value.get("queued_stage"),
                "prompt_id": value.get("prompt_id"),
                "checkpoint_id": value.get("checkpoint_id"),
                "name": value.get("name", "未命名任务"),
                "created_at": value.get("created_at"),
                "low_started_at": value.get("low_started_at"),
                "low_finished_at": value.get("low_finished_at"),
                "high_started_at": value.get("high_started_at"),
                "high_finished_at": value.get("high_finished_at"),
                "error": value.get("error"),
                "seed": value.get("seed", ""),
                "media": {"decoded": None, "sampling": None},
                "metadata": {
                    "workflow_name": value.get("workflow_name", ""),
                    "preview_type": value.get("previewType", "sampling"),
                    "has_workflow": bool(value.get("api_prompt")),
                    "pause_node_id": value.get("pause_node_id"),
                    "preview_node_id": value.get("preview_node_id"),
                },
            })
    return items
