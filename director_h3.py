from __future__ import annotations

from typing import Any
import hashlib
import json
import os

import folder_paths

from comfy_execution.graph_utils import GraphBuilder, is_link

from .director_core import FPS


def _graph_value_signature(value, prefix: str):
    if is_link(value):
        node_id, output_index = value
        local_id = (
            str(node_id)[len(prefix):]
            if str(node_id).startswith(prefix)
            else str(node_id)
        )
        return ["link", local_id, int(output_index)]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {
            str(key): _graph_value_signature(item, prefix)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_graph_value_signature(item, prefix) for item in value]
    if hasattr(value, "shape") and hasattr(value, "dtype"):
        payload = {
            "type": type(value).__name__,
            "shape": [int(dim) for dim in getattr(value, "shape", ())],
            "dtype": str(getattr(value, "dtype", "")),
        }
        try:
            if int(value.numel()) <= 64:
                payload["values"] = [
                    round(float(item), 8)
                    for item in value.detach().cpu().flatten().tolist()
                ]
        except Exception:
            pass
        return payload
    return {
        "type": f"{type(value).__module__}.{type(value).__qualname__}",
    }


def _canonical_core_graph(graph: GraphBuilder) -> dict[str, Any]:
    core = {}
    prefix = str(graph.prefix)
    for node_id, node in graph.nodes.items():
        local_id = (
            str(node_id)[len(prefix):]
            if str(node_id).startswith(prefix)
            else str(node_id)
        )
        if not local_id.startswith("td_s"):
            continue
        core[local_id] = {
            "class_type": node.class_type,
            "inputs": {
                key: _graph_value_signature(value, prefix)
                for key, value in sorted(node.inputs.items())
            },
        }
    return core


def _diagnostic_graph_path(input_signature: str) -> str:
    root = os.path.join(
        folder_paths.get_output_directory(),
        ".terrydirector_diag",
    )
    os.makedirs(root, exist_ok=True)
    safe = "".join(
        char for char in str(input_signature)
        if char.isalnum() or char in {"-", "_"}
    )[:80]
    return os.path.join(root, f"base_core_{safe}.json")


def _short_diag(value: Any, limit: int = 220) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= limit else text[:limit] + "…"


def _compare_core_graphs(base: dict[str, Any], advanced: dict[str, Any]) -> list[str]:
    diffs: list[str] = []
    for node_id in sorted(set(base) | set(advanced)):
        left = base.get(node_id)
        right = advanced.get(node_id)
        if left is None:
            diffs.append(f"{node_id}: only in Advanced")
            continue
        if right is None:
            diffs.append(f"{node_id}: missing from Advanced")
            continue
        if left.get("class_type") != right.get("class_type"):
            diffs.append(
                f"{node_id}.class_type: Base={left.get('class_type')} "
                f"Advanced={right.get('class_type')}"
            )
        left_inputs = left.get("inputs", {})
        right_inputs = right.get("inputs", {})
        for key in sorted(set(left_inputs) | set(right_inputs)):
            lv = left_inputs.get(key, {"__missing__": True})
            rv = right_inputs.get(key, {"__missing__": True})
            if lv != rv:
                diffs.append(
                    f"{node_id}.{key}: Base={_short_diag(lv)} "
                    f"Advanced={_short_diag(rv)}"
                )
    return diffs


def _log_core_graph_signature(
    graph: GraphBuilder,
    diagnostic_label: str | None = None,
    diagnostic_input_signature: str | None = None,
):
    core = _canonical_core_graph(graph)
    raw = json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    label = f" {diagnostic_label}" if diagnostic_label else ""
    print(
        f"[TerryDirector][Diagnostic]{label} core_graph_signature={digest} "
        f"nodes={len(core)}",
        flush=True,
    )

    if not diagnostic_label or not diagnostic_input_signature:
        return digest

    path = _diagnostic_graph_path(diagnostic_input_signature)
    if diagnostic_label == "Base":
        payload = {
            "input_signature": diagnostic_input_signature,
            "core_graph_signature": digest,
            "core": core,
        }
        temp_path = path + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, indent=2)
        os.replace(temp_path, path)
        print(
            f"[TerryDirector][Diagnostic] Base core graph saved for comparison",
            flush=True,
        )
    elif diagnostic_label == "Advanced":
        if not os.path.isfile(path):
            print(
                "[TerryDirector][Diagnostic] No matching Base core graph snapshot; "
                "run Base once with the same input_signature first",
                flush=True,
            )
            return digest
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            base = payload.get("core", {})
            diffs = _compare_core_graphs(base, core)
            if not diffs:
                print(
                    "[TerryDirector][Diagnostic] Base vs Advanced core graph: EXACT MATCH",
                    flush=True,
                )
            else:
                print(
                    f"[TerryDirector][Diagnostic] Base vs Advanced core graph: "
                    f"{len(diffs)} difference(s)",
                    flush=True,
                )
                for diff in diffs[:24]:
                    print(f"[TerryDirector][Diagnostic] DIFF {diff}", flush=True)
                if len(diffs) > 24:
                    print(
                        f"[TerryDirector][Diagnostic] DIFF ... "
                        f"{len(diffs) - 24} more",
                        flush=True,
                    )
        except Exception as exc:
            print(
                f"[TerryDirector][Diagnostic] Core graph comparison failed: {exc}",
                flush=True,
            )
    return digest


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
    rerun: dict[str, Any] | None = None,
    preview_override: dict[str, Any] | None = None,
    reuse_cached_segment_ids: set[str] | None = None,
    finish_state_mode: str = "complete",
    diagnostic_label: str | None = None,
    diagnostic_input_signature: str | None = None,
) -> tuple[dict[str, Any], Any]:
    """Expand a compiled TerryDirector timeline into native ComfyUI H3 nodes."""
    graph = GraphBuilder()
    latents: list[Any] = []
    segment_ids = [str(segment["id"]) for segment in plan["segments"]]
    cache_signatures = [_cache_signature(runtime, segment) for segment in plan["segments"]]
    segment_ids_json = json.dumps(segment_ids, ensure_ascii=False)
    segment_signatures_json = json.dumps(cache_signatures, ensure_ascii=False)
    run_signature = str(
        diagnostic_input_signature
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
        signature = cache_signatures[len(latents)]
        if rerun_segment_id is not None:
            should_sample = segment_id == rerun_segment_id
        else:
            should_sample = segment_id not in reuse_cached

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
                graph, segment_runtime, positive, latent, prefix, segment_seed
            )
            if cache_key is not None:
                sampled = graph.node(
                    "TerryDirectorCacheLatent",
                    f"{prefix}_checkpoint",
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

    _log_core_graph_signature(
        graph,
        diagnostic_label=diagnostic_label,
        diagnostic_input_signature=diagnostic_input_signature,
    )

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
            segment_ids_json=segment_ids_json,
            segment_signatures_json=segment_signatures_json,
            cache_only_segment_id=str(rerun_segment_id or ""),
            run_signature=run_signature,
            state_mode=str(finish_state_mode or "complete"),
        )
        output = final.out(0)
    return graph.finalize(), output
