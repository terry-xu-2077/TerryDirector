from __future__ import annotations

import math
import copy
import hashlib
import json
import uuid
import folder_paths
import comfy.samplers
from comfy_api.latest import io
from comfy_extras.nodes_resolution import ASPECT_RATIOS, AspectRatio

from .director_compile import DEFAULT_TAIL_REFERENCE_PROMPT, compile_timeline
from .director_h3 import build_timeline_graph
from .director_internal import (
    load_advanced_checkpoint,
    prepare_advanced_lossless_run_cache,
    reset_advanced_checkpoint,
)
from .director_core import (
    config_json,
    make_runtime_config,
    make_second_pass_config,
    normalize_config,
    require_runtime_config,
    require_second_pass_config,
)

DirectorConfigData = io.Custom("TERRYDIRECTOR_CONFIG")
SecondPassConfigData = io.Custom("TERRYDIRECTOR_SECOND_PASS_CONFIG")
DirectorOutputData = io.Custom("TERRYDIRECTOR_OUTPUT")
AUTO_UPSCALER = "自动选择兼容模型"

def _preview_tiny_vae_options() -> list[str]:
    try:
        values = list(folder_paths.get_filename_list("vae_approx"))
    except Exception:
        values = []
    return ["none", *values]


def _preview_tiny_vae_default(options: list[str]) -> str:
    for value in options:
        if str(value).replace("\\", "/").split("/")[-1].lower() == "taeh3.safetensors":
            return value
    return "none"


def _second_pass_signature(runtime) -> dict:
    second = runtime.get("params", {}).get("second_pass", {})
    if not isinstance(second, dict) or second.get("method") != "selflift":
        return {"method": "none"}

    sigmas = second.get("sigmas")
    try:
        sigma_values = [
            round(float(value), 8)
            for value in sigmas.detach().cpu().flatten().tolist()
        ]
    except Exception:
        sigma_values = []

    high_model = second.get("high_res_model")
    return {
        "method": "selflift",
        "cfg": float(second.get("cfg", 1.0)),
        "transition_step": int(second.get("transition_step", 5)),
        "lowres_scale": float(second.get("lowres_scale", 0.5)),
        "rho": float(second.get("rho", 0.0)),
        "w_min": float(second.get("w_min", 0.5)),
        "w_max": float(second.get("w_max", 1.0)),
        "upscaler_model": str(second.get("upscaler_model", "none")),
        "sampling_steps": int(second.get("sampling_steps", 6)),
        "sampling_denoise": float(second.get("sampling_denoise", 1.0)),
        "sigma_refine_enabled": bool(second.get("sigma_refine_enabled", True)),
        "sigma_refine_extra_steps": int(second.get("sigma_refine_extra_steps", 1)),
        "sigma_refine_start": float(second.get("sigma_refine_start", 0.7)),
        "sigma_refine_end": float(second.get("sigma_refine_end", 0.0)),
        "sigma_refine_spacing": str(second.get("sigma_refine_spacing", "cosine")),
        "highres_tiling": bool(second.get("highres_tiling", False)),
        "tiling_mode": str(second.get("tiling_mode", "auto")),
        "tiling_tiles": int(second.get("tiling_tiles", 2)),
        "tiling_axis": str(second.get("tiling_axis", "auto")),
        "high_res_model": None if high_model is None else type(high_model).__name__,
        "sigmas": sigma_values,
    }


