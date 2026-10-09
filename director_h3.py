from __future__ import annotations

from typing import Any
import hashlib
import json
from comfy_execution.graph_utils import GraphBuilder

from .director_core import FPS
from .director_internal import (
    advanced_lossless_segment_descriptor,
    advanced_lossless_segment_exists,
    prepare_base_run_cache,
)


def _load_reference_inputs(
    graph: GraphBuilder,
    segment: dict[str, Any],
    prefix: str,
) -> dict[str, Any]:
    inputs: dict[str, Any] = {}

    for index, asset in enumerate(segment["assets"]["images"]):
        source = asset["source"]
        if source.get("type") != "comfy-input":
            raise ValueError("TerryDirector only executes assets stored in ComfyUI input")
        loaded = graph.node(
            "LoadImage",
            f"{prefix}_ref_image_{index}",
            image=source["path"],
        )
        inputs[f"ref_images.ref_image_{index}"] = loaded.out(0)

    for index, asset in enumerate(segment["assets"]["videos"]):
        source = asset["source"]
        if source.get("type") != "comfy-input":
            raise ValueError("TerryDirector only executes assets stored in ComfyUI input")
        loaded = graph.node(
            "LoadVideo",
            f"{prefix}_ref_video_{index}",
            file=source["path"],
        )
        components = graph.node(
            "GetVideoComponents",
            f"{prefix}_ref_video_components_{index}",
            video=loaded.out(0),
        )
        resampled = graph.node(
            "TerryDirectorResampleReferenceVideo",
            f"{prefix}_ref_video_resample_{index}",
            images=components.out(0),
            source_fps=components.out(2),
            target_fps=float(FPS),
        )
        inputs[f"ref_videos.ref_video_{index}"] = resampled.out(0)

    for index, asset in enumerate(segment["assets"]["audios"]):
        source = asset["source"]
        if source.get("type") != "comfy-input":
            raise ValueError("TerryDirector only executes assets stored in ComfyUI input")
        loaded = graph.node(
            "LoadAudio",
            f"{prefix}_ref_audio_{index}",
            audio=source["path"],
        )
        inputs[f"ref_audios.ref_audio_{index}"] = loaded.out(0)

    return inputs


def _condition_segment(
    graph: GraphBuilder,
    runtime: dict[str, Any],
    segment: dict[str, Any],
    prefix: str,
    previous_images: Any = None,
    compact_previous: bool = False,
) -> tuple[Any, Any]:
    references = _load_reference_inputs(graph, segment, prefix)
    prompt = segment["prompt"]
    continuity = segment["continuity"]
    if continuity["kind"] == "tail_reference":
        if previous_images is None:
            raise ValueError("TerryDirector 尾帧参考需要上一片段画面")
        tail = _image_slice(
            graph,
            previous_images,
            0 if compact_previous else continuity["source_frame"],
            1,
            f"{prefix}_tail_reference",
        )
        picture_number = int(continuity["picture_number"])
        image_index = picture_number - 1
        if image_index != len(segment["assets"]["images"]):
            raise ValueError("TerryDirector 尾帧参考图片编号与实际参考输入顺序不一致")
        references[f"ref_images.ref_image_{image_index}"] = tail

    conditioning = graph.node(
        "MiniMaxH3ReferenceToVideo",
        f"{prefix}_conditioning",
        clip=runtime["clip"],
        vae=runtime["vae"],
        audio_vae=runtime["audio_vae"],
        prompt=prompt,
        width=runtime["width"],
        height=runtime["height"],
        length=segment["h3_frames"],
        ref_image_size=runtime["params"]["ref_image_size"],
        **references,
    )
    return conditioning.out(0), conditioning.out(1)


def _image_slice(
    graph: GraphBuilder,
    image: Any,
    index: int,
    length: int,
    node_id: str,
) -> Any:
    return graph.node(
        "ImageFromBatch",
        node_id,
        image=image,
        batch_index=int(index),
        length=int(length),
    ).out(0)


def _audio_slice(
    graph: GraphBuilder,
    audio: Any,
    start_frame: int,
    frame_count: int,
    node_id: str,
) -> Any:
    return graph.node(
        "TrimAudioDuration",
        node_id,
        audio=audio,
        start_index=int(start_frame) / FPS,
        duration=int(frame_count) / FPS,
    ).out(0)


