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
from comfy_execution.graph_utils import GraphBuilder, is_link
from comfy_extras.nodes_loop import StartLoop
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
        raise ValueError("循环信息仅接受已上传到 ComfyUI input 的资产")
    name = source.get("path")
    if not name or not folder_paths.exists_annotated_filepath(name):
        raise FileNotFoundError(f"循环信息找不到 ComfyUI input 图片: {name}")
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



class TerryDirectorLoopFrame(io.ComfyNode):
    """Hidden adapter: combine the current item and carried context into one port."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopFrame",
            display_name="TerryDirector Loop Frame (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.AnyType.Input("segment"),
                io.AnyType.Input("previous_context"),
            ],
            outputs=[io.AnyType.Output(display_name="片段数据")],
        )

    @classmethod
    def execute(cls, segment, previous_context=None):
        if not isinstance(segment, dict) or "_loop" not in segment:
            raise ValueError("循环开始未产生有效的当前片段")
        # The very first context is a JSON-widget literal, not an IMAGE packet.
        previous = previous_context if isinstance(previous_context, dict) else {}
        return io.NodeOutput({
            "segment": segment,
            "previous_context": previous,
        })


def _expand_director_loop(dynprompt, opener_id, body, close_id, items, initial_value):
    """Adapt ComfyUI's native List loop expansion without exposing internal wires.

    Per iteration: LoopIteration -> private LoopFrame -> user H3 graph
    -> private lossless LoopCache. The descriptor is accumulated and the compact
    context feeds the next LoopIteration. Native LoopProgress and LoopResult
    coordinate the original End boundary through the execution_list block.
    """
    graph = GraphBuilder()
    end = dynprompt.get_node(close_id)
    end_inputs = end["inputs"]
    required = ("samples", "vae", "audio_vae", "segment_data")
    for name in required:
        if not is_link(end_inputs.get(name)):
            raise ValueError(f"循环结束必须连接 {name}")

    copied_loop_metadata = {}
    carry = initial_value
    previous_dependencies = []
    previous_progress = None
    result_inputs = {"close_id": close_id}

    for position, item in enumerate(items):
        iteration = graph.node(
            "LoopIteration", f"iteration_{position}",
            iteration_index=position,
            is_first=position == 0,
            is_last=position == len(items) - 1,
            list_item=item,
            current_iteration_value=carry,
            reuse_cache=False,
            **{
                f"dependency{index}": dep
                for index, dep in enumerate(previous_dependencies)
            },
        )
        iteration.set_override_display_id(opener_id)
        frame = graph.node(
            "TerryDirectorLoopFrame", f"frame_{position}",
            segment=iteration.out(3),
            previous_context=iteration.out(4),
        )
        frame.set_override_display_id(opener_id)

        copies = {}
        for node_id in sorted(body):
            original = dynprompt.get_node(node_id)
            copy = graph.node(original["class_type"], f"{position}_{node_id}")
            copy.set_override_display_id(node_id)
            copies[node_id] = copy

        def copied_link(value):
            if not is_link(value):
                return value
            if value[0] == opener_id:
                if int(value[1]) != 0:
                    raise ValueError("循环开始只暴露一个片段数据输出")
                return frame.out(0)
            if value[0] in copies:
                return copies[value[0]].out(value[1])
            return value

        for node_id, copy in copies.items():
            original = dynprompt.get_node(node_id)
            for name, value in original.get("inputs", {}).items():
                copy.set_input(name, copied_link(value))
            if "_loop_end" in original:
                copied_loop_metadata[copy.id] = {
                    "_loop_body": [copies[n].id for n in original["_loop_body"]],
                    "_loop_end": copies[original["_loop_end"]].id,
                }

        # The user-facing End node is not cloned. Add the existing Base cache
        # adapter automatically inside the dynamic graph, once per segment.
        cache = graph.node(
            "TerryDirectorLoopCache", f"cache_{position}",
            **{name: copied_link(end_inputs[name]) for name in required},
        )
        cache.set_override_display_id(close_id)
        descriptor, carry = cache.out(0), cache.out(1)
        result_inputs[f"output{position}"] = descriptor
        previous_dependencies = [descriptor, carry]

        progress_args = {
            "start_id": opener_id,
            "position": position + 1,
            "total": len(items),
            "dependency0": descriptor,
            "dependency1": carry,
        }
        if previous_progress is not None:
            progress_args["previous_progress"] = previous_progress
        progress = graph.node("LoopProgress", f"progress_{position}", **progress_args)
        previous_progress = progress.out(0)

    if previous_progress is not None:
        result_inputs["progress"] = previous_progress
    result_inputs.update({
        f"dependency{index}": dep
        for index, dep in enumerate(previous_dependencies)
    })
    graph.node("LoopResult", "result", **result_inputs)
    expanded = graph.finalize()
    for node_id, metadata in copied_loop_metadata.items():
        expanded[node_id].update(metadata)
    return expanded


class TerryDirectorLooper(StartLoop):
    """The same TerryDirector document now enters the loop through ONE port."""

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
            description="按时间线逐段执行官方 H3 节点；片段数据已包含上一段上下文。",
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
                io.AnyType.Output("segment_data", display_name="片段数据"),
            ],
            hidden=[
                io.Hidden.dynprompt, io.Hidden.execution_list, io.Hidden.unique_id,
            ],
        )

    @classmethod
    def execute(cls, seed, config_json,
                tail_reference_prompt=DEFAULT_TAIL_REFERENCE_PROMPT):
        loop_id = str(_one(cls.hidden.unique_id))
        items = _plan_items(
            _one(config_json), _one(seed), _one(tail_reference_prompt), loop_id
        )
        dynprompt = cls.hidden.dynprompt
        execution_list = cls.hidden.execution_list
        loop = dynprompt.get_node(loop_id)
        body = set(loop["_loop_body"])
        end_id = loop["_loop_end"]
        expanded = _expand_director_loop(
            dynprompt, loop_id, body, end_id, items, "{}"
        )
        end = dynprompt.get_node(end_id)
        remaining_inputs = end["inputs"].copy()
        for key in ("samples", "vae", "audio_vae", "segment_data"):
            remaining_inputs.pop(key, None)
        execution_list.add_node(end_id)
        execution_list.add_external_block(end_id)
        execution_list.inhibit_nodes(body)
        dynprompt.override_node(
            end_id,
            {"class_type": end["class_type"], "inputs": remaining_inputs},
        )
        from server import PromptServer
        PromptServer.instance.send_progress_text(
            f"Iteration 0 / {len(items)}", loop_id
        )
        return io.NodeOutput(None, expand=expanded)

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")


class TerryDirectorLoopInfo(io.ComfyNode):
    """Expose per-segment parameters and stable H3 reference-image sockets."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopInfo",
            display_name="TerryDirector 循环信息",
            category=CATEGORY,
            description="当前片段 Prompt / 时长 / 参考图自动映射到官方 H3 Reference to Video。",
            inputs=[
                io.AnyType.Input("segment_data", display_name="片段数据"),
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
    def execute(cls, segment_data):
        if not isinstance(segment_data, dict):
            raise ValueError("循环信息未收到有效片段数据")
        segment = segment_data["segment"]
        previous_context = segment_data["previous_context"]
        assets = segment["assets"]
        if assets.get("videos") or assets.get("audios"):
            raise ValueError(
                "循环信息当前版本支持图片参考；视频/音频资产适配尚未实现，"
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
            segment_data,
            *images,
        )


class TerryDirectorLoopCondition(io.ComfyNode):
    """Conditionally apply official MiniMaxH3AddGuide to real prior context."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopCondition",
            display_name="TerryDirector 循环条件",
            category=CATEGORY,
            inputs=[
                io.Conditioning.Input("positive", display_name="正向条件"),
                io.Latent.Input("latent", display_name="潜变量"),
                io.Vae.Input("vae", display_name="视频VAE"),
                io.Vae.Input("audio_vae", display_name="音频VAE"),
                io.AnyType.Input("segment_data", display_name="片段数据"),
            ],
            outputs=[io.Conditioning.Output(display_name="正向条件")],
        )

    @classmethod
    def execute(cls, positive, latent, vae, audio_vae, segment_data):
        segment = segment_data["segment"]
        previous_context = segment_data["previous_context"]
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
            raise ValueError(f"无法识别的循环条件模式: {kind}")
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
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            description="内部无损分段缓存与紧凑连续性上下文。",
            inputs=[
                io.Latent.Input("samples", display_name="H3采样结果"),
                io.Vae.Input("vae", display_name="视频VAE"),
                io.Vae.Input("audio_vae", display_name="音频VAE"),
                io.AnyType.Input("segment_data", display_name="片段数据"),
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
    def execute(cls, samples, vae, audio_vae, segment_data):
        segment = segment_data["segment"]
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



class TerryDirectorLoopEnd(io.ComfyNode):
    """One public loop boundary: lossless cache, carry and final merge are private."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopEnd",
            display_name="TerryDirector 循环结束",
            category=CATEGORY,
            loop_boundary="end",
            is_input_list=True,
            is_output_node=True,
            description=(
                "每段自动无损缓存并向下一轮传递上下文；全部完成后"
                "可选合并为 IMAGE / AUDIO。"
            ),
            inputs=[
                io.Latent.Input("samples", display_name="H3采样结果"),
                io.Vae.Input("vae", display_name="视频VAE"),
                io.Vae.Input("audio_vae", display_name="音频VAE"),
                io.AnyType.Input("segment_data", display_name="片段数据"),
                io.Boolean.Input(
                    "merge_output", display_name="合并输出",
                    default=True, socketless=True,
                    tooltip="默认合并为画面和音频；关闭时只保留无损 .pt 缓存。",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="合并画面"),
                io.Audio.Output(display_name="合并音频"),
            ],
            hidden=[io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(cls, merge_output=True, **kwargs):
        # The native LoopResult releases this external block after all segment
        # caches are ready; the actual loop-body sockets were removed by Start.
        results = cls.hidden.execution_list.get_external_block_result(
            _one(cls.hidden.unique_id)
        )
        descriptors = [item for group in results for item in group]
        if not descriptors:
            raise ValueError("循环结束没有收到任何已完成片段")
        if not bool(_one(merge_output)):
            print(
                f"[TerryDirector Loop] {len(descriptors)} 段无损缓存已保存，"
                "跳过最终合并。",
                flush=True,
            )
            return io.NodeOutput(None, None)

        total = 0
        for raw in descriptors:
            info = json.loads(str(raw))
            total += int(info["frames"])
        return TerryDirectorMaterializeTimeline.execute(
            segments={
                f"segment_{index}": raw
                for index, raw in enumerate(descriptors)
            },
            expected_frames=total,
        )
