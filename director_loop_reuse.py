"""Read a prior MOV/MP4 or an input video as a loop continuity source.

Does not read whole videos into RAM.  Only the exact last N frames needed by
the next segment and matching audio samples are decoded.  Result lookup is
restricted to this looper's own output directory and validates clip IDs.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess

import folder_paths
import numpy as np
import torch

FPS = 24
RATE = 48000
SUPPORTED_EXTENSIONS = {".mov", ".mp4", ".mkv", ".webm", ".avi"}


def _ffmpeg_program(kind):
    from .director_loop_media import _ffmpeg
    if kind == "ffmpeg":
        return _ffmpeg()
    companion = shutil.which("ffprobe")
    if not companion:
        candidate = Path(_ffmpeg()).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
        companion = str(candidate) if candidate.exists() else None
    if not companion:
        raise RuntimeError("读取已有镜头需要 ffprobe（请安装完整 FFmpeg）")
    return companion


def _execute(args, label):
    done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if done.returncode:
        raise RuntimeError(
            f"{label}失败：{done.stderr.decode('utf-8', errors='replace')[-1600:]}"
        )
    return done.stdout


def video_info(path):
    if Path(path).suffix.lower() not in SUPPORTED_EXTENSIONS or not Path(path).is_file():
        raise ValueError("需要有效的 MOV、MP4、MKV、WebM 或 AVI 视频")
    raw = _execute([
        _ffmpeg_program("ffprobe"), "-v", "error",
        "-show_entries",
        "stream=index,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,sample_rate,channels:format=duration",
        "-of", "json", str(path),
    ], "视频信息读取")
    data = json.loads(raw)
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video:
        raise ValueError("文件没有可解码的视频轨道")
    width, height = int(video["width"]), int(video["height"])
    duration = float(data.get("format", {}).get("duration") or 0)
    if width <= 0 or height <= 0 or duration <= 0 or duration > 36000:
        raise ValueError("实体视频尺寸或时长无效")
    return {
        "width": width, "height": height,
        "frames_24fps": max(1, round(duration * FPS)),
        "duration": duration,
        "has_audio": audio is not None,
        "audio_channels": int(audio.get("channels") or 0) if audio else 0,
    }


def safe_input_video(asset):
    """Only resolve a source that is already in ComfyUI's input index."""
    source = asset.get("source") or {}
    if source.get("type") != "comfy-input":
        raise ValueError("实体视频必须已上传到 ComfyUI input")
    relative = str(source.get("path") or "")
    if not relative or not folder_paths.exists_annotated_filepath(relative):
        raise FileNotFoundError(f"实体视频丢失：{relative}")
    path = Path(folder_paths.get_annotated_filepath(relative)).resolve()
    input_root = Path(folder_paths.get_input_directory()).resolve()
    if not _contained(path, input_root):
        raise ValueError("实体视频只允许来自 ComfyUI input 文件夹")
    video_info(path)
    return str(path)


def _contained(path, parent):
    try:
        return os.path.commonpath([str(path), str(parent)]) == str(parent)
    except ValueError:
        return False


def find_saved_clip(loop_id, clip_id, required_frames=None):
    """Find latest committed movie from any run, never arbitrary user paths."""
    key = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"loop-{loop_id}")[:56]
    root = (Path(folder_paths.get_output_directory()) / "TerryDirector" / "renders" / key).resolve()
    if not root.is_dir():
        return None
    manifests = sorted(root.glob("*/timeline.json"),
                       key=lambda p: p.stat().st_mtime_ns, reverse=True)
    for path in manifests:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            for entry in payload.get("clips") or ():
                if entry.get("segment_id") != str(clip_id):
                    continue
                if int(entry.get("fps") or 0) != FPS:
                    continue
                if required_frames is not None and int(entry.get("frames") or 0) != int(required_frames):
                    continue
                movie = Path(str(entry["path"])).resolve()
                if not _contained(movie, root) or movie.suffix.lower() not in (".mov", ".mp4"):
                    continue
                if not movie.is_file() or not movie.stat().st_size:
                    continue
                return dict(entry, path=str(movie))
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            continue
    return None


def _video_tail(path, width, height, total_frames, count):
    """Decode only a trailing 24fps window, with bounded stdout buffering."""
    first = total_frames - count
    command = [
        _ffmpeg_program("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(path), "-map", "0:v:0",
        "-vf", f"fps={FPS},trim=start_frame={first}:end_frame={total_frames},setpts=PTS-STARTPTS",
        "-an", "-pix_fmt", "rgb48le", "-f", "rawvideo", "pipe:1",
    ]
    size = width * height * 3 * 2
    # Preserve ProRes 10-bit color depth while decoding to RGB16.
    # Fill directly into one staging buffer, not run().stdout.
    result = np.empty((count, height, width, 3), dtype="<u2")
    p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        view = memoryview(result).cast("B")
        for index in range(count):
            buf = view[index*size:(index+1)*size]
            off = 0
            while off < size:
                got = p.stdout.readinto(buf[off:])
                if not got:
                    raise RuntimeError("视频承接尾帧不完整或原视频时长不足")
                off += got
        p.stdout.close()
        error = p.stderr.read()
        if p.wait() != 0:
            raise RuntimeError(error.decode("utf-8", errors="replace")[-1800:])
        return torch.from_numpy(result).to(torch.float32).div_(65535.0)
    except BaseException:
        p.kill()
        p.wait()
        raise
    finally:
        p.stdout.close()
        p.stderr.close()


def _audio_tail(path, first, total_frames, has_audio):
    samples = (total_frames-first) * (RATE // FPS)
    if not has_audio:
        return {"waveform": torch.zeros((1, 2, samples), dtype=torch.float32),
                "sample_rate": RATE}
    raw = _execute([
        _ffmpeg_program("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(path), "-map", "0:a:0", "-vn",
        "-af", f"aresample={RATE},atrim=start_sample={first*(RATE//FPS)}:"
               f"end_sample={total_frames*(RATE//FPS)},asetpts=PTS-STARTPTS",
        "-ac", "2", "-ar", str(RATE), "-c:a", "pcm_f32le",
        "-f", "f32le", "pipe:1",
    ], "承接音频解码")
    values = np.frombuffer(raw, dtype="<f4")
    available = len(values)//2
    if available < samples:
        raise RuntimeError(
            f"承接音频缺少样本：需要 {samples}，实际 {available}。"
            "请检查视频音轨或改为独立衔接。"
        )
    sound = values[:samples*2].reshape(samples, 2).T.copy()
    return {
        "waveform": torch.from_numpy(sound).unsqueeze(0),
        "sample_rate": RATE,
    }


def load_tail_context(path, output_frames, count):
    """Get raw IMAGE/AUDIO for the *declared* source range, not arbitrary EOF."""
    info = video_info(path)
    total_frames = int(output_frames)
    required = max(1, min(int(count), total_frames))
    if total_frames < 1 or info["frames_24fps"] < total_frames:
        raise ValueError(
            f"上下文来源视频太短：时间线需要 {total_frames} 帧，"
            f"文件约有 {info['frames_24fps']} 帧"
        )
    images = _video_tail(path, info["width"], info["height"], total_frames, required)
    audio = _audio_tail(path, total_frames-required, total_frames, info["has_audio"])
    return {"images": images, "audio": audio}
