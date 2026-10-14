"""TerryDirector timeline-controlled loop built on ComfyUI 0.39's native loop engine.

The repeatable body is the *ordinary graph* between TerryDirectorLooper and
TerryDirectorLoopEnd. This module does not implement an H3 sampler.
"""

from __future__ import annotations

import json
import os
import time
import uuid

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageOps
from comfy_api.latest import io, InputImpl
from comfy_execution.graph_utils import GraphBuilder, is_link
from comfy_extras.nodes_loop import StartLoop
from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide
from comfy_extras.nodes_audio import load as load_audio_file

from .director_compile import DEFAULT_TAIL_REFERENCE_PROMPT, compile_timeline
from .director_ai import prepare_document_for_queue
from .director_ai_node import LlamaConfigData
from .director_loop_adapters import (
    DEFAULT_LOOP_ADAPTER,
    adapter_from_segment,
    get_loop_adapter,
)
from .director_core import config_json, normalize_config
from .director_loop_media import FORMATS, MOV_HQ, save_loop_segment, merge_loop_clips
from .director_loop_reuse import find_saved_clip, safe_input_video, load_tail_context
from .director_loop_memory import log_loop_ram, release_completed_body
from .director_loop_report import start_report, mark_clip, finish_report

# An allowlist of diagnosis-relevant numeric/model settings. Neither prompt
# contents nor arbitrary asset paths are retained in performance reports.
_DIAG_FIELDS = {
    "UNETLoader": ("unet_name", "weight_dtype"),
    "CLIPLoader": ("clip_name", "type", "device"),
    "VAELoader": ("vae_name",),
    "LoraLoaderModelOnly": ("lora_name", "strength_model"),
    "ModelAttentionBackend": ("attention",),
    "MiniMaxLowVRAMAttention": ("head_chunks",),
    "MiniMaxChunkFeedForward": ("chunks", "seq_threshold"),
    "ResolutionSelector": ("aspect_ratio", "megapixels", "multiple"),
    "BasicScheduler": ("scheduler", "steps", "denoise"),
    "KSamplerSelect": ("sampler_name",),
    "H3SigmaRefiner": ("extra_steps", "start_at_sigma", "end_at_sigma", "spacing"),
    "SelfLiftAvatarH3Sampler": (
        "cfg", "transition_step", "lowres_scale", "rho", "w_min", "w_max",
        "upscaler_model", "highres_tiling", "tiling_mode", "tiling_tiles", "tiling_axis",
    ),
    "TerryDirectorSelfLiftSampler": (
        "cfg", "transition_step", "lowres_scale", "sampling_steps",
        "upscaler_model", "highres_tiling", "tiling_mode",
    ),
    "RAMCleanup": ("clean_file_cache", "clean_processes", "clean_dlls", "retry_times"),
    "TerryXuMemoryCleanup": ("clean_ram", "clean_vram", "unload_models"),
    "TerryDirectorH3X2LowRAMDecode": (
        "temporal_tile_frames", "temporal_context_frames",
        "spatial_tile_size", "spatial_tile_overlap", "seam_warning_threshold",
    ),
    "VHS_VideoCombine": ("format", "frame_rate", "crf", "pix_fmt", "save_output"),
    "TerryDirectorLoopInfo": (),
    "TerryDirectorLoopCondition": (),
}


