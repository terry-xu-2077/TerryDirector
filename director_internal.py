from __future__ import annotations

import os
import re
import tempfile

import folder_paths
import torch

from comfy.cli_args import args
from comfy_api.latest import io, ui, Types

DirectorOutputData = io.Custom("TERRYDIRECTOR_OUTPUT")


class TerryDirectorPackOutput(io.ComfyNode):
    """Internal packer for the single TerryDirector public output socket."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.Autogrow.TemplatePrefix(
            io.Latent.Input("latent"),
            prefix="latent_",
            min=1,
            max=64,
        )
        return io.Schema(
            node_id="TerryDirectorPackOutput",
            display_name="TerryDirector Pack Output (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Autogrow.Input("latents", template=template),
                io.Image.Input("images"),
                io.Audio.Input("audio"),
            ],
            outputs=[DirectorOutputData.Output(display_name="导演输出")],
        )

    @classmethod
    def execute(cls, latents, images, audio) -> io.NodeOutput:
        return io.NodeOutput({
            "segment_latents": list(latents.values()),
            "images": images,
            "audio": audio,
        })



def _advanced_cache_path(cache_key: str, segment_id: str) -> str:
    safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cache_key or "default"))[:160]
    safe_segment = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(segment_id or "segment"))[:160]
    root = os.path.join(folder_paths.get_output_directory(), ".terrydirector_cache", safe_key)
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, f"{safe_segment}.pt")


def _cache_to_cpu(value):
    if isinstance(value, torch.Tensor):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: _cache_to_cpu(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_cache_to_cpu(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_cache_to_cpu(item) for item in value)
    return value


class TerryDirectorCacheLatent(io.ComfyNode):
    """Persist one sampled segment latent for Advanced local reruns."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorCacheLatent",
            display_name="TerryDirector Cache Latent (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Latent.Input("latent"),
                io.String.Input("cache_key"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
            ],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # This node has a deliberate disk side effect; never let Comfy skip it
        # when the sampled latent reaches this point.
        return float("NaN")

    @classmethod
    def execute(cls, latent, cache_key, segment_id, signature) -> io.NodeOutput:
        path = _advanced_cache_path(cache_key, segment_id)
        payload = {
            "version": 1,
            "signature": str(signature),
            "latent": _cache_to_cpu(latent),
        }
        fd, temp_path = tempfile.mkstemp(prefix="td_", suffix=".pt", dir=os.path.dirname(path))
        os.close(fd)
        try:
            torch.save(payload, temp_path)
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        print(f"[TerryDirector Advanced] Cached segment {segment_id}: {path}", flush=True)
        return io.NodeOutput(latent)


class TerryDirectorLoadCachedLatent(io.ComfyNode):
    """Load an existing sampled latent instead of re-running H3 sampling."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorLoadCachedLatent",
            display_name="TerryDirector Load Cached Latent (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.String.Input("cache_key"),
                io.String.Input("segment_id"),
                io.String.Input("signature"),
            ],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, cache_key, segment_id, signature, **kwargs):
        path = _advanced_cache_path(cache_key, segment_id)
        try:
            stat = os.stat(path)
            return f"{stat.st_mtime_ns}:{stat.st_size}:{signature}"
        except OSError:
            return float("NaN")

    @classmethod
    def execute(cls, cache_key, segment_id, signature) -> io.NodeOutput:
        path = _advanced_cache_path(cache_key, segment_id)
        if not os.path.isfile(path):
            raise RuntimeError(
                f"TerryDirector Advanced 找不到片段 {segment_id} 的缓存。"
                "请先完整生成一次，再使用局部重跑。"
            )
        payload = torch.load(path, map_location="cpu", weights_only=False)
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise RuntimeError(f"TerryDirector Advanced 片段 {segment_id} 缓存格式无效")
        if str(payload.get("signature")) != str(signature):
            raise RuntimeError(
                f"TerryDirector Advanced 片段 {segment_id} 的尺寸/时长已改变，"
                "请先完整生成一次刷新缓存。"
            )
        latent = payload.get("latent")
        if not isinstance(latent, dict) or "samples" not in latent:
            raise RuntimeError(f"TerryDirector Advanced 片段 {segment_id} 缓存缺少 LATENT")
        return io.NodeOutput(latent)


class TerryDirectorAdvancedFinish(io.ComfyNode):
    """Terminal Advanced step using ComfyUI 0.39.0 native SaveVideo semantics."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TerryDirectorAdvancedFinish",
            display_name="TerryDirector Advanced Finish (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                DirectorOutputData.Input("director_output"),
                io.Video.Input("video"),
                io.String.Input("filename_prefix"),
                io.String.Input("format"),
                io.String.Input("codec"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            outputs=[DirectorOutputData.Output(display_name="导演输出")],
        )

    @classmethod
    def execute(cls, director_output, video, filename_prefix, format, codec) -> io.NodeOutput:
        if video is None:
            raise RuntimeError("TerryDirector Advanced 视频创建失败，未保存")

        format_name = str(format or "auto")
        codec_name = str(codec or "auto")
        if format_name == "auto":
            format_name = "webm" if codec_name == "av1" else "mp4"

        width, height = video.get_dimensions()
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            str(filename_prefix),
            folder_paths.get_output_directory(),
            width,
            height,
        )

        saved_metadata = None
        if not args.disable_metadata:
            metadata = {}
            if cls.hidden.extra_pnginfo is not None:
                metadata.update(cls.hidden.extra_pnginfo)
            if cls.hidden.prompt is not None:
                metadata["prompt"] = cls.hidden.prompt
            if metadata:
                saved_metadata = metadata

        file = f"{filename}_{counter:05}_.{Types.VideoContainer.get_extension(format_name)}"
        output_path = os.path.join(full_output_folder, file)

        print(f"[TerryDirector Advanced] Saving video: {output_path}", flush=True)
        video.save_to(
            output_path,
            format=Types.VideoContainer(format_name),
            codec=Types.VideoCodec(codec_name),
            metadata=saved_metadata,
        )
        print("[TerryDirector Advanced] Native video save completed", flush=True)

        # Publish this as a normal video asset without PreviewVideo.
        # ComfyUI's task/assets system recognizes ResultItem lists under
        # "video", while the canvas' automatic preview path only consumes
        # output.images. TerryDirector therefore owns the only node preview.
        return io.NodeOutput(
            director_output,
            ui={
                "video": [
                    ui.SavedResult(file, subfolder, io.FolderType.output)
                ]
            },
        )


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
