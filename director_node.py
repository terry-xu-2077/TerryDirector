from __future__ import annotations

import folder_paths
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
LINK_COMPONENT_VALUE = "外部输入"


def _native_link_component() -> dict:
    """Ask ComfyUI to render a native widget row with its native socket.

    The backend IO type remains MODEL/CLIP/VAE/SAMPLER/SIGMAS; widgetType only
    controls the frontend presentation. No TerryDirector-owned input widget is
    created.
    """

    return {
        "widgetType": "COMBO",
        "options": [LINK_COMPONENT_VALUE],
        "default": LINK_COMPONENT_VALUE,
    }


def _latent_upscaler_options() -> list[str]:
    try:
        models = list(folder_paths.get_filename_list("latent_upscale_models"))
    except Exception:
        models = []
    return [AUTO_UPSCALER, *models]


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
                io.Model.Input("model", extra_dict=_native_link_component()),
                io.Clip.Input("clip", extra_dict=_native_link_component()),
                io.Vae.Input("vae", extra_dict=_native_link_component()),
                io.Vae.Input("audio_vae", extra_dict=_native_link_component()),
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
                io.Sampler.Input("sampler", extra_dict=_native_link_component()),
                io.Sigmas.Input("sigmas", extra_dict=_native_link_component()),
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
    def execute(
        cls,
        model,
        clip,
        vae,
        audio_vae,
        width,
        height,
        sampler,
        sigmas,
        seed,
        ref_image_size,
        continue_audio_latent,
        second_pass_method,
        second_pass_model=AUTO_UPSCALER,
        second_pass_high_steps=4,
    ):
        required_links = {
            "model": model,
            "clip": clip,
            "vae": vae,
            "audio_vae": audio_vae,
            "sampler": sampler,
            "sigmas": sigmas,
        }
        missing = [
            name
            for name, value in required_links.items()
            if value is None
            or (isinstance(value, str) and value == LINK_COMPONENT_VALUE)
        ]
        if missing:
            raise ValueError(
                "TerryDirector 配置缺少外部输入：" + ", ".join(missing)
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
