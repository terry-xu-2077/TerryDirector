from __future__ import annotations

from comfy_api.latest import io

from .director_core import config_json, normalize_config, summary


class TerryDirector(io.ComfyNode):
    """Single visible TerryDirector node.

    This first implementation intentionally establishes the production node shell,
    serialized editor document, node-owned generation controls and final port contract.
    Sampling is enabled in the next implementation step after UI/persistence acceptance.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirector",
            display_name="TerryDirector",
            category="MiniMax H3/TerryDirector",
            description=(
                "MiniMax H3 multi-segment director. The node owns generation settings and opens "
                "an in-page editor for prompts, shared assets and the timeline."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae"),
                io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"),
                io.String.Input(
                    "config_json",
                    default=config_json(),
                    multiline=True,
                    dynamic_prompts=False,
                    tooltip="TerryDirector serialized node settings and creative arrangement. Managed by the custom UI.",
                ),
            ],
            outputs=[
                io.Latent.Output(display_name="分段潜变量", is_output_list=True),
                io.Image.Output(display_name="合并画面"),
                io.Audio.Output(display_name="合并音频"),
            ],
        )

    @classmethod
    def execute(cls, model, clip, vae, audio_vae, sampler, sigmas, config_json):
        config = normalize_config(config_json)
        info = summary(config)
        raise RuntimeError(
            "TerryDirector 当前测试版已完成节点 UI、页内编辑器与工作流序列化，"
            "采样执行尚未接入。请先验证节点加载、编辑器保存/重载、复制节点隔离和 UI。"
            f" 当前编排：{info['clips']} 个片段，{info['seconds']:.2f}s，"
            f"目标分辨率 {info['width']}x{info['height']}。"
        )