def _pipeline_for_report(dynprompt, body):
    """Capture body nodes and relevant upstream model settings without prompts.

    Traversal includes only a small allowlisted upstream set, never full graph
    serialization. Names or values outside _DIAG_FIELDS are ignored.
    """
    seen = set()
    pending = [str(x) for x in body]
    inventory = []
    while pending and len(seen) < 120:
        node_id = str(pending.pop())
        if node_id in seen:
            continue
        seen.add(node_id)
        try:
            node = dynprompt.get_node(node_id)
        except Exception:
            continue
        if not isinstance(node, dict):
            continue
        node_type = str(node.get("class_type") or "")
        settings = {}
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        for key in _DIAG_FIELDS.get(node_type, ()):
            value = inputs.get(key)
            if isinstance(value, (str, int, float, bool)) and len(str(value)) <= 180:
                settings[key] = value
            elif is_link(value):
                settings[key] = "<连接>"
        if node_id in {str(v) for v in body} or node_type in _DIAG_FIELDS:
            inventory.append({"id": node_id, "type": node_type, "settings": settings})
        for value in inputs.values():
            if not is_link(value):
                continue
            upstream_id = str(value[0])
            if upstream_id in seen:
                continue
            try:
                upstream = dynprompt.get_node(upstream_id)
                upstream_type = upstream.get("class_type") if isinstance(upstream, dict) else None
            except Exception:
                continue
            if upstream_type in _DIAG_FIELDS:
                pending.append(upstream_id)
    return sorted(inventory, key=lambda entry: (
        int(entry["id"]) if entry["id"].isdigit() else float("inf"), entry["id"]
    ))


CATEGORY = "TerryDirector/循环"
IMAGE_SLOTS = 9
VIDEO_SLOTS = 3
AUDIO_SLOTS = 3
LOOP_CONTEXT_KIND = "terrydirector.loop_context"
SEGMENT_DATA_KIND = "terrydirector.segment_data"
LoopContextData = io.Custom("TERRYDIRECTOR_LOOP_CONTEXT")
SegmentData = io.Custom("TERRYDIRECTOR_SEGMENT_DATA")


def _require_loop_context(value):
    """The timeline's full per-iteration envelope, not the extracted segment."""
    if not isinstance(value, dict) or value.get("_type") != LOOP_CONTEXT_KIND:
        raise ValueError("循环信息需要「循环上下文」输入，请连接循环开始节点")
    segment = value.get("current_segment")
    if not isinstance(segment, dict) or not isinstance(segment.get("_loop"), dict):
        raise ValueError("循环上下文缺少当前片段")
    previous = value.get("previous_context")
    if not isinstance(previous, dict):
        raise ValueError("循环上下文的上一片段状态无效")
    return segment, previous


def _require_segment_data(value):
    """Generation-facing data extracted from a LoopContext by LoopInfo."""
    if not isinstance(value, dict) or value.get("_type") != SEGMENT_DATA_KIND:
        raise ValueError("需要「片段数据」，请连接「TerryDirector 循环信息」的片段数据输出")
    return value


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


def _asset_input_path(asset, label):
    source = asset.get("source") or {}
    if source.get("type") != "comfy-input":
        raise ValueError(f"循环信息仅接受已上传到 ComfyUI input 的{label}")
    name = source.get("path")
    if not name or not folder_paths.exists_annotated_filepath(name):
        raise FileNotFoundError(f"循环信息找不到 ComfyUI input {label}: {name}")
    return folder_paths.get_annotated_filepath(name)


def _resample_video_24fps(images, source_fps):
    if not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[0] < 1:
        raise ValueError("参考视频没有可用画面帧")
    fps = float(source_fps)
    if not np.isfinite(fps) or fps <= 0:
        raise ValueError(f"参考视频帧率无效: {source_fps}")
    if abs(fps - 24.0) < 1e-6:
        return images
    duration = images.shape[0] / fps
    target_frames = max(1, int(round(duration * 24.0)))
    positions = torch.arange(target_frames, dtype=torch.float64)
    indices = torch.floor(positions * fps / 24.0).to(torch.long)
    indices = indices.clamp_(0, images.shape[0] - 1)
    return images.index_select(0, indices.to(images.device))


def _load_video(asset):
    path = _asset_input_path(asset, "视频")
    source = InputImpl.VideoFromFile(path)
    components = source.get_components()
    return _resample_video_24fps(
        components.images,
        components.frame_rate,
    )


