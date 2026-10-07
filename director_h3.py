from __future__ import annotations

from typing import Any

from comfy_execution.graph_utils import GraphBuilder

from .director_core import FPS


def _load_reference_inputs(
    graph: GraphBuilder,
    segment: dict[str, Any],
) -> dict[str, Any]:
    inputs: dict[str, Any] = {}

    for index, asset in enumerate(segment["assets"]["images"]):
        source = asset["source"]
        if source.get("type") != "comfy-input":
            raise ValueError("TerryDirector only executes assets stored in ComfyUI input")
        loaded = graph.node(
            "LoadImage",
            f"td_ref_image_{index}",
            image=source["path"],
        )
        inputs[f"ref_images.ref_image_{index}"] = loaded.out(0)

    for index, asset in enumerate(segment["assets"]["videos"]):
        source = asset["source"]
        if source.get("type") != "comfy-input":
            raise ValueError("TerryDirector only executes assets stored in ComfyUI input")
        loaded = graph.node(
            "LoadVideo",
            f"td_ref_video_{index}",
            file=source["path"],
        )
        components = graph.node(
            "GetVideoComponents",
            f"td_ref_video_components_{index}",
            video=loaded.out(0),
        )
        inputs[f"ref_videos.ref_video_{index}"] = components.out(0)

    for index, asset in enumerate(segment["assets"]["audios"]):
        source = asset["source"]
        if source.get("type") != "comfy-input":
            raise ValueError("TerryDirector only executes assets stored in ComfyUI input")
        loaded = graph.node(
            "LoadAudio",
            f"td_ref_audio_{index}",
            audio=source["path"],
        )
        inputs[f"ref_audios.ref_audio_{index}"] = loaded.out(0)

    return inputs


def build_single_segment_graph(
    runtime: dict[str, Any],
    segment: dict[str, Any],
) -> tuple[dict[str, Any], Any, Any, Any]:
    """Expand one compiled segment through ComfyUI's native MiniMax H3 chain."""
    graph = GraphBuilder()
    ref_inputs = _load_reference_inputs(graph, segment)

    conditioning = graph.node(
        "MiniMaxH3ReferenceToVideo",
        "td_h3_conditioning",
        clip=runtime["clip"],
        vae=runtime["vae"],
        audio_vae=runtime["audio_vae"],
        prompt=segment["prompt"],
        width=runtime["width"],
        height=runtime["height"],
        length=segment["h3_frames"],
        ref_image_size=runtime["params"]["ref_image_size"],
        **ref_inputs,
    )
    noise = graph.node(
        "RandomNoise",
        "td_noise",
        noise_seed=runtime["params"]["seed"],
    )
    guider = graph.node(
        "BasicGuider",
        "td_guider",
        model=runtime["model"],
        conditioning=conditioning.out(0),
    )
    sampled = graph.node(
        "SamplerCustomAdvanced",
        "td_sample",
        noise=noise.out(0),
        guider=guider.out(0),
        sampler=runtime["sampler"],
        sigmas=runtime["sigmas"],
        latent_image=conditioning.out(1),
    )

    decoded_images = graph.node(
        "VAEDecode",
        "td_decode_video",
        samples=sampled.out(0),
        vae=runtime["vae"],
    )
    images = graph.node(
        "ImageFromBatch",
        "td_trim_video",
        image=decoded_images.out(0),
        batch_index=0,
        length=segment["output_frames"],
    )

    decoded_audio = graph.node(
        "VAEDecodeAudio",
        "td_decode_audio",
        samples=sampled.out(0),
        vae=runtime["audio_vae"],
    )
    audio = graph.node(
        "TrimAudioDuration",
        "td_trim_audio",
        audio=decoded_audio.out(0),
        start_index=0.0,
        duration=segment["output_frames"] / FPS,
    )

    return graph.finalize(), sampled.out(0), images.out(0), audio.out(0)
