"""TerryDirector loop media: persistent editable clips and frame-accurate assembly.

Each iteration saves an original, tail-trimmed MOV/MP4 immediately. The next
iteration gets original IMAGE/AUDIO tail context, independent of the codec.
No full-video .pt file is produced.  Final assembly reads those files, trims
the incoming overlap at integer frame boundaries and retains every clip.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import folder_paths
import numpy as np
import torch

FPS = 24
AUDIO_RATE = 48000
SAMPLES_PER_FRAME = AUDIO_RATE // FPS
MOV_HQ = "MOV · ProRes 422 HQ"
MP4_H264 = "MP4 · H.264"
FORMATS = (MOV_HQ, MP4_H264)


def _encoder(format_name: str) -> tuple[str, str]:
    if format_name == MOV_HQ:
        return "mov", "prores"
    if format_name == MP4_H264:
        return "mp4", "h264"
    raise ValueError(f"不支持的循环片段格式：{format_name}")


def _ffmpeg() -> str:
    candidates = [os.environ.get("FFMPEG_BINARY"), shutil.which("ffmpeg")]
    try:
        import imageio_ffmpeg
        candidates.append(imageio_ffmpeg.get_ffmpeg_exe())
    except (ImportError, RuntimeError):
        pass
    for path in candidates:
        if path and os.path.isfile(path):
            return str(path)
    raise RuntimeError(
        "TerryDirector 的 MOV/MP4 片段编码需要 FFmpeg。"
        "请安装 FFmpeg 或 imageio-ffmpeg，或者设置 FFMPEG_BINARY。"
    )


def _ffprobe() -> str | None:
    exe = _ffmpeg()
    sibling = os.path.join(os.path.dirname(exe), "ffprobe.exe" if os.name == "nt" else "ffprobe")
    return sibling if os.path.isfile(sibling) else shutil.which("ffprobe")


def _run(args: list[str], *, context: str):
    proc = subprocess.run(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if proc.returncode != 0:
        reason = proc.stderr.decode("utf-8", errors="replace")[-3500:]
        raise RuntimeError(f"{context}失败 (FFmpeg {proc.returncode})：\n{reason}")


def _probe_video(path: str, expected_frames: int):
    """Verify actual decoded count when ffprobe is available."""
    probe = _ffprobe()
    if probe:
        result = subprocess.run(
            [probe, "-v", "error", "-count_frames", "-select_streams", "v:0",
             "-show_entries", "stream=nb_read_frames", "-of", "json", path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("无法验证已编码的视频：" +
                               result.stderr.decode("utf-8", errors="replace")[-1200:])
        streams = json.loads(result.stdout).get("streams") or []
        count = streams[0].get("nb_read_frames") if streams else None
        if count not in (None, "N/A") and int(count) != expected_frames:
            raise RuntimeError(
                f"视频帧数错误：{os.path.basename(path)} 实际 {count} 帧，"
                f"应为 {expected_frames} 帧"
            )
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise RuntimeError("视频编码没有产生有效文件")


def _safe(text: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(text)).strip(" ._")[:56] or "clip"


def _run_dir(cache_key: str, run_signature: str) -> Path:
    root = (
        Path(folder_paths.get_output_directory())
        / "TerryDirector" / "renders"
        / _safe(cache_key) / _safe(run_signature)
    )
    root.mkdir(parents=True, exist_ok=True)
    return root


def _atomic_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with open(temporary, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _update_manifest(root: Path, descriptor: dict):
    path = root / "timeline.json"
    if path.is_file():
        with open(path, "r", encoding="utf-8") as source:
            manifest = json.load(source)
    else:
        manifest = {
            "version": 2, "fps": FPS, "audio_sample_rate": AUDIO_RATE,
            "status": "in_progress", "clips": [],
        }
    clips = [part for part in manifest["clips"]
             if int(part["index"]) != int(descriptor["index"])]
    clips.append(descriptor)
    clips.sort(key=lambda item: int(item["index"]))
    manifest["clips"] = clips
    manifest["segment_format"] = descriptor["segment_format"]
    if descriptor.get("plan_fingerprint"):
        manifest["plan_fingerprint"] = descriptor["plan_fingerprint"]
    if descriptor.get("body_fingerprint"):
        manifest["body_fingerprint"] = descriptor["body_fingerprint"]
    _atomic_json(path, manifest)


def _wav_source(audio: dict, maximum_frames: int, directory: Path) -> tuple[Path, int, int]:
    if not isinstance(audio, dict) or not isinstance(audio.get("waveform"), torch.Tensor):
        raise TypeError("TerryDirector 循环结束需要有效 AUDIO waveform")
    sample_rate = int(audio["sample_rate"])
    waveform = audio["waveform"]
    if waveform.ndim != 3 or int(waveform.shape[0]) != 1:
        raise ValueError("循环器只支持单批次 AUDIO，形状必须为 [1, channels, samples]")
    channels = int(waveform.shape[1])
    if channels not in (1, 2, 6) or sample_rate < 8000:
        raise ValueError("不支持的音频采样率或声道数")
    required = max(1, round(maximum_frames * sample_rate / FPS))
    values = waveform[0, :, :required].detach().to(device="cpu", dtype=torch.float32)
    if int(values.shape[-1]) < required:
        # Generated H3 audio sometimes differs by a few samples. Preserve
        # exact duration by padding rather than extending a codec timestamp.
        values = torch.nn.functional.pad(values, (0, required - values.shape[-1]))
    if not bool(torch.isfinite(values).all()):
        raise ValueError("AUDIO 含非有限值，拒绝编码")
    handle, raw_path = tempfile.mkstemp(suffix=".f32le", prefix=".td_audio_", dir=directory)
    os.close(handle)
    raw = Path(raw_path)
    try:
        interleaved = values.transpose(0, 1).contiguous().numpy().astype("<f4", copy=False)
        with open(raw, "wb") as output:
            output.write(interleaved.tobytes())
    except BaseException:
        raw.unlink(missing_ok=True)
        raise
    return raw, sample_rate, channels


def _write_clip(
    images: torch.Tensor, audio: dict, *,
    output_path: Path, format_name: str, frames: int,
) -> None:
    ext, _ = _encoder(format_name)
    if images.ndim != 4 or images.shape[-1] != 3 or len(images) < frames:
        raise ValueError("片段 IMAGE 必须为 [frames,height,width,3] 且帧数足够")
    height, width = map(int, images.shape[1:3])
    if width % 2 or height % 2:
        raise ValueError("ProRes / H.264 片段需要偶数宽高")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(
        f".{output_path.stem}.{uuid.uuid4().hex}.partial.{ext}"
    )
    raw_audio, sr, ch = _wav_source(audio, frames, output_path.parent)
    sound_samples = frames * SAMPLES_PER_FRAME
    command = [
        _ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pixel_format", "rgb48le",
        "-video_size", f"{width}x{height}", "-framerate", str(FPS), "-i", "pipe:0",
        "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", str(raw_audio),
        "-map", "0:v:0", "-map", "1:a:0",
        "-filter:a", (
            f"aresample={AUDIO_RATE},apad=whole_len={sound_samples},"
            f"atrim=end_sample={sound_samples},asetpts=PTS-STARTPTS"
        ),
        "-frames:v", str(frames), "-ar", str(AUDIO_RATE),
        "-color_primaries", "bt709", "-color_trc", "bt709",
        "-colorspace", "bt709", "-r", str(FPS),
    ]
    if ext == "mov":
        command += [
            "-c:v", "prores_ks", "-profile:v", "3",
            "-pix_fmt", "yuv422p10le", "-vendor", "apl0",
            "-c:a", "pcm_s24le", "-f", "mov",
        ]
    else:
        command += [
            "-c:v", "libx264", "-crf", "17", "-preset", "medium",
            "-pix_fmt", "yuv420p", "-g", "48",
            "-c:a", "aac", "-b:a", "320k",
            "-movflags", "+faststart", "-f", "mp4",
        ]
    command.append(str(temporary))
    log = output_path.with_name("." + output_path.name + ".ffmpeg.log")
    try:
        with open(log, "wb") as stderr:
            with subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                stderr=stderr,
            ) as process:
                try:
                    for image in images[:frames]:
                        # 16-bit RGB input preserves gradients until FFmpeg's
                        # one-time RGB -> ProRes 10-bit 4:2:2 conversion.
                        pixels = (
                            image.detach().to(device="cpu", dtype=torch.float32)
                            .clamp(0.0, 1.0)
                            .mul(65535.0).round().to(dtype=torch.uint16)
                            .numpy().astype("<u2", copy=False)
                        )
                        process.stdin.write(pixels.tobytes())
                    process.stdin.close()
                    rc = process.wait()
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
        if rc:
            error = log.read_text(encoding="utf-8", errors="replace")[-2400:]
            raise RuntimeError(f"片段 {output_path.name} FFmpeg 编码失败：{error}")
        _probe_video(str(temporary), frames)
        os.replace(temporary, output_path)
    finally:
        raw_audio.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        log.unlink(missing_ok=True)


def _context_checkpoint(root: Path, images: torch.Tensor, waveform: torch.Tensor,
                        sample_rate: int, index: int):
    """Only latest carry context is persisted, never the full IMAGE."""
    path = root / ".recovery" / "next_context.npz"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with open(temporary, "wb") as output:
            np.savez(
                output, images=images.detach().cpu().numpy(),
                waveform=waveform.detach().cpu().numpy(),
                sample_rate=np.int64(sample_rate), index=np.int64(index),
            )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_loop_segment(
    *, images: torch.Tensor, audio: dict, segment: dict,
    format_name: str,
) -> tuple[str, torch.Tensor, dict]:
    """Save original clip while retaining only the next clip's raw context."""
    loop = segment["_loop"]
    assembly = segment["assembly"]
    frames = int(segment["output_frames"])
    if not isinstance(images, torch.Tensor):
        raise TypeError("循环结束必须连接已解码 IMAGE")
    if images.ndim == 5:
        images = images.reshape(-1, *images.shape[-3:])
    if images.ndim != 4 or int(images.shape[-1]) != 3 or int(images.shape[0]) < frames:
        raise ValueError("片段的最终 IMAGE 帧数/通道不符合时间线")
    images = images[:frames]
    if not isinstance(audio, dict) or not isinstance(audio.get("waveform"), torch.Tensor):
        raise TypeError("循环结束必须连接已解码 AUDIO")
    sample_rate = int(audio["sample_rate"])
    samples = round(frames * sample_rate / FPS)
    waveform = audio["waveform"][..., :samples]
    count = min(max(1, int(loop["context_frames"])), frames)
    context_images = images[-count:].detach().cpu().clone()
    context_samples = max(1, round(count * sample_rate / FPS))
    context_audio = waveform[..., -context_samples:].detach().cpu().clone()
    carry = {"waveform": context_audio, "sample_rate": sample_rate}

    ext, codec = _encoder(format_name)
    root = _run_dir(loop["cache_key"], loop["run_signature"])
    clip_name = (
        f"{int(loop.get('authored_index', loop['index'])) + 1:03d}_{_safe(segment['name'])}_"
        f"{_safe(segment['id'])}.{ext}"
    )
    output_path = root / "clips" / clip_name
    _write_clip(images, audio, output_path=output_path, format_name=format_name, frames=frames)
    # The encoded clip intentionally keeps its overlapping head. Only the
    # final assembled movie applies the head trim.
    descriptor = {
        "index": int(loop["index"]),
        "authored_index": int(loop.get("authored_index", loop["index"])),
        "segment_id": str(segment["id"]),
        "name": str(segment["name"]),
        "seed": str(loop["seed"]),
        "continuity": dict(segment.get("continuity") or {}),
        "transition_mode": str(segment.get("transition_mode") or ""),
        "upstream_source": loop.get("upstream_path"),
        "upstream_type": loop.get("upstream_type"),
        "rerun_target": loop.get("rerun_target") or None,
        "recipe_fingerprint": loop.get("recipe_fingerprint"),
        "plan_fingerprint": loop.get("plan_fingerprint"),
        "body_fingerprint": loop.get("body_fingerprint"),
        "path": str(output_path),
        "file_size": output_path.stat().st_size,
        "frames": frames,
        "trim_head_frames": int(assembly["trim_head_frames"]),
        "trim_tail_frames": int(assembly["trim_tail_frames"]),
        "gap_before_frames": int(assembly["gap_before_frames"]),
        "width": int(images.shape[2]), "height": int(images.shape[1]),
        "fps": FPS, "audio_sample_rate": AUDIO_RATE,
        "channels": int(audio["waveform"].shape[1]),
        "segment_format": format_name, "video_codec": codec,
        "run_signature": str(loop["run_signature"]),
        "loop_id": str(loop["loop_id"]),
    }
    _context_checkpoint(
        root, context_images, context_audio, sample_rate, int(loop["index"])
    )
    _update_manifest(root, descriptor)
    print(
        f"[TerryDirector Loop][Clip] Saved {clip_name}: "
        f"frames={frames}, trim_in_final={descriptor['trim_head_frames']}, "
        f"size={output_path.stat().st_size / 2**20:.1f}MiB",
        flush=True,
    )
    return json.dumps(descriptor, ensure_ascii=False), context_images, carry



