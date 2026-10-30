"""TerryDirector-owned H3 previews, independent of KJNodes' websocket MP4.

The live model wrapper transports self-contained JPEG/animated WebP. At the
SelfLift pause boundary, a fresh *ordinary* H.264 MP4 is encoded from low_clean
latents directly on the server, not copied from an in-browser stream.

Original implementation using ComfyUI's built-in TAESD layer primitives.
KJNodes is an architectural reference, not a vendored runtime dependency.
"""
from __future__ import annotations

import base64
import io as bytes_io
import logging
import math
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

import torch
from comfy_api.latest import io
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

LOG = logging.getLogger(__name__)


def tiny_vae_choices() -> list[str]:
    import folder_paths
    try:
        return ["none", *folder_paths.get_filename_list("vae_approx")]
    except Exception:
        return ["none"]


def default_tiny_vae() -> str:
    choices = tiny_vae_choices()
    return "taeh3.safetensors" if "taeh3.safetensors" in choices else "none"


def _decoder(name: str):
    """Construct a 2-D TAESD decoder from its actual indexed layer weights."""
    import comfy.model_management as mm
    import comfy.utils
    import folder_paths
    from comfy.taesd.taesd import Block, Clamp, conv

    if name not in tiny_vae_choices() or name == "none":
        raise ValueError("请选择已安装的 taeh3.safetensors 小型预览 VAE")
    path = folder_paths.get_full_path("vae_approx", name)
    if not path:
        raise FileNotFoundError("找不到预览 VAE：" + name)
    source = comfy.utils.load_torch_file(path, safe_load=True)
    indexed = {}
    for original, tensor in source.items():
        parts = original.split(".")
        if not parts[0].isdigit():
            parts = parts[1:]
        if parts and parts[0].isdigit():
            indexed[".".join(parts)] = tensor
    if not indexed:
        raise ValueError("预览 VAE 不包含支持的 2-D TAESD 解码器参数")

    numbered = {}
    for key in indexed:
        head, _, suffix = key.partition(".")
        numbered.setdefault(int(head), set()).add(suffix)
    layers = []
    for i in range(max(numbered) + 1):
        fields = numbered.get(i)
        if fields is None:
            layers.append(Clamp() if i == 0 else nn.ReLU() if i == 2
                          else nn.Upsample(scale_factor=2))
        elif "conv.0.weight" in fields:
            weight = indexed[f"{i}.conv.0.weight"]
            if "pool.0.weight" in fields:
                layers.append(Block(weight.shape[1], weight.shape[0], use_midblock_gn=True))
            else:
                layers.append(Block(weight.shape[1], weight.shape[0]))
        elif "weight" in fields:
            weight = indexed[f"{i}.weight"]
            layers.append(conv(weight.shape[1], weight.shape[0], bias="bias" in fields))
        else:
            raise ValueError(f"预览 VAE 第 {i} 层无法识别")
    model = nn.Sequential(*layers)
    model.load_state_dict(indexed, strict=True)
    device = mm.vae_device()
    dtype = torch.float16 if torch.device(device).type == "cuda" else torch.float32
    model = model.eval().to(device=device, dtype=dtype)
    channels = next(m.in_channels for m in model.modules() if isinstance(m, nn.Conv2d))
    upscales = sum(isinstance(m, nn.Upsample) for m in model.modules())
    return model, device, dtype, channels, 2 ** upscales


def _indices(count: int, limit: int) -> list[int]:
    if count <= 0:
        return []
    n = min(count, max(1, int(limit)))
    if n == 1:
        return [0]
    return [round(i * (count - 1) / (n - 1)) for i in range(n)]


def _video_latent(value, shapes=None):
    """Accept H3's ordinary 5-D tensor or its sampler-packed 3-D video stream."""
    if not isinstance(value, torch.Tensor):
        raise ValueError("H3 视频 latent 不是 Tensor")
    if value.ndim == 5:
        return value
    if value.ndim == 3 and shapes:
        shape = shapes[0]
        if len(shape) == 5:
            count = math.prod(int(v) for v in shape[1:])
            if value.shape[-1] >= count:
                return value[:, :, :count].reshape((value.shape[0], *map(int, shape[1:])))
    raise ValueError("H3 预览需要 5-D 视频 latent")