def _load_audio(asset):
    path = _asset_input_path(asset, "音频")
    waveform, sample_rate = load_audio_file(path)
    return {
        "waveform": waveform.unsqueeze(0),
        "sample_rate": int(sample_rate),
    }


def _plan_items(
    config_data, seed, tail_reference_prompt, loop_id,
    adapter_id=DEFAULT_LOOP_ADAPTER,
    llama_config=None,
    rerun_clip_id="",
):
    # Fail before creating any cache directory if the model has no adapter.
    adapter = get_loop_adapter(adapter_id)
    config = normalize_config(config_data)
    rerun_clip_id = str(rerun_clip_id or "").strip()
    document = config["document"]
    if rerun_clip_id:
        for clip in document["clips"]:
            if clip["id"] != rerun_clip_id:
                clip["aiOptOut"] = True
    for clip in document["clips"]:
        if clip.get("kind") == "entity":
            clip["aiOptOut"] = True
    document = prepare_document_for_queue(document, llama_config, str(loop_id))
    plan = adapter.compile_plan(
        document, tail_reference_prompt,
        compiler=compile_timeline,
    )
    all_segments = plan["segments"]
    if rerun_clip_id:
        target_index = next(
            (i for i, part in enumerate(all_segments)
             if part["id"] == rerun_clip_id), None
        )
        if target_index is None:
            raise ValueError(
                "不能单独重跑：目标镜头不存在或已挂起。"
                "请在时间线中选择有效的生成片段。"
            )
        target = all_segments[target_index]
        if target["kind"] == "entity":
            raise ValueError("实体视频本身不会采样。请选择生成片段进行重跑。")
        previous = all_segments[target_index-1] if target_index else None
        needs_previous = target["continuity"]["kind"] in (
            "tail_reference", "tail_frame", "overlap",
        )
        selected = [previous, target] if previous and needs_previous else [target]
    else:
        selected = all_segments

    run_signature = uuid.uuid4().hex
    cache_key = f"loop-{loop_id}"
    # Each new take has a fresh output directory. Prior MOVs are never overwritten.
    items = []
    for position, segment in enumerate(selected):
        action = (
            "entity" if segment["kind"] == "entity"
            else "reuse_result" if rerun_clip_id and segment["id"] != rerun_clip_id
            else "generate"
        )
        previous_result = None
        if action == "reuse_result":
            previous_result = find_saved_clip(
                loop_id, segment["id"], required_frames=segment["output_frames"]
            )
            if previous_result is None:
                raise FileNotFoundError(
                    f"片段「{rerun_clip_id}」缺少承接上下文："
                    f"未找到上一镜头「{segment['name']}」的有效 MOV/MP4。"
                    "请先生成上一镜头，或导入实体视频。"
                )
        elif action == "entity":
            safe_input_video(segment["source_asset"])
        
        next_segment = selected[position + 1] if position + 1 < len(selected) else None
        next_continuity = (next_segment or {}).get("continuity", {})
        context_frames = (
            max(1, int(next_continuity.get("frames", 1)))
            if next_continuity.get("kind") == "overlap" else 1
        )
        item = dict(segment)
        segment_seed = segment.get("seed")
        effective_seed = int(seed) if segment_seed is None else int(segment_seed)
        item["_loop"] = {
            "adapter_id": adapter.info.adapter_id,
            "index": int(position),
            "action": action,
            "rerun_target": rerun_clip_id,
            "reuse_path": previous_result["path"] if previous_result else None,
            "seed": max(0, min(0xFFFFFFFFFFFFFFFF, effective_seed)),
            "cache_key": cache_key,
            "run_signature": run_signature,
            "context_frames": context_frames,
            "signature": (
                f"{run_signature}:{segment['id']}:"
                f"{adapter.sampling_frames(segment)}"
            ),
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
            category="TerryDirector/循环/内部",
            is_dev_only=True,
            inputs=[
                io.AnyType.Input("segment"),
                io.AnyType.Input("previous_context"),
            ],
            outputs=[LoopContextData.Output(display_name="循环上下文")],
        )

    @classmethod
    def execute(cls, segment, previous_context=None):
        if not isinstance(segment, dict) or "_loop" not in segment:
            raise ValueError("循环开始未产生有效的当前片段")
        # The very first context is a JSON-widget literal, not an IMAGE packet.
        previous = previous_context if isinstance(previous_context, dict) else {}
        return io.NodeOutput({
            "_type": LOOP_CONTEXT_KIND,
            "version": 1,
            "current_segment": segment,
            "previous_context": previous,
        })


