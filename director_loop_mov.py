"""Frame-exact per-clip ProRes MOV output for the TerryDirector loop.

The loop never writes a full-size .pt video cache. Each clip is encoded once
as editable ProRes 422 HQ + 48 kHz PCM s24le; raw Float IMAGE is used only
while that clip executes. Full clips are retained for editorial use, while a
lightweight manifest supplies exact frame-accurate trim points for Final.mov.
The video merge uses stream copy; audio is reconstructed at sample precision.
"""

from __future__ import annotations

from fractions import Fraction
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

import numpy as np
import torch
import folder_paths

FPS = 24
OUTPUT_SAMPLE_RATE = 48000
SAMPLES_PER_FRAME = OUTPUT_SAMPLE_RATE // FPS
VIDEO_CODEC = "prores_ks"
AUDIO_CODEC = "pcm_s24le"
PRORES_PROFILE = "3"


def _safe_name(value, fallback="clip", limit=70):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or ""))
    value = re.sub(r"\s+", " ", value).strip(" .")
    return (value[:limit].rstrip(" .") or fallback)


def loop_mov_root(cache_key, run_signature):
    key = _safe_name(cache_key, "loop", 90)
    run = _safe_name(run_signature, "run", 80)
    root = Path(folder_paths.get_output_directory()) / "TerryDirector" / "clips" / key / run
    root.mkdir(parents=True, exist_ok=True)
    return root


def _ffmpeg_executable():
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        if ffmpeg and os.path.isfile(ffmpeg):
            return ffmpeg
    except (ImportError, RuntimeError, OSError):
        pass
    raise RuntimeError(
        "保存 ProRes MOV 需要 FFmpeg（带 prores_ks 和 pcm_s24le）。"
        "请安装 FFmpeg 或 imageio-ffmpeg 后重试。"
    )


