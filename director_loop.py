"""TerryDirector timeline-controlled loop built on ComfyUI 0.39's native loop engine.

The repeatable body is the *ordinary graph* between TerryDirectorLooper and
TerryDirectorLoopEnd. This module does not implement an H3 sampler.
"""

from __future__ import annotations

import json
import uuid

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageOps
from comfy_api.latest import io
from comfy_extras.nodes_loop import StartLoop, EndLoop
from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide

from .director_compile import DEFAULT_TAIL_REFERENCE_PROMPT, compile_timeline
from .director_core import config_json, normalize_config
from .director_internal import (
    TerryDirectorDecodeSegmentToCache,
    TerryDirectorMaterializeTimeline,
    prepare_base_run_cache,
)

CATEGORY = "MiniMax H3/TerryDirector/循环"
IMAGE_SLOTS = 9


def _one(value):
    """Loop-boundary nodes receive lists from the native is_input_list schema."""
    return value[0] if isinstance(value, list) else value


def _notify(loop_id, segment_id, state):
    # Only report real execution boundaries; never synthesize sampler percentage.
    try:
        from server import PromptServer
        server = PromptServer.instance
        if server is not None:
            server.send_sync(
                "terrydirector:loop-segment",
                {
                    "node_id": str(loop_id),
                    "clip_id": str(segment_id),
                    "status": state,
                },
            )
    except Exception:
        pass


def _load_image(asset):
    source = asset.get("source") or {}
    if source.get("type") != "comfy-input":
        raise ValueError("循环媒体仅接受已上传到 ComfyUI input 的资产")
    name = source.get("path")
    if not name or not folder_paths.exists_annotated_filepath(name):
        raise FileNotFoundError(f"循环媒体找不到 ComfyUI input 图片: {name}")
    path = folder_paths.get_annotated_filepath(name)
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        array = np.array(image, dtype=np.uint8, copy=True)
    return torch.from_numpy(array).float().div_(255.0).unsqueeze(0)


def _plan_items(config_data, seed, tail_reference_prompt, loop_id):
    config = normalize_config(config_data)
    plan = compile_timeline(
        config["document"], tail_reference_prompt=tail_reference_prompt
    )
    run_signature = uuid.uuid4().hex
    cache_key = f"loop-{loop_id}"
    prepare_base_run_cache(cache_key, run_signature)
    items = []
    for position, segment in enumerate(plan["segments"]):
        next_segment = (
            plan["segments"][position + 1]
            if position + 1 < len(plan["segments"]) else None
        )
        next_continuity = (next_segment or {}).get("continuity", {})
        context_frames = (
            max(1, int(next_continuity.get("frames", 1)))
            if next_continuity.get("kind") == "overlap" else 1
        )
        item = dict(segment)
        item["_loop"] = {
            "seed": int(seed),
            "cache_key": cache_key,
            "run_signature": run_signature,
            "context_frames": context_frames,
            "signature": f"{run_signature}:{segment['id']}:{segment['h3_frames']}",
            "loop_id": str(loop_id),
        }
        items.append(item)
    return items


