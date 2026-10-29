from __future__ import annotations

import asyncio
import json
import math
import mimetypes
import shutil
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

PLUGIN_ROOT = Path(__file__).resolve().parent
INPUT_ROOT = Path(folder_paths.get_input_directory()).resolve()
SUPPORTED = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".svg"},
    "video": {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"},
    "audio": {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"},
}
EXT_TO_KIND = {ext: kind for kind, extensions in SUPPORTED.items() for ext in extensions}


def _within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_static(relative: str) -> Path:
    clean = str(relative or "").replace("\\", "/").lstrip("/")
    if not (clean.startswith("src/") or clean.startswith("assets/")):
        raise FileNotFoundError(relative)
    candidate = (PLUGIN_ROOT / clean).resolve()
    if not _within(PLUGIN_ROOT, candidate) or not candidate.is_file():
        raise FileNotFoundError(relative)
    return candidate


def _safe_input(relative: str) -> Path:
    clean = str(relative or "").replace("\\", "/").lstrip("/")
    candidate = (INPUT_ROOT / clean).resolve()
    if not _within(INPUT_ROOT, candidate):
        raise ValueError("Invalid input path")
    return candidate


def _view_url(relative: str) -> str:
    from urllib.parse import quote
    return f"/view?filename={quote(relative)}&type=input"


@PromptServer.instance.routes.get("/terrydirector/editor")
async def terrydirector_editor(request: web.Request) -> web.Response:
    html = (PLUGIN_ROOT / "index.html").read_text(encoding="utf-8")
    html = html.replace("<head>", '<head>\n  <base href="/terrydirector/static/">', 1)
    return web.Response(text=html, content_type="text/html", charset="utf-8")


@PromptServer.instance.routes.get("/terrydirector/static/{tail:.*}")
async def terrydirector_static(request: web.Request) -> web.StreamResponse:
    try:
        path = _safe_static(request.match_info.get("tail", ""))
    except FileNotFoundError:
        raise web.HTTPNotFound()
    content_type, _ = mimetypes.guess_type(path.name)
    return web.FileResponse(path, headers={"Content-Type": content_type or "application/octet-stream"})


@PromptServer.instance.routes.get("/terrydirector/api/selflift/checkpoint-status")
async def terrydirector_selflift_checkpoint_status(request: web.Request) -> web.Response:
    """Existence check only: never deserialize a large SelfLift latent in HTTP."""
    checkpoint_id = str(request.query.get("id") or "").strip()
    if not checkpoint_id:
        return web.json_response({"exists": False}, headers={"Cache-Control": "no-store"})
    try:
        from .director_selflift_checkpoint import read_manifest
        # read_manifest strictly validates the 32-char hex ID before touching
        # any user-controlled filesystem component.
        manifest = read_manifest(checkpoint_id)
        state_path = (Path(folder_paths.get_output_directory()) /
                      "TerryDirector" / "checkpoints" / checkpoint_id /
                      "state.safetensors")
        exists = state_path.is_file()
    except (FileNotFoundError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        exists = False
        manifest = None
    return web.json_response(
        {"exists": exists, "name": manifest.get("name", "") if exists else ""},
        headers={"Cache-Control": "no-store"},
    )


@PromptServer.instance.routes.get("/terrydirector/api/selflift/templates")
async def terrydirector_preview_templates(request: web.Request) -> web.Response:
    from .director_preview_template_catalog import list_preview_templates
    return web.json_response(list_preview_templates(),headers={"Cache-Control":"no-store"})


@PromptServer.instance.routes.get("/terrydirector/api/selflift/template")
async def terrydirector_preview_template_get(request: web.Request) -> web.Response:
    from .director_preview_template_catalog import load_preview_template
    try:
        return web.json_response({"template":load_preview_template(request.query.get("id"))},
                                 headers={"Cache-Control":"no-store"})
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        return web.json_response({"error":str(exc)},status=400)


@PromptServer.instance.routes.post("/terrydirector/api/selflift/template")
async def terrydirector_preview_template_set(request: web.Request) -> web.Response:
    from .director_preview_template_catalog import save_preview_template
    try:
        value=await request.json()
        result=save_preview_template(value)
        return web.json_response({"ok":True,**result})
    except (ValueError, TypeError, OSError, json.JSONDecodeError) as exc:
        return web.json_response({"error":str(exc)},status=400)


@PromptServer.instance.routes.post("/terrydirector/api/selflift/templates/{template_id}/rename")
async def terrydirector_preview_template_rename(request: web.Request) -> web.Response:
    from .director_preview_template_catalog import rename_preview_template
    try:
        value=await request.json()
        rename_preview_template(request.match_info["template_id"],value.get("name"))
        return web.json_response({"ok":True})
    except (ValueError, TypeError, OSError, json.JSONDecodeError) as exc:
        return web.json_response({"error":str(exc)},status=400)


@PromptServer.instance.routes.post("/terrydirector/api/selflift/templates/{template_id}/default")
async def terrydirector_preview_template_default(request: web.Request) -> web.Response:
    from .director_preview_template_catalog import set_default_preview_template
    try:
        set_default_preview_template(request.match_info["template_id"])
        return web.json_response({"ok":True})
    except (ValueError, OSError) as exc:
        return web.json_response({"error":str(exc)},status=400)


@PromptServer.instance.routes.delete("/terrydirector/api/selflift/templates/{template_id}")
async def terrydirector_preview_template_delete(request: web.Request) -> web.Response:
    from .director_preview_template_catalog import delete_preview_template
    try:
        result=delete_preview_template(request.match_info["template_id"])
        return web.json_response({"ok":True,**result})
    except (ValueError, OSError) as exc:
        return web.json_response({"error":str(exc)},status=400)


@PromptServer.instance.routes.get("/terrydirector/api/selflift/drafts")
async def terrydirector_preview_drafts(request: web.Request) -> web.Response:
    from .director_preview_draft_store import list_drafts
    return web.json_response({"drafts": list_drafts()}, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.post("/terrydirector/api/selflift/drafts")
async def terrydirector_preview_draft_create(request: web.Request) -> web.Response:
    from .director_preview_draft_store import save_draft
    try:
        result = save_draft(await request.json())
        return web.json_response(result, status=201)
    except (ValueError, TypeError, KeyError, OSError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.get("/terrydirector/api/selflift/drafts/{draft_id}")
async def terrydirector_preview_draft_get(request: web.Request) -> web.Response:
    from .director_preview_draft_store import get_draft
    try:
        return web.json_response(get_draft(request.match_info["draft_id"]),
                                 headers={"Cache-Control": "no-store"})
    except (FileNotFoundError, ValueError, OSError) as exc:
        return web.json_response({"error": str(exc)}, status=404)


@PromptServer.instance.routes.put("/terrydirector/api/selflift/drafts/{draft_id}")
async def terrydirector_preview_draft_update(request: web.Request) -> web.Response:
    from .director_preview_draft_store import save_draft
    try:
        return web.json_response(save_draft(await request.json(), request.match_info["draft_id"]))
    except (FileNotFoundError, ValueError, TypeError, OSError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/terrydirector/api/selflift/drafts/{draft_id}/status")
async def terrydirector_preview_draft_status(request: web.Request) -> web.Response:
    from .director_preview_draft_store import transition_draft
    try:
        payload = await request.json()
        return web.json_response(transition_draft(
            request.match_info["draft_id"], payload["action"],
            prompt_id=payload.get("prompt_id"),
            checkpoint_id=payload.get("checkpoint_id"),
            error=payload.get("error")))
    except (FileNotFoundError, ValueError, TypeError, KeyError, OSError,
            json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/terrydirector/api/selflift/drafts/batch-delete")
async def terrydirector_preview_draft_batch_delete(request: web.Request) -> web.Response:
    from .director_preview_draft_store import delete_drafts
    try:
        payload = await request.json()
        return web.json_response({"deleted": delete_drafts(payload["draft_ids"])})
    except (FileNotFoundError, ValueError, TypeError, KeyError, OSError,
            json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.get("/terrydirector/api/selflift/tasks")
async def terrydirector_selflift_tasks(request: web.Request) -> web.Response:
    from .director_selflift_task_store import list_tasks
    return web.json_response({"tasks": list_tasks()}, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.post("/terrydirector/api/selflift/tasks/batch-delete")
async def terrydirector_selflift_batch_delete(request: web.Request) -> web.Response:
    """Permanently remove selected checkpoint folders, not any external outputs."""
    from .director_selflift_task_store import (
        checkpoint_ids_in_queue, delete_checkpoints,
    )
    try:
        payload = await request.json()
        ids = payload.get("checkpoint_ids") if isinstance(payload, dict) else None
        if not isinstance(ids, list):
            raise ValueError("请求缺少 checkpoint_ids 列表")
        # A queue lock closes the check/delete race: a queued checkpoint cannot
        # begin executing midway through deletion.
        queue = getattr(PromptServer.instance, "prompt_queue", None)
        if queue is None or not hasattr(queue, "mutex"):
            return web.json_response({"error": "无法读取 ComfyUI 任务队列，已拒绝删除"}, status=503)
        with queue.mutex:
            running, pending = queue.get_current_queue_volatile()
            selected = {item for item in ids if isinstance(item, str)}
            occupied = checkpoint_ids_in_queue(running, selected, running=True)
            occupied.update(checkpoint_ids_in_queue(pending, selected))
            if occupied:
                display = "首阶段生成仍在运行" if "*" in occupied else (
                    "选中的检查点正在运行或已加入队列：" +
                    "、".join(sorted(cid[:8] for cid in occupied))
                )
                return web.json_response({"error": display + "，请等待任务结束后再删除"},
                                         status=409)
            deleted = delete_checkpoints(ids)
        return web.json_response({"deleted": deleted, "count": len(deleted)},
                                 headers={"Cache-Control": "no-store"})
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except OSError as exc:
        return web.json_response({"error": "部分文件删除失败：" + str(exc)}, status=500)


@PromptServer.instance.routes.get("/terrydirector/api/selflift/tasks/{checkpoint_id}/media/{kind}")
async def terrydirector_selflift_task_media(request: web.Request) -> web.StreamResponse:
    from .director_selflift_task_store import media_path
    try:
        kind = request.match_info["kind"]
        path = media_path(request.match_info["checkpoint_id"], kind)
        if kind == "sampling" and path.suffix == ".mp4":
            # One-time, transparent repair for existing fragmented previews.
            # Keep costly FFmpeg processing off aiohttp's event loop.
            from .director_preview_mp4 import repair_legacy_preview_mp4
            await asyncio.to_thread(repair_legacy_preview_mp4, path)
    except (FileNotFoundError, OSError):
        raise web.HTTPNotFound()
    except ValueError as exc:
        raise web.HTTPUnprocessableEntity(text=str(exc))
    return web.FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@PromptServer.instance.routes.get("/terrydirector/api/selflift/tasks/{checkpoint_id}/workflow")
async def terrydirector_selflift_task_workflow(request: web.Request) -> web.Response:
    from .director_selflift_task_store import load_metadata
    try:
        metadata = load_metadata(request.match_info["checkpoint_id"])
    except (FileNotFoundError, ValueError, OSError):
        raise web.HTTPNotFound()
    workflow = metadata.get("workflow")
    if not isinstance(workflow, dict):
        return web.json_response({"error": "该任务未保存工作流快照"}, status=404)
    return web.json_response({"workflow": workflow, "overrides": metadata.get("overrides", []),
                              "prompt_binding": metadata.get("prompt_binding"),
                              "seed_binding": metadata.get("seed_binding"),
                              "h3_properties": metadata.get("h3_properties", {}),
                              "api_prompt": metadata.get("api_prompt"),
                              "pause_target": metadata.get("pause_target"),
                              "highres_target": metadata.get("highres_target"),
                              "decoded_target": metadata.get("decoded_target"),
                              "seed_min": metadata.get("seed_min"),
                              "seed_max": metadata.get("seed_max")})


@PromptServer.instance.routes.get("/terrydirector/api/selflift/tasks/{checkpoint_id}/metadata")
async def terrydirector_selflift_task_metadata_get(request: web.Request) -> web.Response:
    from .director_selflift_task_store import load_metadata
    try:
        meta = load_metadata(request.match_info["checkpoint_id"])
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        return web.json_response({"error": "原任务未保存配置快照，无法继承"}, status=404)
    # Return the complete task snapshot: lifecycle updates must never drop
    # compiled workflows or per-node overrides from existing checkpoints.
    return web.json_response(meta, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.post("/terrydirector/api/selflift/tasks/{checkpoint_id}/metadata")
async def terrydirector_selflift_task_metadata(request: web.Request) -> web.Response:
    from .director_selflift_task_store import save_metadata
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("任务配置必须是 JSON 对象")
        save_metadata(request.match_info["checkpoint_id"], data)
    except (FileNotFoundError, OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/terrydirector/api/selflift/tasks/{checkpoint_id}/sampling-preview")
async def terrydirector_selflift_sampling_preview(request: web.Request) -> web.Response:
    from .director_selflift_task_store import save_sampling_preview
    mime = str(request.headers.get("Content-Type", "")).split(";")[0].strip()
    try:
        duration_param = request.query.get("duration")
        duration = float(duration_param) if duration_param is not None else None
        if duration is not None and (not math.isfinite(duration) or not 4 <= duration <= 20):
            raise ValueError("预演时长须在 4–20 秒之间")
        raw = await request.content.read(48 * 1024 * 1024 + 1)
        # FFmpeg muxing/validation can take seconds; do not hold up ComfyUI
        # websocket/queue handling or other pending Preview Stage tasks.
        filename = await asyncio.to_thread(
            save_sampling_preview, request.match_info["checkpoint_id"], mime, raw, duration,
        )
    except (FileNotFoundError, OSError, ValueError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True, "filename": filename})


@PromptServer.instance.routes.get("/terrydirector/api/input-files")
async def terrydirector_input_files(request: web.Request) -> web.Response:
    query = str(request.query.get("q") or "").strip().lower()
    rows = []
    if INPUT_ROOT.exists():
        for path in INPUT_ROOT.rglob("*"):
            if not path.is_file():
                continue
            kind = EXT_TO_KIND.get(path.suffix.lower())
            if not kind:
                continue
            relative = path.relative_to(INPUT_ROOT).as_posix()
            if query and query not in relative.lower():
                continue
            rows.append({
                "path": relative,
                "name": path.name,
                "kind": kind,
                "preview_url": _view_url(relative),
            })
            if len(rows) >= 1000:
                break
    rows.sort(key=lambda item: item["path"].lower())
    return web.json_response({"files": rows})


@PromptServer.instance.routes.get("/terrydirector/api/video-info")
async def terrydirector_video_info(request: web.Request) -> web.Response:
    """Inspect a selected ComfyUI input video, without exposing other paths."""
    relative = str(request.query.get("path") or "")
    if not relative or len(relative) > 1024:
        return web.json_response({"error": "未选择视频文件"}, status=400)
    try:
        path = _safe_input(relative)
        if not path.is_file() or path.suffix.lower() not in SUPPORTED["video"]:
            raise FileNotFoundError("没有找到有效的视频文件")
        from .director_loop_reuse import video_info
        return web.json_response(video_info(str(path)), headers={"Cache-Control": "no-store"})
    except (FileNotFoundError, ValueError, RuntimeError, OSError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/terrydirector/api/rerun-check")
async def terrydirector_rerun_check(request: web.Request) -> web.Response:
    """Validate that the original predecessor can supply a rerun's context."""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("非法的重跑参数")
        loop_id = str(payload.get("loop_id") or "").strip()
        clip_id = str(payload.get("clip_id") or "").strip()
        if not loop_id.isdigit() or not clip_id or len(clip_id) > 128:
            raise ValueError("必须指定有效的循环节点和目标片段")
        from .director_core import normalize_document
        from .director_compile import compile_timeline
        from .director_loop_reuse import find_saved_clip, safe_input_video, video_info
        from .director_loop_storage import output_profile_from_prefix

        doc = normalize_document(payload.get("document"))
        output_profile = output_profile_from_prefix(
            str(payload.get("filename_prefix") or "video/TerryDirector/timeline")
        )
        plan = compile_timeline(doc)
        segments = plan["segments"]
        index = next((i for i, item in enumerate(segments)
                      if item["id"] == clip_id), None)
        if index is None:
            raise ValueError("目标片段不存在或已挂起，请先恢复该片段")
        target = segments[index]
        if target["kind"] != "generated":
            raise ValueError("实体视频不需要 AI 重跑，请选择生成片段")
        relation = target["continuity"]["kind"]
        if relation not in ("tail_reference", "tail_frame", "overlap"):
            return web.json_response({"ok": True, "context": "not_required"})

        if index == 0:
            raise ValueError("找不到上一镜头，无法取得承接上下文")
        previous = segments[index - 1]
        count = int(target["continuity"].get("frames", 1)) if relation == "overlap" else 1
        if previous["kind"] == "entity":
            source = safe_input_video(previous["source_asset"])
            info = video_info(source)
            if info["frames_24fps"] < previous["output_frames"]:
                raise ValueError(
                    f"实体片段「{previous['name']}」不足 {previous['output_frames']} 帧，"
                    "无法提供完整承接区"
                )
            source_type = "entity"
        else:
            saved = find_saved_clip(
                output_profile, previous["id"],
                required_frames=previous["output_frames"],
            )
            if saved is None:
                raise FileNotFoundError(
                    f"缺少上一镜头「{previous['name']}」的历史 MOV/MP4，"
                    "无法执行当前的尾帧或重叠衔接。请先生成上一镜头，"
                    "或在时间线中导入实体视频。"
                )
            source = saved["path"]
            source_type = "saved_result"

        return web.json_response({
            "ok": True, "source_type": source_type,
            "source_name": previous["name"], "context_frames": count,
        })
    except (ValueError, KeyError, TypeError, RuntimeError, FileNotFoundError, OSError) as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


def _loop_region(prompt: dict, loop_id: str) -> tuple[str, set[str]]:
    """Recover the native loop region from an unvalidated API prompt."""
    outgoing: dict[str, set[str]] = {}
    incoming: dict[str, set[str]] = {}
    for target, node in prompt.items():
        for value in (node.get("inputs") or {}).values():
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                continue
            source = str(value[0])
            outgoing.setdefault(source, set()).add(str(target))
            incoming.setdefault(str(target), set()).add(source)

    descendants = set()
    pending = list(outgoing.get(loop_id, ()))
    while pending:
        node_id = pending.pop()
        if node_id in descendants:
            continue
        descendants.add(node_id)
        pending.extend(outgoing.get(node_id, ()))
    ends = sorted(
        node_id for node_id in descendants
        if (prompt.get(node_id) or {}).get("class_type") == "TerryDirectorLoopEnd"
    )
    if len(ends) != 1:
        raise ValueError("循环开始必须连接恰好一个循环结束节点")
    end_id = ends[0]

    ancestors = set()
    pending = list(incoming.get(end_id, ()))
    while pending:
        node_id = pending.pop()
        if node_id in ancestors:
            continue
        ancestors.add(node_id)
        pending.extend(incoming.get(node_id, ()))
    return end_id, (descendants & ancestors) - {loop_id, end_id}


@PromptServer.instance.routes.post("/terrydirector/api/loop-resume-status")
async def terrydirector_loop_resume_status(request: web.Request) -> web.Response:
    """Read-only exact-match check used by the loop node's circled marker."""
    try:
        payload = await request.json()
        prompt = payload.get("prompt") if isinstance(payload, dict) else None
        loop_id = str(payload.get("loop_id") or "") if isinstance(payload, dict) else ""
        if not isinstance(prompt, dict) or loop_id not in prompt:
            raise ValueError("无法读取当前工作流")
        loop = prompt[loop_id]
        if loop.get("class_type") != "TerryDirectorLooper":
            raise ValueError("目标节点不是 TerryDirector 循环开始")
        inputs = loop.get("inputs") or {}
        config_value = inputs.get("config_json")
        seed = inputs.get("seed")
        tail_prompt = inputs.get("tail_reference_prompt")
        if (isinstance(config_value, (list, tuple))
                or isinstance(seed, (list, tuple))
                or isinstance(tail_prompt, (list, tuple))):
            return web.json_response({"resumable": False, "reason": "dynamic_input"})

        from types import SimpleNamespace
        from comfy_execution.graph_utils import is_link
        from .director_compile import DEFAULT_TAIL_REFERENCE_PROMPT, compile_timeline
        from .director_core import normalize_config
        from .director_loop_media import MOV_HQ
        from .director_loop_resume import (
            find_resume_checkpoint, plan_fingerprint, workflow_fingerprint,
        )
        from .director_loop_storage import resolve_output_profile

        end_id, body = _loop_region(prompt, loop_id)
        end_inputs = (prompt[end_id].get("inputs") or {})
        segment_format = str(end_inputs.get("segment_format") or MOV_HQ)
        output_profile = resolve_output_profile(prompt, end_id)
        document = normalize_config(config_value)["document"]
        plan = compile_timeline(
            document, str(tail_prompt or DEFAULT_TAIL_REFERENCE_PROMPT),
        )
        dynprompt = SimpleNamespace(get_node=lambda node_id: prompt[str(node_id)])
        workflow_hash = workflow_fingerprint(dynprompt, body, is_link)
        fingerprint = plan_fingerprint(
            document, seed, plan, workflow_hash, segment_format, output_profile,
        )
        checkpoint = find_resume_checkpoint(
            output_profile, fingerprint, plan["segments"], segment_format,
        )
        if checkpoint is None:
            return web.json_response({"resumable": False})
        completed = len(checkpoint["completed"])
        return web.json_response({
            "resumable": True,
            "completed": completed,
            "total": len(plan["segments"]),
            "manifest": Path(checkpoint["manifest"]).name,
            "subfolder": output_profile.get("subfolder") or "",
        }, headers={"Cache-Control": "no-store"})
    except (ValueError, KeyError, TypeError, RuntimeError, OSError,
            json.JSONDecodeError) as exc:
        return web.json_response({"resumable": False, "error": str(exc)})


@PromptServer.instance.routes.post("/terrydirector/api/upload")
async def terrydirector_upload(request: web.Request) -> web.Response:
    reader = await request.multipart()
    field = await reader.next()
    if field is None or not field.filename:
        return web.json_response({"error": "No file supplied"}, status=400)

    original = Path(field.filename).name
    suffix = Path(original).suffix.lower()
    kind = EXT_TO_KIND.get(suffix)
    if not kind:
        return web.json_response({"error": "Unsupported media type"}, status=400)

    stem = Path(original).stem or "asset"
    target = _safe_input(original)
    serial = 1
    while target.exists():
        target = _safe_input(f"{stem}_{serial}{suffix}")
        serial += 1
    target.parent.mkdir(parents=True, exist_ok=True)

    with target.open("wb") as handle:
        while True:
            chunk = await field.read_chunk(size=1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)

    relative = target.relative_to(INPUT_ROOT).as_posix()
    return web.json_response({
        "path": relative,
        "name": target.name,
        "kind": kind,
        "preview_url": _view_url(relative),
    })


def _temp_disk_space(directory: str) -> dict:
    """Read free space on the actual media-output drive.

    Do not expose the absolute output directory through the browser API.
    Windows returns a drive label (e.g. G:), Linux a generic disk label.
    """
    path = Path(directory).resolve()
    usage = shutil.disk_usage(path)
    drive = path.anchor.rstrip("\\/") or "当前磁盘"
    return {
        "available": True,
        "drive": drive,
        "free_bytes": int(usage.free),
    }


@PromptServer.instance.routes.get("/terrydirector/api/temp-space")
async def terrydirector_temp_space(request: web.Request) -> web.Response:
    """Show output-drive headroom before generating MOV/MP4 clips."""
    try:
        result = _temp_disk_space(folder_paths.get_output_directory())
    except (OSError, ValueError):
        result = {"available": False, "drive": None, "free_bytes": None}
    return web.json_response(result, headers={"Cache-Control": "no-store"})


# AI enrichment uses an editor-owned HTTP job, never app.queuePrompt.
# The batch's llama-cpp-python inference runs in a worker thread.
@PromptServer.instance.routes.post("/terrydirector/api/ai-enhance")
async def terrydirector_ai_enhance(request: web.Request) -> web.Response:
    from .director_ai_core import require_ai_config
    from .director_ai_jobs import AI_JOBS
    from .director_core import normalize_document

    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        config = require_ai_config(payload.get("llama_config"))
        scope = payload.get("scope", "clips")
        if scope == "global":
            document = normalize_document(payload.get("document"))
            job_id = AI_JOBS.submit_global(config, document)
        elif scope == "clips":
            document = normalize_document(payload.get("document"))
            ids = payload.get("clip_ids")
            if not isinstance(ids, list) or not ids or len(ids) > 64:
                raise ValueError("需要选择 1–64 个片段")
            job_id = AI_JOBS.submit(config, document, [str(x) for x in ids])
        elif scope == "prompt":
            job_id = AI_JOBS.submit_prompt(config, str(payload.get("prompt") or ""))
        else:
            raise ValueError("无效的 AI 增强范围")
        return web.json_response({"job_id": job_id}, status=202)
    except (ValueError, TypeError, RuntimeError) as exc:
        return web.json_response({"error": str(exc)}, status=409 if isinstance(exc, RuntimeError) else 400)


@PromptServer.instance.routes.get("/terrydirector/api/ai-jobs/{job_id}")
async def terrydirector_ai_job(request: web.Request) -> web.Response:
    from .director_ai_jobs import AI_JOBS
    snapshot = AI_JOBS.get(request.match_info["job_id"])
    if snapshot is None:
        raise web.HTTPNotFound()
    return web.json_response(snapshot, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.post("/terrydirector/api/ai-jobs/{job_id}/cancel")
async def terrydirector_ai_cancel(request: web.Request) -> web.Response:
    from .director_ai_jobs import AI_JOBS
    if not AI_JOBS.cancel(request.match_info["job_id"]):
        raise web.HTTPNotFound()
    return web.json_response({"cancel_requested": True})


@PromptServer.instance.routes.get("/terrydirector/api/ai-results")
async def terrydirector_ai_results(request: web.Request) -> web.Response:
    from .director_ai import load_saved_ai
    node_id = str(request.query.get("node_id") or "")
    if not node_id:
        raise web.HTTPBadRequest(text="node_id is required")
    return web.json_response(load_saved_ai(node_id), headers={"Cache-Control": "no-store"})
