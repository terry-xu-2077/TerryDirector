from __future__ import annotations

import json
import mimetypes
import re
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
