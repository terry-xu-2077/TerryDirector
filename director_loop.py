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
from .director_loop_video import TerryDirectorStreamVideo
from .director_loop_report import start_report, mark_clip, finish_report
from .director_internal import (
    TerryDirectorDecodeSegmentToCache,
    prepare_base_run_cache,
)

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
):
    # Fail before creating any cache directory if the model has no adapter.
    adapter = get_loop_adapter(adapter_id)
    config = normalize_config(config_data)
    document = prepare_document_for_queue(
        config["document"], llama_config, str(loop_id)
    )
    plan = adapter.compile_plan(
        document, tail_reference_prompt,
        compiler=compile_timeline,
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
        segment_seed = segment.get("seed")
        effective_seed = int(seed) if segment_seed is None else int(segment_seed)
        item["_loop"] = {
            "adapter_id": adapter.info.adapter_id,
            "index": int(position),
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
    -> private lossless LoopCache. The descriptor is accumulated and the compact
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
                    raise ValueError("循环开始只暴露一个循环上下文输出")
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

        # The user-facing End node is not cloned. The loop boundary only
        # accepts media that the user's generation graph has already decoded.
        cache_inputs = {
            "loop_context": frame.out(0),
            "images": copied_link(end_inputs["images"]),
            "audio": copied_link(end_inputs["audio"]),
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
    ):
        loop_id = str(_one(cls.hidden.unique_id))
        items = _plan_items(
            _one(config_json),
            _one(seed),
            _one(tail_reference_prompt),
            loop_id,
            llama_config=_one(llama_config),
        )
        dynprompt = cls.hidden.dynprompt
        execution_list = cls.hidden.execution_list
        loop = dynprompt.get_node(loop_id)
        body = set(loop["_loop_body"])
        end_id = loop["_loop_end"]
        expanded = _expand_director_loop(
            dynprompt, loop_id, body, end_id, items, "{}"
        )
        # Metrics attach to this expansion only; never change its sampler.
        try:
            start_report(loop_id, items)
        except Exception as exc:
            print(f"[TerryDirector Loop][Report] 采集初始化失败：{exc}", flush=True)
        end = dynprompt.get_node(end_id)
        remaining_inputs = end["inputs"].copy()
        for key in ("images", "audio", "dependency"):
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
            description=(
                "解析循环上下文，输出 0 基循环 index、提示词、采样帧数、随机种子、片段数据，"
                "以及 H3 官方支持的图片/视频/音频参考素材。"
            ),
            inputs=[
                LoopContextData.Input("loop_context", display_name="循环上下文"),
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
        )

    @classmethod
    def execute(cls, loop_context):
        segment, previous_context = _require_loop_context(loop_context)
        adapter = adapter_from_segment(segment)
        loop = segment["_loop"]
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
    """Cache one already-decoded loop segment and return compact continuity context."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLoopCache",
            display_name="TerryDirector 循环缓存",
            category="TerryDirector/循环/内部",
            is_dev_only=True,
            description="内部无损分段缓存与紧凑连续性上下文。",
            inputs=[
                LoopContextData.Input("loop_context", display_name="循环上下文"),
                io.Image.Input("images", display_name="已解码画面"),
                io.Audio.Input("audio", display_name="已解码音频"),
                io.AnyType.Input("dependency", display_name="循环结束依赖", optional=True),
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
    def execute(cls, loop_context, images, audio, dependency=None):
        segment, _previous_context = _require_loop_context(loop_context)
        loop = segment["_loop"]
        assembly = segment["assembly"]
        result = TerryDirectorDecodeSegmentToCache.execute(
            images=images,
            audio=audio,
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
        mark_clip(loop["loop_id"], loop["run_signature"], loop["index"], "completed")
        _notify(loop["loop_id"], segment["id"], "completed")
        # The file-backed VIDEO ignores additional descriptor metadata; tagging
        # the descriptor keeps multi-looper runs isolated in LoopEnd.
        descriptor = json.loads(str(result[0]))
        descriptor["loop_id"] = str(loop["loop_id"])
        descriptor["run_signature"] = str(loop["run_signature"])
        return io.NodeOutput(
            json.dumps(descriptor, ensure_ascii=False),
            {"images": result[1], "audio": result[2]},
        )

class TerryDirectorLoopEnd(io.ComfyNode):
    """Low-memory VIDEO wrapper for already-decoded loop segment media.

    LoopEnd never decodes LATENT and never exposes segment LATENT. The user
    graph must provide final IMAGE/AUDIO for each iteration.
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
                "接收外部 IMAGE/AUDIO，输出流式 VIDEO 和每轮循环的 Markdown 性能记录。"
                "记录包含逐段耗时、原生进度步速、GPU 显存和系统内存，"
                "自动保存至 ComfyUI output/TerryDirector/reports。"
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
            ],
            outputs=[
                io.Video.Output(display_name="视频"),
                io.String.Output(display_name="循环记录 Markdown"),
            ],
            hidden=[io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(cls, bit_depth="auto", color_space="sRGB", **kwargs):
        results = cls.hidden.execution_list.get_external_block_result(
            _one(cls.hidden.unique_id)
        )
        descriptors = [item for group in results for item in group]
        if not descriptors:
            raise ValueError("循环结束没有收到任何已完成片段")

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

        video = TerryDirectorStreamVideo(
            descriptors,
            fps=24,
            bit_depth=_one(bit_depth),
            color_space=_one(color_space),
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
        return io.NodeOutput(video, markdown)