def _frames(video, decoder, *, max_frames: int, max_resolution: int):
    model, device, dtype, channels, factor = decoder
    if video.ndim != 5 or video.shape[0] != 1 or video.shape[1] != channels:
        raise ValueError("TAEH3 通道数与低清视频 latent 不匹配")
    idx = _indices(video.shape[2], max_frames)
    if not idx:
        raise ValueError("低清预览没有视频帧")
    outputs = []
    with torch.inference_mode():
        for t in idx:
            frame = video[0, :, t].unsqueeze(0).detach()
            edge = max(frame.shape[-2:])
            if max_resolution > 0 and edge * factor > max_resolution:
                ratio = max_resolution / (edge * factor)
                h = max(2, int(frame.shape[-2] * ratio))
                w = max(2, int(frame.shape[-1] * ratio))
                frame = F.interpolate(frame.float(), size=(h, w), mode="bilinear",
                                      align_corners=False)
            result = model(frame.to(device=device, dtype=dtype))[0]
            rgb = result.float().clamp_(0, 1).mul_(255).to(torch.uint8)
            rgb = rgb.permute(1, 2, 0).contiguous().cpu().numpy()
            outputs.append(Image.fromarray(rgb, "RGB"))
    return outputs


def _live_payload(frames, fps):
    buff = bytes_io.BytesIO()
    if len(frames) == 1:
        frames[0].save(buff, format="JPEG", quality=78)
        mime = "image/jpeg"
    else:
        frames[0].save(buff, format="WEBP", save_all=True,
                       append_images=frames[1:], duration=max(20, round(1000 / fps)),
                       loop=0, quality=72, method=0)
        mime = "image/webp"
    return mime, base64.b64encode(buff.getvalue()).decode("ascii")


def _encode_final(frames: list[Image.Image], destination: Path, seconds: float) -> None:
    """Encode a complete MP4 from raw RGB; never construct a fragmented MP4."""
    from .director_preview_mp4 import _ffmpeg, _verify_video, _video_duration

    if not 4 <= seconds <= 20 or not frames:
        raise ValueError("预览时长应为 4–20 秒，且必须有视频帧")
    width, height = frames[0].size
    width &= ~1
    height &= ~1
    if width < 2 or height < 2:
        raise ValueError("视频尺寸过小")
    rate = Fraction(len(frames), 1) / Fraction(str(seconds))
    cmd = [
        _ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-xerror", "-y",
        "-f", "rawvideo", "-pixel_format", "rgb24",
        "-video_size", f"{width}x{height}", "-framerate", str(rate),
        "-i", "-", "-an", "-r", "12", "-t", str(seconds),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        "-f", "mp4", str(destination),
    ]
    rgb = b"".join((f.crop((0, 0, width, height)) if f.size != (width, height)
                    else f).convert("RGB").tobytes() for f in frames)
    try:
        result = subprocess.run(cmd, input=rgb, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=False, timeout=100)
    except subprocess.TimeoutExpired as exc:
        raise ValueError("TerryDirector 原生预览编码超时") from exc
    if result.returncode != 0:
        raise ValueError("原生预览编码失败：" +
                         result.stderr.decode("utf-8", "replace")[-600:])
    _verify_video(destination, _ffmpeg())
    actual = _video_duration(destination, _ffmpeg())
    if actual is None or abs(actual - seconds) > 0.6:
        raise ValueError(f"原生预览时长异常：预期 {seconds:.2f}s，实际 {actual}s")