class TerryDirectorLooper(StartLoop):
    """The existing TerryDirector document drives native StartLoop List mode."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLooper",
            display_name="TerryDirector 循环开始",
            search_aliases=["导演时间线循环器", "TerryDirector Looper"],
            category=CATEGORY,
            loop_boundary="start",
            is_input_list=True,
            enable_expand=True,
            description="复用导演时间线；每个未挂起片段循环执行一次外部原生 H3 节点组。",
            inputs=[
                io.Int.Input(
                    "seed", display_name="Seed", default=0, min=0,
                    max=0xFFFFFFFFFFFFFFFF, control_after_generate=True,
                ),
                io.String.Input(
                    "config_json", default=config_json(), multiline=True,
                    dynamic_prompts=False, socketless=True,
                ),
                io.String.Input(
                    "tail_reference_prompt",
                    default=DEFAULT_TAIL_REFERENCE_PROMPT, multiline=True,
                    dynamic_prompts=False, socketless=True,
                ),
            ],
            outputs=[
                io.Int.Output("iteration_index", display_name="循环序号"),
                io.Boolean.Output("is_first", display_name="首段"),
                io.Boolean.Output("is_last", display_name="末段"),
                io.AnyType.Output("list_item", display_name="当前片段"),
                io.AnyType.Output(
                    "current_iteration_value",
                    display_name="上一片段上下文", is_output_list=True,
                ),
            ],
            hidden=[
                io.Hidden.dynprompt, io.Hidden.execution_list, io.Hidden.unique_id,
            ],
        )

    @classmethod
    def execute(cls, seed, config_json, tail_reference_prompt=DEFAULT_TAIL_REFERENCE_PROMPT):
        loop_id = _one(cls.hidden.unique_id)
        items = _plan_items(
            _one(config_json), _one(seed), _one(tail_reference_prompt), loop_id
        )
        return super().execute(
            mode={"mode": ["List"], "list": items}, cache_iterations=False
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Each queue must recompile the timeline and rerun all active segments.
        return float("NaN")


class TerryDirectorLoopMedia(io.ComfyNode):
    """Expose per-segment parameters and stable H3 reference-image sockets."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopMedia",
            display_name="TerryDirector 循环媒体",
            category=CATEGORY,
            description="当前片段 Prompt / 时长 / 参考图自动映射到官方 H3 Reference to Video。",
            inputs=[
                io.AnyType.Input("segment", display_name="当前片段"),
                io.AnyType.Input(
                    "previous_context", display_name="上一片段上下文",
                ),
            ],
            outputs=[
                io.String.Output(display_name="提示词"),
                io.Int.Output(display_name="H3帧数"),
                io.Int.Output(display_name="Seed"),
                io.AnyType.Output(display_name="片段数据"),
                *[
                    io.Image.Output(display_name=f"image_{index}")
                    for index in range(IMAGE_SLOTS)
                ],
            ],
        )

    @classmethod
    def execute(cls, segment, previous_context):
        if not isinstance(segment, dict):
            raise ValueError("循环媒体未收到有效片段数据")
        assets = segment["assets"]
        if assets.get("videos") or assets.get("audios"):
            raise ValueError(
                "循环媒体当前版本支持图片参考；视频/音频资产适配尚未实现，"
                "请先使用图片参考工作流测试。"
            )
        _notify(segment["_loop"]["loop_id"], segment["id"], "running")
        images = [_load_image(a) for a in assets["images"]]
        kind = segment["continuity"]["kind"]
        if kind == "tail_reference":
            previous = (previous_context or {}).get("images")
            if previous is None or previous.shape[0] < 1:
                raise ValueError("尾帧参考需要上一片段生成的真实尾帧")
            slot = int(segment["continuity"]["picture_number"]) - 1
            if slot != len(images):
                raise ValueError("尾帧参考编号与 H3 图片槽位不一致")
            images.append(previous[-1:].clone())
        if len(images) > IMAGE_SLOTS:
            raise ValueError("官方 H3 最多接受 9 张参考图片")
        images.extend([None] * (IMAGE_SLOTS - len(images)))
        return io.NodeOutput(
            segment["prompt"],
            int(segment["h3_frames"]),
            int(segment["_loop"]["seed"]),
            segment,
            *images,
        )