def _apply_continuity(
    graph: GraphBuilder,
    runtime: dict[str, Any],
    segment: dict[str, Any],
    positive: Any,
    latent: Any,
    previous_images: Any,
    previous_audio: Any,
    prefix: str,
    compact_previous: bool = False,
) -> Any:
    continuity = segment["continuity"]
    kind = continuity["kind"]
    if kind in {"independent", "gap", "tail_reference"}:
        return positive

    if previous_images is None or previous_audio is None:
        raise ValueError("TerryDirector continuity requires the preceding segment output")

    if kind == "tail_frame":
        tail = _image_slice(
            graph,
            previous_images,
            0 if compact_previous else continuity["source_frame"],
            1,
            f"{prefix}_tail_frame",
        )
        return graph.node(
            "MiniMaxH3AddGuide",
            f"{prefix}_tail_guide",
            positive=positive,
            vae=runtime["vae"],
            latent=latent,
            image=tail,
            frame_idx=0,
        ).out(0)

    if kind != "overlap":
        raise ValueError(f"Unsupported TerryDirector continuity kind: {kind!r}")

    source_start = 0 if compact_previous else int(continuity["source_start_frame"])
    overlap_frames = int(continuity["frames"])
    guide_frames = int(continuity["video_guide_frames"])

    overlap_audio = _audio_slice(
        graph,
        previous_audio,
        source_start,
        overlap_frames,
        f"{prefix}_overlap_audio",
    )
    guide_inputs: dict[str, Any] = {
        "positive": positive,
        "audio_vae": runtime["audio_vae"],
        "latent": latent,
        "audio": overlap_audio,
        "frame_idx": 0,
    }
    if guide_frames:
        guide_inputs["vae"] = runtime["vae"]
        guide_inputs["image"] = _image_slice(
            graph,
            previous_images,
            source_start,
            guide_frames,
            f"{prefix}_overlap_video",
        )

    positive = graph.node(
        "MiniMaxH3AddGuide",
        f"{prefix}_overlap_guide",
        **guide_inputs,
    ).out(0)

    boundary_target = continuity["boundary_target_frame"]
    if boundary_target is not None:
        boundary = _image_slice(
            graph,
            previous_images,
            source_start + overlap_frames - 1,
            1,
            f"{prefix}_overlap_boundary",
        )
        positive = graph.node(
            "MiniMaxH3AddGuide",
            f"{prefix}_overlap_boundary_guide",
            positive=positive,
            vae=runtime["vae"],
            latent=latent,
            image=boundary,
            frame_idx=int(boundary_target),
        ).out(0)

    return positive


def _sample_segment(
    graph: GraphBuilder,
    runtime: dict[str, Any],
    positive: Any,
    latent: Any,
    prefix: str,
    seed: int,
) -> Any:
    second = runtime.get("params", {}).get("second_pass", {})
    if isinstance(second, dict) and second.get("method") == "selflift":
        negative = graph.node(
            "ConditioningZeroOut",
            f"{prefix}_selflift_negative",
            conditioning=positive,
        )
        inputs: dict[str, Any] = {
            "positive": positive,
            "negative": negative.out(0),
            "vae": runtime["vae"],
            "latent_image": latent,
            "sampler": second["sampler"],
            "sigmas": second["sigmas"],
            "seed": max(0, min(0xFFFFFFFFFFFFFFFF, int(seed))),
            "cfg": float(second["cfg"]),
            "transition_step": int(second["transition_step"]),
            "lowres_scale": float(second["lowres_scale"]),
            "rho": float(second["rho"]),
            "w_min": float(second["w_min"]),
            "w_max": float(second["w_max"]),
            "upscaler_model": str(second["upscaler_model"]),
            "highres_tiling": bool(second["highres_tiling"]),
            "tiling_mode": str(second["tiling_mode"]),
            "tiling_tiles": int(second["tiling_tiles"]),
            "tiling_axis": str(second["tiling_axis"]),
        }

        if str(second.get("sampler_model_inputs", "current")) == "legacy":
            inputs["model"] = runtime["model"]
            if second.get("high_res_model") is not None:
                inputs["model_hires"] = second["high_res_model"]
        else:
            inputs["low_res_model"] = runtime["model"]
            if second.get("high_res_model") is not None:
                inputs["high_res_model"] = second["high_res_model"]

        return graph.node(
            "SelfLiftAvatarH3Sampler",
            f"{prefix}_selflift_sample",
            **inputs,
        ).out(0)

    noise = graph.node(
        "RandomNoise",
        f"{prefix}_noise",
        noise_seed=max(0, min(0xFFFFFFFFFFFFFFFF, int(seed))),
    )
    guider = graph.node(
        "BasicGuider",
        f"{prefix}_guider",
        model=runtime["model"],
        conditioning=positive,
    )
    return graph.node(
        "SamplerCustomAdvanced",
        f"{prefix}_sample",
        noise=noise.out(0),
        guider=guider.out(0),
        sampler=runtime["sampler"],
        sigmas=runtime["sigmas"],
        latent_image=latent,
    ).out(0)


