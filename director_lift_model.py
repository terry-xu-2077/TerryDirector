"""Local inference adapter for the H3 3D latent-upscaler checkpoint format.

The checkpoint's layer/key protocol is the interoperability target. Execution is
implemented here using PyTorch functional operations, not imported model classes
from any custom-node package. Reference and scope: docs/30_SELFLIFT_INTERNAL.md.
"""
from __future__ import annotations

from functools import lru_cache
import logging
import os
import re

import torch
from torch import nn
import torch.nn.functional as F

FOLDER = "latent_upscale_models"
LOG = logging.getLogger(__name__)


def register_model_folder():
    import folder_paths
    if FOLDER not in folder_paths.folder_names_and_paths:
        folder_paths.add_model_folder_path(FOLDER, os.path.join(folder_paths.models_dir, FOLDER))
    paths, extensions = folder_paths.folder_names_and_paths[FOLDER]
    folder_paths.folder_names_and_paths[FOLDER] = (paths, set(extensions) | {".safetensors", ".pth"})


def model_names():
    import folder_paths
    register_model_folder()
    return ["none", *folder_paths.get_filename_list(FOLDER)]


class H3LiftWeights(nn.Module):
    """Checkpoint-driven evaluator: no training initialization or guessed block counts."""
    def __init__(self, state):
        super().__init__()
        required = {"conv_in.weight", "conv_in.bias", "conv_out.weight", "conv_out.bias",
                    "embed.0.weight", "embed.0.bias", "embed.2.weight", "embed.2.bias",
                    "norm_out.weight", "norm_out.bias"}
        if not required.issubset(state):
            raise ValueError(f"H3 放大模型缺少权重: {sorted(required.difference(state))}")
        if state["conv_in.weight"].ndim != 5:
            raise ValueError("仅支持 H3 3D Latent Upscaler，不支持图像像素放大模型")
        self.paths = set(state)
        if any("__" in key for key in state):
            raise ValueError("H3 放大模型包含无法识别的权重键")
        self.weights = nn.ParameterDict({key.replace(".", "__"): nn.Parameter(value, requires_grad=False)
                                         for key, value in state.items()})
        self.channels = int(state["conv_in.weight"].shape[0])
        self.latent_channels = int(state["conv_in.weight"].shape[1])
        if self.channels % 32:
            raise ValueError("H3 放大模型的隐藏通道必须是 32 的倍数")
        self.stages = []
        self.halo = 0
        used = set(required)
        for stage in ("in_blocks", "out_blocks"):
            ids = sorted({int(match.group(1)) for key in state
                          if (match := re.match(rf"{stage}\.(\d+)\.", key))})
            if not ids or ids != list(range(len(ids))):
                raise ValueError(f"H3 放大模型 {stage} 索引必须连续且非空")
            blocks = []
            for index in ids:
                prefix = f"{stage}.{index}"
                local = {key[len(prefix) + 1:] for key in state if key.startswith(prefix + ".")}
                if "dwconv.weight" in local:
                    kind = "temporal"
                    layers = ("norm", "dwconv", "pwconv")
                    self.halo = max(self.halo, int(state[prefix + ".dwconv.weight"].shape[2]))
                elif "q.weight" in local:
                    kind = "attention"
                    layers = ("norm", "q", "k", "v", "proj_out")
                elif "in_layers.2.weight" in local:
                    kind = "residual"
                    layers = ("in_layers.0", "in_layers.2", "emb_layers.1", "out_norm", "out_layers.2")
                    if "skip.weight" in local:
                        layers += ("skip",)
                else:
                    raise ValueError(f"H3 放大模型含不支持的 block: {prefix}")
                expected = {f"{layer}.{suffix}" for layer in layers for suffix in ("weight", "bias")}
                if local != expected:
                    raise ValueError(f"H3 放大模型 block 权重不匹配: {prefix}: {sorted(local ^ expected)}")
                used.update(prefix + "." + name for name in expected)
                blocks.append((prefix, kind))
            self.stages.append(blocks)
        if used != self.paths:
            raise ValueError(f"H3 放大模型存在未使用权重: {sorted(self.paths - used)}")

    def weight(self, name):
        return self.weights[name.replace(".", "__")]

    def conv(self, name, value, groups=1):
        weight = self.weight(name + ".weight")
        return F.conv3d(value, weight, self.weight(name + ".bias"),
                        padding=tuple(int(k) // 2 for k in weight.shape[-3:]), groups=groups)

    def norm(self, name, value):
        return F.group_norm(value, 32, self.weight(name + ".weight"), self.weight(name + ".bias"))

    def linear(self, name, value):
        return F.linear(value, self.weight(name + ".weight"), self.weight(name + ".bias"))

    def block(self, spec, value, embedding):
        prefix, kind = spec
        if kind == "temporal":
            hidden = F.silu(self.norm(prefix + ".norm", value))
            hidden = self.conv(prefix + ".dwconv", hidden, groups=hidden.shape[1])
            return value + self.conv(prefix + ".pwconv", hidden)
        if kind == "attention":
            hidden = self.norm(prefix + ".norm", value)
            q, k, v = [self.conv(prefix + "." + name, hidden).flatten(2).transpose(1, 2).unsqueeze(1)
                       for name in ("q", "k", "v")]
            attended = F.scaled_dot_product_attention(q, k, v).squeeze(1).transpose(1, 2).reshape_as(value)
            return value + self.conv(prefix + ".proj_out", attended)
        hidden = self.conv(prefix + ".in_layers.2", F.silu(self.norm(prefix + ".in_layers.0", value)))
        scale, shift = self.linear(prefix + ".emb_layers.1", F.silu(embedding)).chunk(2, dim=1)
        hidden = self.norm(prefix + ".out_norm", hidden) * (1 + scale[..., None, None, None]) + shift[..., None, None, None]
        residual = self.conv(prefix + ".skip", value) if prefix + ".skip.weight" in self.paths else value
        return residual + self.conv(prefix + ".out_layers.2", F.silu(hidden))

    def evaluate_window(self, value, size, scale):
        embedding = value.new_full((value.shape[0], 1), float(scale) - 1.0)
        embedding = self.linear("embed.2", F.silu(self.linear("embed.0", embedding)))
        hidden = self.conv("conv_in", value)
        for spec in self.stages[0]:
            hidden = self.block(spec, hidden, embedding)
        hidden = F.interpolate(hidden, size=(value.shape[2], *size), mode="trilinear", align_corners=False)
        for spec in self.stages[1]:
            hidden = self.block(spec, hidden, embedding)
        return self.conv("conv_out", F.silu(self.norm("norm_out", hidden)))

    def forward(self, value, size):
        if tuple(value.shape[-2:]) == tuple(size):
            return value
        scale = sum(float(a) / b for a, b in zip(size, value.shape[-2:])) / 2
        length = value.shape[2]
        if length <= 32:
            return self.evaluate_window(value, size, scale)
        halo = self.halo
        padded = F.pad(value, (0, 0, 0, 0, halo, halo), mode="replicate") if halo else value
        result = value.new_zeros((*value.shape[:3], *size))
        counts = value.new_zeros((1, 1, length, 1, 1))
        for core_start in range(0, length, 32):
            core_end = min(core_start + 32, length)
            start, end = max(0, core_start - halo), min(length, core_end + halo)
            window = padded[:, :, start:end + 2 * halo].contiguous()
            predicted = self.evaluate_window(window, size, scale)[:, :, halo:halo + end - start]
            weights = value.new_ones(end - start)
            left, right = core_start - start, end - core_end
            if left:
                weights[:left] = torch.arange(1, left + 1, device=value.device, dtype=value.dtype) / (left + 1)
            if right:
                weights[-right:] = torch.arange(right, 0, -1, device=value.device, dtype=value.dtype) / (right + 1)
            weights = weights.view(1, 1, -1, 1, 1)
            result[:, :, start:end] += predicted * weights
            counts[:, :, start:end] += weights
        return result / counts.clamp_min(1e-8)


@lru_cache(maxsize=1)
def _load(path, mtime_ns, file_size, device_string):
    import comfy.model_management as mm
    import comfy.model_patcher
    import comfy.utils
    state = comfy.utils.load_torch_file(path, safe_load=True)
    if "model" in state and isinstance(state["model"], dict):
        state = state["model"]
    if any(key.startswith("upscaler.") for key in state):
        state = {key[len("upscaler."):]: value for key, value in state.items() if key.startswith("upscaler.")}
    if "conv_in.weight" not in state:
        raise ValueError("不是有效的 H3 3D latent upscaler 权重")
    device = torch.device(device_string)
    dtype = state["conv_in.weight"].dtype
    if device.type == "cpu":
        dtype = torch.float32
    elif str(dtype).startswith("torch.float8"):
        dtype = torch.bfloat16 if any(t.dtype == torch.bfloat16 for t in state.values()) else torch.float16
    if dtype not in (torch.float16, torch.bfloat16, torch.float32, torch.float64):
        raise ValueError(f"不支持的 H3 放大模型权重类型: {dtype}")
    state = {key: tensor.to(dtype=dtype) for key, tensor in state.items()}
    network = H3LiftWeights(state).eval().requires_grad_(False)
    return comfy.model_patcher.CoreModelPatcher(network, load_device=device, offload_device=mm.unet_offload_device())


def lift_video(value, size, model_name):
    import folder_paths
    import comfy.model_management as mm
    from comfy.ldm.minimax.vae import LATENTS_MEAN, LATENTS_STD
    register_model_folder()
    path = folder_paths.get_full_path(FOLDER, model_name)
    if path is None or not os.path.isfile(path):
        raise FileNotFoundError(f"H3 Latent 放大模型不存在: {model_name}；目录为 models/{FOLDER}")
    if tuple(value.shape[-2:]) == tuple(size):
        return value.float()
    stat = os.stat(path)
    device = mm.get_torch_device()
    patcher = _load(path, stat.st_mtime_ns, stat.st_size, str(device))
    network = patcher.model
    dtype = network.weight("conv_in.weight").dtype
    if value.shape[1] != network.latent_channels or len(LATENTS_MEAN) != value.shape[1]:
        raise ValueError("H3 放大模型与视频 LATENT 的通道数不匹配")
    frames = value.shape[2] if value.shape[2] <= 32 else min(value.shape[2] + 2 * network.halo, 32 + 4 * network.halo)
    workspace = math_prod((value.shape[0], network.channels, frames, *size)) * torch.empty((), dtype=dtype).element_size() * 8
    LOG.info("[TerryDirector SelfLift] latent upscaler=%s target=%s estimated_workspace=%.1f MiB",
             model_name, size, workspace / 2**20)
    mm.load_models_gpu([patcher], memory_required=workspace)
    mean = torch.as_tensor(LATENTS_MEAN, device=device, dtype=dtype).view(1, -1, 1, 1, 1)
    std = torch.as_tensor(LATENTS_STD, device=device, dtype=dtype).view(1, -1, 1, 1, 1)
    with torch.no_grad():
        normalized = (value.to(device=device, dtype=dtype) - mean) / std
        result = network(normalized, tuple(size)) * std + mean
        return result.float().to(mm.intermediate_device())


def math_prod(values):
    result = 1
    for value in values:
        result *= int(value)
    return result
