from __future__ import annotations

import gc
import json
import os
import re
import shutil
import tempfile
import time
import av
from fractions import Fraction

import folder_paths
import torch

from comfy.cli_args import args
from comfy_api.latest import io, ui, Types
from comfy_api.latest._input_impl.video_types import (
    VIDEO_ENCODERS,
    BT709_NCL,
    video_encoder_options,
    set_video_color_properties,
)

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


class TerryDirectorPackAdvancedOutput(io.ComfyNode):
    """Advanced packet that deliberately avoids materializing merged IMAGE/AUDIO."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.Autogrow.TemplatePrefix(
            io.Latent.Input("latent"),
            prefix="latent_",
            min=1,
            max=64,
        )
        return io.Schema(
            node_id="TerryDirectorPackAdvancedOutput",
            display_name="TerryDirector Pack Advanced Output (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[io.Autogrow.Input("latents", template=template)],
            outputs=[DirectorOutputData.Output(display_name="导演输出")],
        )

    @classmethod
    def execute(cls, latents) -> io.NodeOutput:
        return io.NodeOutput({
            "segment_latents": list(latents.values()),
            "images": None,
            "audio": None,
            "streamed_video": True,
        })


def _advanced_cache_root(cache_key: str) -> str:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cache_key or "default"))[:160]
    root = os.path.join(folder_paths.get_output_directory(), ".terrydirector_cache", safe_key)
    os.makedirs(root, exist_ok=True)
    return root


def _advanced_cache_path(cache_key: str, segment_id: str) -> str:
    safe_segment = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(segment_id or "segment"))[:160]
    return os.path.join(_advanced_cache_root(cache_key), f"{safe_segment}.pt")


def _advanced_lossless_root(cache_key: str, run_signature: str) -> str:
    safe_run = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(run_signature or "run"))[:80]
    root = os.path.join(
        _advanced_cache_root(cache_key),
        "lossless",
        safe_run,
    )
    os.makedirs(root, exist_ok=True)
    return root


def _advanced_lossless_segment_path(
    cache_key: str,
    run_signature: str,
    segment_id: str,
    signature: str,
) -> str:
    safe_segment = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(segment_id or "segment"))[:100]
    signature_hash = __import__("hashlib").sha256(
        str(signature).encode("utf-8")
    ).hexdigest()[:12]
    return os.path.join(
        _advanced_lossless_root(cache_key, run_signature),
        f"{safe_segment}_{signature_hash}.pt",
    )


def advanced_lossless_segment_exists(
    cache_key: str,
    run_signature: str,
    segment_id: str,
    signature: str,
) -> bool:
    return os.path.isfile(
        _advanced_lossless_segment_path(
            cache_key, run_signature, segment_id, signature
        )
    )


def advanced_lossless_segment_descriptor(
    cache_key: str,
    run_signature: str,
    segment_id: str,
    signature: str,
) -> str:
    return json.dumps(
        {
            "path": _advanced_lossless_segment_path(
                cache_key, run_signature, segment_id, signature
            ),
            "segment_id": str(segment_id),
        },
        ensure_ascii=False,
    )


def prepare_advanced_lossless_run_cache(cache_key: str, run_signature: str) -> str:
    root = os.path.join(_advanced_cache_root(cache_key), "lossless")
    if os.path.isdir(root):
        shutil.rmtree(root, ignore_errors=True)
    # Remove obsolete lossy segment-video caches created by earlier builds.
    legacy = os.path.join(_advanced_cache_root(cache_key), "segments")
    if os.path.isdir(legacy):
        shutil.rmtree(legacy, ignore_errors=True)
    return _advanced_lossless_root(cache_key, run_signature)


def _base_cache_root(cache_key: str, run_signature: str) -> str:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cache_key or "base"))[:120]
    safe_run = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(run_signature or "run"))[:80]
    root = os.path.join(
        folder_paths.get_temp_directory(),
        "terrydirector_base",
        safe_key,
        safe_run,
    )
    os.makedirs(root, exist_ok=True)
    return root


def prepare_base_run_cache(cache_key: str, run_signature: str) -> str:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cache_key or "base"))[:120]
    node_root = os.path.join(
        folder_paths.get_temp_directory(),
        "terrydirector_base",
        safe_key,
    )
    if os.path.isdir(node_root):
        shutil.rmtree(node_root, ignore_errors=True)
    return _base_cache_root(cache_key, run_signature)


def _base_segment_cache_path(
    cache_key: str,
    run_signature: str,
    segment_id: str,
    signature: str,
) -> str:
    safe_segment = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(segment_id or "segment"))[:100]
    signature_hash = __import__("hashlib").sha256(
        str(signature).encode("utf-8")
    ).hexdigest()[:12]
    return os.path.join(
        _base_cache_root(cache_key, run_signature),
        f"{safe_segment}_{signature_hash}.pt",
    )


def _torch_dtype_from_name(value: str):
    name = str(value or "float32").split(".")[-1]
    return getattr(torch, name, torch.float32)


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
    run_seed: int | None = None,
) -> dict:
    payload = {
        "version": 1,
        "status": "running",
        "run_signature": str(run_signature),
        "segment_ids": [str(value) for value in segment_ids],
        "segment_signatures": [str(value) for value in segment_signatures],
        "run_seed": None if run_seed is None else int(run_seed),
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
    run_seed: int | None = None,
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
            run_seed,
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
                io.Int.Input("run_seed", min=0, max=0xFFFFFFFFFFFFFFFF),
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
        run_seed,
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
                int(run_seed),
            )
        except Exception as exc:
            print(
                f"[TerryDirector Advanced] Checkpoint manifest update failed: {exc}",
                flush=True,
            )
        return io.NodeOutput(latent)


class TerryDirectorDecodeSegmentToCache(io.ComfyNode):
    """Losslessly cache one Base segment while returning only compact continuity context."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorDecodeSegmentToCache",
            display_name="TerryDirector Decode Segment To Cache (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Latent.Input("samples"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.String.Input("cache_key"),
                io.String.Input("run_signature"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
                io.Int.Input("output_frames", min=1),
                io.Int.Input("trim_head_frames", min=0),
                io.Int.Input("gap_frames", min=0),
                io.Int.Input("gap_after_frames", min=0),
                io.Int.Input("context_frames", min=1),
                io.Int.Input("fps", min=1),
            ],
            outputs=[
                io.String.Output(display_name="segment cache"),
                io.Image.Output(display_name="continuity images"),
                io.Audio.Output(display_name="continuity audio"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(
        cls,
        samples,
        vae,
        audio_vae,
        cache_key,
        run_signature,
        segment_id,
        signature,
        output_frames,
        trim_head_frames,
        gap_frames,
        gap_after_frames,
        context_frames,
        fps,
    ) -> io.NodeOutput:
        started = time.perf_counter()
        output_frames = int(output_frames)
        trim = int(trim_head_frames)
        gap = int(gap_frames)
        gap_after = int(gap_after_frames)
        fps = int(fps)
        context_frames = max(1, int(context_frames))
        if fps < 1 or output_frames < 1:
            raise ValueError("TerryDirector Base segment has invalid duration")

        latent = samples["samples"]
        video_latent = latent.unbind()[0] if getattr(latent, "is_nested", False) else latent
        images = vae.decode(video_latent)
        if len(images.shape) == 5:
            images = images.reshape(
                -1, images.shape[-3], images.shape[-2], images.shape[-1]
            )
        images = images[:output_frames]

        audio = _decode_h3_audio(audio_vae, samples)
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        output_samples = round((output_frames / fps) * sample_rate)
        waveform = waveform[..., :output_samples]

        # Continuity always reads from the unassembled segment, matching the
        # original Base path. Keep only the tail needed by the next active clip.
        context_count = min(context_frames, int(images.shape[0]))
        context_images = images[-context_count:].clone()
        context_samples = max(1, round((context_count / fps) * sample_rate))
        context_waveform = waveform[..., -context_samples:].clone()
        continuity_audio = {
            "waveform": context_waveform,
            "sample_rate": sample_rate,
        }

        if trim < 0 or trim >= int(images.shape[0]):
            if trim:
                raise ValueError("TerryDirector Base overlap trim exceeds segment frame count")
            trim = 0
        trim_samples = round((trim / fps) * sample_rate)
        current_images = images[trim:]
        current_waveform = waveform[..., trim_samples:]

        if gap:
            black = current_images.new_zeros(
                (gap, current_images.shape[1], current_images.shape[2], current_images.shape[3])
            )
            current_images = torch.cat((black, current_images), dim=0)
            silence = current_waveform.new_zeros(
                (*current_waveform.shape[:-1], round((gap / fps) * sample_rate))
            )
            current_waveform = torch.cat((silence, current_waveform), dim=-1)

        if gap_after:
            black = current_images.new_zeros(
                (gap_after, current_images.shape[1], current_images.shape[2], current_images.shape[3])
            )
            current_images = torch.cat((current_images, black), dim=0)
            silence = current_waveform.new_zeros(
                (*current_waveform.shape[:-1], round((gap_after / fps) * sample_rate))
            )
            current_waveform = torch.cat((current_waveform, silence), dim=-1)

        cached_images = current_images.detach().cpu().contiguous()
        cached_waveform = current_waveform.detach().cpu().contiguous()
        path = _base_segment_cache_path(
            str(cache_key),
            str(run_signature),
            str(segment_id),
            str(signature),
        )
        fd, temp_path = tempfile.mkstemp(
            prefix="td_base_segment_",
            suffix=".pt",
            dir=os.path.dirname(path),
        )
        os.close(fd)
        payload = {
            "version": 1,
            "images": cached_images,
            "audio": {
                "waveform": cached_waveform,
                "sample_rate": sample_rate,
            },
        }
        try:
            torch.save(payload, temp_path)
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

        descriptor = {
            "path": path,
            "segment_id": str(segment_id),
            "frames": int(cached_images.shape[0]),
            "height": int(cached_images.shape[1]),
            "width": int(cached_images.shape[2]),
            "channels": int(cached_images.shape[3]),
            "image_dtype": str(cached_images.dtype),
            "audio_shape": [int(value) for value in cached_waveform.shape],
            "audio_dtype": str(cached_waveform.dtype),
            "sample_rate": sample_rate,
        }

        size_mb = os.path.getsize(path) / (1024 * 1024)
        print(
            f"[TerryDirector Base][Stream] Segment {segment_id}: "
            f"frames={descriptor['frames']} cache={size_mb:.1f}MB "
            f"time={time.perf_counter() - started:.3f}s",
            flush=True,
        )
        return io.NodeOutput(
            json.dumps(descriptor, ensure_ascii=False),
            context_images,
            continuity_audio,
        )


class TerryDirectorMaterializeTimeline(io.ComfyNode):
    """Materialize Base IMAGE/AUDIO once, after all segments have finished."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.Autogrow.TemplatePrefix(
            io.String.Input("segment"),
            prefix="segment_",
            min=1,
            max=64,
        )
        return io.Schema(
            node_id="TerryDirectorMaterializeTimeline",
            display_name="TerryDirector Materialize Timeline (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Autogrow.Input("segments", template=template),
                io.Int.Input("expected_frames", min=1),
            ],
            outputs=[
                io.Image.Output(display_name="合并画面"),
                io.Audio.Output(display_name="合并音频"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(cls, segments, expected_frames) -> io.NodeOutput:
        started = time.perf_counter()
        descriptors = []
        for value in segments.values():
            try:
                descriptor = json.loads(str(value))
            except Exception as exc:
                raise RuntimeError("TerryDirector Base 分段缓存描述无效") from exc
            if not isinstance(descriptor, dict) or not descriptor.get("path"):
                raise RuntimeError("TerryDirector Base 分段缓存描述缺少文件路径")
            if not os.path.isfile(str(descriptor["path"])):
                raise RuntimeError(
                    f"TerryDirector Base 找不到分段缓存: {descriptor['path']}"
                )
            descriptors.append(descriptor)

        if not descriptors:
            raise RuntimeError("TerryDirector Base 没有可合并的分段缓存")

        # Sampling/decoding is complete at this point. Free loaded model weights
        # and CUDA allocator cache before creating the long merged CPU tensors.
        gc.collect()
        try:
            import comfy.model_management as model_management
            model_management.unload_all_models()
            model_management.soft_empty_cache()
        except Exception as exc:
            print(
                f"[TerryDirector Base] Model release before final merge skipped: {exc}",
                flush=True,
            )
        gc.collect()

        first = descriptors[0]
        total_frames = sum(int(item["frames"]) for item in descriptors)
        expected_frames = int(expected_frames)
        if total_frames != expected_frames:
            raise RuntimeError(
                f"TerryDirector Base 合并画面帧数不匹配: "
                f"{total_frames} != {expected_frames}"
            )

        height = int(first["height"])
        width = int(first["width"])
        channels = int(first["channels"])
        image_dtype = _torch_dtype_from_name(first.get("image_dtype", "torch.float32"))
        sample_rate = int(first["sample_rate"])
        audio_shape = [int(value) for value in first.get("audio_shape", [])]
        if len(audio_shape) < 3:
            raise RuntimeError("TerryDirector Base 分段音频形状无效")
        audio_batch = audio_shape[0]
        audio_channels = audio_shape[1]
        audio_dtype = _torch_dtype_from_name(first.get("audio_dtype", "torch.float32"))
        total_audio_samples = sum(
            int(item.get("audio_shape", [0, 0, 0])[-1])
            for item in descriptors
        )

        final_images = torch.empty(
            (total_frames, height, width, channels),
            dtype=image_dtype,
            device="cpu",
        )
        final_waveform = torch.empty(
            (audio_batch, audio_channels, total_audio_samples),
            dtype=audio_dtype,
            device="cpu",
        )

        image_offset = 0
        audio_offset = 0
        for descriptor in descriptors:
            if (
                int(descriptor["height"]) != height
                or int(descriptor["width"]) != width
                or int(descriptor["channels"]) != channels
            ):
                raise RuntimeError("TerryDirector Base 分段画面尺寸不一致")
            if int(descriptor["sample_rate"]) != sample_rate:
                raise RuntimeError("TerryDirector Base 分段音频采样率不一致")
            shape = [int(value) for value in descriptor.get("audio_shape", [])]
            if len(shape) < 3 or shape[0] != audio_batch or shape[1] != audio_channels:
                raise RuntimeError("TerryDirector Base 分段音频声道布局不一致")

            payload = torch.load(
                str(descriptor["path"]),
                map_location="cpu",
                weights_only=False,
            )
            images = payload.get("images") if isinstance(payload, dict) else None
            audio = payload.get("audio") if isinstance(payload, dict) else None
            waveform = audio.get("waveform") if isinstance(audio, dict) else None
            if not isinstance(images, torch.Tensor) or not isinstance(waveform, torch.Tensor):
                raise RuntimeError("TerryDirector Base 分段缓存内容无效")

            frame_count = int(images.shape[0])
            sample_count = int(waveform.shape[-1])
            final_images[image_offset:image_offset + frame_count].copy_(images)
            final_waveform[..., audio_offset:audio_offset + sample_count].copy_(waveform)
            image_offset += frame_count
            audio_offset += sample_count

            del payload, images, audio, waveform

        gc.collect()
        try:
            import psutil
            rss = psutil.Process().memory_info().rss / (1024 * 1024)
            vm = psutil.virtual_memory()
            memory_text = (
                f" rss={rss:.0f}MB ram={vm.percent:.1f}% "
                f"ram_free={vm.available / (1024 * 1024):.0f}MB"
            )
        except Exception:
            memory_text = ""

        print(
            f"[TerryDirector Base][Stream] Final merge: "
            f"frames={total_frames} "
            f"images={final_images.numel() * final_images.element_size() / (1024 * 1024):.1f}MB "
            f"time={time.perf_counter() - started:.3f}s{memory_text}",
            flush=True,
        )

        # The merged tensors now own the complete result. Base has no resume
        # semantics, so its large lossless segment caches can be removed
        # immediately after a successful final merge.
        try:
            run_roots = {
                os.path.dirname(str(item["path"]))
                for item in descriptors
            }
            for run_root in run_roots:
                shutil.rmtree(run_root, ignore_errors=True)
        except Exception:
            pass

        return io.NodeOutput(
            final_images,
            {"waveform": final_waveform, "sample_rate": sample_rate},
        )


def _decode_h3_audio(audio_vae, samples):
    latent = samples["samples"]
    if getattr(latent, "is_nested", False):
        latent = latent.unbind()[-1]
    audio = audio_vae.decode(latent).movedim(-1, 1)
    std = torch.std(audio, dim=[1, 2], keepdim=True) * 5.0
    std[std < 1.0] = 1.0
    audio /= std
    sample_rate = samples.get(
        "sample_rate",
        getattr(
            audio_vae,
            "audio_sample_rate_output",
            getattr(audio_vae, "audio_sample_rate", 44100),
        ),
    )
    return {"waveform": audio, "sample_rate": sample_rate}


class TerryDirectorDecodeAdvancedSegmentToCache(io.ComfyNode):
    """Losslessly cache one Advanced segment and return only compact continuity context."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorDecodeAdvancedSegmentToCache",
            display_name="TerryDirector Decode Advanced Segment To Cache (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Latent.Input("samples"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.String.Input("cache_key"),
                io.String.Input("run_signature"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
                io.Int.Input("output_frames", min=1),
                io.Int.Input("trim_head_frames", min=0),
                io.Int.Input("gap_frames", min=0),
                io.Int.Input("gap_after_frames", min=0),
                io.Int.Input("context_frames", min=1),
                io.Int.Input("fps", min=1),
            ],
            outputs=[
                io.String.Output(display_name="segment cache"),
                io.Image.Output(display_name="continuity images"),
                io.Audio.Output(display_name="continuity audio"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Persistent media cache is required for interruption recovery.
        return float("NaN")

    @classmethod
    def execute(
        cls,
        samples,
        vae,
        audio_vae,
        cache_key,
        run_signature,
        segment_id,
        signature,
        output_frames,
        trim_head_frames,
        gap_frames,
        gap_after_frames,
        context_frames,
        fps,
    ) -> io.NodeOutput:
        started = time.perf_counter()
        output_frames = int(output_frames)
        trim = int(trim_head_frames)
        gap = int(gap_frames)
        gap_after = int(gap_after_frames)
        fps = int(fps)
        context_frames = max(1, int(context_frames))

        latent = samples["samples"]
        video_latent = latent.unbind()[0] if getattr(latent, "is_nested", False) else latent
        images = vae.decode(video_latent)
        if len(images.shape) == 5:
            images = images.reshape(
                -1, images.shape[-3], images.shape[-2], images.shape[-1]
            )
        images = images[:output_frames]

        audio = _decode_h3_audio(audio_vae, samples)
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        waveform = waveform[..., :round((output_frames / fps) * sample_rate)]

        context_count = min(context_frames, int(images.shape[0]))
        context_images = images[-context_count:].clone()
        context_samples = max(1, round((context_count / fps) * sample_rate))
        continuity_audio = {
            "waveform": waveform[..., -context_samples:].clone(),
            "sample_rate": sample_rate,
        }

        if trim < 0 or trim >= int(images.shape[0]):
            if trim:
                raise ValueError("TerryDirector Advanced overlap trim exceeds segment frame count")
            trim = 0
        current_images = images[trim:]
        current_waveform = waveform[..., round((trim / fps) * sample_rate):]

        if gap:
            current_images = torch.cat((
                current_images.new_zeros(
                    (gap, current_images.shape[1], current_images.shape[2], current_images.shape[3])
                ),
                current_images,
            ), dim=0)
            current_waveform = torch.cat((
                current_waveform.new_zeros(
                    (*current_waveform.shape[:-1], round((gap / fps) * sample_rate))
                ),
                current_waveform,
            ), dim=-1)

        if gap_after:
            current_images = torch.cat((
                current_images,
                current_images.new_zeros(
                    (gap_after, current_images.shape[1], current_images.shape[2], current_images.shape[3])
                ),
            ), dim=0)
            current_waveform = torch.cat((
                current_waveform,
                current_waveform.new_zeros(
                    (*current_waveform.shape[:-1], round((gap_after / fps) * sample_rate))
                ),
            ), dim=-1)

        cached_images = current_images.detach().cpu().contiguous()
        cached_waveform = current_waveform.detach().cpu().contiguous()
        path = _advanced_lossless_segment_path(
            str(cache_key),
            str(run_signature),
            str(segment_id),
            str(signature),
        )
        fd, temp_path = tempfile.mkstemp(
            prefix="td_adv_lossless_",
            suffix=".pt",
            dir=os.path.dirname(path),
        )
        os.close(fd)
        try:
            torch.save(
                {
                    "version": 1,
                    "images": cached_images,
                    "audio": {
                        "waveform": cached_waveform,
                        "sample_rate": sample_rate,
                    },
                },
                temp_path,
            )
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

        descriptor = json.dumps(
            {"path": path, "segment_id": str(segment_id)},
            ensure_ascii=False,
        )
        size_mb = os.path.getsize(path) / (1024 * 1024)
        print(
            f"[TerryDirector Advanced][Lossless] Segment {segment_id}: "
            f"frames={int(cached_images.shape[0])} cache={size_mb:.1f}MB "
            f"time={time.perf_counter() - started:.3f}s",
            flush=True,
        )
        return io.NodeOutput(descriptor, context_images, continuity_audio)


class TerryDirectorLoadAdvancedSegmentContext(io.ComfyNode):
    """Read only the tail context needed by the next sampled segment."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorLoadAdvancedSegmentContext",
            display_name="TerryDirector Load Advanced Segment Context (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.String.Input("cache_key"),
                io.String.Input("run_signature"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
                io.Int.Input("context_frames", min=1),
                io.Int.Input("fps", min=1),
            ],
            outputs=[
                io.Image.Output(),
                io.Audio.Output(),
            ],
        )

    @classmethod
    def fingerprint_inputs(
        cls, cache_key, run_signature, segment_id, signature, **kwargs
    ):
        path = _advanced_lossless_segment_path(
            cache_key, run_signature, segment_id, signature
        )
        try:
            stat = os.stat(path)
            return f"{stat.st_mtime_ns}:{stat.st_size}:{signature}"
        except OSError:
            return float("NaN")

    @classmethod
    def execute(
        cls,
        cache_key,
        run_signature,
        segment_id,
        signature,
        context_frames,
        fps,
    ) -> io.NodeOutput:
        path = _advanced_lossless_segment_path(
            cache_key, run_signature, segment_id, signature
        )
        if not os.path.isfile(path):
            raise RuntimeError(
                f"TerryDirector Advanced 找不到片段 {segment_id} 的无损媒体缓存"
            )
        payload = torch.load(path, map_location="cpu", weights_only=False)
        images = payload.get("images") if isinstance(payload, dict) else None
        audio = payload.get("audio") if isinstance(payload, dict) else None
        waveform = audio.get("waveform") if isinstance(audio, dict) else None
        sample_rate = int(audio.get("sample_rate", 0)) if isinstance(audio, dict) else 0
        if not isinstance(images, torch.Tensor) or not isinstance(waveform, torch.Tensor) or sample_rate < 1:
            raise RuntimeError(
                f"TerryDirector Advanced 片段 {segment_id} 的无损媒体缓存无效"
            )
        count = min(max(1, int(context_frames)), int(images.shape[0]))
        samples = max(1, round((count / max(1, int(fps))) * sample_rate))
        return io.NodeOutput(
            images[-count:].clone(),
            {
                "waveform": waveform[..., -samples:].clone(),
                "sample_rate": sample_rate,
            },
        )


class TerryDirectorAdvancedLosslessFinish(io.ComfyNode):
    """Encode Advanced exactly once from lossless segment tensors without full-timeline IMAGE materialization."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        segment_template = io.Autogrow.TemplatePrefix(
            io.String.Input("segment"),
            prefix="segment_",
            min=1,
            max=64,
        )
        return io.Schema(
            node_id="TerryDirectorAdvancedLosslessFinish",
            display_name="TerryDirector Advanced Lossless Finish (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                DirectorOutputData.Input("director_output"),
                io.Autogrow.Input("segments", template=segment_template),
                io.Int.Input("fps", min=1),
                io.String.Input("filename_prefix"),
                io.String.Input("format"),
                io.String.Input("codec"),
                io.String.Input("cache_key"),
                io.String.Input("segment_ids_json"),
                io.String.Input("segment_signatures_json"),
                io.String.Input("run_signature"),
                io.String.Input("state_mode"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            outputs=[DirectorOutputData.Output(display_name="导演输出")],
        )

    @classmethod
    def execute(
        cls,
        director_output,
        segments,
        fps,
        filename_prefix,
        format,
        codec,
        cache_key,
        segment_ids_json,
        segment_signatures_json,
        run_signature,
        state_mode,
    ) -> io.NodeOutput:
        terminal_started = time.perf_counter()
        fps = max(1, int(fps))
        state_mode = str(state_mode or "complete").strip().lower()

        descriptors = []
        for value in segments.values():
            try:
                descriptor = json.loads(str(value))
            except Exception as exc:
                raise RuntimeError(
                    "TerryDirector Advanced 无损分段描述无效"
                ) from exc
            path = str(descriptor.get("path") or "")
            if not path or not os.path.isfile(path):
                raise RuntimeError(
                    f"TerryDirector Advanced 找不到无损分段缓存: {path}"
                )
            descriptors.append(descriptor)
        if not descriptors:
            raise RuntimeError("TerryDirector Advanced 没有可编码的无损分段")

        # Read one segment only to establish stream geometry/audio layout.
        first_payload = torch.load(
            str(descriptors[0]["path"]),
            map_location="cpu",
            weights_only=False,
        )
        first_images = first_payload.get("images")
        first_audio = first_payload.get("audio")
        first_waveform = first_audio.get("waveform") if isinstance(first_audio, dict) else None
        if not isinstance(first_images, torch.Tensor) or not isinstance(first_waveform, torch.Tensor):
            raise RuntimeError("TerryDirector Advanced 首段无损缓存无效")
        width = int(first_images.shape[2])
        height = int(first_images.shape[1])
        source_audio_rate = int(first_audio["sample_rate"])
        audio_channels = int(first_waveform.shape[1])
        layout = {1: "mono", 2: "stereo", 6: "5.1"}.get(audio_channels, "stereo")

        format_name = str(format or "auto").lower()
        codec_name = str(codec or "auto").lower()
        if format_name == "auto":
            format_name = "webm" if codec_name == "av1" else "mp4"
        if codec_name == "auto":
            codec_name = "av1" if format_name == "webm" else "h264"
        if format_name == "webm" and codec_name != "av1":
            raise ValueError("WebM 容器不支持 H.264，请选择 auto 或 av1")

        format_enum = Types.VideoContainer(format_name)
        codec_enum = Types.VideoCodec(codec_name)
        extension = Types.VideoContainer.get_extension(format_enum)
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            str(filename_prefix),
            folder_paths.get_output_directory(),
            width,
            height,
        )
        file = f"{filename}_{counter:05}_.{extension}"
        output_path = os.path.join(full_output_folder, file)

        container_format = {
            "mp4": "mp4",
            "mkv": "matroska",
            "webm": "webm",
        }[format_name]
        open_kwargs = {"mode": "w", "format": container_format}
        if format_name == "mp4":
            open_kwargs["options"] = {"movflags": "use_metadata_tags+faststart"}

        output = av.open(output_path, **open_kwargs)
        try:
            metadata = {}
            if not args.disable_metadata:
                if cls.hidden.extra_pnginfo is not None:
                    metadata.update(cls.hidden.extra_pnginfo)
                if cls.hidden.prompt is not None:
                    metadata["prompt"] = cls.hidden.prompt
            for key, value in metadata.items():
                output.metadata[key] = value if isinstance(value, str) else json.dumps(value)

            video_stream = output.add_stream(VIDEO_ENCODERS[codec_enum], rate=Fraction(fps))
            video_stream.width = width
            video_stream.height = height
            video_stream.pix_fmt = "yuv420p"
            video_stream.options = video_encoder_options(codec_enum, None)
            set_video_color_properties(video_stream.codec_context, "sRGB")

            target_audio_rate = 48000 if format_name == "webm" else source_audio_rate
            audio_stream = output.add_stream(
                "libopus" if format_name == "webm" else "aac",
                rate=target_audio_rate,
                layout=layout,
            )
            audio_resampler = (
                av.audio.resampler.AudioResampler(
                    format="fltp",
                    layout=layout,
                    rate=target_audio_rate,
                )
                if target_audio_rate != source_audio_rate
                else None
            )

            audio_parts = []
            total_frames = 0
            for index, descriptor in enumerate(descriptors):
                payload = (
                    first_payload
                    if index == 0
                    else torch.load(
                        str(descriptor["path"]),
                        map_location="cpu",
                        weights_only=False,
                    )
                )
                images = payload.get("images")
                audio = payload.get("audio")
                waveform = audio.get("waveform") if isinstance(audio, dict) else None
                if (
                    not isinstance(images, torch.Tensor)
                    or not isinstance(waveform, torch.Tensor)
                    or int(audio.get("sample_rate", 0)) != source_audio_rate
                    or int(images.shape[1]) != height
                    or int(images.shape[2]) != width
                ):
                    raise RuntimeError(
                        f"TerryDirector Advanced 分段 {index + 1} 的无损缓存不兼容"
                    )

                for tensor_frame in images:
                    image = (
                        (tensor_frame * 255)
                        .clamp(0, 255)
                        .byte()
                        .cpu()
                        .numpy()
                    )
                    frame = av.VideoFrame.from_ndarray(image, format="rgb24")
                    frame = frame.reformat(format="yuv420p", dst_colorspace=BT709_NCL)
                    set_video_color_properties(frame, "sRGB")
                    for packet in video_stream.encode(frame):
                        output.mux(packet)
                total_frames += int(images.shape[0])
                audio_parts.append(waveform)
                if index != 0:
                    del payload
                del images, audio, waveform

            for packet in video_stream.encode(None):
                output.mux(packet)

            waveform = torch.cat(audio_parts, dim=-1)
            target_source_samples = round((total_frames / fps) * source_audio_rate)
            waveform = waveform[..., :target_source_samples]
            audio_frame = av.AudioFrame.from_ndarray(
                waveform[0].float().cpu().contiguous().numpy(),
                format="fltp",
                layout=layout,
            )
            audio_frame.sample_rate = source_audio_rate
            audio_frame.pts = 0
            frames = (
                [audio_frame]
                if audio_resampler is None
                else audio_resampler.resample(audio_frame)
            )
            for frame in frames:
                for packet in audio_stream.encode(frame):
                    output.mux(packet)
            if audio_resampler is not None:
                for frame in audio_resampler.resample(None):
                    for packet in audio_stream.encode(frame):
                        output.mux(packet)
            for packet in audio_stream.encode(None):
                output.mux(packet)
        except BaseException:
            output.close()
            if os.path.isfile(output_path):
                os.remove(output_path)
            raise
        else:
            output.close()

        del first_payload, first_images, first_audio, first_waveform
        try:
            del audio_parts, waveform
        except Exception:
            pass
        gc.collect()

        try:
            segment_ids = json.loads(str(segment_ids_json or "[]"))
            if not isinstance(segment_ids, list):
                segment_ids = []
        except Exception:
            segment_ids = []

        video_state = {
            "filename": file,
            "subfolder": subfolder,
            "type": io.FolderType.output.value,
        }
        if str(cache_key or "").strip():
            if state_mode == "partial":
                update_advanced_checkpoint_partial_video(
                    str(cache_key),
                    str(run_signature),
                    video_state,
                )
            else:
                state = {
                    "version": 3,
                    "saved_at": time.time(),
                    "video": video_state,
                    "segment_ids": [str(value) for value in segment_ids],
                    "run_signature": str(run_signature),
                    "lossless_segment_pipeline": True,
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
                # Full result is now safely encoded. Keep durable LATENT
                # checkpoints for local reruns, but remove the multi-GB
                # temporary lossless pixel cache.
                lossless_root = os.path.dirname(str(descriptors[0]["path"]))
                shutil.rmtree(lossless_root, ignore_errors=True)

        print(
            f"[TerryDirector Advanced][Lossless] Final encode: "
            f"frames={total_frames} time={time.perf_counter() - terminal_started:.3f}s "
            f"path={output_path}",
            flush=True,
        )
        return io.NodeOutput(
            director_output,
            ui={"video": [ui.SavedResult(file, subfolder, io.FolderType.output)]},
        )


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