def _decode_segment(
    graph: GraphBuilder,
    runtime: dict[str, Any],
    segment: dict[str, Any],
    sampled: Any,
    prefix: str,
) -> tuple[Any, Any]:
    decoded_images = graph.node(
        "VAEDecode",
        f"{prefix}_decode_video",
        samples=sampled,
        vae=runtime["vae"],
    )
    images = _image_slice(
        graph,
        decoded_images.out(0),
        0,
        segment["output_frames"],
        f"{prefix}_trim_video",
    )

    decoded_audio = graph.node(
        "VAEDecodeAudio",
        f"{prefix}_decode_audio",
        samples=sampled,
        vae=runtime["audio_vae"],
    )
    audio = _audio_slice(
        graph,
        decoded_audio.out(0),
        0,
        segment["output_frames"],
        f"{prefix}_trim_audio",
    )
    return images, audio



def _cache_signature(runtime: dict[str, Any], segment: dict[str, Any]) -> str:
    second = runtime.get("params", {}).get("second_pass", {})
    second_signature = (
        str(second.get("cache_signature") or "selflift")
        if isinstance(second, dict) and second.get("method") == "selflift"
        else "none"
    )
    return (
        f"v2:{int(runtime['width'])}x{int(runtime['height'])}:"
        f"h3={int(segment['h3_frames'])}:out={int(segment['output_frames'])}:"
        f"sp={second_signature}"
    )


