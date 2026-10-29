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
            old = get_draft(draft_id)
            if old.get("status") != "low_pending" or old.get("queued_stage"):
                raise ValueError("任务已经提交运行，不允许修改")
            created = old["created_at"]
        else:
            draft_id = "draft_" + uuid.uuid4().hex
            created = _now()
        excluded = {"id", "status", "prompt_id", "checkpoint_id", "created_at",
                    "updated_at", "error", "queued_stage", "low_started_at",
                    "low_finished_at", "high_started_at", "high_finished_at"}
        value = {k: v for k, v in data.items() if k not in excluded}
        value.update({
            "id": draft_id, "status": "low_pending", "queued_stage": None,
            "created_at": created, "updated_at": _now(),
            "checkpoint_id": None, "prompt_id": None,
            "low_started_at": None, "low_finished_at": None,
            "high_started_at": None, "high_finished_at": None,
        })
        _write(draft_id, value)
        return {"id": draft_id, "status": "low_pending"}


def transition_draft(draft_id: str, action: str, *,
                     prompt_id: str | None = None, checkpoint_id: str | None = None,
                     error: str | None = None) -> dict:
    """Six UI states and queue lock are persisted separately with server times."""
    with _LOCK:
        value = get_draft(draft_id)
        old = value.get("status", "low_pending")
        stage = value.get("queued_stage")
        if action == "claim_low":
            if old != "low_pending" or stage:
                raise ValueError("只有低清待生成任务可开始预演")
            value["queued_stage"] = "low"
            value["prompt_id"] = None
            value.pop("error", None)
        elif action == "claim_high":
            if old != "low_complete" or stage or not value.get("checkpoint_id"):
                raise ValueError("必须先完成低清并保存检查点")
            value["status"] = "high_pending"
            value["queued_stage"] = "high"
            value["prompt_id"] = None
            value.pop("error", None)
        elif action == "ack":
            if not prompt_id:
                raise ValueError("缺少 ComfyUI 队列编号")
            if not stage:
                if value.get("prompt_id") == str(prompt_id):
                    return {"id": draft_id, "status": old, "queued_stage": None}
                raise ValueError("任务未申请运行")
            if value.get("prompt_id") not in (None, str(prompt_id)):
                raise ValueError("队列编号冲突")
            value["prompt_id"] = str(prompt_id)
        elif action == "start":
            if stage not in _STAGE:
                raise ValueError("当前任务不在生成队列")
            if prompt_id and value.get("prompt_id") not in (None, str(prompt_id)):
                raise ValueError("执行编号不匹配")
            value["status"] = _STAGE[stage][1]
            if prompt_id:
                value["prompt_id"] = str(prompt_id)
            field = stage + "_started_at"
            if not value.get(field):
                value[field] = _now()
        elif action == "checkpoint":
            if stage != "low" or not isinstance(checkpoint_id, str) or not re.fullmatch(r"[0-9a-f]{32}", checkpoint_id):
                raise ValueError("无效的低清检查点")
            value["checkpoint_id"] = checkpoint_id
        elif action == "finish":
            if stage not in _STAGE:
                raise ValueError("任务不在生成阶段")
            if stage == "low" and not value.get("checkpoint_id"):
                raise ValueError("低清检查点未保存，不能标记完成")
            stamp = _now()
            value["status"] = _STAGE[stage][2]
            value[stage + "_finished_at"] = stamp
            if not value.get(stage + "_started_at"):
                value[stage + "_started_at"] = stamp
            value["queued_stage"] = None
            value.pop("error", None)
        elif action == "fail":
            if stage not in _STAGE:
                raise ValueError("当前任务没有排队或运行记录")
            value["status"] = "low_pending" if stage == "low" else "low_complete"
            value["queued_stage"] = None
            value["prompt_id"] = None
            value["error"] = str(error or "生成失败或中断")[:2000]
        else:
            raise ValueError("无效的任务状态操作")
        value["updated_at"] = _now()
        _write(draft_id, value)
        return {"id": draft_id, "status": value["status"],
                "queued_stage": value.get("queued_stage"),
                "checkpoint_id": value.get("checkpoint_id")}


def delete_drafts(ids: list[str]) -> list[str]:
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500 or len(ids) != len(set(ids)):
        raise ValueError("请选择 1～500 个不同任务")
    with _LOCK:
        for draft_id in ids:
            item = get_draft(draft_id)
            if item.get("queued_stage") or item.get("status") in ("low_running", "high_running", "high_pending"):
                raise ValueError("运行或排队中的任务不能删除")
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
