from __future__ import annotations

import torch

from comfy_api.latest import io


class TerryDirectorAssembleMedia(io.ComfyNode):
    """Internal timeline assembly: remove overlap head, insert gaps, append AV media."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorAssembleMedia",
            display_name="TerryDirector Assemble Media (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Image.Input("images"),
                io.Audio.Input("audio"),
                io.Int.Input("gap_frames", min=0),
                io.Int.Input("gap_after_frames", min=0),
                io.Int.Input("trim_head_frames", min=0),
                io.Int.Input("fps", min=1),
                io.Image.Input("accumulated_images", optional=True),
                io.Audio.Input("accumulated_audio", optional=True),
            ],
            outputs=[
                io.Image.Output(),
                io.Audio.Output(),
            ],
        )

    @classmethod
    def execute(
        cls,
        images,
        audio,
        gap_frames,
        gap_after_frames,
        trim_head_frames,
        fps,
        accumulated_images=None,
        accumulated_audio=None,
    ) -> io.NodeOutput:
        gap = int(gap_frames)
        gap_after = int(gap_after_frames)
        trim = int(trim_head_frames)
        fps = int(fps)
        if fps < 1:
            raise ValueError("TerryDirector assembly FPS must be positive")
        if trim < 0 or trim >= images.shape[0]:
            if trim:
                raise ValueError("TerryDirector overlap trim exceeds segment frame count")
            trim = 0

        current_images = images[trim:].clone()
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        trim_samples = round((trim / fps) * sample_rate)
        if trim_samples >= waveform.shape[-1]:
            raise ValueError("TerryDirector overlap trim exceeds segment audio duration")
        current_waveform = waveform[..., trim_samples:].clone()

        if gap:
            black = current_images.new_zeros(
                (gap, current_images.shape[1], current_images.shape[2], current_images.shape[3])
            )
            current_images = torch.cat((black, current_images), dim=0)
            silence = current_waveform.new_zeros(
                (*current_waveform.shape[:-1], round((gap / fps) * sample_rate))
            )
            current_waveform = torch.cat((silence, current_waveform), dim=-1)

        if accumulated_images is not None:
            if tuple(accumulated_images.shape[1:]) != tuple(current_images.shape[1:]):
                raise ValueError("TerryDirector assembled segments must share one image size")
            current_images = torch.cat((accumulated_images, current_images), dim=0)

        if accumulated_audio is not None:
            accumulated_rate = int(accumulated_audio["sample_rate"])
            if accumulated_rate != sample_rate:
                raise ValueError("TerryDirector assembled segments must share one audio sample rate")
            accumulated_waveform = accumulated_audio["waveform"]
            if accumulated_waveform.shape[:-1] != current_waveform.shape[:-1]:
                raise ValueError("TerryDirector assembled segments must share one audio channel layout")
            current_waveform = torch.cat((accumulated_waveform, current_waveform), dim=-1)

        if gap_after:
            black = current_images.new_zeros(
                (gap_after, current_images.shape[1], current_images.shape[2], current_images.shape[3])
            )
            current_images = torch.cat((current_images, black), dim=0)
            silence = current_waveform.new_zeros(
                (*current_waveform.shape[:-1], round((gap_after / fps) * sample_rate))
            )
            current_waveform = torch.cat((current_waveform, silence), dim=-1)

        return io.NodeOutput(
            current_images,
            {"waveform": current_waveform, "sample_rate": sample_rate},
        )



class TerryDirectorResampleReferenceVideo(io.ComfyNode):
    """Internal nearest-frame conversion of reference video batches to H3's 24 fps."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorResampleReferenceVideo",
            display_name="TerryDirector Resample Reference Video (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Image.Input("images"),
                io.Float.Input("source_fps", min=0.001),
                io.Float.Input("target_fps", default=24.0, min=0.001),
            ],
            outputs=[io.Image.Output()],
        )

    @classmethod
    def execute(cls, images, source_fps, target_fps=24.0) -> io.NodeOutput:
        source_fps = float(source_fps)
        target_fps = float(target_fps)
        if source_fps <= 0.0 or target_fps <= 0.0:
            raise ValueError("TerryDirector reference video FPS must be positive")
        count = int(images.shape[0])
        if count < 1:
            raise ValueError("TerryDirector reference video has no frames")
        target_count = max(1, round(count * target_fps / source_fps))
        positions = torch.arange(target_count, device=images.device, dtype=torch.float64)
        indices = torch.round(positions * source_fps / target_fps).to(torch.long)
        indices.clamp_(0, count - 1)
        return io.NodeOutput(images.index_select(0, indices))



class TerryDirectorLatentList(io.ComfyNode):
    """Internal container used to expose segment latents through a native list output."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.Autogrow.TemplatePrefix(
            io.Latent.Input("latent"),
            prefix="latent_",
            min=1,
            max=64,
        )
        return io.Schema(
            node_id="TerryDirectorLatentList",
            display_name="TerryDirector Latent List (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[io.Autogrow.Input("latents", template=template)],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def execute(cls, latents) -> io.NodeOutput:
        return io.NodeOutput(list(latents.values()))
