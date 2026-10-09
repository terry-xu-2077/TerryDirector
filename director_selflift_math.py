"""Tensor operations for TerryDirector's independent H3 SelfLift implementation.

Reference algorithm and checkpoint provenance: docs/30_SELFLIFT_INTERNAL.md.
This module has no ComfyUI or external custom-node imports.
"""
from __future__ import annotations

import math
import torch
from torch.nn import functional as F

ENGINE_ID = "terrydirector-selflift-v1"


def validate_schedule(sigmas: torch.Tensor, transition_step: int) -> None:
    if not isinstance(sigmas, torch.Tensor) or sigmas.ndim != 1 or not sigmas.is_floating_point():
        raise ValueError("TerryDirector SelfLift: SIGMAS 必须是一维浮点 Tensor")
    if sigmas.numel() < 3:
        raise ValueError("TerryDirector SelfLift: 日程至少需要低清、高清各一步")
    if not bool(torch.isfinite(sigmas).all()) or bool((sigmas < 0).any()):
        raise ValueError("TerryDirector SelfLift: Sigma 不能为负数、NaN 或无穷大")
    if bool((sigmas[1:] > sigmas[:-1]).any()) or bool((sigmas[:-1] <= 0).any()):
        raise ValueError("TerryDirector SelfLift: Sigma 必须递减，只有最后一项可以为零")
    if type(transition_step) is not int or not 1 <= transition_step < sigmas.numel() - 1:
        raise ValueError("TerryDirector SelfLift: 低清阶段步数必须保留至少一步高清采样")
    if float(sigmas[transition_step]) >= 1:
        raise ValueError("TerryDirector SelfLift: 高清起始 Sigma 必须小于 1")


def validate_options(cfg, lowres_scale, rho, w_min, w_max) -> None:
    values = (cfg, lowres_scale, rho, w_min, w_max)
    if not all(math.isfinite(float(v)) for v in values):
        raise ValueError("TerryDirector SelfLift: 参数必须是有限数值")
    if not 0 <= cfg <= 100 or not 0.25 <= lowres_scale <= 1:
        raise ValueError("TerryDirector SelfLift: CFG 或低清比例超出允许范围")
    if not 0 <= rho <= 1 or not 0 <= w_min <= w_max <= 1:
        raise ValueError("TerryDirector SelfLift: 需要 0≤rho≤1，0≤w_min≤w_max≤1")


def low_resolution(height: int, width: int, scale: float) -> tuple[int, int]:
    # H3 has a 2x2 spatial patch grid. Time is never scaled.
    return tuple(max(2, round(value * scale / 2) * 2) for value in (height, width))


def spatial_resize(video: torch.Tensor, size: tuple[int, int], *, mode="bilinear", mean_match=False):
    if video.ndim != 5:
        raise ValueError("TerryDirector SelfLift: 视频 latent 必须是 [B,C,T,H,W]")
    if tuple(video.shape[-2:]) == tuple(size):
        return video
    b, c, t, h, w = video.shape
    frames = video.float().permute(0, 2, 1, 3, 4).reshape(b * t, c, h, w)
    options = {} if mode == "nearest" else {"align_corners": False}
    resized = F.interpolate(frames, size=size, mode=mode, **options)
    resized = resized.reshape(b, t, c, *size).permute(0, 2, 1, 3, 4)
    if mean_match:
        resized = resized + video.float().mean((-2, -1), keepdim=True) - resized.mean((-2, -1), keepdim=True)
    return resized.to(dtype=video.dtype)


def resize_guides(conditioning, size):
    """Copy only generation-grid keyframes; reference-image grids are independent."""
    result = []
    for embedding, metadata in conditioning:
        if not metadata.get("minimax_keyframes"):
            result.append((embedding, metadata))
            continue
        keyframes = []
        for guide in metadata["minimax_keyframes"]:
            updated = dict(guide)
            if guide.get("latent") is not None:
                updated["latent"] = spatial_resize(guide["latent"], size, mean_match=True)
            keyframes.append(updated)
        result.append((embedding, {**metadata, "minimax_keyframes": keyframes}))
    return result


