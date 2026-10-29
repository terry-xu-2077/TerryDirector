"""Small, deterministic low-res review sink bound to a SelfLift checkpoint.

Unlike ComfyUI SaveVideo, it persists the decoded review movie directly next to
state.safetensors. The checkpoint_id dependency guarantees saving happens after
the pause node, without changing the checkpoint's blocked hi-res output.
"""
from __future__ import annotations

from comfy_api.latest import io

from .director_selflift_task_store import checkpoint_dir


class TerryDirectorLowresReviewSave(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorLowresReviewSave",
            display_name="TerryDirector 保存低清审片视频",
            category="TerryDirector/SelfLift",
            is_output_node=True,
            description="将 denoised_output 解码后的音视频存入本次检查点文件夹的 review.mp4；不参与高清采样。",
            inputs=[
                io.String.Input("checkpoint_id", display_name="检查点 ID"),
                io.Image.Input("images", display_name="低清已解码画面"),
                io.Audio.Input("audio", display_name="低清已解码音频"),
            ],
            outputs=[io.String.Output("path", display_name="低清视频路径")],
        )

    @classmethod
    def execute(cls, checkpoint_id, images, audio):
        from .director_loop_media import _write_clip, MP4
        folder = checkpoint_dir(str(checkpoint_id).strip())
        path = folder / "review.mp4"
        _write_clip(images, audio, output_path=path, format_name=MP4, frames=len(images))
        return io.NodeOutput(str(path))

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")
