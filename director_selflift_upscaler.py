"""H3 3D latent-upscaler inference, owned by TerryDirector.

The layer names are the public checkpoint format, not a custom-node dependency.
Release implementation context and verified baseline: docs/ARCHITECTURE.md and docs/STABLE_BASELINES.md.
"""
from __future__ import annotations

import logging
import os
from pathlib import PurePosixPath
import re
import threading
from time import perf_counter

import torch
from torch import nn
from torch.nn import functional as F

FOLDER = "latent_upscale_models"
_LOCK = threading.RLock()
_CACHE = None


def list_models():
    import folder_paths
    if FOLDER not in folder_paths.folder_names_and_paths:
        folder_paths.add_model_folder_path(FOLDER, os.path.join(folder_paths.models_dir, FOLDER))
    return sorted(set(folder_paths.get_filename_list(FOLDER)))


def _conv(weight, *, groups=1):
    out_channels, input_per_group, *kernel = weight.shape
    return nn.Conv3d(input_per_group * groups, out_channels, tuple(kernel),
                     padding=tuple(k // 2 for k in kernel), groups=groups)


def _norm(channels):
    if channels % 32:
        raise ValueError("H3 latent upscaler expects channel counts divisible by 32")
    return nn.GroupNorm(32, channels)


class _Residual(nn.Module):
    def __init__(self, state, prefix):
        super().__init__()
        conv = state[prefix + "in_layers.2.weight"]
        channels, input_channels = conv.shape[:2]
        self.in_layers = nn.Sequential(_norm(input_channels), nn.SiLU(), _conv(conv))
        emb = state[prefix + "emb_layers.1.weight"]
        self.emb_layers = nn.Sequential(nn.SiLU(), nn.Linear(emb.shape[1], emb.shape[0]))
        self.out_norm = _norm(channels)
        # Dropout is an identity during inference; index 2 is part of the format.
        self.out_layers = nn.Sequential(nn.SiLU(), nn.Identity(), _conv(state[prefix + "out_layers.2.weight"]))
        self.skip = _conv(state[prefix + "skip.weight"]) if prefix + "skip.weight" in state else nn.Identity()

    def forward(self, value, embedding):
        scale, shift = self.emb_layers(embedding).chunk(2, dim=-1)
        hidden = self.out_norm(self.in_layers(value))
        hidden = hidden * (1 + scale[:, :, None, None, None]) + shift[:, :, None, None, None]
        return self.skip(value) + self.out_layers(hidden)


class _Temporal(nn.Module):
    def __init__(self, state, prefix):
        super().__init__()
        weight = state[prefix + "dwconv.weight"]
        self.norm = _norm(weight.shape[0])
        self.dwconv = _conv(weight, groups=weight.shape[0])
        self.pwconv = _conv(state[prefix + "pwconv.weight"])

    def forward(self, value):
        return value + self.pwconv(self.dwconv(F.silu(self.norm(value))))


class _Attention(nn.Module):
    def __init__(self, state, prefix):
        super().__init__()
        self.norm = _norm(state[prefix + "q.weight"].shape[0])
        for name in ("q", "k", "v", "proj_out"):
            setattr(self, name, _conv(state[prefix + name + ".weight"]))

    def forward(self, value):
        hidden = self.norm(value)
        q, k, v = [getattr(self, name)(hidden).flatten(2).transpose(1, 2).unsqueeze(1) for name in ("q", "k", "v")]
        attended = F.scaled_dot_product_attention(q, k, v).squeeze(1).transpose(1, 2).reshape_as(value)
        return value + self.proj_out(attended)


class H3LatentUpscaler(nn.Module):
    """Build the exact inference layer layout described by a checkpoint's keys."""
    def __init__(self, state):
        super().__init__()
        self.conv_in = _conv(state["conv_in.weight"])
        self.conv_out = _conv(state["conv_out.weight"])
        e0, e2 = state["embed.0.weight"], state["embed.2.weight"]
        self.embed = nn.Sequential(nn.Linear(e0.shape[1], e0.shape[0]), nn.SiLU(), nn.Linear(e2.shape[1], e2.shape[0]))
        self.norm_out = _norm(state["norm_out.weight"].numel())
        for name in ("in_blocks", "out_blocks"):
            ids = sorted({int(m.group(1)) for key in state if (m := re.match(rf"{name}\.(\d+)\.", key))})
            if not ids or ids != list(range(len(ids))):
                raise ValueError(f"H3 latent upscaler: missing or non-contiguous {name}")
            blocks = []
            for index in ids:
                prefix = f"{name}.{index}."
                if prefix + "in_layers.2.weight" in state:
                    block = _Residual(state, prefix)
                elif prefix + "dwconv.weight" in state:
                    block = _Temporal(state, prefix)
                elif prefix + "q.weight" in state:
                    block = _Attention(state, prefix)
                else:
                    raise ValueError(f"H3 latent upscaler: unknown block {prefix}")
                blocks.append(block)
            setattr(self, name, nn.ModuleList(blocks))
        kernels = [m.dwconv.kernel_size[0] for m in self.modules() if isinstance(m, _Temporal)]
        self.halo = max(kernels, default=0)

    def _window(self, value, target, scale):
        scale_input = torch.full((value.shape[0], 1), scale - 1, device=value.device, dtype=value.dtype)
        embedding = self.embed(scale_input)
        hidden = self.conv_in(value)
        for layer in self.in_blocks:
            hidden = layer(hidden, embedding) if isinstance(layer, _Residual) else layer(hidden)
        hidden = F.interpolate(hidden, size=(value.shape[2], *target), mode="trilinear", align_corners=False)
        for layer in self.out_blocks:
            hidden = layer(hidden, embedding) if isinstance(layer, _Residual) else layer(hidden)
        return self.conv_out(F.silu(self.norm_out(hidden)))

    def forward(self, value, target, *, interrupt=lambda: None):
        if tuple(value.shape[-2:]) == tuple(target):
            return value
        scale = sum(t / s for t, s in zip(target, value.shape[-2:])) / 2
        frames, chunk, halo = value.shape[2], 32, self.halo
        if frames <= chunk:
            interrupt()
            logging.info("[TerryDirector SelfLift upscaler] 开始单窗口 3D 推理 frames=%d", frames)
            window_at = perf_counter()
            result = self._window(value, target, scale)
            if result.is_cuda:
                torch.cuda.synchronize(result.device)
            logging.info("[TerryDirector SelfLift upscaler] 单窗口 3D 推理完成 %.1fs",
                         perf_counter() - window_at)
            return result
        # Temporal windows keep output length unchanged. Overlapping predictions
        # are feathered; this is not claimed to equal an unchunked forward pass.
        padded = F.pad(value, (0, 0, 0, 0, halo, halo), mode="replicate") if halo else value
        output = value.new_zeros((*value.shape[:3], *target))
        weight_sum = value.new_zeros((1, 1, frames, 1, 1))
        window_count = (frames + chunk - 1) // chunk
        for window_index, start in enumerate(range(0, frames, chunk), 1):
            interrupt()
            stop = min(frames, start + chunk)
            logging.info("[TerryDirector SelfLift upscaler] 开始 3D 推理窗口 %d/%d frames=%d:%d",
                         window_index, window_count, start, stop)
            window_at = perf_counter()
            left, right = max(0, start - halo), min(frames, stop + halo)
            prediction = self._window(padded[:, :, left:right + 2 * halo].contiguous(), target, scale)
            if prediction.is_cuda:
                torch.cuda.synchronize(prediction.device)
            logging.info("[TerryDirector SelfLift upscaler] 完成 3D 推理窗口 %d/%d %.1fs",
                         window_index, window_count, perf_counter() - window_at)
            prediction = prediction[:, :, halo:halo + right - left]
            weights = value.new_ones(right - left)
            before, after = start - left, right - stop
            if before:
                weights[:before] = torch.linspace(0, 1, before + 2, device=value.device, dtype=value.dtype)[1:-1]
            if after:
                weights[-after:] = torch.linspace(1, 0, after + 2, device=value.device, dtype=value.dtype)[1:-1]
            weights = weights[None, None, :, None, None]
            output[:, :, left:right] += prediction * weights
            weight_sum[:, :, left:right] += weights
        return output / weight_sum.clamp_min(1e-8)


def _state_dict(raw, device):
    raw = raw.get("model", raw)
    if any(k.startswith("upscaler.") for k in raw):
        raw = {k.removeprefix("upscaler."): v for k, v in raw.items() if k.startswith("upscaler.")}
    if "conv_in.weight" not in raw:
        raise ValueError("TerryDirector SelfLift: 文件不是支持的 H3 3D latent upscaler")
    dtype = raw["conv_in.weight"].dtype
    if str(dtype).startswith("torch.float8_"):
        dtype = torch.bfloat16 if any(v.dtype == torch.bfloat16 for v in raw.values()) else torch.float16
    if dtype not in (torch.float16, torch.bfloat16, torch.float32, torch.float64):
        raise ValueError(f"TerryDirector SelfLift: 不支持放大权重类型 {dtype}")
    if torch.device(device).type == "cpu":
        dtype = torch.float32
    return {k: v.to(dtype=dtype) if v.is_floating_point() else v for k, v in raw.items()}


def _load(model_name, device):
    global _CACHE
    import comfy.model_management as mm
    import comfy.model_patcher
    import comfy.utils
    import folder_paths
    list_models()  # Register our folder even when the reference plugin is absent.
    name = str(model_name).replace("\\", "/")
    path_parts = PurePosixPath(name)
    if path_parts.is_absolute() or ".." in path_parts.parts or ":" in name:
        raise ValueError("TerryDirector SelfLift: 放大模型必须来自模型目录")
    path = folder_paths.get_full_path(FOLDER, name)
    if not path or not os.path.isfile(path):
        raise FileNotFoundError(f"找不到 H3 latent upscaler：{model_name}；目录 models/{FOLDER}/")
    stat = os.stat(path)
    key = (path, stat.st_mtime_ns, stat.st_size, str(device))
    if _CACHE is not None and _CACHE[0] == key:
        logging.info("[TerryDirector SelfLift upscaler] 命中放大器权重缓存")
        return _CACHE[1]
    logging.info("[TerryDirector SelfLift upscaler] 开始从磁盘读取放大器权重：%s", name)
    load_at = perf_counter()
    state = _state_dict(comfy.utils.load_torch_file(path, safe_load=True), device)
    logging.info("[TerryDirector SelfLift upscaler] 磁盘读取完成 %.1fs；权重项=%d",
                 perf_counter() - load_at, len(state))
    with torch.device("meta"):
        network = H3LatentUpscaler(state)
    network.load_state_dict(state, strict=True, assign=True)
    network.eval().requires_grad_(False)
    logging.info("[TerryDirector SelfLift upscaler] 网络实例化完成；开始创建 CoreModelPatcher")
    patcher = comfy.model_patcher.CoreModelPatcher(network, load_device=device, offload_device=torch.device("cpu"))
    _CACHE = key, patcher
    return patcher


def _offload_owned(patcher):
    """Targeted unload through ComfyUI 0.39's LoadedModel lifecycle."""
    import comfy.model_management as mm
    found = False
    for index in range(len(mm.current_loaded_models) - 1, -1, -1):
        loaded = mm.current_loaded_models[index]
        if loaded is not None and loaded.model is patcher:
            loaded.model_unload()
            mm.current_loaded_models.pop(index)
            found = True
    if not found:
        # load_models_gpu can fail before it appends a LoadedModel record.
        # Release this partially loaded, privately owned patcher as well.
        patcher.detach()


def learned_lift(video, target, model_name):
    import comfy.model_management as mm
    from comfy.ldm.minimax.vae import LATENTS_MEAN, LATENTS_STD
    if tuple(video.shape[-2:]) == tuple(target):
        return video
    if video.shape[1] != len(LATENTS_MEAN):
        raise ValueError("TerryDirector SelfLift: 放大器需要 H3 视频 latent 通道数")
    device = mm.get_torch_device()
    with _LOCK, torch.no_grad():
        patcher = _load(model_name, device)
        network = patcher.model
        if network.conv_in.in_channels != video.shape[1] or network.conv_out.out_channels != video.shape[1]:
            raise ValueError("TerryDirector SelfLift: 放大器权重与 H3 视频通道不匹配")
        temporal_work = video.shape[2] if video.shape[2] <= 32 else min(video.shape[2] + 2 * network.halo, 32 + 4 * network.halo)
        workspace = video.shape[0] * network.conv_in.out_channels * temporal_work * target[0] * target[1] * network.conv_in.weight.element_size() * 8
        logging.info("[TerryDirector SelfLift] upscaler=%s low=%s target=%s workspace_estimate=%.1f MiB", model_name, tuple(video.shape), target, workspace / 2**20)
        try:
            if device.type == "cuda":
                available, total = torch.cuda.mem_get_info(device)
                logging.info("[TerryDirector SelfLift upscaler] 准备加载模型 GPU free=%.1f GiB total=%.1f GiB "
                             "torch_allocated=%.1f GiB torch_reserved=%.1f GiB",
                             available / 2**30, total / 2**30,
                             torch.cuda.memory_allocated(device) / 2**30,
                             torch.cuda.memory_reserved(device) / 2**30)
            logging.info("[TerryDirector SelfLift upscaler] 开始 ComfyUI 动态显存加载；"
                         "需要工作空间 %.1f MiB", workspace / 2**20)
            load_at = perf_counter()
            mm.load_models_gpu([patcher], memory_required=workspace)
            logging.info("[TerryDirector SelfLift upscaler] 动态显存加载完成 %.1fs",
                         perf_counter() - load_at)
            dtype = network.conv_in.weight.dtype
            mean = torch.tensor(LATENTS_MEAN, device=device, dtype=dtype)[None, :, None, None, None]
            std = torch.tensor(LATENTS_STD, device=device, dtype=dtype)[None, :, None, None, None]
            normalized = (video.to(device=device, dtype=dtype) - mean) / std
            logging.info("[TerryDirector SelfLift upscaler] 开始 3D 网络推理 input=%s dtype=%s",
                         tuple(normalized.shape), dtype)
            infer_at = perf_counter()
            lifted = network(normalized, target, interrupt=mm.throw_exception_if_processing_interrupted)
            result = (lifted * std + mean).float().to(mm.intermediate_device())
            logging.info("[TerryDirector SelfLift upscaler] 3D 推理和输出转移完成 %.1fs",
                         perf_counter() - infer_at)
            return result
        finally:
            # Only our lifter is offloaded. Never unload the user's entire model set.
            logging.info("[TerryDirector SelfLift upscaler] 开始释放自身模型权重")
            offload_at = perf_counter()
            _offload_owned(patcher)
            logging.info("[TerryDirector SelfLift upscaler] 权重卸载完成 %.1fs",
                         perf_counter() - offload_at)