def advance_euler(state, clean, sigma_from, sigma_to):
    sigma_from = torch.as_tensor(sigma_from, device=state.device, dtype=state.dtype)
    sigma_to = torch.as_tensor(sigma_to, device=state.device, dtype=state.dtype)
    if float(sigma_from) <= 0:
        raise ValueError("TerryDirector SelfLift: Euler 起始 Sigma 必须大于零")
    return state + (state - clean.to(state)) * ((sigma_to - sigma_from) / sigma_from)


def correct_endpoint(direct, anchor, rho, w_min, w_max, mask=None):
    """Correct the highest channel-mean residual locations in each batch item.

    Threshold ties intentionally share the same decision. This is a quantile
    rule, not a promise to select exactly round(rho*N) locations.
    """
    if rho <= 0 or w_max <= 0:
        if direct is None:
            raise ValueError("SelfLift direct endpoint is missing")
        return direct
    if anchor is None:
        raise ValueError("SelfLift pixel/VAE endpoint is missing")
    if rho == 1 and w_min == 1:
        return anchor
    if direct is None or direct.shape != anchor.shape:
        raise ValueError("SelfLift paired endpoints have different shapes")
    direct = direct.to(device=anchor.device, dtype=torch.float32)
    delta = anchor.float() - direct
    risk = delta.abs().mean(dim=1)
    eligible = torch.ones_like(risk, dtype=torch.bool)
    if mask is not None:
        mask = mask.to(delta)
        risk = (delta.abs() * mask).mean(dim=1)
        eligible = (mask.amax(dim=1) > 0).expand_as(risk)
    corrections = []
    # Per-item processing also avoids NaNs for an entirely preserved item.
    for batch in range(delta.shape[0]):
        scores = risk[batch]
        valid = eligible[batch]
        weights = torch.zeros_like(scores)
        if bool(valid.any()):
            threshold = torch.quantile(scores[valid], 1.0 - float(rho))
            chosen = valid & (scores >= threshold)
            selected_scores = scores[chosen]
            lo, hi = selected_scores.min(), selected_scores.max()
            weights[chosen] = w_min + (w_max - w_min) * (selected_scores - lo) / (hi - lo + 1e-8)
        corrections.append(weights.unsqueeze(0) * delta[batch])
    return direct + torch.stack(corrections)


def normalize_masks(raw_mask, streams):
    """Static H3 masks: a mask per AV stream, or a video mask + generated audio.

    Mask values are 0=preserve, 1=generate. Ambiguous layouts are rejected rather
    than silently broadcasting a video mask over the audio stream.
    """
    if raw_mask is None:
        return None
    if getattr(raw_mask, "is_nested", False):
        masks = list(raw_mask.unbind())
        if len(masks) != len(streams):
            raise ValueError("TerryDirector SelfLift: AV mask 数量与 latent 流数量不同")
    elif isinstance(raw_mask, torch.Tensor):
        masks = [raw_mask] + [torch.ones_like(s[:, :1]) for s in streams[1:]]
    else:
        raise ValueError("TerryDirector SelfLift: mask 必须是 Tensor 或 H3 AV NestedTensor")
    normalized = []
    for mask, stream in zip(masks, streams):
        if not isinstance(mask, torch.Tensor) or not bool(torch.isfinite(mask).all()):
            raise ValueError("TerryDirector SelfLift: mask 包含无效数值")
        if bool(((mask < 0) | (mask > 1)).any()):
            raise ValueError("TerryDirector SelfLift: mask 数值必须在 0 到 1 之间")
        # Unambiguous convenience forms: [B,H,W] and [B,T,H,W] for video.
        if stream.ndim == 5:
            if mask.ndim == 3:
                mask = mask[:, None, None]
            elif mask.ndim == 4:
                mask = mask[:, None]
        if mask.ndim != stream.ndim:
            raise ValueError("TerryDirector SelfLift: mask 维度不匹配")
        if stream.ndim == 5 and tuple(mask.shape[-2:]) != tuple(stream.shape[-2:]):
            mask = spatial_resize(mask.float(), tuple(stream.shape[-2:]))
        try:
            shape = torch.broadcast_shapes(mask.shape, stream.shape)
            if tuple(shape) != tuple(stream.shape):
                raise RuntimeError("mask would expand the latent")
        except RuntimeError as exc:
            raise ValueError("TerryDirector SelfLift: mask 形状无法匹配 latent") from exc
        normalized.append(mask.to(device=stream.device, dtype=stream.dtype).expand_as(stream))
    return normalized
