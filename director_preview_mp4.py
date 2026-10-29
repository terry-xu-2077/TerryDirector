"""Finalize KJNodes TAEH3 sampling previews as ordinary, verified MP4 files.

ModelPreviewOverrideKJ uses fragmented MP4 for websocket/blob transport
(movflags=frag_keyframe+empty_moov+default_base_moof). An ftyp signature is
not evidence that the MP4 is finalized or decodable. Never copy the fMP4 bytes
straight into the checkpoint as a user-facing video.

All FFmpeg processing occurs only after generation, on the upload thread.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path


_REPAIR_LOCK = threading.RLock()
_MAX_ERROR_CHARS = 1200


def _ffmpeg() -> str:
    candidates = [os.environ.get("FFMPEG_BINARY"), shutil.which("ffmpeg")]
    try:
        import imageio_ffmpeg
        candidates.append(imageio_ffmpeg.get_ffmpeg_exe())
    except (ImportError, RuntimeError, OSError):
        pass
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return str(candidate)
    raise ValueError(
        "TAEH3 MP4 预览保存需要 FFmpeg。请安装 FFmpeg / imageio-ffmpeg，"
        "或设置 FFMPEG_BINARY 环境变量。"
    )


def _atoms(data: bytes):
    """Read top-level ISO BMFF box names without assuming a 32-bit size."""
    offset = 0
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset:offset + 4], "big")
        tag = data[offset + 4:offset + 8]
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                return
            size = int.from_bytes(data[offset + 8:offset + 16], "big")
            header = 16
        elif size == 0:
            size = len(data) - offset
        if size < header or offset + size > len(data):
            return
        yield tag
        offset += size


def is_fragmented_mp4(data: bytes) -> bool:
    return b"moof" in set(_atoms(data))


def _run(cmd: list[str], *, timeout: int = 90) -> bytes:
    try:
        done = subprocess.run(
            cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=False, timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("TAEH3 MP4 处理超时") from exc
    except OSError as exc:
        raise ValueError("无法启动 FFmpeg：" + str(exc)) from exc
    if done.returncode:
        detail = done.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError("FFmpeg 处理失败：" + detail[-_MAX_ERROR_CHARS:])
    return done.stdout


def _verify_video(path: Path, executable: str) -> None:
    if not path.is_file() or path.stat().st_size < 256:
        raise ValueError("生成的视频文件为空或过短")
    # Decode *all* frames. Header-only checks can accept broken/truncated fMP4
    # containing a valid poster frame but no playable video.
    frame_hashes = _run([
        executable, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-xerror", "-i", str(path),
        "-map", "0:v:0", "-an", "-f", "framemd5", "-",
    ])
    if not any(row and not row.startswith(b"#") for row in frame_hashes.splitlines()):
        raise ValueError("MP4 没有可解码的视频帧")
    raw = path.read_bytes()
    atoms = set(_atoms(raw))
    if b"ftyp" not in atoms or b"moov" not in atoms or b"mdat" not in atoms:
        raise ValueError("MP4 缺少完整的视频容器结构")
    if b"moof" in atoms:
        raise ValueError("预览仍是分片 MP4，无法作为最终视频文件使用")


def _video_duration(source: Path, executable: str) -> float | None:
    """Probe actual decoded video duration once, with no ffprobe dependency."""
    try:
        output = _run([
            executable, "-hide_banner", "-nostdin", "-loglevel", "error",
            "-i", str(source), "-map", "0:v:0", "-an",
            "-progress", "pipe:1", "-f", "null", "-",
        ])
        clocks = re.findall(rb"out_time_us=(\d+)", output)
        if clocks:
            duration = int(clocks[-1]) / 1_000_000
            return duration if duration > 0 else None
        clocks = re.findall(rb"out_time=(\d+):(\d+):(\d+(?:\.\d+)?)", output)
        if clocks:
            h, m, sec = clocks[-1]
            return int(h) * 3600 + int(m) * 60 + float(sec)
    except ValueError:
        return None
    return None


def _time_scale(source: Path, target_seconds: float | None, executable: str) -> float:
    if target_seconds is None:
        return 1.0
    if not 4 <= target_seconds <= 20:
        raise ValueError("预演时长必须在 4–20 秒之间")
    measured = _video_duration(source, executable)
    if not measured:
        raise ValueError("无法读取采样预览的视频时长，拒绝错误地调整播放速度")
    scale = target_seconds / measured
    # A few frames of rounding are normal; don't rewrite timestamps if the
    # clip already plays at the intended duration.
    if abs(measured - target_seconds) <= 0.3:
        return 1.0
    if not 0.3 <= scale <= 10:
        raise ValueError("采样预览帧数与目标时长偏差过大，请检查 KJ 预览帧数")
    return scale


def _remux(source: Path, output: Path, executable: str, scale: float = 1.0) -> None:
    _run([
        executable, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-xerror", "-y", "-itsscale", str(scale), "-i", str(source),
        "-map", "0:v:0", "-map", "0:a?",
        "-c", "copy", "-movflags", "+faststart",
        "-f", "mp4", str(output),
    ])
    _verify_video(output, executable)


def _transcode(source: Path, output: Path, executable: str, scale: float = 1.0) -> None:
    # Only if container remux/validation fails. Keep generation performance
    # unaffected; the fallback runs on CPU once at task completion.
    _run([
        executable, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-xerror", "-y", "-itsscale", str(scale), "-i", str(source),
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", "-f", "mp4", str(output),
    ])
    _verify_video(output, executable)


def _normalize(source: Path, destination: Path, target_seconds: float | None = None) -> None:
    executable = _ffmpeg()
    scale = _time_scale(source, target_seconds, executable)
    last_error = None
    for mode in (_remux, _transcode):
        try:
            destination.unlink(missing_ok=True)
            mode(source, destination, executable, scale)
            return
        except ValueError as exc:
            last_error = exc
    raise ValueError(
        "TAEH3 预览 MP4 无法整理为可播放视频；原始文件可能不完整。"
        " 原因：" + str(last_error)
    )


def finalize_preview_mp4(raw: bytes, folder: Path, target_seconds: float | None = None) -> Path:
    """Write a normalized MP4 atomically; never leave a broken final file."""
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "sampling_preview.mp4"
    with tempfile.TemporaryDirectory(prefix=".taeh3_mp4_", dir=folder) as tmp:
        base = Path(tmp)
        source = base / "incoming.mp4"
        final = base / "normalized.mp4"
        source.write_bytes(raw)
        _normalize(source, final, target_seconds)
        final.replace(target)
    return target


def repair_legacy_preview_mp4(path: Path) -> bool:
    """Repair a previously saved fragmented MP4 on first view, in place.

    Nonfragmented video is not touched. A failed repair leaves the original
    byte-for-byte intact and raises a readable error to the media request.
    """
    with _REPAIR_LOCK:
        if not path.is_file():
            raise FileNotFoundError(path)
        if not is_fragmented_mp4(path.read_bytes()):
            return False
        with tempfile.TemporaryDirectory(prefix=".taeh3_repair_", dir=path.parent) as tmp:
            final = Path(tmp) / "normalized.mp4"
            _normalize(path, final)
            final.replace(path)
        return True
