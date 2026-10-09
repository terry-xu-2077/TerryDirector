from __future__ import annotations

import gc
import json
import os
import re
import tempfile
import time
from fractions import Fraction

import folder_paths
import torch

from comfy.cli_args import args
from comfy_api.latest import io, ui, Types, InputImpl

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


def _advanced_segment_video_path(cache_key: str, segment_id: str, signature: str) -> str:
    safe_segment = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(segment_id or "segment"))[:120]
    signature_hash = __import__("hashlib").sha256(
        str(signature).encode("utf-8")
    ).hexdigest()[:12]
    root = os.path.join(_advanced_cache_root(cache_key), "segments")
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, f"{safe_segment}_{signature_hash}.mkv")


def advanced_segment_video_exists(cache_key: str, segment_id: str, signature: str) -> bool:
    return os.path.isfile(_advanced_segment_video_path(cache_key, segment_id, signature))


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
        print(
            f"[TerryDirector Advanced][Perf] Checkpoint {segment_id}: "
            f"cpu={copy_seconds:.3f}s disk={disk_seconds:.3f}s "
            f"size={size_mb:.1f}MB path={path}",
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


class TerryDirectorDecodeSegmentToFile(io.ComfyNode):
    """Decode one H3 segment, encode it to a persistent file, and keep only tiny continuity context in RAM."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorDecodeSegmentToFile",
            display_name="TerryDirector Decode Segment To File (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Latent.Input("samples"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.String.Input("cache_key"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
                io.Int.Input("output_frames", min=1),
                io.Int.Input("trim_head_frames", min=0),
                io.Int.Input("gap_frames", min=0),
                io.Int.Input("gap_after_frames", min=0),
                io.Int.Input("context_frames", min=1),
                io.Int.Input("fps", min=1),
                io.String.Input("codec"),
            ],
            outputs=[
                io.Video.Output(),
                io.Image.Output(display_name="continuity images"),
                io.Audio.Output(display_name="continuity audio"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Encoding is a durable side effect used by interruption recovery.
        return float("NaN")

    @classmethod
    def execute(
        cls,
        samples,
        vae,
        audio_vae,
        cache_key,
        segment_id,
        signature,
        output_frames,
        trim_head_frames,
        gap_frames,
        gap_after_frames,
        context_frames,
        fps,
        codec,
    ) -> io.NodeOutput:
        started = time.perf_counter()
        output_frames = int(output_frames)
        trim = int(trim_head_frames)
        gap = int(gap_frames)
        gap_after = int(gap_after_frames)
        fps = int(fps)
        context_frames = max(1, int(context_frames))
        if fps < 1 or output_frames < 1:
            raise ValueError("TerryDirector streamed segment has invalid duration")

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
                raise ValueError("TerryDirector streamed overlap trim exceeds segment frame count")
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

        segment_audio = {
            "waveform": current_waveform,
            "sample_rate": sample_rate,
        }
        video = InputImpl.VideoFromComponents(
            Types.VideoComponents(
                images=current_images,
                audio=segment_audio,
                frame_rate=Fraction(fps),
            )
        )

        resolved_codec = str(codec or "h264").lower()
        if resolved_codec not in {"h264", "av1"}:
            resolved_codec = "h264"
        path = _advanced_segment_video_path(
            str(cache_key), str(segment_id), str(signature)
        )
        fd, temp_path = tempfile.mkstemp(
            prefix="td_segment_", suffix=".mkv", dir=os.path.dirname(path)
        )
        os.close(fd)
        try:
            video.save_to(
                temp_path,
                format=Types.VideoContainer.MKV,
                codec=Types.VideoCodec(resolved_codec),
            )
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

        size_mb = os.path.getsize(path) / (1024 * 1024)
        rss_text = ""
        try:
            import psutil
            rss = psutil.Process().memory_info().rss / (1024 * 1024)
            rss_text = f" rss={rss:.0f}MB"
        except Exception:
            pass
        print(
            f"[TerryDirector Advanced][Stream] Segment {segment_id}: "
            f"frames={int(current_images.shape[0])} file={size_mb:.1f}MB "
            f"time={time.perf_counter() - started:.3f}s{rss_text}",
            flush=True,
        )
        return io.NodeOutput(
            InputImpl.VideoFromFile(path),
            context_images,
            continuity_audio,
        )


class TerryDirectorLoadSegmentVideo(io.ComfyNode):
    """Load a previously encoded Advanced segment without materializing its frames."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorLoadSegmentVideo",
            display_name="TerryDirector Load Segment Video (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.String.Input("cache_key"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
            ],
            outputs=[io.Video.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, cache_key, segment_id, signature, **kwargs):
        path = _advanced_segment_video_path(cache_key, segment_id, signature)
        try:
            stat = os.stat(path)
            return f"{stat.st_mtime_ns}:{stat.st_size}:{signature}"
        except OSError:
            return float("NaN")

    @classmethod
    def execute(cls, cache_key, segment_id, signature) -> io.NodeOutput:
        path = _advanced_segment_video_path(cache_key, segment_id, signature)
        if not os.path.isfile(path):
            raise RuntimeError(
                f"TerryDirector Advanced 找不到片段 {segment_id} 的文件缓存"
            )
        return io.NodeOutput(InputImpl.VideoFromFile(path))


class TerryDirectorConcatSegmentVideos(io.ComfyNode):
    """Create a streaming/file-backed video list from encoded segment files."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.Autogrow.TemplatePrefix(
            io.Video.Input("video"),
            prefix="video_",
            min=1,
            max=64,
        )
        return io.Schema(
            node_id="TerryDirectorConcatSegmentVideos",
            display_name="TerryDirector Concat Segment Videos (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Autogrow.Input("videos", template=template),
                io.String.Input("codec"),
            ],
            outputs=[io.Video.Output()],
        )

    @classmethod
    def execute(cls, videos, codec) -> io.NodeOutput:
        values = list(videos.values())
        if not values:
            raise RuntimeError("TerryDirector Advanced 没有可拼接的视频片段")
        resolved_codec = str(codec or "h264").lower()
        if resolved_codec not in {"h264", "av1"}:
            resolved_codec = "h264"
        return io.NodeOutput(
            InputImpl.VideoFromList(
                values,
                codec=Types.VideoCodec(resolved_codec),
            )
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
