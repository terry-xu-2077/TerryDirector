"""One node for low- and high-resolution H3 sampling."""
from __future__ import annotations

from comfy_api.latest import io

from .director_resolution_math import ASPECT_RATIO_OPTIONS, actual_megapixels, compute_resolution


class TerryDirectorDualSamplingResolutionSelector(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorDualSamplingResolutionSelector",
            display_name="TerryDirector 双采样分辨率选择器",
            category="TerryDirector/分辨率",
            description=(
                "将低清与高清采样分辨率集中到一个节点。两路百万像素输入独立计算，"
                "共用宽高比；尺寸向上取整到 32 的倍数，以适配 H3 空间网格。"
                "输出低清/高清各自的宽度、高度与取整后的实际百万像素。"
            ),
            inputs=[
                io.Combo.Input(
                    "aspect_ratio",
                    display_name="宽高比",
                    options=ASPECT_RATIO_OPTIONS,
                    default="16:9 (Widescreen)",
                    socketless=True,
                ),
                io.Float.Input(
                    "lowres_megapixels",
                    display_name="低清百万像素",
                    default=0.2,
                    min=0.01,
                    max=16.0,
                    step=0.05,
                    tooltip="连接低清阶段的目标百万像素值。",
                ),
                io.Float.Input(
                    "highres_megapixels",
                    display_name="高清百万像素",
                    default=2.0,
                    min=0.01,
                    max=16.0,
                    step=0.05,
                    tooltip="连接高清阶段的目标百万像素值。",
                ),
            ],
            outputs=[
                io.Int.Output("lowres_width", display_name="低清宽度"),
                io.Int.Output("lowres_height", display_name="低清高度"),
                io.Int.Output("highres_width", display_name="高清宽度"),
                io.Int.Output("highres_height", display_name="高清高度"),
                io.Float.Output("lowres_actual_megapixels", display_name="低清实际 MP"),
                io.Float.Output("highres_actual_megapixels", display_name="高清实际 MP"),
            ],
        )

    @classmethod
    def execute(
        cls,
        aspect_ratio="16:9 (Widescreen)",
        lowres_megapixels=0.2,
        highres_megapixels=2.0,
    ):
        low_width, low_height = compute_resolution(lowres_megapixels, aspect_ratio)
        high_width, high_height = compute_resolution(highres_megapixels, aspect_ratio)
        return io.NodeOutput(
            low_width,
            low_height,
            high_width,
            high_height,
            actual_megapixels(low_width, low_height),
            actual_megapixels(high_width, high_height),
        )
