from __future__ import annotations

import folder_paths
import torch
import comfy.samplers
import nodes
from comfy_api.latest import io

from .director_core import (
    config_json,
    make_runtime_config,
    normalize_config,
    require_runtime_config,
    summary,
)

DirectorConfigData = io.Custom("TERRYDIRECTOR_CONFIG")
AUTO_UPSCALER = "自动选择兼容模型"


def _files(category: str) -> list[str]:
    try:
        values = list(folder_paths.get_filename_list(category))
    except Exception:
        values = []
    return values or [""]


def _vae_options() -> list[str]:
    try:
        values = list(nodes.VAELoader.vae_list(nodes.VAELoader))
    except Exception:
        values = _files("vae")
    return values or [""]


def _preferred(values: list[str], *needles: str) -> str:
    for needle in needles:
        needle = needle.lower()
        for value in values:
            if needle in value.lower():
                return value
    return values[0] if values else ""


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


def _resolve_model(value, weight_dtype: str):
    if not isinstance(value, str):
        return value
    return nodes.UNETLoader().load_unet(value, weight_dtype)[0]


def _resolve_clip(value, clip_type: str):
    if not isinstance(value, str):
        return value
    return nodes.CLIPLoader().load_clip(value, type=clip_type, device="default")[0]


def _resolve_vae(value):
    if not isinstance(value, str):
        return value
    return nodes.VAELoader().load_vae(value)[0]


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
                io.Model.Input(
                    "model",
                    display_name="UNet名称",
                    extra_dict=_native_combo(
                        _files("diffusion_models"),
                        _preferred(_files("diffusion_models"), "minimax_h3"),
                    ),
                ),
                io.Combo.Input(
                    "model_weight_dtype",
                    display_name="UNet精度",
                    options=["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"],
                    default="default",
                    advanced=True,
                ),
                io.Clip.Input(
                    "clip",
                    display_name="CLIP名称",
                    extra_dict=_native_combo(
                        _files("text_encoders"),
                        _preferred(_files("text_encoders"), "minimax_h3"),
                    ),
                ),
                io.Combo.Input(
                    "clip_type",
                    display_name="CLIP类型",
                    options=["minimax"],
                    default="minimax",
                ),
                io.Vae.Input(
                    "vae",
                    display_name="视频VAE",
                    extra_dict=_native_combo(
                        _vae_options(),
                        _preferred(_vae_options(), "minimax_h3_video_vae"),
                    ),
                ),
                io.Vae.Input(
                    "audio_vae",
                    display_name="音频VAE",
                    extra_dict=_native_combo(
                        _vae_options(),
                        _preferred(_vae_options(), "minimax_h3_audio_vae"),
                    ),
                ),
                io.Int.Input(
                    "width",
                    display_name="width",
                    default=1344,
                    min=32,
                    max=16384,
                    step=32,
                ),
                io.Int.Input(
                    "height",
                    display_name="height",
                    default=768,
                    min=32,
                    max=16384,
                    step=32,
                ),
                io.Sampler.Input(
                    "sampler",
                    display_name="采样器",
                    extra_dict=_native_combo(
                        list(comfy.samplers.SAMPLER_NAMES),
                        "res_multistep",
                    ),
                ),
                io.Sigmas.Input(
                    "sigmas",
                    display_name="调度器",
                    extra_dict=_native_combo(
                        list(comfy.samplers.SCHEDULER_NAMES),
                        "simple",
                    ),
                ),
                io.Int.Input(
                    "sigmas_steps",
                    display_name="步数",
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
                io.Boolean.Input(
                    "continue_audio_latent",
                    display_name="音频连续",
                    default=True,
                ),
                io.Combo.Input(
                    "second_pass_method",
                    display_name="二采方案",
                    options=["无", "SelfLift"],
                    default="无",
                ),
                io.Combo.Input(
                    "second_pass_model",
                    display_name="SelfLift 放大模型",
                    options=_latent_upscaler_options(),
                    default=AUTO_UPSCALER,
                    advanced=True,
                ),
                io.Int.Input(
                    "second_pass_high_steps",
                    display_name="SelfLift 高清步数",
                    default=4,
                    min=1,
                    max=1000,
                    step=1,
                    advanced=True,
                ),
            ],
            outputs=[
                DirectorConfigData.Output(display_name="导演配置"),
            ],
        )

    @classmethod
    def validate_inputs(cls, **kwargs):
        # MODEL/CLIP/VAE/SAMPLER/SIGMAS rows intentionally accept either the
        # native widget value or a real upstream object through the same socket.
        return True

    @classmethod
    def execute(
        cls,
        model,
        model_weight_dtype,
        clip,
        clip_type,
        vae,
        audio_vae,
        width,
        height,
        sampler,
        sigmas,
        sigmas_steps,
        sigmas_denoise,
        seed,
        ref_image_size,
        continue_audio_latent,
        second_pass_method,
        second_pass_model=AUTO_UPSCALER,
        second_pass_high_steps=4,
    ):
        model = _resolve_model(model, model_weight_dtype)
        clip = _resolve_clip(clip, clip_type)
        vae = _resolve_vae(vae)
        audio_vae = _resolve_vae(audio_vae)
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
            continue_audio_latent=continue_audio_latent,
            second_pass_method=method,
            second_pass_model=upscaler,
            second_pass_high_steps=second_pass_high_steps,
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
        info = summary(config, runtime)
        raise RuntimeError(
            "TerryDirector 当前测试版已完成配置节点、导演台 UI 与工作流序列化，"
            "采样执行尚未接入。"
            f" 当前编排：{info['clips']} 个片段，{info['seconds']:.2f}s，"
            f"目标尺寸 {info['width']}x{info['height']}，"
            f"二采方案 {info['second_pass']}。"
        )
