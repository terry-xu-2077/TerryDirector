"""Shared media catalog and input import for TerryDirector asset consumers."""
from __future__ import annotations

import os
import hashlib
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from io import BytesIO
from urllib.parse import urlencode

import folder_paths

SUPPORTED = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".svg"},
    "video": {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"},
    "audio": {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"},
}
EXT_TO_KIND = {ext: kind for kind, extensions in SUPPORTED.items() for ext in extensions}
CATALOG_TTL = 10.0
_catalog_lock = threading.Lock()
_catalogs: dict[str, tuple[float, list[dict]]] = {}
_thumbnail_slots = threading.BoundedSemaphore(2)
_thumbnail_locks = [threading.Lock() for _ in range(32)]


def invalidate_asset_catalog(source: str = "input") -> None:
    with _catalog_lock:
        _catalogs.pop(str(asset_root(source)), None)


def asset_root(source: str) -> Path:
    if source not in ("input", "output"):
        raise ValueError("资产来源必须为 input 或 output")
    return Path(getattr(folder_paths, f"get_{source}_directory")()).resolve()


def safe_asset(source: str, relative: str) -> Path:
    root = asset_root(source)
    clean = str(relative or "").replace("\\", "/")
    if not clean or Path(clean).is_absolute() or ":" in clean:
        raise ValueError("无效的资产路径")
    candidate = (root / clean).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("资产路径超出来源目录")
    return candidate


def asset_view_url(relative: str, source: str = "input") -> str:
    path = Path(relative.replace("\\", "/"))
    subfolder = path.parent.as_posix() if path.parent != Path(".") else ""
    return "/view?" + urlencode({"filename": path.name, "subfolder": subfolder, "type": source})


def asset_record(path: Path, source: str) -> dict:
    relative = path.relative_to(asset_root(source)).as_posix()
    kind = EXT_TO_KIND[path.suffix.lower()]
    preview_url = asset_view_url(relative, source)
    thumbnail_url = preview_url
    if kind in ("image", "video") and path.suffix.lower() != ".svg":
        stat = path.stat()
        thumbnail_url = "/terrydirector/api/assets/thumbnail?" + urlencode({
            "source": source, "path": relative, "v": f"{stat.st_mtime_ns}-{stat.st_size}"})
    return {"path": relative, "name": path.name, "kind": EXT_TO_KIND[path.suffix.lower()],
            "source": source, "preview_url": preview_url, "thumbnail_url": thumbnail_url}


def _scan_catalog(source: str) -> list[dict]:
    root = asset_root(source)
    matches = []
    # Do not traverse linked directories or disclose files outside the selected root.
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()
                   and (Path(directory) / name).resolve().is_relative_to(root)]
        for name in files:
            path = Path(directory) / name
            media_kind = EXT_TO_KIND.get(path.suffix.lower())
            if not media_kind:
                continue
            if not path.resolve().is_relative_to(root) or not path.is_file():
                continue
            try:
                matches.append(asset_record(path, source))
            except FileNotFoundError:
                continue  # A file can disappear while scanning generated outputs.
    matches.sort(key=lambda item: item["path"].casefold())
    return matches


def list_assets(source: str, kind: str = "", query: str = "", offset: int = 0,
                limit: int = 150, refresh: bool = False) -> dict:
    root = asset_root(source)
    if kind and kind not in SUPPORTED:
        raise ValueError("无效的资产类型")
    if offset < 0 or not 1 <= limit <= 150:
        raise ValueError("无效的分页参数")
    query = query.strip().casefold()
    with _catalog_lock:
        cached = _catalogs.get(str(root))
        if refresh or cached is None or time.monotonic() - cached[0] >= CATALOG_TTL:
            rows = _scan_catalog(source)
            _catalogs[str(root)] = (time.monotonic(), rows)
        else:
            rows = cached[1]
    matches = [row for row in rows if (not kind or row["kind"] == kind)
               and (not query or query in row["path"].casefold())]
    return {"files": matches[offset:offset + limit],
            "total": len(matches), "offset": offset, "limit": limit}