def _h3_preview_token_count(segment: dict[str, Any]) -> int:
    frames = max(5, int(segment["h3_frames"]))
    cycles = max(0, (frames - 5) // 17)
    # H3 temporal latent pattern: 2 tokens for the first 5 frames,
    # then 5 tokens per additional 17-frame block.
    return 2 + 5 * cycles


def _preview_frames_for_fps(preview_fps: int, segment: dict[str, Any]) -> int:
    """Map target preview FPS onto H3's temporal latent density.

    H3 output runs at 24 fps, but KJ preview_frames samples latent-time tokens.
    Scaling token count by target_fps / 24 preserves a roughly proportional
    temporal density without forcing a full 24-fps decode for 12-fps preview.
    """
    tokens = _h3_preview_token_count(segment)
    fps = max(2, min(FPS, int(preview_fps)))
    return max(2, min(tokens, round(tokens * fps / FPS)))


def build_timeline_graph(
    runtime: dict[str, Any],
    plan: dict[str, Any],
    seed: int,
    video_export: dict[str, str] | None = None,
    cache_key: str | None = None,
    base_cache_key: str | None = None,
    rerun: dict[str, Any] | None = None,
    preview_override: dict[str, Any] | None = None,
    reuse_cached_segment_ids: set[str] | None = None,
    finish_state_mode: str = "complete",
    run_signature: str | None = None,
) -> tuple[dict[str, Any], Any]:
    """Expand a compiled TerryDirector timeline into native ComfyUI H3 nodes.

    Base and Advanced share lossless per-segment decoding. Base performs one
    final IMAGE/AUDIO merge; Advanced performs one final video/audio encode.
    """
    graph = GraphBuilder()
    latents: list[Any] = []
    advanced_segment_caches: list[Any] = []
    base_segment_caches: list[Any] = []
    segment_ids = [str(segment["id"]) for segment in plan["segments"]]
    cache_signatures = [_cache_signature(runtime, segment) for segment in plan["segments"]]
    segment_ids_json = json.dumps(segment_ids, ensure_ascii=False)
    segment_signatures_json = json.dumps(cache_signatures, ensure_ascii=False)
    run_signature = str(
        run_signature
        or hashlib.sha256(
            json.dumps(
                {
                    "seed": int(seed),
                    "segments": segment_ids,
                    "signatures": cache_signatures,
                    "width": int(runtime["width"]),
                    "height": int(runtime["height"]),
                },
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()[:16]
    )
    reuse_cached = {str(value) for value in (reuse_cached_segment_ids or set())}
    streamed_advanced = video_export is not None
    streamed_base = video_export is None and bool(str(base_cache_key or "").strip())
    if streamed_base:
        prepare_base_run_cache(str(base_cache_key), run_signature)

    previous_images = None
    previous_audio = None
    previous_is_compact = False
    merged_images = None
    merged_audio = None

    rerun_segment_id = str(rerun.get("segment_id")) if rerun else None
    rerun_seed = int(rerun.get("seed", seed)) if rerun else int(seed)
    if rerun_segment_id is not None and not any(
        str(segment["id"]) == rerun_segment_id for segment in plan["segments"]
    ):
        raise ValueError(f"TerryDirector Advanced 找不到要重跑的片段: {rerun_segment_id}")

    def should_sample_segment(segment_id: str) -> bool:
        if rerun_segment_id is not None:
            return str(segment_id) == rerun_segment_id
        return str(segment_id) not in reuse_cached

    segments = list(plan["segments"])
    for position, segment in enumerate(segments):
        prefix_id = f"td_s{segment['index'] + 1}"
        segment_id = str(segment["id"])
        signature = cache_signatures[position]
        should_sample = should_sample_segment(segment_id)

        if should_sample:
            positive, latent = _condition_segment(
                graph,
                runtime,
                segment,
                prefix_id,
                previous_images,
                compact_previous=previous_is_compact,
            )
            positive = _apply_continuity(
                graph,
                runtime,
                segment,
                positive,
                latent,
                previous_images,
                previous_audio,
                prefix_id,
                compact_previous=previous_is_compact,
            )
            segment_seed = rerun_seed if rerun_segment_id is not None else int(seed)
            segment_runtime = runtime
            if preview_override is not None:
                preview_model = graph.node(
                    "ModelPreviewOverrideKJ",
                    f"{prefix_id}_preview_override",
                    model=runtime["model"],
                    max_resolution=int(preview_override["max_resolution"]),
                    jpeg_quality=int(preview_override["jpeg_quality"]),
                    suppress_default_preview=bool(preview_override["suppress_default_preview"]),
                    preview_frames=_preview_frames_for_fps(
                        int(preview_override["preview_fps"]), segment
                    ),
                    preview_fps=int(preview_override["preview_fps"]),
                    tiny_vae=str(preview_override.get("tiny_vae") or "none"),
                    audio_vae=runtime["audio_vae"],
                )
                segment_runtime = dict(runtime)
                segment_runtime["model"] = preview_model.out(0)
            sampled = _sample_segment(
                graph, segment_runtime, positive, latent, prefix_id, segment_seed
            )
            if cache_key is not None:
                sampled = graph.node(
                    "TerryDirectorCacheLatent",
                    f"{prefix_id}_checkpoint",
                    latent=sampled,
                    cache_key=str(cache_key),
                    segment_id=segment_id,
                    signature=signature,
                    run_signature=run_signature,
                    segment_ids_json=segment_ids_json,
                    segment_signatures_json=segment_signatures_json,
                    run_seed=int(seed),
                ).out(0)
        else:
            if cache_key is None:
                raise RuntimeError("TerryDirector Advanced 复用片段缺少缓存标识")
            sampled = graph.node(
                "TerryDirectorLoadCachedLatent",
                f"{prefix_id}_cache_load",
                cache_key=cache_key,
                segment_id=segment_id,
                signature=signature,
            ).out(0)

        latents.append(sampled)

        next_segment = segments[position + 1] if position + 1 < len(segments) else None
        next_needs_context = False
        context_frames = 1
        if next_segment is not None:
            next_kind = str(next_segment["continuity"]["kind"])
            next_needs_context = next_kind not in {"independent", "gap"}
            if next_kind == "overlap":
                context_frames = max(1, int(next_segment["continuity"]["frames"]))

        if streamed_base:
            cached = graph.node(
                "TerryDirectorDecodeSegmentToCache",
                f"{prefix_id}_segment_cache",
                samples=sampled,
                vae=runtime["vae"],
                audio_vae=runtime["audio_vae"],
                cache_key=str(base_cache_key),
                run_signature=run_signature,
                segment_id=segment_id,
                signature=signature,
                output_frames=int(segment["output_frames"]),
                trim_head_frames=int(segment["assembly"]["trim_head_frames"]),
                gap_frames=int(segment["assembly"]["gap_before_frames"]),
                gap_after_frames=int(segment["assembly"]["gap_after_frames"]),
                context_frames=int(context_frames),
                fps=int(FPS),
            )
            base_segment_caches.append(cached.out(0))
            previous_images = cached.out(1)
            previous_audio = cached.out(2)
            previous_is_compact = True
            continue

        if streamed_advanced:
            # Advanced now keeps decoded media lossless until the final encode.
            # Existing interrupted-run caches can be reused directly. If a
            # cache is missing, rebuild only that segment from its LATENT.
            cache_exists = (
                cache_key is not None
                and advanced_lossless_segment_exists(
                    str(cache_key),
                    run_signature,
                    segment_id,
                    signature,
                )
            )

            if not should_sample and cache_exists:
                descriptor = advanced_lossless_segment_descriptor(
                    str(cache_key),
                    run_signature,
                    segment_id,
                    signature,
                )
                advanced_segment_caches.append(descriptor)

                # Only materialize the cached segment's tail when the next
                # sampled segment actually needs continuity.
                next_context_for_sampling = (
                    next_segment is not None
                    and should_sample_segment(str(next_segment["id"]))
                    and next_needs_context
                )
                if next_context_for_sampling:
                    context = graph.node(
                        "TerryDirectorLoadAdvancedSegmentContext",
                        f"{prefix_id}_lossless_context",
                        cache_key=str(cache_key),
                        run_signature=run_signature,
                        segment_id=segment_id,
                        signature=signature,
                        context_frames=int(context_frames),
                        fps=int(FPS),
                    )
                    previous_images = context.out(0)
                    previous_audio = context.out(1)
                else:
                    previous_images = None
                    previous_audio = None
                previous_is_compact = True
                continue

            cached = graph.node(
                "TerryDirectorDecodeAdvancedSegmentToCache",
                f"{prefix_id}_lossless_cache",
                samples=sampled,
                vae=runtime["vae"],
                audio_vae=runtime["audio_vae"],
                cache_key=str(cache_key or "default"),
                run_signature=run_signature,
                segment_id=segment_id,
                signature=signature,
                output_frames=int(segment["output_frames"]),
                trim_head_frames=int(segment["assembly"]["trim_head_frames"]),
                gap_frames=int(segment["assembly"]["gap_before_frames"]),
                gap_after_frames=int(segment["assembly"]["gap_after_frames"]),
                context_frames=int(context_frames),
                fps=int(FPS),
            )
            advanced_segment_caches.append(cached.out(0))
            previous_images = cached.out(1)
            previous_audio = cached.out(2)
            previous_is_compact = True
            continue

        # Legacy Base path retained for callers that do not request streamed Base.
        images, audio = _decode_segment(graph, runtime, segment, sampled, prefix_id)

        assembly_inputs: dict[str, Any] = {
            "images": images,
            "audio": audio,
            "gap_frames": segment["assembly"]["gap_before_frames"],
            "gap_after_frames": segment["assembly"]["gap_after_frames"],
            "trim_head_frames": segment["assembly"]["trim_head_frames"],
            "fps": FPS,
        }
        if merged_images is not None:
            assembly_inputs["accumulated_images"] = merged_images
            assembly_inputs["accumulated_audio"] = merged_audio

        assembled = graph.node(
            "TerryDirectorAssembleMedia",
            f"{prefix_id}_assemble",
            **assembly_inputs,
        )
        merged_images = assembled.out(0)
        merged_audio = assembled.out(1)
        previous_images = images
        previous_audio = audio
        previous_is_compact = False

    if streamed_base:
        materialized = graph.node(
            "TerryDirectorMaterializeTimeline",
            "td_base_materialize",
            expected_frames=int(plan["total_frames"]),
            **{
                f"segments.segment_{index}": token
                for index, token in enumerate(base_segment_caches)
            },
        )
        packed_output = graph.node(
            "TerryDirectorPackOutput",
            "td_output_pack",
            images=materialized.out(0),
            audio=materialized.out(1),
            **{
                f"latents.latent_{index}": latent
                for index, latent in enumerate(latents)
            },
        )
        return graph.finalize(), packed_output.out(0)

    if not streamed_advanced:
        packed_output = graph.node(
            "TerryDirectorPackOutput",
            "td_output_pack",
            images=merged_images,
            audio=merged_audio,
            **{
                f"latents.latent_{index}": latent
                for index, latent in enumerate(latents)
            },
        )
        return graph.finalize(), packed_output.out(0)

    packed_output = graph.node(
        "TerryDirectorPackAdvancedOutput",
        "td_advanced_output_pack",
        **{
            f"latents.latent_{index}": latent
            for index, latent in enumerate(latents)
        },
    )
    final = graph.node(
        "TerryDirectorAdvancedLosslessFinish",
        "td_advanced_finish",
        director_output=packed_output.out(0),
        fps=int(FPS),
        filename_prefix=video_export["filename_prefix"],
        format=video_export["format"],
        codec=video_export["codec"],
        cache_key=str(cache_key or ""),
        segment_ids_json=segment_ids_json,
        segment_signatures_json=segment_signatures_json,
        run_signature=run_signature,
        state_mode=str(finish_state_mode or "complete"),
        **{
            f"segments.segment_{index}": descriptor
            for index, descriptor in enumerate(advanced_segment_caches)
        },
    )
    return graph.finalize(), final.out(0)