def save_native_preview(checkpoint_id: str, low_clean: dict, *,
                        tiny_vae: str, duration_seconds: float, max_resolution=768):
    """Capture the complete temporal span at the pause boundary (server-side)."""
    from .director_selflift_task_store import checkpoint_dir
    folder = checkpoint_dir(checkpoint_id)
    samples = low_clean.get("samples") if isinstance(low_clean, dict) else None
    if not getattr(samples, "is_nested", False):
        raise ValueError("原生预览需要 H3 NestedTensor 低清视频流")
    video = list(samples.unbind())[0]
    decoder = _decoder(tiny_vae)
    try:
        frames = _frames(video, decoder, max_frames=72,
                         max_resolution=max_resolution)
    finally:
        del decoder
    with tempfile.TemporaryDirectory(prefix=".td_native_preview_", dir=folder) as tmp:
        staged = Path(tmp) / "complete.mp4"
        _encode_final(frames, staged, float(duration_seconds))
        staged.replace(folder / "sampling_preview.mp4")
    LOG.info("[TerryDirector] 原生低清预览已保存：%s, %.1fs, %d sampled frames",
             checkpoint_id, duration_seconds, len(frames))
    return "sampling_preview.mp4"


class _LivePreviewWrapper:
    def __init__(self, node_id, tiny_vae, frame_limit, fps, max_resolution):
        self.node_id = str(node_id)
        self.tiny_vae = tiny_vae
        self.frame_limit = frame_limit
        self.fps = fps
        self.max_resolution = max_resolution

    def __call__(self, executor, noise, latent_image, sampler, sigmas,
                 denoise_mask, callback, disable_pbar, seed, latent_shapes):
        from server import PromptServer

        decoder = _decoder(self.tiny_vae)
        thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="td_h3_preview")
        task = None

        def publish(x0, step, total):
            try:
                video = _video_latent(x0, latent_shapes)
                images = _frames(video, decoder, max_frames=self.frame_limit,
                                 max_resolution=self.max_resolution)
                mime, image = _live_payload(images, self.fps)
                PromptServer.instance.send_sync("terrydirector_preview", {
                    "node_id": self.node_id, "image": image, "mime": mime,
                    "step": step, "total": total,
                }, PromptServer.instance.client_id)
            except Exception:
                LOG.exception("[TerryDirector] 原生实时预览编码失败")

        def capture(step, x0, x, total):
            nonlocal task
            if task is None or task.done():
                # Clone to CPU before the sampler reuses its latent buffer.
                # The bounded worker prevents CPU/GPU previews piling up.
                try:
                    video = _video_latent(x0, latent_shapes)
                    task = thread.submit(publish, video.detach().cpu().clone(),
                                         step + 1, total)
                except Exception:
                    LOG.exception("[TerryDirector] 无法读取实时预览 latent")
            if callback is not None:
                callback(step, x0, x, total)

        try:
            return executor(noise, latent_image, sampler, sigmas, denoise_mask,
                            capture, disable_pbar, seed, latent_shapes=latent_shapes)
        finally:
            thread.shutdown(wait=True)
            del decoder


class TerryDirectorH3Preview(io.ComfyNode):
    """Registered as a ComfyUI V3 node by TerryDirectorExtension."""

    @classmethod
    def define_schema(cls):
        from comfy_api.latest import io
        choices = tiny_vae_choices()
        return io.Schema(
            node_id="TerryDirectorH3Preview",
            display_name="TerryDirector H3 采样预览",
            category="TerryDirector/SelfLift",
            description="原生 TAEH3 实时预览：无 KJNodes 依赖，WebP/JPEG 传输，最终 MP4 由暂停节点直接保存。",
            inputs=[
                io.Model.Input("model"),
                io.Combo.Input("tiny_vae", options=choices, default=default_tiny_vae()),
                io.Int.Input("preview_frames", default=6, min=1, max=48),
                io.Int.Input("preview_fps", default=12, min=1, max=60),
                io.Int.Input("max_resolution", default=768, min=256, max=2048),
            ],
            outputs=[io.Model.Output()],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def execute(cls, model, tiny_vae, preview_frames, preview_fps, max_resolution):
        import comfy.patcher_extension
        from comfy_api.latest import io
        dynprompt = cls.hidden.dynprompt
        node_id = dynprompt.get_display_node_id(cls.hidden.unique_id) if dynprompt else cls.hidden.unique_id
        result = model.clone()
        result.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
            "terrydirector_h3_preview",
            _LivePreviewWrapper(node_id, tiny_vae, int(preview_frames),
                                int(preview_fps), int(max_resolution)),
        )
        return io.NodeOutput(result)