def complete_isolated_rerun(descriptors: list[dict], clip_id: str):
    """Commit a new take without touching any earlier full-length Final."""
    if not descriptors:
        raise ValueError("重跑没有生成任何片段")
    root = Path(descriptors[0]["path"]).resolve().parent.parent
    for item in descriptors:
        if str(item.get("segment_id")) != str(clip_id):
            raise ValueError("单片段重跑混入了其他已保存镜头")
    manifest = root / "timeline.json"
    if not manifest.is_file():
        raise FileNotFoundError("本次重跑的视频文件记录缺失")
    with open(manifest, encoding="utf-8") as source:
        state = json.load(source)
    state["status"] = "completed"
    state["rerun_target"] = str(clip_id)
    state["final"] = None
    _atomic_json(manifest, state)
    (root / ".recovery" / "next_context.npz").unlink(missing_ok=True)
    print(
        f"[TerryDirector Loop][Rerun] {clip_id}: "
        f"saved {descriptors[0]['path']} without overwriting Final",
        flush=True,
    )


def _raw_audio(path: str, channels: int, directory: Path) -> Path:
    fd, tmp = tempfile.mkstemp(prefix=".td_audio_decoded_", suffix=".pcm", dir=directory)
    os.close(fd)
    target = Path(tmp)
    try:
        _run([
            _ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
            "-i", path, "-map", "0:a:0", "-vn",
            "-ac", str(channels), "-ar", str(AUDIO_RATE),
            "-c:a", "pcm_s24le", "-f", "s24le", str(target),
        ], context="解码片段音频")
        return target
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def _black_video(path: Path, frames: int, width: int, height: int,
                 format_name: str):
    ext, _ = _encoder(format_name)
    command = [
        _ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={FPS}",
        "-frames:v", str(frames), "-an",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    ]
    if ext == "mov":
        command += ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
    else:
        command += ["-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p"]
    _run(command + ["-f", ext, str(path)], context="生成时间线空档")
    _probe_video(str(path), frames)