class TerryDirectorLoopGuide(io.ComfyNode):
    """Conditionally apply official MiniMaxH3AddGuide to real prior context."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopGuide",
            display_name="TerryDirector 循环承接",
            category=CATEGORY,
            inputs=[
                io.Conditioning.Input("positive"),
                io.Latent.Input("latent"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.AnyType.Input("segment"),
                io.AnyType.Input("previous_context"),
            ],
            outputs=[io.Conditioning.Output(display_name="承接后正向条件")],
        )

    @classmethod
    def execute(cls, positive, latent, vae, audio_vae, segment, previous_context):
        continuity = segment["continuity"]
        kind = continuity["kind"]
        if kind in ("independent", "gap", "tail_reference"):
            return io.NodeOutput(positive)
        previous = previous_context or {}
        images = previous.get("images")
        audio = previous.get("audio")
        if images is None or audio is None:
            raise ValueError(f"{kind} 承接需要上一片段的真实 IMAGE/AUDIO")
        if kind == "tail_frame":
            return MiniMaxH3AddGuide.execute(
                positive=positive, latent=latent, vae=vae,
                image=images[-1:], frame_idx=0,
            )
        if kind != "overlap":
            raise ValueError(f"无法识别的循环承接模式: {kind}")
        frames = int(continuity["frames"])
        if images.shape[0] < frames:
            raise ValueError("上一片段保留的重叠图像帧不足")
        waveform = audio["waveform"]
        rate = int(audio["sample_rate"])
        samples = round(frames * rate / 24)
        if waveform.shape[-1] < samples:
            raise ValueError("上一片段保留的重叠音频不足")
        overlap_audio = {
            "waveform": waveform[..., -samples:].clone(),
            "sample_rate": rate,
        }
        image_frames = int(continuity["video_guide_frames"])
        result = MiniMaxH3AddGuide.execute(
            positive=positive, latent=latent,
            audio_vae=audio_vae, audio=overlap_audio,
            vae=vae if image_frames else None,
            image=images[-frames:][:image_frames] if image_frames else None,
            frame_idx=0,
        )[0]
        boundary_frame = continuity.get("boundary_target_frame")
        if boundary_frame is not None:
            result = MiniMaxH3AddGuide.execute(
                positive=result, latent=latent, vae=vae,
                image=images[-1:], frame_idx=int(boundary_frame),
            )[0]
        return io.NodeOutput(result)


class TerryDirectorLoopCache(io.ComfyNode):
    """Run the existing lossless Base decoder/cache after each H3 sampling."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopCache",
            display_name="TerryDirector 循环缓存",
            category=CATEGORY,
            description="逐段无损 .pt 落盘，只传递需要的尾帧/重叠上下文。",
            inputs=[
                io.Latent.Input("samples", display_name="H3采样结果"),
                io.Vae.Input("vae", display_name="视频VAE"),
                io.Vae.Input("audio_vae", display_name="音频VAE"),
                io.AnyType.Input("segment", display_name="片段数据"),
            ],
            outputs=[
                io.String.Output(display_name="分段缓存"),
                io.AnyType.Output(display_name="下一片段上下文"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(cls, samples, vae, audio_vae, segment):
        loop = segment["_loop"]
        assembly = segment["assembly"]
        result = TerryDirectorDecodeSegmentToCache.execute(
            samples=samples,
            vae=vae,
            audio_vae=audio_vae,
            cache_key=loop["cache_key"],
            run_signature=loop["run_signature"],
            segment_id=segment["id"],
            signature=loop["signature"],
            output_frames=int(segment["output_frames"]),
            trim_head_frames=int(assembly["trim_head_frames"]),
            gap_frames=int(assembly["gap_before_frames"]),
            gap_after_frames=int(assembly["gap_after_frames"]),
            context_frames=int(loop["context_frames"]),
            fps=24,
        )
        _notify(loop["loop_id"], segment["id"], "completed")
        return io.NodeOutput(
            result[0], {"images": result[1], "audio": result[2]}
        )


class TerryDirectorLoopEnd(EndLoop):
    """Native EndLoop returns every lossless cache descriptor, in timeline order."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopEnd",
            display_name="TerryDirector 循环结束",
            category=CATEGORY,
            loop_boundary="end",
            is_input_list=True,
            is_output_node=True,
            description="收集所有片段缓存；要输出合并音画可接 TerryDirector 循环合并。",
            inputs=[
                io.String.Input("output_value", display_name="分段缓存"),
                io.AnyType.Input(
                    "next_iteration_value", display_name="下一片段上下文",
                ),
                io.Boolean.Input("accumulate", default=True, socketless=True),
            ],
            outputs=[
                io.String.Output("outputs", is_output_list=True, display_name="分段缓存列表"),
            ],
            hidden=[io.Hidden.execution_list, io.Hidden.unique_id],
        )


class TerryDirectorLoopMerge(io.ComfyNode):
    """Optional, fully lossless end-of-run materialization using existing Base code."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopMerge",
            display_name="TerryDirector 循环合并",
            category=CATEGORY,
            is_input_list=True,
            inputs=[
                io.String.Input("segments", display_name="分段缓存列表"),
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
    def execute(cls, segments):
        values = [json.loads(x) for x in segments]
        if not values:
            raise ValueError("循环合并没有收到任何有效分段")
        count = sum(int(item["frames"]) for item in values)
        return TerryDirectorMaterializeTimeline.execute(
            segments={f"segment_{i}": raw for i, raw in enumerate(segments)},
            expected_frames=count,
        )
