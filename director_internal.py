from __future__ import annotations

import json
import os
import re
import tempfile
import time

import folder_paths
import torch

from comfy.cli_args import args
from comfy_api.latest import io, ui, Types

DirectorOutputData = io.Custom("TERRYDIRECTOR_OUTPUT")


class TerryDirectorPackOutput(io.ComfyNode):
    """Internal packer for the single TerryDirector public output socket."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.Autogrow.TemplatePrefix(
            io.Latent.Input("latent"),
            prefix="latent_",
            min=1,
            max=64,
        )
        return io.Schema(
            node_id="TerryDirectorPackOutput",
            display_name="TerryDirector Pack Output (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Autogrow.Input("latents", template=template),
                io.Image.Input("images"),
                io.Audio.Input("audio"),
            ],
            outputs=[DirectorOutputData.Output(display_name="导演输出")],
        )

    @classmethod
    def execute(cls, latents, images, audio) -> io.NodeOutput:
        return io.NodeOutput({
            "segment_latents": list(latents.values()),
            "images": images,
            "audio": audio,
        })



def _advanced_cache_root(cache_key: str) -> str:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cache_key or "default"))[:160]
    root = os.path.join(folder_paths.get_output_directory(), ".terrydirector_cache", safe_key)
    os.makedirs(root, exist_ok=True)
    return root


def _advanced_cache_path(cache_key: str, segment_id: str) -> str:
    safe_segment = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(segment_id or "segment"))[:160]
    return os.path.join(_advanced_cache_root(cache_key), f"{safe_segment}.pt")


def _advanced_state_path(cache_key: str) -> str:
    return os.path.join(_advanced_cache_root(cache_key), "state.json")


def _advanced_checkpoint_path(cache_key: str) -> str:
    return os.path.join(_advanced_cache_root(cache_key), "checkpoint.json")


def _write_json_atomic(path: str, payload: dict, prefix: str) -> None:
    fd, temp_path = tempfile.mkstemp(prefix=prefix, suffix=".json", dir=os.path.dirname(path))
    os.close(fd)
    try:
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def load_advanced_checkpoint(cache_key: str) -> dict | None:
    path = _advanced_checkpoint_path(cache_key)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def reset_advanced_checkpoint(
    cache_key: str,
    run_signature: str,
    segment_ids: list[str],
    segment_signatures: list[str],
) -> dict:
    payload = {
        "version": 1,
        "status": "running",
        "run_signature": str(run_signature),
        "segment_ids": [str(value) for value in segment_ids],
        "segment_signatures": [str(value) for value in segment_signatures],
        "completed_segment_ids": [],
        "started_at": time.time(),
        "updated_at": time.time(),
    }
    _write_json_atomic(
        _advanced_checkpoint_path(cache_key),
        payload,
        "td_checkpoint_",
    )
    return payload


def mark_advanced_checkpoint_segment(
    cache_key: str,
    run_signature: str,
    segment_id: str,
    segment_ids: list[str],
    segment_signatures: list[str],
) -> dict:
    payload = load_advanced_checkpoint(cache_key)
    if (
        not isinstance(payload, dict)
        or str(payload.get("run_signature")) != str(run_signature)
        or [str(value) for value in payload.get("segment_ids", [])]
            != [str(value) for value in segment_ids]
    ):
        payload = reset_advanced_checkpoint(
            cache_key,
            run_signature,
            segment_ids,
            segment_signatures,
        )

    completed = [str(value) for value in payload.get("completed_segment_ids", [])]
    sid = str(segment_id)
    if sid not in completed:
        completed.append(sid)
    ordered = [str(value) for value in segment_ids]
    completed_set = set(completed)
    payload["completed_segment_ids"] = [
        value for value in ordered if value in completed_set
    ]
    payload["status"] = "partial"
    payload["updated_at"] = time.time()
    _write_json_atomic(
        _advanced_checkpoint_path(cache_key),
        payload,
        "td_checkpoint_",
    )
    return payload


def finalize_advanced_checkpoint(
    cache_key: str,
    run_signature: str,
    video: dict | None = None,
) -> None:
    payload = load_advanced_checkpoint(cache_key)
    if not isinstance(payload, dict):
        return
    if str(payload.get("run_signature")) != str(run_signature):
        return
    payload["status"] = "complete"
    payload["updated_at"] = time.time()
    if video is not None:
        payload["video"] = video
    _write_json_atomic(
        _advanced_checkpoint_path(cache_key),
        payload,
        "td_checkpoint_",
    )


def update_advanced_checkpoint_partial_video(
    cache_key: str,
    run_signature: str,
    video: dict,
) -> None:
    payload = load_advanced_checkpoint(cache_key)
    if not isinstance(payload, dict):
        return
    if str(payload.get("run_signature")) != str(run_signature):
        return
    payload["status"] = "partial"
    payload["updated_at"] = time.time()
    payload["partial_video"] = video
    _write_json_atomic(
        _advanced_checkpoint_path(cache_key),
        payload,
        "td_checkpoint_",
    )


def _cache_to_cpu(value):
    if isinstance(value, torch.Tensor):
        return value.detach().cpu()
    # MiniMax H3 AV latents store video/audio tensors in ComfyUI's
    # NestedTensor wrapper. Handle it explicitly so torch.save never receives
    # CUDA-backed tensors by accident.
    if getattr(value, "is_nested", False) and hasattr(value, "cpu"):
        return value.cpu()
    if isinstance(value, dict):
        return {key: _cache_to_cpu(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_cache_to_cpu(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_cache_to_cpu(item) for item in value)
    return value


def _save_advanced_cache_latent(latent, cache_key, segment_id, signature):
    path = _advanced_cache_path(cache_key, segment_id)

    copy_started = time.perf_counter()
    cpu_latent = _cache_to_cpu(latent)
    copy_seconds = time.perf_counter() - copy_started

    payload = {
        "version": 1,
        "signature": str(signature),
        "latent": cpu_latent,
    }
    fd, temp_path = tempfile.mkstemp(prefix="td_", suffix=".pt", dir=os.path.dirname(path))
    os.close(fd)

    disk_started = time.perf_counter()
    try:
        torch.save(payload, temp_path)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
    disk_seconds = time.perf_counter() - disk_started

    try:
        size_mb = os.path.getsize(path) / (1024 * 1024)
    except OSError:
        size_mb = 0.0

    return path, copy_seconds, disk_seconds, size_mb


class TerryDirectorCacheLatent(io.ComfyNode):
    """Persist one sampled segment latent for Advanced local reruns."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorCacheLatent",
            display_name="TerryDirector Cache Latent (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Latent.Input("latent"),
                io.String.Input("cache_key"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
                io.String.Input("run_signature"),
                io.String.Input("segment_ids_json"),
                io.String.Input("segment_signatures_json"),
            ],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # This node has a deliberate disk side effect; never let Comfy skip it
        # when the sampled latent reaches this point.
        return float("NaN")

    @classmethod
    def execute(
        cls,
        latent,
        cache_key,
        segment_id,
        signature,
        run_signature,
        segment_ids_json,
        segment_signatures_json,
    ) -> io.NodeOutput:
        path, copy_seconds, disk_seconds, size_mb = _save_advanced_cache_latent(
            latent, cache_key, segment_id, signature
        )
        try:
            segment_ids = json.loads(str(segment_ids_json or "[]"))
            segment_signatures = json.loads(str(segment_signatures_json or "[]"))
            if not isinstance(segment_ids, list):
                segment_ids = []
            if not isinstance(segment_signatures, list):
                segment_signatures = []
            mark_advanced_checkpoint_segment(
                str(cache_key),
                str(run_signature),
                str(segment_id),
                [str(value) for value in segment_ids],
                [str(value) for value in segment_signatures],
            )
        except Exception as exc:
            print(
                f"[TerryDirector Advanced] Checkpoint manifest update failed: {exc}",
                flush=True,
            )
        print(
            f"[TerryDirector Advanced][Perf] Checkpoint {segment_id}: "
            f"cpu={copy_seconds:.3f}s disk={disk_seconds:.3f}s "
            f"size={size_mb:.1f}MB path={path}",
            flush=True,
        )
        return io.NodeOutput(latent)