def _concat_video(parts: list[tuple[Path, int, int]], destination: Path, format_name: str,
                  expected_frames: int):
    ext, _ = _encoder(format_name)
    if ext == "mov":
        concat_file = destination.with_suffix(".ffconcat")
        try:
            with open(concat_file, "w", encoding="utf-8") as output:
                output.write("ffconcat version 1.0\n")
                for path, lo, hi in parts:
                    # Absolute forward-slash paths are accepted by concat
                    # demuxer on Windows; escape embedded apostrophes.
                    escaped = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
                    output.write(f"file '{escaped}'\n")
                    output.write(f"inpoint {lo / FPS:.12f}\n")
                    output.write(f"outpoint {hi / FPS:.12f}\n")
            _run([
                _ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
                "-safe", "0", "-f", "concat", "-i", str(concat_file),
                "-map", "0:v:0", "-an", "-c:v", "copy",
                "-f", "mov", str(destination),
            ], context="ProRes 无重编码拼接")
            _probe_video(str(destination), expected_frames)
        finally:
            concat_file.unlink(missing_ok=True)
        return

    # If MP4 needs no overlap/gap edits, stream-copy the original H.264
    # bitstreams. Otherwise GOP dependencies make arbitrary inpoints unsafe,
    # so fall back to exact frame-filtering and one final H.264 encode.
    if all(lo == 0 and not path.stem.startswith("gap_") for path, lo, _ in parts):
        concat_file = destination.with_suffix(".ffconcat")
        try:
            with open(concat_file, "w", encoding="utf-8") as output:
                output.write("ffconcat version 1.0\n")
                for path, _, _ in parts:
                    escaped = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
                    output.write(f"file '{escaped}'\n")
            try:
                _run([
                    _ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
                    "-safe", "0", "-f", "concat", "-i", str(concat_file),
                    "-map", "0:v:0", "-an", "-c:v", "copy",
                    "-f", "mp4", str(destination),
                ], context="H.264 无裁切流复制拼接")
                _probe_video(str(destination), expected_frames)
                return
            except RuntimeError as exc:
                destination.unlink(missing_ok=True)
                print(f"[TerryDirector Loop] MP4 stream copy fallback: {exc}", flush=True)
        finally:
            concat_file.unlink(missing_ok=True)

    # H.264 frames are interdependent within a GOP: stream-copying an
    # arbitrary overlap cut can duplicate/miss frames. Use frame-accurate
    # decoding/filtering when trimming MP4, keeping the output 24fps.
    command = [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]
    for path, _, _ in parts:
        command.extend(["-i", str(path)])
    filters = [
        f"[{i}:v:0]trim=start_frame={lo}:end_frame={hi},"
        f"setpts=PTS-STARTPTS[v{i}]"
        for i, (_, lo, hi) in enumerate(parts)
    ]
    filters.append(
        "".join(f"[v{i}]" for i in range(len(parts))) +
        f"concat=n={len(parts)}:v=1:a=0[v]"
    )
    command += [
        "-filter_complex", ";".join(filters), "-map", "[v]", "-an",
        "-c:v", "libx264", "-crf", "17", "-preset", "medium",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-f", "mp4", str(destination),
    ]
    _run(command, context="H.264 帧精确拼接")
    _probe_video(str(destination), expected_frames)