def _video_first_frame(path: Path):
    """Decode only the first video frame, scaled before piping it into Pillow."""
    from PIL import Image
    candidates = [os.environ.get("FFMPEG_BINARY"), shutil.which("ffmpeg")]
    try:
        import imageio_ffmpeg
        candidates.append(imageio_ffmpeg.get_ffmpeg_exe())
    except (ImportError, RuntimeError):
        pass
    executable = next((str(item) for item in candidates if item and Path(item).is_file()), None)
    if not executable:
        raise ValueError("视频缩略图需要 FFmpeg 或 imageio-ffmpeg")
    try:
        result = subprocess.run([
            executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
            "-i", str(path), "-map", "0:V:0", "-an", "-sn", "-dn", "-frames:v", "1",
            "-filter_threads", "1", "-vf",
            "scale=w='min(384,iw)':h='min(384,ih)':force_original_aspect_ratio=decrease,setsar=1",
            "-f", "image2pipe", "-c:v", "png", "-threads", "1", "pipe:1",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=25, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except subprocess.TimeoutExpired as exc:
        raise ValueError("视频首帧读取超时") from exc
    if result.returncode or not result.stdout:
        raise ValueError("无法读取视频首帧")
    return Image.open(BytesIO(result.stdout))


def asset_thumbnail(source: str, relative: str) -> Path:
    """Generate a bounded, orientation-correct first-frame WebP on demand.

    The original is never modified. Disk hits do not reopen/decode the image.
    Two worker slots bound simultaneous image/video decodes and deduplicate misses.
    """
    path = safe_asset(source, relative)
    kind = EXT_TO_KIND.get(path.suffix.lower())
    if kind not in ("image", "video") or path.suffix.lower() == ".svg" or not path.is_file():
        raise ValueError("没有找到可生成缩略图的图片或视频")
    stat = path.stat()
    identity = hashlib.sha256((str(path) + "|384|webp-v1").encode("utf-8")).hexdigest()
    revision = f"{stat.st_mtime_ns}-{stat.st_size}"
    cache = Path(folder_paths.get_user_directory()) / "TerryDirector" / "asset_thumbnails" / identity[:2]
    target = cache / f"{identity}_{revision}.webp"
    if target.is_file():
        return target
    with _thumbnail_locks[int(identity[:2], 16) % len(_thumbnail_locks)], _thumbnail_slots:
        if target.is_file():
            return target
        from PIL import Image, ImageOps
        with (_video_first_frame(path) if kind == "video" else Image.open(path)) as image:
            # JPEG's decoder can reduce before allocating full-resolution pixels.
            image.draft("RGB", (384, 384))
            image.seek(0)
            thumb = ImageOps.exif_transpose(image)
            try:
                thumb.thumbnail((384, 384), Image.Resampling.LANCZOS, reducing_gap=3.0)
                if thumb.mode not in ("RGB", "RGBA"):
                    converted = thumb.convert("RGBA" if "A" in thumb.getbands() or
                                              "transparency" in thumb.info else "RGB")
                    thumb.close()
                    thumb = converted
                cache.mkdir(parents=True, exist_ok=True)
                temporary = cache / f"{identity}_{uuid.uuid4().hex}.tmp"
                try:
                    thumb.save(temporary, format="WEBP", quality=78, method=3)
                    temporary.replace(target)
                finally:
                    temporary.unlink(missing_ok=True)
            finally:
                thumb.close()
        # Keep recent revisions long enough for in-flight FileResponses to open.
        for old in cache.glob(f"{identity}_*.webp"):
            if old != target:
                try:
                    if old.stat().st_mtime < time.time() - 3600:
                        old.unlink(missing_ok=True)
                except OSError:
                    pass  # Another response may still be streaming this revision.
    return target


def import_asset(source: str, relative: str, kind: str) -> dict:
    path = safe_asset(source, relative)
    actual_kind = EXT_TO_KIND.get(path.suffix.lower())
    if not path.is_file() or not actual_kind or kind != actual_kind:
        raise ValueError("资产不存在或类型不匹配")
    if source == "input":
        return asset_record(path, "input")
    # A unique copy keeps input-only third-party loaders and saved drafts working,
    # even if the original output is later regenerated or removed.
    destination_dir = safe_asset("input", "TerryDirector/imported")
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"{path.stem[:100]}_{uuid.uuid4().hex}{path.suffix}"
    try:
        with path.open("rb") as src, destination.open("xb") as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    invalidate_asset_catalog("input")
    return asset_record(destination, "input")
