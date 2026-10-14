from __future__ import annotations

import asyncio
import json
import uuid
import mimetypes
import re
import shutil
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

PLUGIN_ROOT = Path(__file__).resolve().parent
INPUT_ROOT = Path(folder_paths.get_input_directory()).resolve()
OUTPUT_ROOT = Path(folder_paths.get_output_directory()).resolve()
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

        doc = normalize_document(payload.get("document"))
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
                loop_id, previous["id"], required_frames=previous["output_frames"],
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


@PromptServer.instance.routes.post("/terrydirector/api/resume-check")
async def terrydirector_resume_check(request: web.Request) -> web.Response:
    """A quick UI hint. Full recipe and body validation happens at Queue time."""
    try:
        payload = await request.json()
        from .director_loop_state import loop_folder, _manifests, _manifest
        loop_root = loop_folder(
            folder_paths.get_output_directory(), str(payload.get("loop_id") or "")
        )
        for path in _manifests(loop_root):
            info = _manifest(path)
            if (info and info.get("status") == "in_progress"
                    and info.get("plan_fingerprint")
                    and not info.get("rerun_target")):
                return web.json_response({
                    "available": True,
                    "previous_clips": len(info.get("clips") or []),
                    "requires_signature_check": True,
                })
        return web.json_response({
            "available": False,
            "error": "没有找到可续跑的未完成 MOV 任务",
        })
    except (ValueError, KeyError, OSError, TypeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


def _rebuild_final_sync(payload: dict) -> dict:
    from .director_compile import compile_timeline, DEFAULT_TAIL_REFERENCE_PROMPT
    from .director_core import normalize_document
    from .director_loop_state import loop_folder, select_current_takes
    from .director_loop_media import merge_loop_clips, FORMATS

    loop_id = str(payload.get("loop_id") or "")
    root = loop_folder(folder_paths.get_output_directory(), loop_id)
    document = normalize_document(payload.get("document"))
    if len(document["clips"]) > 200:
        raise ValueError("当前版本最多支持 200 个时间线片段参与 Final 重建")
    seed = int(str(payload.get("seed") or "0"))
    if not 0 <= seed <= 0xFFFFFFFFFFFFFFFF:
        raise ValueError("全局 Seed 超出范围")
    name = str(payload.get("segment_format") or "")
    if name not in FORMATS:
        raise ValueError("请选择有效的 MOV/MP4 保存格式")
    prompt = str(payload.get("tail_reference_prompt") or DEFAULT_TAIL_REFERENCE_PROMPT)
    plan = compile_timeline(document, tail_reference_prompt=prompt)
    segments = plan["segments"]

    def asset_path(rel):
        safe = _safe_input(rel)
        if not safe.is_file():
            raise FileNotFoundError("引用资产已丢失：" + rel)
        return str(safe)

    selected = select_current_takes(
        root, segments, [None] * len(segments), name,
        seed=seed, resolver=asset_path,
    )
    if not selected["clips"]:
        raise ValueError("没有能够参与 Final 的生成镜头")
    stale = selected["stale"]
    if stale and payload.get("allow_stale") is not True:
        return {
            "ok": False, "stale": stale, "status": "stale",
            "message": "部分镜头仍依赖旧版上游结果。可以重跑相应镜头，"
                       "或确认后仍然合并。",
        }
    output = root / "assemblies" / ("rebuild-" + uuid.uuid4().hex[:12])
    # The merge is atomic at the Final file level. On any failure, all
    # existing source MOVs and historical Final videos remain unchanged.
    final = merge_loop_clips(
        selected["clips"], merge_final=True,
        output_root=output, source_root=root,
    )
    manifest = output / "timeline.json"
    metadata = json.loads(manifest.read_text(encoding="utf-8"))
    metadata["stale_dependencies"] = stale
    metadata["source"] = "TerryDirector reassemble"
    from .director_loop_media import _atomic_json
    _atomic_json(manifest, metadata)
    return {
        "ok": True, "status": "completed", "final": str(final),
        "frames": metadata["final_frames"], "stale": stale,
    }


@PromptServer.instance.routes.post("/terrydirector/api/rebuild-final")
async def terrydirector_rebuild_final(request: web.Request) -> web.Response:
    """Assemble an updated Final solely from original MOV/MP4 files."""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("无效的整片合并参数")
        result = await asyncio.to_thread(_rebuild_final_sync, payload)
        return web.json_response(result, status=409 if result.get("status") == "stale" else 200)
    except (FileNotFoundError, ValueError, KeyError, TypeError, OSError, RuntimeError) as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


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


@PromptServer.instance.routes.get("/terrydirector/api/latent-upscalers")
async def terrydirector_latent_upscalers(request: web.Request) -> web.Response:
    try:
        models = list(folder_paths.get_filename_list("latent_upscale_models"))
    except Exception:
        models = []
    return web.json_response({"models": models})


def _read_advanced_json(cache_dir: Path, name: str):
    path = (cache_dir / name).resolve()
    cache_root = (OUTPUT_ROOT / ".terrydirector_cache").resolve()
    if not _within(cache_root, path) or not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _valid_output_video(value):
    if not isinstance(value, dict) or not value.get("filename"):
        return None
    rel = Path(str(value.get("subfolder") or "")) / str(value.get("filename") or "")
    candidate = (OUTPUT_ROOT / rel).resolve()
    if not _within(OUTPUT_ROOT, candidate) or not candidate.is_file():
        return None
    return value


@PromptServer.instance.routes.get("/terrydirector/api/advanced-state")
async def terrydirector_advanced_state(request: web.Request) -> web.Response:
    node_id = str(request.query.get("node_id") or "").strip()
    if not node_id:
        return web.json_response({"state": None, "checkpoint": None})
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", node_id)[:160]
    cache_dir = (OUTPUT_ROOT / ".terrydirector_cache" / safe).resolve()
    cache_root = (OUTPUT_ROOT / ".terrydirector_cache").resolve()
    if not _within(cache_root, cache_dir):
        return web.json_response({"state": None, "checkpoint": None})

    state = _read_advanced_json(cache_dir, "state.json")
    checkpoint = _read_advanced_json(cache_dir, "checkpoint.json")

    if isinstance(state, dict):
        video = _valid_output_video(state.get("video"))
        if state.get("video") is not None and video is None:
            state = None

    if isinstance(checkpoint, dict):
        partial_video = _valid_output_video(checkpoint.get("partial_video"))
        if checkpoint.get("partial_video") is not None and partial_video is None:
            checkpoint = dict(checkpoint)
            checkpoint.pop("partial_video", None)

    return web.json_response({"state": state, "checkpoint": checkpoint})


@PromptServer.instance.routes.get("/terrydirector/api/capabilities")
async def terrydirector_capabilities(request: web.Request) -> web.Response:
    try:
        import nodes as comfy_nodes
        kj_preview = "ModelPreviewOverrideKJ" in comfy_nodes.NODE_CLASS_MAPPINGS
    except Exception:
        kj_preview = False
    return web.json_response({
        "multi_frame_preview": bool(kj_preview),
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
