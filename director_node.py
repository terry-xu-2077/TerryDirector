from __future__ import annotations

import math
import folder_paths
import comfy.samplers
from comfy_api.latest import io
from comfy_extras.nodes_resolution import ASPECT_RATIOS, AspectRatio

from .director_compile import compile_timeline
from .director_core import (
    config_json,
    make_runtime_config,
    normalize_config,
    require_runtime_config,
    summary,
)

DirectorConfigData = io.Custom("TERRYDIRECTOR_CONFIG")
AUTO_UPSCALER = "自动选择兼容模型"


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
                    optional=False,
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
                io.Int.Input(
                    "seed",
                    display_name="Seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    control_after_generate=True,
                ),
                io.Combo.Input(
                    "ref_image_size",
                    display_name="参考图尺寸",
                    options=["match", "max"],
                    default="match",
                ),
                io.Combo.Input(
                    "second_pass_method",
                    display_name="二采方案",
                    options=["无", "SelfLift"],
                    default="无",
                    advanced=True,
                ),
                io.Combo.Input(
                    "second_pass_model",
                    display_name="SelfLift 放大模型",
                    options=_latent_upscaler_options(),
                    default=AUTO_UPSCALER,
                    advanced=True,
                ),
                io.Float.Input(
                    "second_pass_high_ratio",
                    display_name="SelfLift 高清占比",
                    default=0.25,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="0.25 = 25%。实际高清步数由总步数 × 高清占比计算。",
                    advanced=True,
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
        seed,
        ref_image_size,
        second_pass_method,
        second_pass_model=AUTO_UPSCALER,
        second_pass_high_ratio=0.25,
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

        method = "selflift" if second_pass_method == "SelfLift" else "none"
        upscaler = "" if second_pass_model == AUTO_UPSCALER else str(second_pass_model or "")
        packet = make_runtime_config(
            model=model,
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            width=width,
            height=height,
            sampler=sampler,
            sigmas=sigmas,
            seed=seed,
            ref_image_size=ref_image_size,
            second_pass_method=method,
            second_pass_model=upscaler,
            second_pass_high_ratio=second_pass_high_ratio,
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
                io.String.Input(
                    "config_json",
                    default=config_json(),
                    multiline=True,
                    dynamic_prompts=False,
                    socketless=True,
                    tooltip="Internal TerryDirector creative state. Managed by the custom UI.",
                ),
            ],
            outputs=[
                io.Latent.Output(display_name="分段潜变量", is_output_list=True),
                io.Image.Output(display_name="合并画面"),
                io.Audio.Output(display_name="合并音频"),
            ],
        )

    @classmethod
    def execute(cls, director_config, config_json):
        runtime = require_runtime_config(director_config)
        config = normalize_config(config_json)
        plan = compile_timeline(config["document"])
        info = summary(config, runtime)
        raise RuntimeError(
            "TerryDirector 时间线编译已接入，真实 H3 采样尚未接入。"
            f" 当前编译为 {len(plan['segments'])} 个 H3 任务，"
            f"最终时间线 {plan['total_frames']} 帧 / {info['seconds']:.2f}s，"
            f"目标尺寸 {info['width']}x{info['height']}，"
            f"二采方案 {info['second_pass']}。"
        )