def _ffmpeg_run(args, *, timeout=1800):
    command = [_ffmpeg_executable(), "-hide_banner", "-nostdin", "-loglevel", "error", *args]
    result = subprocess.run(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, timeout=timeout, check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        details = result.stderr.decode("utf-8", errors="replace")[-4000:]
        raise RuntimeError(f"FFmpeg 返回 {result.returncode}: {details}")


def _temporary_path(root, label, suffix):
    return str(root / f".{label}_{uuid.uuid4().hex}{suffix}")


def _atomic_json(path, data):
    path = Path(path)
    temporary = _temporary_path(path.parent, path.stem, ".json")
    try:
        with open(temporary, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def _read_manifest(root):
    path = Path(root) / "manifest.json"
    if path.exists():
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    return {"version": 2, "format": "mov_prores422_hq_pcm24",
            "fps": FPS, "audio_sample_rate": OUTPUT_SAMPLE_RATE,
            "clips": [], "status": "in_progress", "final_mov": None}


def _inspect_mov(path, *, expected_frames, require_audio=True):
    # PyAV is already a TerryDirector/ComfyUI dependency (used by the
    # previously shipped director_loop_video.py).
    import av
    with av.open(str(path)) as container:
        videos = list(container.streams.video)
        audios = list(container.streams.audio)
        if len(videos) != 1 or (require_audio and len(audios) != 1):
            raise RuntimeError("MOV 必须包含单条视频轨和单条音轨")
        video = videos[0]
        if video.codec_context.name not in ("prores", "prores_aw", "prores_ks"):
            raise RuntimeError("MOV 视频编码不是 ProRes")
        frame_count = int(video.frames or 0)
        if not frame_count:
            frame_count = sum(1 for packet in container.demux(video) if packet.size > 0)
        if frame_count != int(expected_frames):
            raise RuntimeError(
                f"MOV 帧数不匹配：{frame_count} != {expected_frames}，文件 {path}"
            )
        if require_audio:
            audio = audios[0]
            if audio.codec_context.name != AUDIO_CODEC:
                raise RuntimeError("MOV 音频不是 PCM 24-bit")
            if int(audio.codec_context.sample_rate) != OUTPUT_SAMPLE_RATE:
                raise RuntimeError("MOV PCM 音频采样率不是 48 kHz")
        return {"frames": frame_count, "width": int(video.width),
                "height": int(video.height),
                "channels": int(audios[0].codec_context.channels) if audios else 0}


def _write_prores_clip(images, audio, target, output_frames):
    if not isinstance(images, torch.Tensor):
        raise TypeError("循环 MOV 输出需要 IMAGE Tensor")
    if images.ndim != 4 or images.shape[-1] != 3:
        raise ValueError("循环 MOV IMAGE 必须是 [frames, height, width, 3]")
    if int(images.shape[0]) < output_frames:
        raise ValueError("MOV IMAGE 少于时间线要求的有效帧数")
    height, width = (int(images.shape[1]), int(images.shape[2]))
    if height <= 0 or width <= 0 or width % 2 or height % 2:
        raise ValueError("ProRes 422 HQ 要求有效且为偶数的宽高")

    if not isinstance(audio, dict):
        raise TypeError("循环 MOV AUDIO 格式不正确")
    waveform = audio.get("waveform")
    source_rate = int(audio.get("sample_rate") or 0)
    if (not isinstance(waveform, torch.Tensor) or waveform.ndim != 3
            or waveform.shape[0] != 1 or source_rate < 1):
        raise ValueError("循环 MOV AUDIO 必须是 [1, channels, samples] Tensor")
    channels = int(waveform.shape[1])
    if channels not in (1, 2, 6):
        raise ValueError("ProRes MOV PCM 音频仅支持 1/2/6 声道")

    root = Path(target).parent
    audio_file = _temporary_path(root, "audio", ".f32le")
    pending = _temporary_path(root, "video", ".mov")
    ffmpeg = _ffmpeg_executable()
    try:
        samples = waveform[0].detach().float().cpu().transpose(0, 1).contiguous()
        samples.numpy().astype("<f4", copy=False).tofile(audio_file)
        del samples
        command = [
            ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
            "-f", "rawvideo", "-pixel_format", "rgb48le",
            "-video_size", f"{width}x{height}", "-framerate", str(FPS),
            "-i", "pipe:0",
            "-f", "f32le", "-ar", str(source_rate), "-ac", str(channels),
            "-i", audio_file,
            "-map", "0:v:0", "-map", "1:a:0",
            "-frames:v", str(int(output_frames)),
            "-c:v", VIDEO_CODEC, "-profile:v", PRORES_PROFILE,
            "-pix_fmt", "yuv422p10le", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-colorspace", "bt709",
            "-c:a", AUDIO_CODEC, "-ar", str(OUTPUT_SAMPLE_RATE),
            "-af", ("aresample=48000:first_pts=0,apad,"
                    f"atrim=end_sample={int(output_frames) * SAMPLES_PER_FRAME},"
                    "asetpts=N/SR/TB"),
            "-f", "mov", "-y", pending,
        ]
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            assert process.stdin is not None
            for frame in images[:output_frames]:
                pixels = frame.detach().cpu().numpy()
                pixels = np.rint(
                    np.clip(pixels, 0.0, 1.0) * 65535.0
                ).astype("<u2", copy=False)
                process.stdin.write(pixels.tobytes())
                del pixels
            process.stdin.close()
            process.stdin = None
            _, stderr = process.communicate(timeout=1800)
            if process.returncode:
                raise RuntimeError(
                    "ProRes MOV 编码失败：" +
                    stderr.decode("utf-8", errors="replace")[-4000:]
                )
        except BaseException:
            if process.poll() is None:
                process.kill()
                process.communicate()
            raise
        _inspect_mov(pending, expected_frames=output_frames)
        os.replace(pending, target)
    finally:
        for path in (audio_file, pending):
            if os.path.isfile(path):
                os.remove(path)
    return {"frames": int(output_frames), "width": width, "height": height,
            "channels": channels, "audio_sample_rate": OUTPUT_SAMPLE_RATE}


def _store_context(root, segment_id, images, audio):
    # Only the context for the most recently completed clip is needed.
    # Float32 content is kept uncompressed in RAM between iterations; the
    # on-disk NPZ is solely for recovery after a restart.
    path = Path(root) / ".recovery"
    path.mkdir(exist_ok=True)
    tmp = _temporary_path(path, "context", ".npz")
    final = path / "next_context.npz"
    try:
        with open(tmp, "wb") as file:
            np.savez_compressed(
                file,
                segment_id=np.asarray(str(segment_id)),
                images=images.detach().cpu().numpy(),
                waveform=audio["waveform"].detach().cpu().numpy(),
                sample_rate=np.asarray(int(audio["sample_rate"])),
            )
        os.replace(tmp, final)
    finally:
        if os.path.isfile(tmp):
            os.remove(tmp)


def save_loop_mov_segment(*, images, audio, cache_key, run_signature,
                          segment_id, segment_name, position,
                          output_frames, trim_head_frames,
                          gap_frames, gap_after_frames,
                          context_frames, total_clips=None):
    """Write full editorial MOV but retain only minimal raw generation context.

    The overlap head is intentionally NOT removed here: users can trim source
    footage in their NLE. The final movie applies exactly this trim metadata.
    """
    output_frames = int(output_frames)
    if images.ndim == 5:
        images = images.reshape(-1, *images.shape[-3:])
    if images.ndim != 4 or images.shape[0] < output_frames:
        raise ValueError("循环视频画面缺少有效帧")
    if not isinstance(audio, dict) or "waveform" not in audio:
        raise TypeError("循环结束需要 AUDIO waveform")

    waveform = audio["waveform"]
    source_rate = int(audio["sample_rate"])
    if source_rate <= 0:
        raise ValueError("AUDIO 采样率无效")
    waveform = waveform[..., :round(output_frames * source_rate / FPS)]
    context_count = min(max(1, int(context_frames)), output_frames)
    # Next segment uses the original unassembled tail, not the MOV YUV result.
    context_images = images[output_frames-context_count:output_frames].clone()
    audio_count = max(1, round(context_count * source_rate / FPS))
    context_waveform = waveform[..., -audio_count:].clone()
    continuity_audio = {"waveform": context_waveform, "sample_rate": source_rate}

    trim = int(trim_head_frames)
    gap = int(gap_frames)
    gap_after = int(gap_after_frames)
    if trim < 0 or trim >= output_frames or gap < 0 or gap_after < 0:
        raise ValueError("时间线重叠/空档裁切数据无效")

    root = loop_mov_root(cache_key, run_signature)
    filename = f"{int(position) + 1:03d}_{_safe_name(segment_name)}.mov"
    target = root / filename
    technical = _write_prores_clip(
        images[:output_frames], {"waveform": waveform, "sample_rate": source_rate},
        target, output_frames,
    )
    _store_context(root, segment_id, context_images, continuity_audio)

    descriptor = {
        "index": int(position), "segment_id": str(segment_id),
        "name": str(segment_name), "path": str(target),
        "frames": output_frames, "trim_head_frames": trim,
        "gap_before_frames": gap, "gap_after_frames": gap_after,
        **technical,
    }
    manifest = _read_manifest(root)
    clips = [clip for clip in manifest["clips"] if clip["index"] != int(position)]
    clips.append(descriptor)
    manifest["clips"] = sorted(clips, key=lambda item: item["index"])
    manifest["total_clips"] = int(total_clips or len(manifest["clips"]))
    manifest["run_signature"] = str(run_signature)
    manifest["loop_id"] = str(cache_key)
    _atomic_json(root / "manifest.json", manifest)

    print(
        f"[TerryDirector Loop][MOV] Saved {filename}: frames={output_frames} "
        f"overlap_trim={trim} gap={gap} size={os.path.getsize(target)/2**20:.1f}MiB",
        flush=True,
    )
    return descriptor, context_images, continuity_audio


def _ffconcat_file_line(path):
    # ffconcat's own quoting syntax (not shell syntax). Paths use forward slash
    # on Windows for compatibility with the FFmpeg concat demuxer.
    value = Path(path).resolve().as_posix()
    return "file '" + value.replace("'", "'\\''") + "'"


def _make_gap(root, gap_frames, width, height, channels):
    if int(gap_frames) < 1:
        raise ValueError("间隔帧数必须大于零")
    target = Path(root) / f".gap_{gap_frames}_{width}x{height}_{channels}.mov"
    if target.is_file():
        try:
            _inspect_mov(target, expected_frames=gap_frames)
            return target
        except (RuntimeError, OSError, ValueError):
            target.unlink()
    layout = {1: "mono", 2: "stereo", 6: "5.1"}[channels]
    _ffmpeg_run([
        "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={FPS}",
        "-f", "lavfi", "-i",
        f"anullsrc=channel_layout={layout}:sample_rate={OUTPUT_SAMPLE_RATE}",
        "-frames:v", str(gap_frames),
        "-map", "0:v:0", "-map", "1:a:0",
        "-af", f"atrim=end_sample={gap_frames*SAMPLES_PER_FRAME},asetpts=N/SR/TB",
        "-c:v", VIDEO_CODEC, "-profile:v", PRORES_PROFILE,
        "-pix_fmt", "yuv422p10le", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", AUDIO_CODEC, "-ar", str(OUTPUT_SAMPLE_RATE),
        "-f", "mov", "-y", str(target),
    ])
    _inspect_mov(target, expected_frames=gap_frames)
    return target


def _timeline_entries(root, descriptors):
    clips = sorted(descriptors, key=lambda item: int(item["index"]))
    if not clips:
        raise ValueError("没有可合并的片段")
    if len({int(item["index"]) for item in clips}) != len(clips):
        raise ValueError("片段序号重复")
    entries = []
    base = clips[0]
    dimensions = (int(base["width"]), int(base["height"]), int(base["channels"]))
    for clip in clips:
        frames = int(clip["frames"])
        trim = int(clip.get("trim_head_frames", 0))
        gap = int(clip.get("gap_before_frames", 0))
        gap_after = int(clip.get("gap_after_frames", 0))
        if trim < 0 or trim >= frames or gap < 0 or gap_after < 0:
            raise ValueError("片段剪辑点超出有效时间范围")
        if (int(clip["width"]), int(clip["height"]), int(clip["channels"])) != dimensions:
            raise ValueError("合并影片要求所有片段宽高、声道一致")
        if not Path(clip["path"]).is_file():
            raise FileNotFoundError(f"片段 MOV 不存在：{clip['path']}")
        if gap:
            entries.append({"path": str(_make_gap(
                root, gap, dimensions[0], dimensions[1], dimensions[2])),
                "frames": gap, "trim": 0, "temporary_gap": True})
        entries.append({"path": str(clip["path"]), "frames": frames,
                        "trim": trim, "temporary_gap": False})
        if gap_after:
            entries.append({"path": str(_make_gap(
                root, gap_after, dimensions[0], dimensions[1], dimensions[2])),
                "frames": gap_after, "trim": 0, "temporary_gap": True})
    return entries


def merge_loop_mov_clips(descriptors, *, final_name="Final.mov"):
    """Packet-copy ProRes frames; sample-trim and remux only the PCM audio."""
    clips = [json.loads(item) if isinstance(item, str) else dict(item)
             for item in descriptors]
    if not clips:
        raise ValueError("循环结束没有 MOV 片段")
    root = Path(clips[0]["path"]).parent
    if any(Path(c["path"]).parent != root for c in clips):
        raise ValueError("不允许将不同运行目录的片段混合合并")
    entries = _timeline_entries(root, clips)
    total_frames = sum(int(e["frames"]) - int(e["trim"]) for e in entries)
    if total_frames <= 0:
        raise ValueError("时间线有效时长为零")
    concat_file = _temporary_path(root, "timeline", ".ffconcat")
    audio_filter = _temporary_path(root, "audiofilter", ".txt")
    video_temp = _temporary_path(root, "finalvideo", ".mov")
    audio_temp = _temporary_path(root, "finalaudio", ".wav")
    final_temp = _temporary_path(root, "finalmux", ".mov")
    final = root / _safe_name(final_name, "Final.mov", 100)
    if final.suffix.lower() != ".mov":
        final = final.with_suffix(".mov")

    try:
        with open(concat_file, "w", encoding="utf-8") as file:
            file.write("ffconcat version 1.0\n")
            for entry in entries:
                file.write(_ffconcat_file_line(entry["path"]) + "\n")
                if entry["trim"]:
                    file.write(f"inpoint {Fraction(entry['trim'], FPS)}\n")
                file.write(f"outpoint {Fraction(entry['frames'], FPS)}\n")

        _ffmpeg_run([
            "-safe", "0", "-f", "concat", "-i", concat_file,
            "-map", "0:v:0", "-an", "-c:v", "copy",
            "-fps_mode", "passthrough", "-f", "mov", "-y", video_temp,
        ])

        input_args = []
        filter_parts = []
        for i, entry in enumerate(entries):
            input_args.extend(["-i", entry["path"]])
            start = int(entry["trim"]) * SAMPLES_PER_FRAME
            stop = int(entry["frames"]) * SAMPLES_PER_FRAME
            filter_parts.append(
                f"[{i}:a:0]atrim=start_sample={start}:end_sample={stop},"
                f"asetpts=N/SR/TB[a{i}]"
            )
        filter_parts.append(
            "".join(f"[a{i}]" for i in range(len(entries))) +
            f"concat=n={len(entries)}:v=0:a=1[aout]"
        )
        with open(audio_filter, "w", encoding="utf-8") as file:
            file.write(";\n".join(filter_parts))
        _ffmpeg_run([
            *input_args, "-filter_complex_script", audio_filter,
            "-map", "[aout]", "-c:a", AUDIO_CODEC,
            "-ar", str(OUTPUT_SAMPLE_RATE), "-f", "wav", "-y", audio_temp,
        ])
        _ffmpeg_run([
            "-i", video_temp, "-i", audio_temp,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c", "copy", "-movflags", "+faststart",
            "-f", "mov", "-y", final_temp,
        ])
        information = _inspect_mov(final_temp, expected_frames=total_frames)
        os.replace(final_temp, final)
        manifest = _read_manifest(root)
        manifest["status"] = "completed"
        manifest["final_mov"] = str(final)
        manifest["final_frames"] = int(total_frames)
        manifest["merge_mode"] = "prores_video_stream_copy_pcm_sample_trim"
        _atomic_json(root / "manifest.json", manifest)
        print(
            f"[TerryDirector Loop][MOV] Final: clips={len(clips)} "
            f"frames={total_frames} fps={FPS} size={information['width']}x"
            f"{information['height']} path={final} (ProRes stream copy)",
            flush=True,
        )
        return str(final)
    finally:
        for path in (concat_file, audio_filter, video_temp, audio_temp, final_temp):
            if os.path.isfile(path):
                os.remove(path)
