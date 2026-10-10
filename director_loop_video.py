"""Lazy ComfyUI VIDEO backed by TerryDirector lossless per-segment .pt caches.

The only supported pre-save consumer is the official SaveVideo: its save_to()
reads one segment at a time and encodes once, without a full IMAGE/AUDIO tensor.
The file-backed VIDEO remains reusable after successful save.
"""
from __future__ import annotations

import gc
import json
import os
import shutil
from fractions import Fraction

import av
import numpy as np
import torch

import folder_paths
from comfy_api.latest import InputImpl, Types
from comfy_api.latest._input import VideoInput
from comfy_api.latest._input_impl.video_types import (
    BT2020_NCL,
    BT709_NCL,
    VIDEO_ENCODERS,
    set_video_color_properties,
    video_encoder_options,
    video_output_config,
)


class TerryDirectorStreamVideo(VideoInput):
    """A low-memory VIDEO object usable directly by ComfyUI's SaveVideo."""

    def __init__(self, descriptors, fps=24, bit_depth="auto", color_space="sRGB"):
        self._descriptors = [
            json.loads(item) if isinstance(item, str) else dict(item)
            for item in descriptors
        ]
        if not self._descriptors:
            raise ValueError("流式视频没有可用的片段缓存")
        self._fps = Fraction(int(fps), 1)
        self._color_space = str(color_space)
        if self._color_space not in ("sRGB", "HDR", "HDR PQ"):
            raise ValueError(f"不支持的视频色彩空间：{self._color_space}")
        self._bit_depth = (10 if self._color_space in ("HDR", "HDR PQ") else 8) \
            if str(bit_depth) == "auto" else int(bit_depth)
        if self._bit_depth not in (8, 10):
            raise ValueError("视频位深只支持 auto / 8 / 10")
        first = self._descriptors[0]
        self._width = int(first["width"])
        self._height = int(first["height"])
        self._sample_rate = int(first["sample_rate"])
        self._channels = int(first["audio_shape"][1])
        self._frames = sum(int(item["frames"]) for item in self._descriptors)
        self._saved_path = None
        for index, item in enumerate(self._descriptors):
            if (
                int(item["width"]) != self._width
                or int(item["height"]) != self._height
                or int(item["channels"]) != 3
                or int(item["sample_rate"]) != self._sample_rate
                or int(item["audio_shape"][1]) != self._channels
                or int(item["frames"]) < 1
                or not os.path.isfile(item["path"])
            ):
                raise ValueError(f"流式视频分段 {index + 1} 尺寸、音频或缓存文件不一致")
        if self._width < 2 or self._height < 2 or (self._width | self._height) & 1:
            raise ValueError("流式视频编码需要偶数宽高")
        if self._sample_rate < 1 or self._channels not in (1, 2, 6):
            raise ValueError("流式视频音频采样率或声道布局无效")

    def get_dimensions(self):
        return self._width, self._height

    def get_bit_depth(self):
        return self._bit_depth

    def get_color_space(self):
        return self._color_space

    def get_frame_count(self):
        return self._frames

    def get_frame_rate(self):
        return self._fps

    def get_duration(self):
        return float(Fraction(self._frames, 1) / self._fps)

    def _saved_video(self):
        if self._saved_path and os.path.isfile(self._saved_path):
            return InputImpl.VideoFromFile(self._saved_path)
        raise RuntimeError(
            "TerryDirector 流式 VIDEO 尚未保存；请直接连接官方 SaveVideo。"
            "视频裁剪、提取 IMAGE 等操作需要先完成保存。"
        )

    def get_stream_source(self):
        return self._saved_video().get_stream_source()

    def get_components(self):
        return self._saved_video().get_components()

    def as_trimmed(self, start_time=None, duration=None, strict_duration=False):
        return self._saved_video().as_trimmed(start_time, duration, strict_duration)

    def as_cropped(self, x=0, y=0, width=0, height=0):
        return self._saved_video().as_cropped(x, y, width, height)

    def _clear_lossless_cache(self):
        """Only delete our private per-run temp directory, never arbitrary paths."""
        temp_root = os.path.realpath(os.path.join(
            folder_paths.get_temp_directory(), "terrydirector_base"
        ))
        roots = {os.path.realpath(os.path.dirname(item["path"])) for item in self._descriptors}
        if len(roots) != 1:
            return
        root = roots.pop()
        common = os.path.commonpath((os.path.normcase(root), os.path.normcase(temp_root)))
        if common != os.path.normcase(temp_root) or root == temp_root:
            return
        shutil.rmtree(root, ignore_errors=True)

    def save_to(self, path, format=Types.VideoContainer.AUTO,
                codec=Types.VideoCodec.AUTO, metadata=None,
                bit_depth=None, crf=None, color_space=None, preset=None):
        if self._saved_path and os.path.isfile(self._saved_path):
            return self._saved_video().save_to(
                path, format=format, codec=codec, metadata=metadata,
                bit_depth=bit_depth, crf=crf, color_space=color_space,
                preset=preset,
            )

        depth = self._bit_depth if bit_depth is None else int(bit_depth)
        color = self._color_space if color_space is None else str(color_space)
        if depth not in (8, 10) or color not in ("sRGB", "HDR", "HDR PQ"):
            raise ValueError("无效的视频位深或色彩空间")
        open_kwargs, container, encoder = video_output_config(path, format, codec)
        pix_fmt = "yuv420p10le" if depth == 10 else "yuv420p"
        dst_color = BT2020_NCL if color in ("HDR", "HDR PQ") else BT709_NCL
        layout = {1: "mono", 2: "stereo", 6: "5.1"}[self._channels]
        audio_rate = 48000 if container == Types.VideoContainer.WEBM else self._sample_rate
        output = None
        frames_done = 0
        audio_pts = 0
        resampler = None
        try:
            output = av.open(path, **open_kwargs)
            if metadata:
                for key, value in metadata.items():
                    output.metadata[key] = value if isinstance(value, str) else json.dumps(value)

            vstream = output.add_stream(VIDEO_ENCODERS[encoder], rate=self._fps)
            vstream.width = self._width
            vstream.height = self._height
            vstream.pix_fmt = pix_fmt
            vstream.options = video_encoder_options(encoder, crf, preset)
            set_video_color_properties(vstream.codec_context, color)

            astream = output.add_stream(
                "libopus" if container == Types.VideoContainer.WEBM else "aac",
                rate=audio_rate, layout=layout,
            )
            if audio_rate != self._sample_rate:
                resampler = av.AudioResampler(format="fltp", layout=layout, rate=audio_rate)

            def encode_audio(frame):
                nonlocal audio_pts
                frame.pts = audio_pts
                frame.time_base = Fraction(1, audio_rate)
                frame.sample_rate = audio_rate
                audio_pts += frame.samples
                for packet in astream.encode(frame):
                    output.mux(packet)

            for index, descriptor in enumerate(self._descriptors):
                payload = torch.load(
                    str(descriptor["path"]), map_location="cpu", weights_only=False,
                )
                images = payload.get("images")
                audio = payload.get("audio")
                waveform = audio.get("waveform") if isinstance(audio, dict) else None
                if (
                    not isinstance(images, torch.Tensor)
                    or not isinstance(waveform, torch.Tensor)
                    or images.ndim != 4
                    or tuple(images.shape[1:]) != (self._height, self._width, 3)
                    or int(images.shape[0]) != int(descriptor["frames"])
                    or int(audio.get("sample_rate", -1)) != self._sample_rate
                    or waveform.ndim != 3
                    or waveform.shape[1] != self._channels
                ):
                    raise ValueError(f"流式视频分段 {index + 1} 缓存数据不一致")

                for tensor_frame in images:
                    if depth == 10:
                        pixels = (tensor_frame.float() * 65535).clamp(0, 65535)
                        pixels = pixels.to(dtype=torch.uint16).numpy()
                        frame = av.VideoFrame.from_ndarray(pixels, format="rgb48le")
                    else:
                        pixels = (tensor_frame * 255).clamp(0, 255).byte().numpy()
                        frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
                    frame = frame.reformat(format=pix_fmt, dst_colorspace=dst_color)
                    set_video_color_properties(frame, color)
                    for packet in vstream.encode(frame):
                        output.mux(packet)
                frames_done += int(images.shape[0])

                # Write audio per segment; unlike the previous Advanced helper,
                # do not retain an audio_parts list until the final segment.
                sample_data = waveform[0].float().cpu().contiguous().numpy()
                if sample_data.shape[-1]:
                    audio_frame = av.AudioFrame.from_ndarray(
                        sample_data, format="fltp", layout=layout,
                    )
                    audio_frame.sample_rate = self._sample_rate
                    audio_frame.time_base = Fraction(1, self._sample_rate)
                    audio_frame.pts = int(round((frames_done - len(images)) * self._sample_rate / float(self._fps)))
                    for output_frame in (
                        resampler.resample(audio_frame) if resampler else [audio_frame]
                    ):
                        encode_audio(output_frame)
                del payload, images, audio, waveform, sample_data

            if frames_done != self._frames:
                raise RuntimeError(f"流式视频输出帧数不匹配：{frames_done} != {self._frames}")
            for packet in vstream.encode(None):
                output.mux(packet)
            if resampler:
                for output_frame in resampler.resample(None):
                    encode_audio(output_frame)
            for packet in astream.encode(None):
                output.mux(packet)
            output.close()
            output = None
        except BaseException:
            if output is not None:
                output.close()
            if isinstance(path, (str, os.PathLike)) and os.path.isfile(path):
                os.remove(path)
            # Retain the lossless cache for debugging / retry.
            raise

        if isinstance(path, (str, os.PathLike)):
            self._saved_path = os.fspath(path)
            self._clear_lossless_cache()
        gc.collect()
        print(
            f"[TerryDirector Loop][Stream] Saved: "
            f"frames={frames_done} fps={float(self._fps):g} "
            f"size={self._width}x{self._height} path={path}",
            flush=True,
        )
