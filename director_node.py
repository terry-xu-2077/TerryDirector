from __future__ import annotations

from comfy_api.latest import io

from .director_core import config_json, normalize_config, summary


class TerryDirector(io.ComfyNode):
    """Single visible TerryDirector node.

    The visible shell owns generation controls and opens the in-page creative editor.
    Width and height are deliberately supplied by connected ComfyUI inputs rather than
    duplicated as local resolution widgets.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirector",
            display_name="TerryDirector",
            category="MiniMax H3/TerryDirector",
            description=(
                "MiniMax H3 multi-segment director. Connect model, sampling inputs and target width/height; "
                "edit prompts, shared assets and the timeline in the in-page director."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.Int.Input(
                    "width",
                    display_name="width",
                    min=32,
                    max=16384,
                    step=32,
                    force_input=True,
                    advanced=True,
                ),
                io.Int.Input(
                    "height",
                    display_name="height",
                    min=32,
                    max=16384,
                    step=32,
                    force_input=True,
                    advanced=True,
                ),
                io.Sampler.Input("sampler", advanced=True),
                io.Sigmas.Input("sigmas", advanced=True),
                io.String.Input(
                    "config_json",
                    default=config_json(),
                    multiline=True,
                    dynamic_prompts=False,
                    advanced=True,
                    tooltip="Internal TerryDirector serialized state. Managed by the custom UI.",
                ),
            ],
            outputs=[
                io.Latent.Output(display_name="分段潜变量", is_output_list=True),
                io.Image.Output(display_name="合并画面"),
                io.Audio.Output(display_name="合并音频"),
            ],
        )

    @classmethod
    def execute(cls, model, clip, vae, audio_vae, width, height, sampler, sigmas, config_json):
        config = normalize_config(config_json)
        info = summary(config, width, height)
        raise RuntimeError(
            "TerryDirector 当前测试版已完成节点 UI、页内编辑器与工作流序列化，"
            "采样执行尚未接入。请先验证节点加载、编辑器保存/重载、复制节点隔离和 UI。"
            f" 当前编排：{info['clips']} 个片段，{info['seconds']:.2f}s，"
            f"外部目标尺寸 {info['width']}x{info['height']}，"
            f"二采方案 {info['second_pass']}。"
        )