class TerryDirectorLoadCachedLatent(io.ComfyNode):
    """Load an existing sampled latent instead of re-running H3 sampling."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorLoadCachedLatent",
            display_name="TerryDirector Load Cached Latent (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.String.Input("cache_key"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
            ],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, cache_key, segment_id, signature, **kwargs):
        path = _advanced_cache_path(cache_key, segment_id)
        try:
            stat = os.stat(path)
            return f"{stat.st_mtime_ns}:{stat.st_size}:{signature}"
        except OSError:
            return float("NaN")

    @classmethod
    def execute(cls, cache_key, segment_id, signature) -> io.NodeOutput:
        path = _advanced_cache_path(cache_key, segment_id)
        if not os.path.isfile(path):
            raise RuntimeError(
                f"TerryDirector Advanced 找不到片段 {segment_id} 的缓存。"
                "请先完整生成一次，再使用局部重跑。"
            )
        payload = torch.load(path, map_location="cpu", weights_only=False)
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise RuntimeError(f"TerryDirector Advanced 片段 {segment_id} 缓存格式无效")
        if str(payload.get("signature")) != str(signature):
            raise RuntimeError(
                f"TerryDirector Advanced 片段 {segment_id} 的尺寸/时长已改变，"
                "请先完整生成一次刷新缓存。"
            )
        latent = payload.get("latent")
        if not isinstance(latent, dict) or "samples" not in latent:
            raise RuntimeError(f"TerryDirector Advanced 片段 {segment_id} 缓存缺少 LATENT")
        return io.NodeOutput(latent)


class TerryDirectorAdvancedFinish(io.ComfyNode):
    """Terminal Advanced step using ComfyUI 0.39.0 native SaveVideo semantics."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorAdvancedFinish",
            display_name="TerryDirector Advanced Finish (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                DirectorOutputData.Input("director_output"),
                io.Video.Input("video"),
                io.String.Input("filename_prefix"),
                io.String.Input("format"),
                io.String.Input("codec"),
                io.String.Input("cache_key"),
                io.String.Input("segment_ids_json"),
                io.String.Input("segment_signatures_json"),
                io.String.Input("cache_only_segment_id"),
                io.String.Input("run_signature"),
                io.String.Input("state_mode"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            outputs=[DirectorOutputData.Output(display_name="导演输出")],
        )

    @classmethod
    def execute(
        cls, director_output, video, filename_prefix, format, codec,
        cache_key, segment_ids_json, segment_signatures_json,
        cache_only_segment_id, run_signature, state_mode,
    ) -> io.NodeOutput:
        if video is None:
            raise RuntimeError("TerryDirector Advanced 视频创建失败，未保存")

        terminal_started = time.perf_counter()

        try:
            segment_ids = json.loads(str(segment_ids_json or "[]"))
            if not isinstance(segment_ids, list):
                segment_ids = []
        except Exception:
            segment_ids = []
        try:
            segment_signatures = json.loads(str(segment_signatures_json or "[]"))
            if not isinstance(segment_signatures, list):
                segment_signatures = []
        except Exception:
            segment_signatures = []

        cache_enabled = bool(str(cache_key or "").strip())
        state_mode = str(state_mode or "complete").strip().lower()
        if cache_enabled:
            packet_latents = (
                director_output.get("segment_latents", [])
                if isinstance(director_output, dict)
                else []
            )
            if len(segment_ids) != len(packet_latents) or len(segment_signatures) != len(packet_latents):
                raise RuntimeError(
                    "TerryDirector Advanced 缓存清单与分段 LATENT 数量不一致"
                )
            print(
                f"[TerryDirector Advanced][Perf] Segment checkpoints already persisted: "
                f"segments={len(segment_ids)} mode={state_mode}",
                flush=True,
            )
        else:
            print(
                "[TerryDirector Advanced][Diagnostic] Cache disabled; "
                "testing video/save topology only",
                flush=True,
            )

        format_name = str(format or "auto")
        codec_name = str(codec or "auto")
        if format_name == "auto":
            format_name = "webm" if codec_name == "av1" else "mp4"

        width, height = video.get_dimensions()
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            str(filename_prefix),
            folder_paths.get_output_directory(),
            width,
            height,
        )

        saved_metadata = None
        if not args.disable_metadata:
            metadata = {}
            if cls.hidden.extra_pnginfo is not None:
                metadata.update(cls.hidden.extra_pnginfo)
            if cls.hidden.prompt is not None:
                metadata["prompt"] = cls.hidden.prompt
            if metadata:
                saved_metadata = metadata

        file = f"{filename}_{counter:05}_.{Types.VideoContainer.get_extension(format_name)}"
        output_path = os.path.join(full_output_folder, file)

        print(f"[TerryDirector Advanced] Saving video: {output_path}", flush=True)
        video_started = time.perf_counter()
        video.save_to(
            output_path,
            format=Types.VideoContainer(format_name),
            codec=Types.VideoCodec(codec_name),
            metadata=saved_metadata,
        )
        video_seconds = time.perf_counter() - video_started
        print(
            f"[TerryDirector Advanced][Perf] Video save complete: "
            f"{video_seconds:.3f}s path={output_path}",
            flush=True,
        )
        if cache_enabled:
            video_state = {
                "filename": file,
                "subfolder": subfolder,
                "type": io.FolderType.output.value,
            }
            if state_mode == "partial":
                update_advanced_checkpoint_partial_video(
                    str(cache_key),
                    str(run_signature),
                    video_state,
                )
            else:
                state = {
                    "version": 2,
                    "saved_at": time.time(),
                    "video": video_state,
                    "segment_ids": [str(value) for value in segment_ids],
                    "run_signature": str(run_signature),
                }
                _write_json_atomic(
                    _advanced_state_path(str(cache_key)),
                    state,
                    "td_state_",
                )
                finalize_advanced_checkpoint(
                    str(cache_key),
                    str(run_signature),
                    video_state,
                )

        print(
            f"[TerryDirector Advanced][Perf] Terminal total: "
            f"{time.perf_counter() - terminal_started:.3f}s",
            flush=True,
        )

        # Publish this as a normal video asset without PreviewVideo.
        # ComfyUI's task/assets system recognizes ResultItem lists under
        # "video", while the canvas' automatic preview path only consumes
        # output.images. TerryDirector therefore owns the only node preview.
        return io.NodeOutput(
            director_output,
            ui={
                "video": [
                    ui.SavedResult(file, subfolder, io.FolderType.output)
                ]
            },
        )


