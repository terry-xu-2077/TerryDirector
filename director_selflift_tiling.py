"""Optional H3 spatial tiling with global positions and complete audio context.

Tiling is approximate: video predictions are feathered, and generated audio
uses the first tile's prediction. It is disabled by default. No global model
monkey-patch and no external plugin classes are involved.
"""
from __future__ import annotations

from functools import partial
import inspect
import logging
import math
import torch

from .director_selflift_math import ENGINE_ID


def tile_regions(length, count):
    patches = (length + 1) // 2
    count = min(max(1, int(count)), max(1, patches // 2))
    if count == 1 or patches < 4:
        return [(0, length)]
    halo = min(4, max(1, patches // 8))
    edges = [i * patches // count for i in range(count + 1)]
    return [(max(0, edges[i] - halo) * 2, min(length, (edges[i + 1] + halo) * 2)) for i in range(count)]


def tile_weights(regions, index):
    start, end = regions[index]
    window = torch.ones(end - start, dtype=torch.float32)
    if index:
        overlap = min(end, regions[index - 1][1]) - start
        if overlap > 0:
            window[:overlap] *= (torch.arange(overlap) + 0.5) / overlap
    if index < len(regions) - 1:
        overlap = end - max(start, regions[index + 1][0])
        if overlap > 0:
            window[-overlap:] *= 1 - (torch.arange(overlap) + 0.5) / overlap
    return window


def _workspace(model):
    import comfy.model_management as mm
    device = model.load_device
    seen, reclaimable = set(), 0
    for entry in mm.loaded_models():
        try:
            patcher = entry if callable(getattr(entry, "loaded_size", None)) else getattr(entry, "model", None)
            body = getattr(patcher, "model", None)
            if body is None or getattr(patcher, "load_device", None) != device or id(body) in seen:
                continue
            seen.add(id(body))
            if callable(getattr(patcher, "loaded_size", None)):
                reclaimable += patcher.loaded_size()
        except ReferenceError:
            continue
    pool = min(mm.get_total_memory(device), mm.get_free_memory(device) + reclaimable)
    reserve = min(model.model_size(), pool * mm.MIN_WEIGHT_MEMORY_RATIO)
    return max(0, pool - reserve - mm.minimum_inference_memory())


def _condition_size(conds, height, width, channels):
    estimates = [0]
    for group in conds.values():
        for cond in group or []:
            text = cond.get("cross_attn")
            size = 0 if text is None else text.shape[-2] * channels * 4
            for guide in cond.get("minimax_keyframes") or []:
                latent = guide["latent"]
                size += latent.shape[1] * latent.shape[2] * height * width
            for reference in cond.get("minimax_refs") or []:
                for key in ("latent", "audio_latent"):
                    tensor = reference.get(key)
                    if tensor is not None:
                        size += math.prod(tensor.shape[1:])
            estimates.append(size)
    return max(estimates)


def _prepare(executor, model, noise_shape, conds, model_options=None,
             force_full_load=False, force_offload=False, *, plan):
    import comfy.sampler_helpers
    kwargs = dict(model_options=model_options, force_full_load=force_full_load, force_offload=force_offload)
    if force_offload:
        return executor(model, noise_shape, conds, **kwargs)
    video, audio = plan["shapes"]
    total = math.prod(video[1:]) + math.prod(audio[1:])
    if tuple(noise_shape) != (video[0], 1, total):
        raise ValueError("TerryDirector SelfLift: 分块规划与采样的 AV 形状不一致")
    axis = {"height": 3, "width": 4}.get(plan["axis_choice"], 3 if video[3] >= video[4] else 4)
    available = _workspace(model)
    counts = range(1, 9) if plan["mode"] == "auto" else (plan["requested"],)
    for count in counts:
        regions = tile_regions(video[axis], count)
        shape = list(video)
        shape[axis] = max(end - start for start, end in regions)
        shape[3], shape[4] = ((n + 1) // 2 * 2 for n in shape[3:5])
        elements = math.prod(shape[1:]) + math.prod(audio[1:])
        elements += _condition_size(conds, shape[3], shape[4], video[1])
        # Full resumed state, noise and stitched buffers remain present.
        bytes_per_element = max(1.0, float(model.model.memory_required((1, 1, 1))))
        elements += math.ceil(total * 4 * 8 / bytes_per_element)
        budget_shape = (noise_shape[0], 1, elements)
        preferred, minimum = comfy.sampler_helpers.estimate_memory(model, budget_shape, conds)
        if minimum <= available:
            break
    plan.update(axis=axis, regions=regions, actual_tiles=len(regions))
    logging.info("[TerryDirector SelfLift] tiling mode=%s axis=%s actual=%d workspace=%.1f MiB estimate=%.1f MiB fits=%s",
                 plan["mode"], "width" if axis == 4 else "height", len(regions), available / 2**20, minimum / 2**20, minimum <= available)
    if minimum > available:
        logging.warning("[TerryDirector SelfLift] 分块估算仍超出可用空间；不自动重试或改变用户手动块数")
    return executor(model, noise_shape if len(regions) == 1 else budget_shape, conds, **kwargs)


def _layout(signature, payload):
    from comfy.ldm.minimax.model import PackedLayout
    options = {"keyframes": payload.get("keyframes"), "refs": payload.get("refs")}
    # ComfyUI builds may extend this native constructor; no plugin API detection.
    if "frame_count" in inspect.signature(PackedLayout).parameters:
        options["frame_count"] = payload.get("frame_count")
    return PackedLayout(*signature, **options)


def crop_payload(payload, context, video, audio, axis, start, stop):
    from comfy.ldm.common_dit import pad_to_patch_size
    payload = payload or {}
    h, w = video.shape[-2:]
    ph, pw = (h + 1) // 2 * 2, (w + 1) // 2 * 2
    signature = (context.shape[1], video.shape[2], ph, pw, audio.shape[-1])
    full = payload.get("layout")
    if full is None or full.signature != signature:
        full = _layout(signature, payload)
    cropped = dict(payload)
    if payload.get("keyframes"):
        guides = []
        for guide in payload["keyframes"]:
            latent = guide["latent"]
            if tuple(latent.shape[-2:]) != (h, w):
                raise ValueError("TerryDirector SelfLift: 高清分块 Guide 必须保留目标分辨率")
            tile = pad_to_patch_size(latent.narrow(axis, start, stop - start), (1, 2, 2)).contiguous()
            guides.append({**guide, "latent": tile})
        cropped["keyframes"] = guides
        if not payload.get("refs"):
            cropped["cond_video_latents"] = [guide["latent"] for guide in guides]
    th, tw = (stop - start, w) if axis == 3 else (h, stop - start)
    tile_layout = _layout((context.shape[1], video.shape[2], (th + 1) // 2 * 2, (tw + 1) // 2 * 2, audio.shape[-1]), cropped)
    if len(full.segments) != len(tile_layout.segments):
        raise ValueError("TerryDirector SelfLift: H3 分块 token 布局不匹配")
    for source, destination in zip(full.segments, tile_layout.segments):
        left, right, kind = source
        tleft, tright, tkind = destination
        if kind != tkind:
            raise ValueError("TerryDirector SelfLift: H3 分块 token 类型顺序改变")
        positions = full.position_ids[left:right]
        if kind in ("cond", "video"):
            grid = positions.reshape(-1, ph // 2, pw // 2, 3)
            positions = grid.narrow(axis - 2, start // 2, (stop - start + 1) // 2).reshape(-1, 3)
        if positions.shape[0] != tright - tleft:
            raise ValueError("TerryDirector SelfLift: H3 分块位置编码长度不匹配")
        tile_layout.position_ids[tleft:tright].copy_(positions)
    cropped["layout"] = tile_layout
    return cropped


def _forward(executor, streams, timestep, context, transformer_options, minimax_payload=None, *, plan, **kwargs):
    import comfy.model_management as mm
    video, audio = streams
    if "regions" not in plan:
        raise RuntimeError("TerryDirector SelfLift: 高清分块尚未执行内存规划")
    regions, axis = plan["regions"], plan["axis"]
    if len(regions) == 1:
        return executor(streams, timestep, context, transformer_options, minimax_payload=minimax_payload, **kwargs)
    if kwargs.get("control") is not None:
        raise ValueError("TerryDirector SelfLift: 高清分块暂不支持 ControlNet")
    video_mask, audio_mask = kwargs.get("denoise_mask"), kwargs.get("audio_denoise_mask")
    if video_mask is not None:
        if not bool((video_mask == 1).all()):
            raise ValueError("TerryDirector SelfLift: 分块不支持局部视频保留 mask")
        kwargs = {**kwargs, "denoise_mask": None}
    if audio_mask is not None and not bool((audio_mask == 0).all()):
        raise ValueError("TerryDirector SelfLift: 分块的音频 mask 必须为全保留")
    assembled = torch.zeros(video.shape, dtype=torch.float32, device="cpu")
    coverage = torch.zeros(video.shape[axis], dtype=torch.float32, device="cpu")
    first_audio = None
    view = [1] * video.ndim
    for index, (start, stop) in enumerate(regions):
        mm.throw_exception_if_processing_interrupted()
        tile = video.narrow(axis, start, stop - start).contiguous()
        payload = crop_payload(minimax_payload, context, video, audio, axis, start, stop)
        predicted, audio_prediction = executor([tile, audio], timestep, context, dict(transformer_options), minimax_payload=payload, **kwargs)
        weights = tile_weights(regions, index)
        view[axis] = stop - start
        assembled.narrow(axis, start, stop - start).add_(predicted.float().cpu() * weights.view(view))
        coverage[start:stop] += weights
        if first_audio is None:
            first_audio = audio_prediction.detach().float().cpu().clone()
        del tile, payload, predicted, audio_prediction
    if bool((coverage <= 0).any()):
        raise RuntimeError("TerryDirector SelfLift: 分块结果存在未覆盖区域")
    view[axis] = video.shape[axis]
    assembled /= coverage.view(view)
    return [assembled.to(video), first_audio.to(audio)]


def configure_tiling(model, shapes, mode="auto", tiles=2, axis="auto"):
    import comfy.model_base
    from comfy.patcher_extension import WrappersMP
    if mode not in {"auto", "manual"} or axis not in {"auto", "height", "width"}:
        raise ValueError("TerryDirector SelfLift: 高清分块模式/方向无效")
    if tiles not in {2, 4, 6, 8}:
        raise ValueError("TerryDirector SelfLift: 手动块数必须为 2 / 4 / 6 / 8")
    if not isinstance(model.model, comfy.model_base.MiniMaxH3):
        raise ValueError("TerryDirector SelfLift: 高清分块只支持 MiniMax H3")
    if len(shapes) != 2 or len(shapes[0]) != 5 or len(shapes[1]) != 4:
        raise ValueError("TerryDirector SelfLift: 高清分块需要 H3 AV latent")
    plan = {"mode": mode, "requested": tiles, "axis_choice": axis, "shapes": tuple(tuple(s) for s in shapes)}
    clone = model.clone()
    clone.add_wrapper_with_key(WrappersMP.PREPARE_SAMPLING, ENGINE_ID + ".tiling", partial(_prepare, plan=plan))
    clone.add_wrapper_with_key(WrappersMP.DIFFUSION_MODEL, ENGINE_ID + ".tiling", partial(_forward, plan=plan))
    return clone
