"""TerryDirector spatial-strip evaluation for the high-resolution H3 stage.

Keeps global token positions and full audio on every tile. No external sampler
or tiling plugin is consulted. Automatic memory planning is an estimate, not an
OOM guarantee. See docs/30_SELFLIFT_INTERNAL.md.
"""
from __future__ import annotations

import logging
import math

import torch

LOG = logging.getLogger(__name__)


def strips(length, count):
    patches = (int(length) + 1) // 2
    count = max(1, min(int(count), max(1, patches // 2)))
    if count == 1:
        return [(0, int(length))]
    margin = min(4, max(1, patches // 8))
    boundaries = [patches * i // count for i in range(count + 1)]
    return [(2 * max(0, boundaries[i] - margin), min(length, 2 * (boundaries[i + 1] + margin)))
            for i in range(count)]


def blend_window(regions, index):
    start, end = regions[index]
    window = torch.ones(end - start, dtype=torch.float32)
    if index:
        overlap = max(0, min(end, regions[index - 1][1]) - start)
        if overlap:
            window[:overlap] *= (torch.arange(overlap) + 0.5) / overlap
    if index + 1 < len(regions):
        overlap = max(0, end - regions[index + 1][0])
        if overlap:
            window[-overlap:] *= 1 - (torch.arange(overlap) + 0.5) / overlap
    return window


def crop_payload(payload, context, video, audio, axis, start, end):
    from comfy.ldm.minimax.model import PackedLayout
    from comfy.ldm.common_dit import pad_to_patch_size
    height, width = video.shape[-2:]
    full_size = (2 * math.ceil(height / 2), 2 * math.ceil(width / 2))
    signature = (context.shape[1], video.shape[2], *full_size, audio.shape[-1])
    original = payload.get("layout")
    if original is None or original.signature != signature:
        original = PackedLayout(*signature, keyframes=payload.get("keyframes"), refs=payload.get("refs"))
    local = dict(payload)
    if payload.get("keyframes"):
        keyframes = []
        for frame in payload["keyframes"]:
            frame = dict(frame)
            value = frame.get("latent")
            if value is not None:
                if tuple(value.shape[-2:]) != (height, width):
                    raise ValueError("SelfLift 分块 Guide 尺寸与目标尺寸不匹配")
                frame["latent"] = pad_to_patch_size(value.narrow(axis, start, end - start), (1, 2, 2)).contiguous()
            keyframes.append(frame)
        local["keyframes"] = keyframes
        if not payload.get("refs"):
            local["cond_video_latents"] = [f["latent"] for f in keyframes if f.get("latent") is not None]
    size = list(full_size)
    size[axis - 3] = 2 * math.ceil((end - start) / 2)
    layout = PackedLayout(context.shape[1], video.shape[2], *size, audio.shape[-1],
                          keyframes=local.get("keyframes"), refs=local.get("refs"))
    if len(original.segments) != len(layout.segments):
        raise ValueError("SelfLift 分块前后条件序列不一致")
    for source, target in zip(original.segments, layout.segments):
        a, b, kind = source
        c, d, target_kind = target
        if kind != target_kind:
            raise ValueError("SelfLift 分块条件类型不匹配")
        positions = original.position_ids[a:b]
        if kind in ("video", "cond"):
            grid = positions.reshape(-1, full_size[0] // 2, full_size[1] // 2, 3)
            positions = grid.narrow(axis - 2, start // 2, math.ceil((end - start) / 2)).reshape(-1, 3)
        if positions.shape != layout.position_ids[c:d].shape:
            raise ValueError("SelfLift 分块位置编码长度不匹配")
        layout.position_ids[c:d].copy_(positions)
    local["layout"] = layout
    return local


def available_workspace(model):
    import comfy.model_management as mm
    available = float(mm.get_free_memory(model.load_device))
    seen = set()
    for entry in mm.loaded_models():
        patcher = entry if callable(getattr(entry, "loaded_size", None)) else getattr(entry, "model", None)
        underlying = getattr(patcher, "model", None)
        size_fn = getattr(patcher, "loaded_size", None)
        if underlying is None or id(underlying) in seen or getattr(patcher, "load_device", None) != model.load_device:
            continue
        seen.add(id(underlying))
        if callable(size_fn):
            available += max(0, float(size_fn()))
    available = min(available, float(mm.get_total_memory(model.load_device)))
    weights = min(float(model.model_size()), available * mm.MIN_WEIGHT_MEMORY_RATIO)
    return max(0, available - weights - float(mm.minimum_inference_memory()))


def planning_shape(model, shapes, axis, regions, batch, conds):
    video, audio = shapes
    tile = list(video)
    tile[axis] = max(b - a for a, b in regions)
    tile[3:] = [2 * math.ceil(x / 2) for x in tile[3:]]
    conditional = 0
    for group in conds.values():
        for cond in group or ():
            elements = 0
            text = cond.get("cross_attn")
            if text is not None:
                elements += text.shape[-2] * video[1] * 4
            for frame in cond.get("minimax_keyframes") or ():
                latent = frame.get("latent")
                if latent is not None:
                    elements += latent.shape[1] * latent.shape[2] * tile[3] * tile[4]
                audio_latent = frame.get("audio_latent")
                if audio_latent is not None:
                    elements += math.prod(audio_latent.shape[1:])
            for ref in cond.get("minimax_refs") or ():
                for key in ("latent", "audio_latent"):
                    latent = ref.get(key)
                    if latent is not None:
                        elements += math.prod(latent.shape[1:])
            conditional = max(conditional, elements)
    full = math.prod(video[1:]) + math.prod(audio[1:])
    per_element = max(1.0, float(model.model.memory_required((1, 1, 1))))
    extra = math.ceil(full * 4 * 8 / per_element)
    return (batch, 1, math.prod(tile[1:]) + math.prod(audio[1:]) + conditional + extra)


def patch_tiling(model, shapes, mode="auto", tiles=2, axis="auto"):
    import comfy.model_base
    import comfy.patcher_extension
    import comfy.sampler_helpers
    if mode not in ("auto", "manual") or axis not in ("auto", "width", "height") or tiles not in (2, 4, 6, 8):
        raise ValueError("SelfLift 分块参数无效")
    if not isinstance(model.model, comfy.model_base.MiniMaxH3):
        raise ValueError("SelfLift 高清分块仅支持原生 MiniMax H3 架构")
    dim = 3 if axis == "height" or (axis == "auto" and shapes[0][3] >= shapes[0][4]) else 4
    plan = {}
    patched = model.clone()

    def prepare(executor, selected, noise_shape, conds, model_options=None,
                force_full_load=False, force_offload=False):
        if force_offload:
            return executor(selected, noise_shape, conds, model_options=model_options,
                            force_full_load=force_full_load, force_offload=True)
        expected = (shapes[0][0], 1, sum(math.prod(s[1:]) for s in shapes))
        if tuple(noise_shape) != expected:
            raise ValueError("SelfLift 分块规划与实际音视频潜变量尺寸不同")
        capacity = available_workspace(selected)
        for count in (range(1, 9) if mode == "auto" else (tiles,)):
            regions = strips(shapes[0][dim], count)
            budget = planning_shape(selected, shapes, dim, regions, noise_shape[0], conds)
            preferred, minimum = comfy.sampler_helpers.estimate_memory(selected, budget, conds)
            if minimum <= capacity:
                break
        plan["regions"] = regions
        LOG.info("[TerryDirector SelfLift] tiling=%s actual_tiles=%d axis=%s estimated=%.1f MiB available=%.1f MiB",
                 mode, len(regions), "height" if dim == 3 else "width", minimum / 2**20, capacity / 2**20)
        if minimum > capacity:
            LOG.warning("[TerryDirector SelfLift] 分块显存估计仍超预算；不自动重试或改参数，请降低分辨率/时长")
        return executor(selected, noise_shape if len(regions) == 1 else budget, conds,
                        model_options=model_options, force_full_load=force_full_load, force_offload=False)

    def forward(executor, streams, timestep, context, transformer_options, minimax_payload=None, **kwargs):
        video, audio = streams
        regions = plan.get("regions")
        if regions is None:
            raise RuntimeError("SelfLift 分块必须先完成原生采样准备")
        if len(regions) == 1:
            return executor(streams, timestep, context, transformer_options, minimax_payload=minimax_payload, **kwargs)
        if kwargs.get("control") is not None:
            raise ValueError("SelfLift 高清分块不支持 ControlNet，请关闭分块")
        kwargs = dict(kwargs)
        mask = kwargs.get("denoise_mask")
        if mask is not None:
            if not bool((mask == 1).all()):
                raise ValueError("SelfLift 分块不支持局部视频遮罩")
            kwargs["denoise_mask"] = None
        mask = kwargs.get("audio_denoise_mask")
        if mask is not None and not bool((mask == 0).all()):
            raise ValueError("SelfLift 分块仅支持完整保留的音频遮罩")
        combined = torch.zeros(video.shape, dtype=torch.float32, device="cpu")
        weights = torch.zeros(video.shape[dim], dtype=torch.float32, device="cpu")
        first_audio = None
        broadcast = [1] * video.ndim
        for index, (start, end) in enumerate(regions):
            tile = video.narrow(dim, start, end - start).contiguous()
            payload = crop_payload(minimax_payload or {}, context, video, audio, dim, start, end)
            out_video, out_audio = executor([tile, audio], timestep, context, transformer_options.copy(),
                                             minimax_payload=payload, **kwargs)
            window = blend_window(regions, index)
            broadcast[dim] = end - start
            combined.narrow(dim, start, end - start).add_(out_video.float().cpu() * window.view(broadcast))
            weights[start:end] += window
            if first_audio is None:
                first_audio = out_audio.detach().float().cpu().clone()
            del tile, payload, out_video, out_audio
        broadcast[dim] = video.shape[dim]
        combined /= weights.view(broadcast)
        return [combined.to(video), first_audio.to(audio)]

    wrappers = comfy.patcher_extension.WrappersMP
    patched.add_wrapper_with_key(wrappers.PREPARE_SAMPLING, "terry_selflift_tiles", prepare)
    patched.add_wrapper_with_key(wrappers.DIFFUSION_MODEL, "terry_selflift_tiles", forward)
    return patched