class TerryDirectorAssembleMedia(io.ComfyNode):
    """Internal timeline assembly: remove overlap head, insert gaps, append AV media."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorAssembleMedia",
            display_name="TerryDirector Assemble Media (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Image.Input("images"),
                io.Audio.Input("audio"),
                io.Int.Input("gap_frames", min=0),
                io.Int.Input("gap_after_frames", min=0),
                io.Int.Input("trim_head_frames", min=0),
                io.Int.Input("fps", min=1),
                io.Image.Input("accumulated_images", optional=True),
                io.Audio.Input("accumulated_audio", optional=True),
            ],
            outputs=[
                io.Image.Output(),
                io.Audio.Output(),
            ],
        )

    @classmethod
    def execute(
        cls,
        images,
        audio,
        gap_frames,
        gap_after_frames,
        trim_head_frames,
        fps,
        accumulated_images=None,
        accumulated_audio=None,
    ) -> io.NodeOutput:
        gap = int(gap_frames)
        gap_after = int(gap_after_frames)
        trim = int(trim_head_frames)
        fps = int(fps)
        if fps < 1:
            raise ValueError("TerryDirector assembly FPS must be positive")
        if trim < 0 or trim >= images.shape[0]:
            if trim:
                raise ValueError("TerryDirector overlap trim exceeds segment frame count")
            trim = 0

        current_images = images[trim:].clone()
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        trim_samples = round((trim / fps) * sample_rate)
        if trim_samples >= waveform.shape[-1]:
            raise ValueError("TerryDirector overlap trim exceeds segment audio duration")
        current_waveform = waveform[..., trim_samples:].clone()

        if gap:
            black = current_images.new_zeros(
                (gap, current_images.shape[1], current_images.shape[2], current_images.shape[3])
            )
            current_images = torch.cat((black, current_images), dim=0)
            silence = current_waveform.new_zeros(
                (*current_waveform.shape[:-1], round((gap / fps) * sample_rate))
            )
            current_waveform = torch.cat((silence, current_waveform), dim=-1)

        if accumulated_images is not None:
            if tuple(accumulated_images.shape[1:]) != tuple(current_images.shape[1:]):
                raise ValueError("TerryDirector assembled segments must share one image size")
            current_images = torch.cat((accumulated_images, current_images), dim=0)

        if accumulated_audio is not None:
            accumulated_rate = int(accumulated_audio["sample_rate"])
            if accumulated_rate != sample_rate:
                raise ValueError("TerryDirector assembled segments must share one audio sample rate")
            accumulated_waveform = accumulated_audio["waveform"]
            if accumulated_waveform.shape[:-1] != current_waveform.shape[:-1]:
                raise ValueError("TerryDirector assembled segments must share one audio channel layout")
            current_waveform = torch.cat((accumulated_waveform, current_waveform), dim=-1)

        if gap_after:
            black = current_images.new_zeros(
                (gap_after, current_images.shape[1], current_images.shape[2], current_images.shape[3])
            )
            current_images = torch.cat((current_images, black), dim=0)
            silence = current_waveform.new_zeros(
                (*current_waveform.shape[:-1], round((gap_after / fps) * sample_rate))
            )
            current_waveform = torch.cat((current_waveform, silence), dim=-1)

        try:
            process_rss_mb = None
            system_used_pct = None
            system_available_mb = None
            try:
                import psutil
                process_rss_mb = psutil.Process().memory_info().rss / (1024 * 1024)
                vm = psutil.virtual_memory()
                system_used_pct = float(vm.percent)
                system_available_mb = vm.available / (1024 * 1024)
            except Exception:
                pass

            cuda_text = "cuda=n/a"
            if torch.cuda.is_available():
                try:
                    free_bytes, total_bytes = torch.cuda.mem_get_info()
                    allocated = torch.cuda.memory_allocated()
                    reserved = torch.cuda.memory_reserved()
                    cuda_text = (
                        f"cuda_free={free_bytes / (1024 * 1024):.0f}MB/"
                        f"{total_bytes / (1024 * 1024):.0f}MB "
                        f"torch_alloc={allocated / (1024 * 1024):.0f}MB "
                        f"torch_reserved={reserved / (1024 * 1024):.0f}MB"
                    )
                except Exception:
                    pass

            image_mb = current_images.numel() * current_images.element_size() / (1024 * 1024)
            audio_mb = current_waveform.numel() * current_waveform.element_size() / (1024 * 1024)
            host_parts = []
            if process_rss_mb is not None:
                host_parts.append(f"rss={process_rss_mb:.0f}MB")
            if system_used_pct is not None:
                host_parts.append(f"ram={system_used_pct:.1f}%")
            if system_available_mb is not None:
                host_parts.append(f"ram_free={system_available_mb:.0f}MB")
            host_text = " ".join(host_parts) if host_parts else "ram=n/a"

            print(
                f"[TerryDirector][Perf] Assemble checkpoint: "
                f"frames={int(current_images.shape[0])} "
                f"images={image_mb:.1f}MB audio={audio_mb:.1f}MB "
                f"device={current_images.device} {host_text} {cuda_text}",
                flush=True,
            )
        except Exception:
            # Diagnostic logging must never affect generation.
            pass

        return io.NodeOutput(
            current_images,
            {"waveform": current_waveform, "sample_rate": sample_rate},
        )



class TerryDirectorResampleReferenceVideo(io.ComfyNode):
    """Internal nearest-frame conversion of reference video batches to H3's 24 fps."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorResampleReferenceVideo",
            display_name="TerryDirector Resample Reference Video (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Image.Input("images"),
                io.Float.Input("source_fps", min=0.001),
                io.Float.Input("target_fps", default=24.0, min=0.001),
            ],
            outputs=[io.Image.Output()],
        )

    @classmethod
    def execute(cls, images, source_fps, target_fps=24.0) -> io.NodeOutput:
        source_fps = float(source_fps)
        target_fps = float(target_fps)
        if source_fps <= 0.0 or target_fps <= 0.0:
            raise ValueError("TerryDirector reference video FPS must be positive")
        count = int(images.shape[0])
        if count < 1:
            raise ValueError("TerryDirector reference video has no frames")
        target_count = max(1, round(count * target_fps / source_fps))
        positions = torch.arange(target_count, device=images.device, dtype=torch.float64)
        indices = torch.round(positions * source_fps / target_fps).to(torch.long)
        indices.clamp_(0, count - 1)
        return io.NodeOutput(images.index_select(0, indices))