def _execution_signature(runtime, plan, seed) -> str:
    segments = []
    for segment in plan.get("segments", []):
        refs = segment.get("assets", {})
        prompt_hash = hashlib.sha1(
            str(segment.get("prompt", "")).encode("utf-8")
        ).hexdigest()[:10]
        segments.append({
            "id": str(segment.get("id")),
            "start": int(segment.get("start_frame", 0)),
            "end": int(segment.get("end_frame", 0)),
            "out": int(segment.get("output_frames", 0)),
            "h3": int(segment.get("h3_frames", 0)),
            "transition": str(segment.get("transition_mode", "")),
            "continuity": str(segment.get("continuity", {}).get("kind", "")),
            "images": len(refs.get("images", [])),
            "videos": len(refs.get("videos", [])),
            "audios": len(refs.get("audios", [])),
            "prompt": prompt_hash,
        })

    sigmas = runtime.get("sigmas")
    try:
        sigma_values = [round(float(value), 8) for value in sigmas.detach().cpu().flatten().tolist()]
    except Exception:
        try:
            sigma_values = [round(float(value), 8) for value in sigmas]
        except Exception:
            sigma_values = [str(type(sigmas).__name__)]

    payload = {
        "width": int(runtime.get("width", 0)),
        "height": int(runtime.get("height", 0)),
        "seed": int(seed),
        "ref_image_size": runtime.get("params", {}).get("ref_image_size"),
        "sampler": type(runtime.get("sampler")).__name__,
        "sigmas": sigma_values,
        "second_pass": _second_pass_signature(runtime),
        "segments": segments,
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return digest


def _segment_cache_signatures(runtime, plan) -> list[str]:
    second = runtime.get("params", {}).get("second_pass", {})
    second_hash = (
        str(second.get("cache_signature") or "selflift")
        if isinstance(second, dict) and second.get("method") == "selflift"
        else "none"
    )
    return [
        (
            f"v2:{int(runtime['width'])}x{int(runtime['height'])}:"
            f"h3={int(segment['h3_frames'])}:out={int(segment['output_frames'])}:"
            f"sp={second_hash}"
        )
        for segment in plan.get("segments", [])
    ]


def _require_director_output(value):
    if not isinstance(value, dict):
        raise ValueError("TerryDirector 导演输出无效")
    required = {"segment_latents", "images", "audio"}
    missing = sorted(required.difference(value))
    if missing:
        raise ValueError(f"TerryDirector 导演输出缺少字段: {', '.join(missing)}")
    if not isinstance(value["segment_latents"], list):
        raise ValueError("TerryDirector 导演输出中的分段潜变量必须是列表")
    return value


def _native_combo(options: list[str], default: str | None = None) -> dict:
    values = list(options) or [""]
    return {
        "widgetType": "COMBO",
        "options": values,
        "default": default if default in values else values[0],
    }


def _latent_upscaler_options() -> list[str]:
    try:
        models = list(folder_paths.get_filename_list("latent_upscale_models"))
    except Exception:
        models = []
    return [AUTO_UPSCALER, *models]


def _selflift_upscaler_options() -> list[str]:
    try:
        models = list(folder_paths.get_filename_list("latent_upscale_models"))
    except Exception:
        models = []
    return ["none", *models]


def _selflift_upscaler_default(options: list[str]) -> str:
    target = "minimax_h3_latent_upscaler_3d_fp16.safetensors"
    for value in options:
        if str(value).replace("\\", "/").split("/")[-1].lower() == target:
            return value
    for value in options:
        if value != "none" and "h3" in str(value).lower():
            return value
    return "none"


def _refine_sigmas(
    sigmas,
    *,
    extra_steps: int,
    start_at_sigma: float,
    end_at_sigma: float,
    spacing: str,
):
    if int(extra_steps) <= 0:
        return sigmas

    sigmas_cpu = sigmas.detach().cpu()
    index = -1
    for idx, sigma in enumerate(sigmas_cpu):
        if float(sigma) <= float(start_at_sigma):
            index = idx
            break
    if index < 0 or index >= len(sigmas_cpu) - 1:
        return sigmas

    head = sigmas_cpu[:index]
    start = float(sigmas_cpu[index])
    end = max(float(end_at_sigma), float(sigmas_cpu[-1]))
    count = len(sigmas_cpu) - index + int(extra_steps)
    t = torch.linspace(0.0, 1.0, steps=count)

    if spacing == "cosine":
        factor = (1.0 - torch.cos(t * math.pi)) / 2.0
    elif spacing == "exponential":
        alpha = 3.0
        factor = (torch.exp(t * alpha) - 1.0) / (math.exp(alpha) - 1.0)
    else:
        factor = t

    tail = start + (end - start) * factor
    if float(sigmas_cpu[-1]) == 0.0 and end > 0.0:
        tail = torch.cat([tail, torch.tensor([0.0])])
    return torch.cat([head, tail]).to(device=sigmas.device, dtype=sigmas.dtype)


def _prepare_second_pass_runtime(value, model):
    if value is None:
        return None

    second = dict(require_second_pass_config(value))
    sigmas = _resolve_sigmas(
        "simple",
        model,
        int(second["sampling_steps"]),
        float(second["sampling_denoise"]),
    )
    if second["sigma_refine_enabled"]:
        sigmas = _refine_sigmas(
            sigmas,
            extra_steps=int(second["sigma_refine_extra_steps"]),
            start_at_sigma=float(second["sigma_refine_start"]),
            end_at_sigma=float(second["sigma_refine_end"]),
            spacing=str(second["sigma_refine_spacing"]),
        )

    transition_step = int(second["transition_step"])
    nfe = max(0, int(sigmas.numel()) - 1)
    if nfe < 2 or transition_step > nfe - 1:
        raise ValueError(
            f"SelfLift transition_step={transition_step} 与当前 {nfe} 步 Sigma 日程不兼容"
        )
    if float(sigmas[transition_step]) >= 1.0:
        raise ValueError(
            "SelfLift 高清阶段起始 Sigma 必须小于 1；请调整 transition_step 或采样步数"
        )
    if float(second["rho"]) == 0.0 and str(second["upscaler_model"]) == "none":
        raise ValueError(
            "SelfLift 当前 rho=0 且未选择 latent upscaler，二者不能同时关闭"
        )

    second["sampler"] = comfy.samplers.sampler_object("euler")
    second["sigmas"] = sigmas
    signature_payload = {
        key: value
        for key, value in _second_pass_signature({"params": {"second_pass": second}}).items()
        if key != "sigmas"
    }
    signature_payload["sigmas"] = [
        round(float(value), 8)
        for value in sigmas.detach().cpu().flatten().tolist()
    ]
    second["cache_signature"] = hashlib.sha1(
        json.dumps(
            signature_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()[:10]
    return second


def _resolution(aspect_ratio: str, megapixels: float, multiple: int) -> tuple[int, int]:
    ratio = aspect_ratio if isinstance(aspect_ratio, AspectRatio) else AspectRatio(aspect_ratio)
    w_ratio, h_ratio = ASPECT_RATIOS[ratio]
    total_pixels = float(megapixels) * 1024 * 1024
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    width = round(w_ratio * scale / multiple) * multiple
    height = round(h_ratio * scale / multiple) * multiple
    return int(width), int(height)


def _resolve_sampler(value):
    if not isinstance(value, str):
        return value
    return comfy.samplers.sampler_object(value)


def _resolve_sigmas(value, model, steps: int, denoise: float):
    if not isinstance(value, str):
        return value
    steps = max(1, int(steps))
    denoise = float(denoise)
    if denoise <= 0.0:
        import torch
        return torch.FloatTensor([])
    total_steps = steps if denoise >= 1.0 else int(steps / denoise)
    sigmas = comfy.samplers.calculate_sigmas(
        model.get_model_object("model_sampling"),
        value,
        total_steps,
    ).cpu()
    return sigmas[-(steps + 1):]


class TerryDirectorSecondPassConfig(io.ComfyNode):
    """SelfLift second-pass settings routed through TerryDirector Config."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        upscalers = _selflift_upscaler_options()
        return io.Schema(
            node_id="TerryDirectorSecondPassConfig",
            display_name="TerryDirector 二采配置",
            category="MiniMax H3/TerryDirector",
            description=(
                "SelfLift 二采参数。连接到 TerryDirector 配置后启用；"
                "采样阶段直接调用已安装的 selflift-Avatar H3 Sampler。"
            ),
            inputs=[
                io.Model.Input(
                    "high_res_model",
                    display_name="高清模型（可选）",
                    optional=True,
                    tooltip="不连接时，高清阶段继续使用导演配置里的主模型。",
                ),
                io.Float.Input(
                    "cfg",
                    display_name="CFG",
                    default=1.0,
                    min=0.0,
                    max=100.0,
                    step=0.1,
                ),
                io.Int.Input(
                    "transition_step",
                    display_name="低清阶段步数",
                    default=5,
                    min=1,
                    max=10000,
                    tooltip="前多少次去噪在低分辨率进行；成熟工作流默认 5。",
                ),
                io.Float.Input(
                    "lowres_scale",
                    display_name="低清比例",
                    default=0.5,
                    min=0.25,
                    max=1.0,
                    step=0.05,
                ),
                io.Combo.Input(
                    "upscaler_model",
                    display_name="Latent 放大模型",
                    options=upscalers,
                    default=_selflift_upscaler_default(upscalers),
                ),
                io.Float.Input(
                    "rho",
                    default=0.0,
                    min=0.0,
                    max=1.0,
                    step=0.05,
                ),
                io.Float.Input(
                    "w_min",
                    default=0.5,
                    min=0.0,
                    max=1.0,
                    step=0.05,
                ),
                io.Float.Input(
                    "w_max",
                    default=1.0,
                    min=0.0,
                    max=1.0,
                    step=0.05,
                ),
                io.Int.Input(
                    "sampling_steps",
                    display_name="SelfLift 总步数",
                    default=6,
                    min=2,
                    max=10000,
                ),
                io.Float.Input(
                    "sampling_denoise",
                    display_name="Denoise",
                    default=1.0,
                    min=0.01,
                    max=1.0,
                    step=0.01,
                    advanced=True,
                ),
                io.Boolean.Input(
                    "sigma_refine_enabled",
                    display_name="H3 Sigma 精修",
                    default=True,
                ),
                io.Int.Input(
                    "sigma_refine_extra_steps",
                    display_name="精修加步",
                    default=1,
                    min=0,
                    max=15,
                    advanced=True,
                ),
                io.Float.Input(
                    "sigma_refine_start",
                    display_name="精修起始 Sigma",
                    default=0.7,
                    min=0.0,
                    max=20.0,
                    step=0.01,
                    advanced=True,
                ),
                io.Float.Input(
                    "sigma_refine_end",
                    display_name="精修结束 Sigma",
                    default=0.0,
                    min=0.0,
                    max=5.0,
                    step=0.01,
                    advanced=True,
                ),
                io.Combo.Input(
                    "sigma_refine_spacing",
                    display_name="精修分布",
                    options=["cosine", "linear", "exponential"],
                    default="cosine",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "highres_tiling",
                    display_name="高清分块",
                    default=False,
                ),
                io.Combo.Input(
                    "tiling_mode",
                    display_name="分块模式",
                    options=["auto", "manual"],
                    default="auto",
                    advanced=True,
                ),
                io.Combo.Input(
                    "tiling_tiles",
                    display_name="手动块数",
                    options=[2, 4, 6, 8],
                    default=2,
                    advanced=True,
                ),
                io.Combo.Input(
                    "tiling_axis",
                    display_name="分块方向",
                    options=["auto", "width", "height"],
                    default="auto",
                    advanced=True,
                ),
            ],
            outputs=[
                SecondPassConfigData.Output(display_name="二采配置"),
            ],
        )

    @classmethod
    def execute(
        cls,
        cfg,
        transition_step,
        lowres_scale,
        upscaler_model,
        rho,
        w_min,
        w_max,
        sampling_steps,
        sampling_denoise,
        sigma_refine_enabled,
        sigma_refine_extra_steps,
        sigma_refine_start,
        sigma_refine_end,
        sigma_refine_spacing,
        highres_tiling,
        tiling_mode,
        tiling_tiles,
        tiling_axis,
        high_res_model=None,
    ):
        try:
            import nodes as comfy_nodes
            if "SelfLiftAvatarH3Sampler" not in comfy_nodes.NODE_CLASS_MAPPINGS:
                raise RuntimeError
        except Exception:
            raise RuntimeError(
                "TerryDirector SelfLift 需要安装并启用 slmonker/selflift-Avatar，"
                "且必须包含 SelfLiftAvatarH3Sampler 节点。"
            )

        packet = make_second_pass_config(
            high_res_model=high_res_model,
            cfg=cfg,
            transition_step=transition_step,
            lowres_scale=lowres_scale,
            rho=rho,
            w_min=w_min,
            w_max=w_max,
            upscaler_model=upscaler_model,
            sampling_steps=sampling_steps,
            sampling_denoise=sampling_denoise,
            sigma_refine_enabled=sigma_refine_enabled,
            sigma_refine_extra_steps=sigma_refine_extra_steps,
            sigma_refine_start=sigma_refine_start,
            sigma_refine_end=sigma_refine_end,
            sigma_refine_spacing=sigma_refine_spacing,
            highres_tiling=highres_tiling,
            tiling_mode=tiling_mode,
            tiling_tiles=tiling_tiles,
            tiling_axis=tiling_axis,
        )
        return io.NodeOutput(packet)


class TerryDirectorConfig(io.ComfyNode):
    """Collect all generation-chain dependencies into one TerryDirector packet."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorConfig",
            display_name="TerryDirector 配置",
            category="MiniMax H3/TerryDirector",
            description=(
                "Bundle model, VAE, resolution, sampler/sigmas and TerryDirector generation "
                "settings into one connection for the main TerryDirector node."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input("vae", display_name="视频VAE"),
                io.Vae.Input("audio_vae", display_name="音频VAE"),
                io.Combo.Input(
                    "aspect_ratio",
                    display_name="宽高比",
                    options=AspectRatio,
                    default=AspectRatio.WIDESCREEN_H,
                ),
                io.Float.Input(
                    "megapixels",
                    display_name="百万像素",
                    default=1.0,
                    min=0.1,
                    max=16.0,
                    step=0.1,
                ),
                io.ResolutionPreview.Input(
                    "resolution_preview",
                    ratio_widget="aspect_ratio",
                    megapixels_widget="megapixels",
                    multiple_widget="multiple",
                ),
                io.Int.Input(
                    "multiple",
                    default=32,
                    min=8,
                    max=128,
                    step=4,
                    advanced=True,
                ),
                io.Sampler.Input(
                    "sampler",
                    display_name="采样器",
                    advanced=True,
                    extra_dict=_native_combo(
                        list(comfy.samplers.SAMPLER_NAMES),
                        "res_multistep",
                    ),
                ),
                io.Sigmas.Input(
                    "sigmas",
                    display_name="调度器",
                    advanced=True,
                    extra_dict=_native_combo(
                        list(comfy.samplers.SCHEDULER_NAMES),
                        "simple",
                    ),
                ),
                io.Int.Input(
                    "sigmas_steps",
                    display_name="总步数",
                    default=8,
                    min=1,
                    max=10000,
                ),
                io.Float.Input(
                    "sigmas_denoise",
                    display_name="Denoise",
                    default=1.0,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    advanced=True,
                ),
                io.Combo.Input(
                    "ref_image_size",
                    display_name="参考图尺寸",
                    options=["match", "max"],
                    default="match",
                ),
                SecondPassConfigData.Input(
                    "second_pass_config",
                    display_name="二采配置",
                    optional=True,
                    tooltip="连接 TerryDirector 二采配置后启用 SelfLift。",
                ),



            ],
            outputs=[
                DirectorConfigData.Output(display_name="导演配置"),
            ],
        )

    @classmethod
    def execute(
        cls,
        model,
        clip,
        vae,
        audio_vae,
        aspect_ratio,
        megapixels,
        multiple,
        sampler,
        sigmas,
        sigmas_steps,
        sigmas_denoise,
        ref_image_size,
        second_pass_config=None,
        resolution_preview=None,
    ):
        width, height = _resolution(aspect_ratio, megapixels, multiple)
        sampler = _resolve_sampler(sampler)
        sigmas = _resolve_sigmas(
            sigmas,
            model,
            sigmas_steps,
            sigmas_denoise,
        )

        second_pass = _prepare_second_pass_runtime(second_pass_config, model)
        packet = make_runtime_config(
            model=model,
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            width=width,
            height=height,
            sampler=sampler,
            sigmas=sigmas,
            ref_image_size=ref_image_size,
            second_pass=second_pass,
        )
        return io.NodeOutput(packet)


class TerryDirector(io.ComfyNode):
    """Creative timeline node with one visible runtime input."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirector",
            display_name="TerryDirector",
            category="MiniMax H3/TerryDirector",
            description=(
                "Edit prompts, shared assets and a segment timeline. All generation dependencies "
                "arrive through the single Director Config input."
            ),
            inputs=[
                DirectorConfigData.Input("director_config", display_name="导演配置"),
                io.Int.Input(
                    "seed",
                    display_name="Seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    control_after_generate=True,
                ),
                io.String.Input(
                    "config_json",
                    default=config_json(),
                    multiline=True,
                    dynamic_prompts=False,
                    socketless=True,
                    tooltip="Internal TerryDirector creative state. Managed by the custom UI.",
                ),
                io.String.Input(
                    "tail_reference_prompt",
                    default=DEFAULT_TAIL_REFERENCE_PROMPT,
                    multiline=True,
                    dynamic_prompts=False,
                    socketless=True,
                    tooltip="User-level tail-reference prompt template. Synced from ComfyUI Settings.",
                ),
            ],
            hidden=[io.Hidden.unique_id],
            outputs=[
                DirectorOutputData.Output(display_name="导演输出"),
            ],
            is_output_node=True,
            enable_expand=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # TerryDirector expands an ephemeral H3 execution graph. Always rebuild
        # it for a new Queue so an interrupted run can never reuse stale
        # expanded-node cache state.
        return float("NaN")

    @classmethod
    def execute(
        cls,
        director_config,
        seed,
        config_json,
        tail_reference_prompt=DEFAULT_TAIL_REFERENCE_PROMPT,
    ):
        runtime = require_runtime_config(director_config)
        config = normalize_config(config_json)
        plan = compile_timeline(
            config["document"],
            tail_reference_prompt=tail_reference_prompt,
        )
        run_signature = _execution_signature(runtime, plan, seed)

        expanded, director_output = build_timeline_graph(
            runtime,
            plan,
            seed,
            base_cache_key=(
                f"base-{cls.hidden.unique_id}-"
                f"{uuid.uuid4().hex}"
            ),
            run_signature=run_signature,
        )
        return io.NodeOutput(
            director_output,
            expand=expanded,
        )



class TerryDirectorAdvanced(TerryDirector):
    """Advanced director with lossless segment caching, review UI and final video export."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorAdvanced",
            display_name="TerryDirector Advanced",
            category="MiniMax H3/TerryDirector",
            description="增强版导演节点：视频审片、原生保存、分段 LATENT 缓存与选中片段局部重跑。",
            inputs=[
                DirectorConfigData.Input("director_config", display_name="导演配置"),
                io.Int.Input(
                    "seed", display_name="Seed", default=0, min=0,
                    max=0xFFFFFFFFFFFFFFFF, control_after_generate=True,
                ),
                io.String.Input(
                    "config_json", default=config_json(), multiline=True,
                    dynamic_prompts=False, socketless=True,
                    tooltip="Internal TerryDirector creative state.",
                ),
                io.String.Input(
                    "tail_reference_prompt", default=DEFAULT_TAIL_REFERENCE_PROMPT,
                    multiline=True, dynamic_prompts=False, socketless=True,
                ),
                io.String.Input(
                    "save_subfolder", default="TerryDirector", socketless=True,
                    tooltip="Advanced 最终视频保存子目录（相对于 ComfyUI output）。",
                ),
                io.String.Input(
                    "filename_prefix", default="video/TerryDirector", socketless=True,
                    tooltip="Advanced 最终视频文件名前缀。",
                ),
                # Keep the original Advanced widget order stable for old workflows.
                io.Combo.Input("video_format", display_name="格式",
                    options=["auto", "mp4", "mkv", "webm"], default="auto"),
                io.Combo.Input("video_codec", display_name="编解码器",
                    options=["auto", "h264", "av1"], default="auto"),
                # New preview settings must stay AFTER the original save widgets,
                # otherwise ComfyUI restores old widgets_values into the wrong types.
                io.Boolean.Input("preview_enabled", default=False, socketless=True),
                io.Int.Input("preview_max_resolution", default=1024, min=0, max=8192, socketless=True),
                io.Int.Input("preview_jpeg_quality", default=80, min=30, max=100, socketless=True),
                io.Int.Input("preview_fps", default=12, min=1, max=24, socketless=True),
                io.Boolean.Input("preview_suppress_default", default=True, socketless=True),
                io.String.Input("rerun_clip_id", default="", socketless=True),
                io.Int.Input(
                    "rerun_seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF,
                    socketless=True,
                ),
                io.Combo.Input(
                    "preview_tiny_vae",
                    options=_preview_tiny_vae_options(),
                    default=_preview_tiny_vae_default(_preview_tiny_vae_options()),
                    socketless=True,
                ),
                # Recovery is appended after every previously released widget so
                # old workflow widgets_values keep their original positions.
                io.String.Input(
                    "recovery_mode", default="", socketless=True,
                ),
            ],
            hidden=[io.Hidden.unique_id],
            outputs=[DirectorOutputData.Output(display_name="导演输出")],
            is_output_node=True,
            enable_expand=True,
        )

    @classmethod
    def execute(
        cls, director_config, seed, config_json,
        tail_reference_prompt=DEFAULT_TAIL_REFERENCE_PROMPT,
        save_subfolder="TerryDirector", filename_prefix="video/TerryDirector",
        video_format="auto", video_codec="auto",
        preview_enabled=False, preview_max_resolution=1024,
        preview_jpeg_quality=80, preview_fps=12,
        preview_suppress_default=True,
        rerun_clip_id="", rerun_seed=0,
        recovery_mode="",
        preview_tiny_vae="none",
    ):
        runtime = require_runtime_config(director_config)
        config = normalize_config(config_json)
        plan = compile_timeline(
            config["document"], tail_reference_prompt=tail_reference_prompt,
        )
        cache_key = str(cls.hidden.unique_id)
        recovery_mode = str(recovery_mode or "").strip().lower()
        recovery_checkpoint = None
        if recovery_mode in {"resume", "export_partial"}:
            recovery_checkpoint = load_advanced_checkpoint(cache_key)
            if isinstance(recovery_checkpoint, dict):
                saved_seed = recovery_checkpoint.get("run_seed")
                if saved_seed is not None:
                    seed = int(saved_seed)
        run_signature = _execution_signature(runtime, plan, seed)
        if video_format == "webm" and video_codec == "h264":
            raise ValueError("WebM 容器不支持 H.264，请选择 auto 或 av1")

        prefix = str(filename_prefix or "video/TerryDirector").replace("\\", "/")
        folder = str(save_subfolder or "TerryDirector").strip().strip("/")
        if prefix == "TerryDirector" and folder:
            prefix = folder + "/TerryDirector"

        rerun = None
        if str(rerun_clip_id or "").strip():
            rerun = {
                "segment_id": str(rerun_clip_id).strip(),
                "seed": int(rerun_seed),
            }
            print(
                f"[TerryDirector Advanced] Local rerun: segment={rerun['segment_id']} "
                f"seed={rerun['seed']}",
                flush=True,
            )

        segment_ids = [str(segment["id"]) for segment in plan["segments"]]
        segment_signatures = _segment_cache_signatures(runtime, plan)
        reuse_cached_segment_ids: set[str] = set()
        finish_state_mode = "complete"

        if recovery_mode not in {"", "resume", "export_partial"}:
            raise ValueError(f"TerryDirector Advanced 未知恢复模式: {recovery_mode}")

        if rerun is not None and recovery_mode:
            raise ValueError("TerryDirector Advanced 局部重跑与中断恢复不能同时执行")

        # Fresh full runs and local reruns start from a clean temporary
        # lossless pixel cache. Interrupted resume/partial-export must retain
        # the existing cache files.
        if recovery_mode == "":
            prepare_advanced_lossless_run_cache(
                cache_key,
                run_signature,
            )

        if rerun is None and recovery_mode == "":
            reset_advanced_checkpoint(
                cache_key,
                run_signature,
                segment_ids,
                segment_signatures,
                int(seed),
            )
        elif recovery_mode in {"resume", "export_partial"}:
            checkpoint = recovery_checkpoint
            if not isinstance(checkpoint, dict):
                raise RuntimeError("TerryDirector Advanced 没有可恢复的中断任务")
            if str(checkpoint.get("run_signature")) != str(run_signature):
                raise RuntimeError(
                    "TerryDirector Advanced 当前时间线/生成参数已变化，无法复用中断缓存"
                )
            saved_ids = [str(value) for value in checkpoint.get("segment_ids", [])]
            if saved_ids != segment_ids:
                raise RuntimeError(
                    "TerryDirector Advanced 当前片段结构已变化，无法复用中断缓存"
                )
            completed = {
                str(value) for value in checkpoint.get("completed_segment_ids", [])
            }
            prefix_ids = []
            for segment_id in segment_ids:
                if segment_id not in completed:
                    break
                prefix_ids.append(segment_id)
            if not prefix_ids:
                raise RuntimeError("TerryDirector Advanced 中断任务尚无已完成片段")

            if recovery_mode == "resume":
                reuse_cached_segment_ids = set(prefix_ids)
                print(
                    f"[TerryDirector Advanced] Resume from checkpoint: "
                    f"completed={len(prefix_ids)}/{len(segment_ids)}",
                    flush=True,
                )
            else:
                prefix_count = len(prefix_ids)
                partial_plan = copy.deepcopy(plan)
                partial_plan["segments"] = partial_plan["segments"][:prefix_count]
                partial_plan["total_frames"] = int(
                    partial_plan["segments"][-1]["end_frame"]
                )
                plan = partial_plan
                reuse_cached_segment_ids = set(prefix_ids)
                finish_state_mode = "partial"
                prefix = prefix.rstrip("/") + "_partial"
                preview_enabled = False
                print(
                    f"[TerryDirector Advanced] Export completed checkpoint: "
                    f"segments={prefix_count}/{len(segment_ids)}",
                    flush=True,
                )

        # Restore the production live-preview path after the performance
        # isolation run. 1 fps uses ComfyUI's built-in H3 preview; >1 fps uses
        # KJ ModelPreviewOverride when that node is available.
        preview_override = None
        target_preview_fps = max(1, min(24, int(preview_fps)))
        preview_mode = "off"
        core_preview = None

        # Preview selection is process-global in ComfyUI. Reset it on every
        # Advanced execution so a previous 1 fps run cannot leak previews into
        # a later preview-off or KJ run.
        try:
            import latent_preview
            latent_preview.set_preview_method("default")
            core_preview = latent_preview
        except Exception:
            core_preview = None

        if bool(preview_enabled) and target_preview_fps > 1:
            try:
                import nodes as comfy_nodes
                if "ModelPreviewOverrideKJ" in comfy_nodes.NODE_CLASS_MAPPINGS:
                    preview_override = {
                        "max_resolution": int(preview_max_resolution),
                        "jpeg_quality": int(preview_jpeg_quality),
                        "suppress_default_preview": True,
                        "preview_fps": target_preview_fps,
                        "tiny_vae": str(preview_tiny_vae or "none"),
                    }
                    preview_mode = f"kj-{target_preview_fps}fps"
                else:
                    target_preview_fps = 1
            except Exception:
                target_preview_fps = 1

        if bool(preview_enabled) and target_preview_fps == 1:
            # ComfyUI defaults sampler previews to "none". Auto selects the
            # built-in MiniMax H3 Latent2RGB preview in current ComfyUI builds.
            # Forcing TAESD is unsafe here: the commonly installed flat 2D
            # taeh3 checkpoint is a KJ TinyVAE and core expects the temporal
            # decoder.* layout, which otherwise aborts before sampling starts.
            if core_preview is not None:
                core_preview.set_preview_method("auto")
                preview_mode = "core-1fps"
            else:
                preview_mode = "core-1fps-unavailable"

        if preview_mode != "off":
            print(
                f"[TerryDirector Advanced] Preview: {preview_mode}",
                flush=True,
            )
        expanded, director_output = build_timeline_graph(
            runtime,
            plan,
            seed,
            video_export={
                "filename_prefix": prefix,
                "format": str(video_format or "auto"),
                "codec": str(video_codec or "auto"),
            },
            cache_key=cache_key,
            rerun=rerun,
            preview_override=preview_override,
            reuse_cached_segment_ids=reuse_cached_segment_ids,
            finish_state_mode=finish_state_mode,
            run_signature=run_signature,
        )
        return io.NodeOutput(director_output, expand=expanded)



class TerryDirectorOutput(io.ComfyNode):
    """Unpack TerryDirector's single result socket into native ComfyUI outputs."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorOutput",
            display_name="TerryDirector 输出",
            search_aliases=["导演输出", "TerryDirector 解码"],
            category="MiniMax H3/TerryDirector",
            description=(
                "将 TerryDirector 的导演输出解包为分段 LATENT、"
                "合并 IMAGE 和合并 AUDIO。视频封装、编码、预览与保存"
                "由工作流下游的视频节点负责。"
            ),
            inputs=[
                DirectorOutputData.Input("director_output", display_name="导演输出"),
            ],
            outputs=[
                io.Latent.Output(display_name="分段潜变量", is_output_list=True),
                io.Image.Output(display_name="合并画面"),
                io.Audio.Output(display_name="合并音频"),
            ],
        )

    @classmethod
    def execute(cls, director_output):
        packet = _require_director_output(director_output)
        if packet.get("streamed_video") and (
            packet.get("images") is None or packet.get("audio") is None
        ):
            raise RuntimeError(
                "TerryDirector Advanced 使用分段文件化输出，不再物化整条 merged IMAGE/AUDIO。"
                "请直接使用 Advanced 节点保存的视频；基础版 TerryDirector 仍提供 IMAGE/AUDIO 输出。"
            )
        return io.NodeOutput(
            packet["segment_latents"],
            packet["images"],
            packet["audio"],
        )