def merge_loop_clips(
    descriptors: list[dict], *, merge_final: bool,
    output_root: str | Path | None = None,
    source_root: str | Path | None = None,
) -> str | None:
    """Frame-exact Final: normal run or copy-only rebuild across old takes.

    Rebuild writes a new assembly directory and references the original
    encoded MOVs; the source files are neither duplicated nor overwritten.
    """
    if not descriptors:
        raise ValueError("循环没有生成有效片段")
    ordered = sorted(descriptors, key=lambda part: int(part["index"]))
    format_name = ordered[0]["segment_format"]
    ext, codec = _encoder(format_name)
    cross_run = output_root is not None
    if cross_run and not merge_final:
        raise ValueError("重组整片必须启用合并")
    root = (
        Path(output_root).resolve() if cross_run
        else Path(ordered[0]["path"]).resolve().parent.parent
    )
    allowed = Path(source_root).resolve() if source_root else root
    if cross_run and (
        source_root is None or not root.is_relative_to(allowed / "assemblies")
    ):
        raise ValueError("重组整片的输出目录必须位于循环器私有 assemblies 目录")
    expected_run = str(ordered[0]["run_signature"])
    if not all(
        (cross_run or str(part.get("run_signature")) == expected_run)
        and str(part.get("segment_format")) == format_name
        and int(part.get("fps", 0)) == FPS
        and int(part.get("width", 0)) == int(ordered[0]["width"])
        and int(part.get("height", 0)) == int(ordered[0]["height"])
        and int(part.get("channels", 0)) == int(ordered[0]["channels"])
        and Path(part["path"]).is_file()
        and Path(part["path"]).resolve().is_relative_to(allowed)
        and (cross_run or Path(part["path"]).resolve().parent.parent == root)
        and (
            not part.get("file_size")
            or Path(part["path"]).stat().st_size == int(part["file_size"])
        )
        for part in ordered
    ):
        raise ValueError("循环片段编码参数、文件大小、来源路径或运行签名不一致")
    if [int(item["index"]) for item in ordered] != list(range(len(ordered))):
        raise ValueError("循环片段缺失或顺序不连续")
    if not merge_final:
        manifest = root / "timeline.json"
        if manifest.is_file():
            with open(manifest, encoding="utf-8") as source:
                state = json.load(source)
            state["status"] = "completed"
            state["final"] = None
            state["final_frames"] = sum(
                int(part["gap_before_frames"]) +
                int(part["frames"]) - int(part["trim_head_frames"])
                for part in ordered
            )
            _atomic_json(manifest, state)
        # No next segment is pending. Failure snapshots are useful only
        # while the run is incomplete.
        (root / ".recovery" / "next_context.npz").unlink(missing_ok=True)
        return None

    channels = int(ordered[0]["channels"])
    video_parts: list[tuple[Path, int, int]] = []
    expected_frames = 0
    root.mkdir(parents=True, exist_ok=True)
    if cross_run:
        _atomic_json(root / "timeline.json", {
            "version": 2, "fps": FPS, "audio_sample_rate": AUDIO_RATE,
            "status": "in_progress", "segment_format": format_name,
            "clips": ordered,
            "assembled_from_history": True,
        })
    work = root / ".merging"
    work.mkdir(exist_ok=True)
    pcm = work / "timeline_audio.pcm"
    video_only = work / ("timeline_video." + ext)
    final = root / ("Final." + ext)
    temporary = root / (".Final." + uuid.uuid4().hex + ".partial." + ext)
    gap_files: dict[int, Path] = {}
    try:
        with open(pcm, "wb") as merged_audio:
            for part in ordered:
                gap = int(part["gap_before_frames"])
                count = int(part["frames"])
                trim = int(part["trim_head_frames"])
                if gap < 0 or count <= trim or trim < 0:
                    raise ValueError("无效的时间线重叠或空档帧数")
                if gap:
                    gap_file = gap_files.get(gap)
                    if gap_file is None:
                        gap_file = work / f"gap_{gap:06d}.{ext}"
                        _black_video(
                            gap_file, gap, int(part["width"]), int(part["height"]), format_name
                        )
                        gap_files[gap] = gap_file
                    video_parts.append((gap_file, 0, gap))
                    remaining = gap * SAMPLES_PER_FRAME * channels * 3
                    while remaining:
                        block = min(remaining, 1024 * 1024)
                        merged_audio.write(bytes(block))
                        remaining -= block
                    expected_frames += gap

                video_parts.append((Path(part["path"]), trim, count))
                expected_frames += count - trim
                raw = _raw_audio(part["path"], channels, work)
                try:
                    offset = trim * SAMPLES_PER_FRAME * channels * 3
                    length = (count - trim) * SAMPLES_PER_FRAME * channels * 3
                    with open(raw, "rb") as sound:
                        sound.seek(offset)
                        while length:
                            chunk = sound.read(min(length, 1024 * 1024))
                            if not chunk:
                                raise RuntimeError(
                                    f"片段 {part['index'] + 1} 音频不足，"
                                    "无法保证音画同步"
                                )
                            merged_audio.write(chunk)
                            length -= len(chunk)
                finally:
                    raw.unlink(missing_ok=True)

        _concat_video(video_parts, video_only, format_name, expected_frames)
        command = [
            _ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(video_only),
            "-f", "s24le", "-ar", str(AUDIO_RATE),
            "-ac", str(channels), "-i", str(pcm),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-ar", str(AUDIO_RATE),
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        ]
        if ext == "mov":
            command += ["-c:a", "pcm_s24le", "-f", "mov"]
        else:
            command += ["-c:a", "aac", "-b:a", "320k",
                        "-movflags", "+faststart", "-f", "mp4"]
        _run(command + [str(temporary)], context="最终视频音画封装")
        _probe_video(str(temporary), expected_frames)
        os.replace(temporary, final)
        manifest = root / "timeline.json"
        if manifest.exists():
            with open(manifest, encoding="utf-8") as source:
                state = json.load(source)
            state["status"] = "completed"
            state["final"] = str(final)
            state["final_frames"] = expected_frames
            _atomic_json(manifest, state)
        (root / ".recovery" / "next_context.npz").unlink(missing_ok=True)
        print(
            f"[TerryDirector Loop][Final] {final}, frames={expected_frames}, "
            f"fps={FPS}, format={format_name}",
            flush=True,
        )
        return str(final)
    finally:
        temporary.unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)