def _expand_director_loop(dynprompt, opener_id, body, close_id, items, initial_value):
    """Adapt ComfyUI's native List loop expansion without exposing internal wires.

    Per iteration: LoopIteration -> private LoopFrame -> user H3 graph
    -> per-clip MOV/MP4 encoder (or existing video reuse). The descriptor and compact
    context feeds the next LoopIteration. Native LoopProgress and LoopResult
    coordinate the original End boundary through the execution_list block.
    """
    graph = GraphBuilder()
    end = dynprompt.get_node(close_id)
    end_inputs = end["inputs"]
    required = ("images", "audio")
    for name in required:
        if not is_link(end_inputs.get(name)):
            raise ValueError(f"循环结束必须连接 {name}")
    copied_loop_metadata = {}
    carry = initial_value
    previous_dependencies = []
    previous_progress = None
    result_inputs = {"close_id": close_id}
    previous_body_ids = []

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

        if item["_loop"]["action"] != "generate":
            # Existing MOV and imported physical clips never traverse the
            # user's sampler/VAE body. They still produce carry context for
            # the next generated segment in normal ComfyUI execution order.
            reused = graph.node(
                "TerryDirectorLoopReuse", f"reuse_{position}",
                loop_context=frame.out(0),
            )
            descriptor, carry = reused.out(0), reused.out(1)
            copies = {}
        else:
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
                        raise ValueError("循环开始只暴露一个循环上下文输出")
                    return frame.out(0)
                if value[0] in copies:
                    return copies[value[0]].out(value[1])
                return value

            for node_id, copy in copies.items():
                original = dynprompt.get_node(node_id)
                for name, value in original.get("inputs", {}).items():
                    copy.set_input(name, copied_link(value))
                if original["class_type"] == "TerryDirectorLoopInfo":
                    copy.set_input("release_node_ids", json.dumps(previous_body_ids))
                if "_loop_end" in original:
                    copied_loop_metadata[copy.id] = {
                        "_loop_body": [copies[n].id for n in original["_loop_body"]],
                        "_loop_end": copies[original["_loop_end"]].id,
                    }

            cache_inputs = {
                "loop_context": frame.out(0),
                "images": copied_link(end_inputs["images"]),
                "audio": copied_link(end_inputs["audio"]),
                "segment_format": end_inputs.get("segment_format", MOV_HQ),
            }
            if is_link(end_inputs.get("dependency")):
                cache_inputs["dependency"] = copied_link(end_inputs["dependency"])

            cache = graph.node(
                "TerryDirectorLoopCache", f"cache_{position}",
                **cache_inputs,
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
        previous_body_ids = [copy.id for copy in copies.values()]

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
    return expanded, previous_body_ids


class TerryDirectorLoopReuse(io.ComfyNode):
    """Use an existing output MOV or imported video without sampling."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopReuse",
            display_name="TerryDirector 已有视频上下文（内部）",
            category="TerryDirector/循环/内部",
            is_dev_only=True,
            inputs=[LoopContextData.Input("loop_context")],
            outputs=[
                io.String.Output(display_name="复用片段"),
                io.AnyType.Output(display_name="连续性上下文"),
            ],
        )

    @classmethod
    def execute(cls, loop_context):
        segment, _ = _require_loop_context(loop_context)
        loop = segment["_loop"]
        action = loop.get("action")
        if action == "entity":
            path = safe_input_video(segment["source_asset"])
        elif action == "reuse_result":
            path = str(loop.get("reuse_path") or "")
            if not os.path.isfile(path):
                raise FileNotFoundError("上一次生成的视频结果已被移动或删除：" + path)
        else:
            raise ValueError("无效的片段复用模式")

        # Maintain the authored source range, even if the reused clip is
        # followed by a single-target rerun rather than a full render.
        carry = load_tail_context(
            path, segment["output_frames"], int(loop["context_frames"]),
        )
        descriptor = {
            "segment_id": segment["id"],
            "index": loop["index"],
            "frames": segment["output_frames"],
            "path": path,
            "skip_in_final": True,
            "context_source": action,
            "run_signature": loop["run_signature"],
        }
        _notify(loop["loop_id"], segment["id"], "completed")
        return io.NodeOutput(json.dumps(descriptor, ensure_ascii=False), carry)


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
            description="按时间线逐段执行外部视频生成节点组；通过循环上下文传递当前片段与上一轮状态。",
            inputs=[
                LlamaConfigData.Input(
                    "llama_config", display_name="Llama", optional=True,
                ),
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
                io.String.Input(
                    "rerun_clip_id", default="", socketless=True,
                    tooltip="由时间线编辑器临时设置。留空为正常完整循环。",
                ),
            ],
            outputs=[
                LoopContextData.Output("loop_context", display_name="循环上下文"),
            ],
            hidden=[
                io.Hidden.dynprompt, io.Hidden.execution_list, io.Hidden.unique_id,
            ],
        )

    @classmethod
    def execute(
        cls,
        seed,
        config_json,
        tail_reference_prompt=DEFAULT_TAIL_REFERENCE_PROMPT,
        llama_config=None,
        rerun_clip_id="",
    ):
        loop_id = str(_one(cls.hidden.unique_id))
        items = _plan_items(
            _one(config_json),
            _one(seed),
            _one(tail_reference_prompt),
            loop_id,
            llama_config=_one(llama_config),
            rerun_clip_id=_one(rerun_clip_id),
        )
        dynprompt = cls.hidden.dynprompt
        execution_list = cls.hidden.execution_list
        loop = dynprompt.get_node(loop_id)
        body = set(loop["_loop_body"])
        end_id = loop["_loop_end"]
        expanded, last_body_ids = _expand_director_loop(
            dynprompt, loop_id, body, end_id, items, "{}"
        )
        # Metrics attach to this expansion only; never change its sampler.
        try:
            start_report(loop_id, items, pipeline=_pipeline_for_report(dynprompt, body))
        except Exception as exc:
            print(f"[TerryDirector Loop][Report] 采集初始化失败：{exc}", flush=True)
        end = dynprompt.get_node(end_id)
        remaining_inputs = end["inputs"].copy()
        for key in ("images", "audio", "dependency"):
            remaining_inputs.pop(key, None)
        remaining_inputs["release_node_ids"] = json.dumps(last_body_ids)
        remaining_inputs["rerun_clip_id"] = str(_one(rerun_clip_id) or "")
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
            description=(
                "解析循环上下文，输出 0 基循环 index、提示词、采样帧数、随机种子、片段数据，"
                "以及 H3 官方支持的图片/视频/音频参考素材。"
            ),
            inputs=[
                LoopContextData.Input("loop_context", display_name="循环上下文"),
                io.String.Input("release_node_ids", optional=True, advanced=True),
            ],
            outputs=[
                io.Int.Output(display_name="index"),
                io.String.Output(display_name="提示词"),
                io.Int.Output(display_name="采样帧数"),
                io.Int.Output(display_name="Seed"),
                SegmentData.Output(display_name="片段数据"),
                *[
                    io.Image.Output(display_name=f"image_{index}")
                    for index in range(IMAGE_SLOTS)
                ],
                *[
                    io.Image.Output(display_name=f"video_{index}")
                    for index in range(VIDEO_SLOTS)
                ],
                *[
                    io.Audio.Output(display_name=f"audio_{index}")
                    for index in range(AUDIO_SLOTS)
                ],
            ],
            hidden=[io.Hidden.execution_list],
        )

    @classmethod
    def execute(cls, loop_context, release_node_ids=None):
        segment, previous_context = _require_loop_context(loop_context)
        adapter = adapter_from_segment(segment)
        loop = segment["_loop"]
        execution_list = cls.hidden.execution_list
        if release_node_ids:
            log_loop_ram("next_segment_before_release", segment["id"], execution_list)
            released = release_completed_body(execution_list, json.loads(release_node_ids))
            print(f"[TerryDirector RAM] prior body cache entries released={released}", flush=True)
        log_loop_ram("before_sampling", segment["id"], execution_list)
        mark_clip(loop["loop_id"], loop["run_signature"], loop["index"], "running")
        _notify(loop["loop_id"], segment["id"], "running")
        media = adapter.reference_media(
            segment,
            previous_context,
            load_image=_load_image,
            load_video=_load_video,
            load_audio=_load_audio,
        )
        images = list(media["images"])
        videos = list(media["videos"])
        audios = list(media["audios"])
        if len(images) > IMAGE_SLOTS:
            raise ValueError("当前循环信息节点最多提供 9 个参考图片输入")
        if len(videos) > VIDEO_SLOTS:
            raise ValueError("当前循环信息节点最多提供 3 个参考视频输入")
        if len(audios) > AUDIO_SLOTS:
            raise ValueError("当前循环信息节点最多提供 3 个参考音频输入")
        images.extend([None] * (IMAGE_SLOTS - len(images)))
        videos.extend([None] * (VIDEO_SLOTS - len(videos)))
        audios.extend([None] * (AUDIO_SLOTS - len(audios)))
        segment_data = {
            **segment,
            "_type": SEGMENT_DATA_KIND,
            "version": 1,
            "previous_context": previous_context,
        }
        return io.NodeOutput(
            int(segment["_loop"]["index"]),
            segment["prompt"],
            adapter.sampling_frames(segment),
            int(segment["_loop"]["seed"]),
            segment_data,
            *images,
            *videos,
            *audios,
        )

class TerryDirectorLoopCondition(io.ComfyNode):
    """Conditionally apply official MiniMaxH3AddGuide to real prior context."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopCondition",
            display_name="TerryDirector 循环条件",
            category=CATEGORY,
            description="处理前后片段的生成条件；当前承接实现使用 MiniMax H3 Guide，其他模型需要对应适配器。",
            inputs=[
                io.Conditioning.Input("positive", display_name="正向条件"),
                io.Latent.Input("latent", display_name="潜变量"),
                io.Vae.Input("vae", display_name="视频VAE"),
                io.Vae.Input("audio_vae", display_name="音频VAE"),
                SegmentData.Input("segment_data", display_name="片段数据"),
            ],
            outputs=[io.Conditioning.Output(display_name="正向条件")],
        )

    @classmethod
    def execute(cls, positive, latent, vae, audio_vae, segment_data):
        segment = _require_segment_data(segment_data)
        adapter = adapter_from_segment(segment)
        result = adapter.apply_continuity(
            segment, positive, latent, vae, audio_vae,
            guide_node=MiniMaxH3AddGuide,
        )
        return io.NodeOutput(result)

