from __future__ import annotations

from typing import Any

from comfy_execution.graph_utils import GraphBuilder

from .director_core import FPS


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
            continuity["source_frame"],
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
            continuity["source_frame"],
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

    source_start = int(continuity["source_start_frame"])
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
    return (
        f"v1:{int(runtime['width'])}x{int(runtime['height'])}:"
        f"h3={int(segment['h3_frames'])}:out={int(segment['output_frames'])}"
    )


def _h3_preview_token_count(segment: dict[str, Any]) -> int:
    frames = max(5, int(segment["h3_frames"]))
    cycles = max(0, (frames - 5) // 17)
    # H3 temporal latent pattern: 2 tokens for the first 5 frames,
    # then 5 tokens per additional 17-frame block.
    return 2 + 5 * cycles


def _preview_frames_for_segment(mode: str, segment: dict[str, Any]) -> int:
    tokens = _h3_preview_token_count(segment)
    mode = str(mode or "half").lower()
    if mode == "first":
        return 1
    if mode == "all":
        return tokens
    return max(1, (tokens + 1) // 2)


def build_timeline_graph(
    runtime: dict[str, Any],
    plan: dict[str, Any],
    seed: int,
    video_export: dict[str, str] | None = None,
    cache_key: str | None = None,
    rerun: dict[str, Any] | None = None,
    preview_override: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], Any]:
    """Expand a compiled TerryDirector timeline into native ComfyUI H3 nodes."""
    graph = GraphBuilder()
    latents: list[Any] = []
    previous_images = None
    previous_audio = None
    merged_images = None
    merged_audio = None

    rerun_segment_id = str(rerun.get("segment_id")) if rerun else None
    rerun_seed = int(rerun.get("seed", seed)) if rerun else int(seed)
    if rerun_segment_id is not None and not any(
        str(segment["id"]) == rerun_segment_id for segment in plan["segments"]
    ):
        raise ValueError(f"TerryDirector Advanced 找不到要重跑的片段: {rerun_segment_id}")

    for segment in plan["segments"]:
        prefix = f"td_s{segment['index'] + 1}"
        segment_id = str(segment["id"])
        signature = _cache_signature(runtime, segment)
        should_sample = rerun_segment_id is None or segment_id == rerun_segment_id

        if should_sample:
            positive, latent = _condition_segment(
                graph,
                runtime,
                segment,
                prefix,
                previous_images,
            )
            positive = _apply_continuity(
                graph,
                runtime,
                segment,
                positive,
                latent,
                previous_images,
                previous_audio,
                prefix,
            )
            segment_seed = rerun_seed if rerun_segment_id is not None else int(seed)
            segment_runtime = runtime
            if preview_override is not None:
                preview_model = graph.node(
                    "ModelPreviewOverrideKJ",
                    f"{prefix}_preview_override",
                    model=runtime["model"],
                    max_resolution=int(preview_override["max_resolution"]),
                    jpeg_quality=int(preview_override["jpeg_quality"]),
                    suppress_default_preview=bool(preview_override["suppress_default_preview"]),
                    preview_frames=_preview_frames_for_segment(
                        preview_override.get("frame_mode", "half"), segment
                    ),
                    preview_fps=int(preview_override["preview_fps"]),
                    tiny_vae=str(preview_override.get("tiny_vae") or "none"),
                    audio_vae=runtime["audio_vae"],
                )
                segment_runtime = dict(runtime)
                segment_runtime["model"] = preview_model.out(0)
            sampled = _sample_segment(
                graph, segment_runtime, positive, latent, prefix, segment_seed
            )
            if cache_key is not None:
                sampled = graph.node(
                    "TerryDirectorCacheLatent",
                    f"{prefix}_cache_save",
                    latent=sampled,
                    cache_key=cache_key,
                    segment_id=segment_id,
                    signature=signature,
                ).out(0)
        else:
            if cache_key is None:
                raise RuntimeError("TerryDirector Advanced 局部重跑缺少缓存标识")
            sampled = graph.node(
                "TerryDirectorLoadCachedLatent",
                f"{prefix}_cache_load",
                cache_key=cache_key,
                segment_id=segment_id,
                signature=signature,
            ).out(0)

        images, audio = _decode_segment(graph, runtime, segment, sampled, prefix)

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
            f"{prefix}_assemble",
            **assembly_inputs,
        )
        merged_images = assembled.out(0)
        merged_audio = assembled.out(1)
        previous_images = images
        previous_audio = audio
        latents.append(sampled)

    packed_output = graph.node(
        "TerryDirectorPackOutput",
        "td_output_pack",
        images=merged_images,
        audio=merged_audio,
        **{f"latents.latent_{index}": latent for index, latent in enumerate(latents)},
    )
    output = packed_output.out(0)
    if video_export is not None:
        # Reuse ComfyUI core video nodes rather than maintain a second encoder.
        created = graph.node(
            "CreateVideo", "td_advanced_create_video",
            images=merged_images, audio=merged_audio, fps=float(FPS),
        )
        # Run native SaveVideo.execute INSIDE the terminal dependency.
        # A standalone SaveVideo output node in an expanded graph could be
        # pruned or its UI event could be hidden from the parent.
        final = graph.node(
            "TerryDirectorAdvancedFinish", "td_advanced_finish",
            director_output=output,
            video=created.out(0),
            filename_prefix=video_export["filename_prefix"],
            format=video_export["format"],
            codec=video_export["codec"],
            cache_key=str(cache_key or ""),
            segment_ids_json=__import__("json").dumps(
                [str(segment["id"]) for segment in plan["segments"]],
                ensure_ascii=False,
            ),
        )
        output = final.out(0)
    return graph.finalize(), output