class TerryDirectorLoopCache(io.ComfyNode):
    """Encode one independent clip and retain compact raw continuity context."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopCache",
            display_name="TerryDirector 片段保存（内部）",
            category="TerryDirector/循环/内部",
            is_dev_only=True,
            description="逐轮编码 MOV/MP4 镜头；仅保留必要的原始承接上下文。",
            inputs=[
                LoopContextData.Input("loop_context", display_name="循环上下文"),
                io.Image.Input("images", display_name="已解码画面"),
                io.Audio.Input("audio", display_name="已解码音频"),
                io.AnyType.Input("dependency", display_name="循环结束依赖", optional=True),
                io.Combo.Input("segment_format", options=list(FORMATS), default=MOV_HQ),
            ],
            outputs=[
                io.String.Output(display_name="片段文件"),
                io.AnyType.Output(display_name="下一片段上下文"),
            ],
            hidden=[io.Hidden.execution_list],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(cls, loop_context, images, audio, dependency=None,
                segment_format=MOV_HQ):
        segment, _previous_context = _require_loop_context(loop_context)
        loop = segment["_loop"]
        log_loop_ram("before_clip_save", segment["id"], cls.hidden.execution_list)
        started = time.perf_counter()
        descriptor_text, carry_images, carry_audio = save_loop_segment(
            images=images, audio=audio, segment=segment,
            format_name=str(segment_format),
        )
        elapsed = time.perf_counter() - started
        descriptor = json.loads(descriptor_text)
        log_loop_ram(
            "after_clip_save", segment["id"], cls.hidden.execution_list,
            descriptor["path"],
        )
        try:
            clip_mb = os.path.getsize(descriptor["path"]) / (1024 * 1024)
            mark_clip(
                loop["loop_id"], loop["run_signature"], loop["index"], "completed",
                cache_seconds=elapsed, cache_mb=clip_mb,
                cache_frames=int(descriptor["frames"]),
            )
        except Exception as exc:
            print(f"[TerryDirector Loop][Report] 片段计时失败: {exc}", flush=True)
        _notify(loop["loop_id"], segment["id"], "completed")
        return io.NodeOutput(
            descriptor_text,
            {"images": carry_images, "audio": carry_audio},
        )

class TerryDirectorLoopEnd(io.ComfyNode):
    """Save editable per-clip video during each loop; optionally assemble final.

    Never decodes LATENT. Users connect already decoded IMAGE/AUDIO; each
    generated clip is permanently saved before the next iteration begins.
    """

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
                "每段立即保存完整 MOV ProRes 422 HQ（默认）或 MP4 H.264；"
                "可选在全部完成后按时间线重叠精确裁切并合并整片，不再缓存完整 .pt。"
                "旧 VIDEO 输出保留兼容，合并关闭时该输出为空。"
            ),
            inputs=[
                io.Image.Input(
                    "images", display_name="已解码画面", optional=True,
                    tooltip="连接循环体最终画面，例如 MiniMax H3 VAE Decode (fast) 的 IMAGE 输出。",
                ),
                io.Audio.Input(
                    "audio", display_name="已解码音频", optional=True,
                    tooltip="连接与已解码画面配套的最终分段音频。",
                ),
                io.AnyType.Input(
                    "dependency", display_name="循环结束依赖", optional=True,
                    tooltip="可接 VHS Video Combine 等每段必须执行的输出节点结果，确保该分支完成后再结束当前循环。",
                ),
                io.Combo.Input(
                    "bit_depth", display_name="bit_depth",
                    options=["auto", 8, 10], default="auto",
                    advanced=True, socketless=True,
                    tooltip="默认 sRGB 使用 8-bit，HDR 使用 10-bit；无需修改即可直接保存。",
                ),
                io.Combo.Input(
                    "color_space", display_name="color_space",
                    options=["sRGB", "HDR", "HDR PQ"], default="sRGB",
                    advanced=True, socketless=True,
                    tooltip=(
                        "沿用官方 CreateVideo 的色彩空间标记。"
                        "仅当输入已经是真正 HDR 画面时选择 HDR / HDR PQ，"
                        "此选项不会把 SDR 画面转换为 HDR。"
                    ),
                ),
                io.String.Input("release_node_ids", optional=True, advanced=True),
                io.String.Input("rerun_clip_id", optional=True, advanced=True),
                io.Combo.Input(
                    "segment_format", display_name="片段保存格式",
                    options=list(FORMATS), default=MOV_HQ, socketless=True,
                ),
                io.Boolean.Input(
                    "merge_final", display_name="循环结束合并整片",
                    default=True, socketless=True,
                ),
            ],
            outputs=[
                io.Video.Output(display_name="最终整片（合并开启时）"),
                io.String.Output(display_name="循环记录 Markdown"),
                io.String.Output(display_name="片段输出目录"),
            ],
            hidden=[io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(cls, bit_depth="auto", color_space="sRGB",
                release_node_ids=None, segment_format=MOV_HQ,
                merge_final=True, rerun_clip_id="", **kwargs):
        # Existing workflow widgets remain for backwards compatibility. The
        # new MOV/MP4 encoder is SDR Rec.709-only: do not silently relabel HDR.
        if str(_one(color_space)) not in ("sRGB", "None", ""):
            raise ValueError(
                "新片段编码目前仅支持 SDR / Rec.709。旧版 HDR 选项尚未"
                "适配 ProRes/MP4，请将 color_space 改为 sRGB。"
            )
        results = cls.hidden.execution_list.get_external_block_result(
            _one(cls.hidden.unique_id)
        )
        descriptors = [item for group in results for item in group]
        if not descriptors:
            raise ValueError("循环结束没有收到任何已完成片段")

        if release_node_ids:
            log_loop_ram("before_final_release", "final", cls.hidden.execution_list)
            released = release_completed_body(
                cls.hidden.execution_list, json.loads(str(_one(release_node_ids)))
            )
            print(f"[TerryDirector RAM] final body cache entries released={released}", flush=True)
            log_loop_ram("after_final_release", "final", cls.hidden.execution_list)

        import gc
        gc.collect()
        try:
            import comfy.model_management as model_management
            model_management.unload_all_models()
            model_management.soft_empty_cache()
        except Exception as exc:
            print(
                f"[TerryDirector Loop] Model release before output skipped: {exc}",
                flush=True,
            )
        gc.collect()

        all_parts = [
            json.loads(str(_one(item))) if isinstance(_one(item), str)
            else dict(_one(item))
            for item in descriptors
        ]
        # Context-only entity videos and reused predecessors are never emitted
        # into the final movie or its run manifest.
        descriptions = [part for part in all_parts if not part.get("skip_in_final")]
        format_name = str(_one(segment_format))
        if any(part.get("segment_format") != format_name for part in descriptions):
            raise ValueError("循环输出设置与已经编码的片段格式不一致")
        is_rerun = bool(str(_one(rerun_clip_id) or ""))
        # An isolated rerun updates only its movie result. It must not
        # accidentally replace the original Final with an incomplete render.
        for index, part in enumerate(descriptions):
            original_index = part["index"]
            part["index"] = index
            if index == 0 and all_parts and all_parts[0].get("skip_in_final"):
                part["trim_head_frames"] = 0
                part["gap_before_frames"] = 0
        merged_path = (
            merge_loop_clips(descriptions, merge_final=bool(_one(merge_final)))
            if descriptions and not is_rerun else None
        )
        video = InputImpl.VideoFromFile(merged_path) if merged_path else None
        clips_root = (
            str(os.path.dirname(os.path.dirname(descriptions[0]["path"])))
            if descriptions else ""
        )
        try:
            identity = json.loads(str(descriptors[0]))
            markdown = finish_report(
                identity.get("loop_id", ""),
                identity.get("run_signature", ""),
            )
        except Exception as exc:
            print(f"[TerryDirector Loop][Report] 输出报告失败：{exc}", flush=True)
            markdown = "# TerryDirector 循环性能记录\n\n报告生成失败，VIDEO 输出不受影响。\n"
        return io.NodeOutput(video, markdown, clips_root)

