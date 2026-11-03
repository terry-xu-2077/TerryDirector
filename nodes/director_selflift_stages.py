"""Independent low/high SelfLift stages joined by a cacheable native LATENT.

The generic pause boundary knows nothing about this payload. All model-specific
transition data is owned and validated by the two sampling stages here.
"""
from __future__ import annotations

import torch

from .director_selflift import ComfyBackend
from .director_selflift_math import normalize_masks, resize_guides, spatial_resize, validate_options, validate_schedule
from .director_selflift_resume import resume_highres

CONTEXT_KEY = "terrydirector_preview_transition"
CONTEXT_ENGINE = "terrydirector-selflift-stages-v3"


def _format_signature(model):
    fmt = model.get_model_object("latent_format")
    result = {"type": type(fmt).__module__ + "." + type(fmt).__qualname__}
    for field in ("latent_channels", "scale_factor", "shift_factor"):
        value = getattr(fmt, field, None)
        if value is not None:
            result[field] = torch.as_tensor(value).detach().cpu().tolist()
    return result


def sample_lowres(*, model, positive, negative, latent_image, sampler, sigmas,
                  low_steps, seed, cfg, _backend=None):
    validate_schedule(sigmas, low_steps)
    validate_options(cfg, 1.0)
    if not 0 <= int(seed) < 1 << 64:
        raise ValueError("SelfLift: Seed 超出 uint64 范围")
    if float(sigmas[-1]) != 0:
        raise ValueError("SelfLift: 需要完整且以零结束的 SIGMAS")
    backend = _backend or ComfyBackend()
    backend.validate(model, model, sampler)
    backend.interrupt()
    source = backend.split(backend.fix(model, latent_image))
    if any(stream.numel() == 0 or stream.shape[0] != source[0].shape[0] for stream in source):
        raise ValueError("SelfLift: 音画 latent 为空或 batch 不一致")
    source = [stream.to(backend.device) for stream in source]
    masks = normalize_masks(latent_image.get("noise_mask"), source)
    size = tuple(source[0].shape[-2:])
    anchors = source
    low_masks = masks
    selected_model = backend.mask_model(model, anchors, low_masks)
    latent = backend.pack(anchors)
    noise = backend.noise(latent, int(seed), latent_image.get("batch_index"))
    preview = backend.preview(model, low_steps)
    calls = 0
    last_clean = last_state = None

    def callback(step, clean, state, total):
        nonlocal calls, last_clean, last_state
        calls += 1
        if calls > low_steps:
            raise RuntimeError("SelfLift: 低清采样超过设置步数")
        if calls == low_steps:
            if not getattr(clean, "is_nested", False):
                clean = backend.pack(backend.utils.unpack_latents(clean, [tuple(x.shape) for x in anchors]))
            if not getattr(state, "is_nested", False):
                state = backend.pack(backend.utils.unpack_latents(state, [tuple(x.shape) for x in anchors]))
            last_clean = backend.pack([x.detach().clone() for x in backend.split(clean)])
            last_state = backend.pack([x.detach().clone() for x in backend.split(state)])
        if preview is not None:
            preview(calls - 1, clean, state, low_steps)

    backend.sample(selected_model, noise, resize_guides(positive, size),
                   resize_guides(negative, size), cfg, sampler,
                   sigmas[:low_steps + 1], latent, callback, int(seed))
    if calls != low_steps or last_clean is None:
        raise RuntimeError(f"SelfLift: 低清采样应执行 {low_steps} 步，实际 {calls} 步")
    backend.interrupt()
    # Preview is in VAE space; continuation retains the original callback tensors
    # before the last Euler update, as Avatar does (no audio scale round trip).
    clean = model.model.process_latent_out(last_clean)
    state_streams, clean_streams = backend.split(last_state), backend.split(last_clean)
    expected = [tuple(stream.shape) for stream in anchors]
    if [tuple(stream.shape) for stream in state_streams] != expected or [tuple(stream.shape) for stream in clean_streams] != expected:
        raise ValueError("SelfLift: 低清输出尺寸不匹配")
    cpu = lambda streams: [stream.detach().to("cpu") for stream in streams]
    context = {
        "engine": CONTEXT_ENGINE, "format": _format_signature(model),
        "sigmas": sigmas.detach().cpu().clone(), "transition_step": low_steps,
        "state": cpu(state_streams), "clean": cpu(clean_streams),
        "state_space": "sampler",
        "audio_scale": float(model.model.audio_scale()) if hasattr(model.model, "audio_scale") else 1.0,
        "noise_scale": float(getattr(model.get_model_object("model_sampling"), "noise_scale", 1.0)),
        "source": cpu(source), "masks": cpu(masks) if masks is not None else None,
        "batch_index": latent_image.get("batch_index"),
    }
    result = dict(latent_image)
    result["samples"] = clean
    if low_masks is not None:
        result["noise_mask"] = backend.pack(low_masks)
    result[CONTEXT_KEY] = context
    return result


def sample_highres(*, latent, model, positive, negative, sampler, high_steps,
                   seed, cfg, width, height, upscaler_model, highres_tiling=False,
                   tiling_mode="manual", tiling_tiles=4, tiling_axis="auto",
                   _backend=None, _lifter=None):
    for value in (width, height):
        if type(value) is not int or value < 32 or value > 16384 or value % 32:
            raise ValueError("SelfLift: 高清目标宽高须为 32～16384 的 32 倍数（像素）")
    context = latent.get(CONTEXT_KEY) if isinstance(latent, dict) else None
    if isinstance(context, dict) and context.get("engine") != CONTEXT_ENGINE:
        raise ValueError("SelfLift: 低清过渡缓存版本不同，请重新生成低清后继续高清")
    if not isinstance(context, dict):
        raise ValueError("SelfLift: 请连接「SelfLift 低清采样」的 LATENT，可经过通用暂停/继续缓存")
    if context.get("format") != _format_signature(model):
        raise ValueError("SelfLift: 低清和高清模型的 latent 格式不匹配")
    if type(high_steps) is not int or not 1 <= high_steps <= 10000:
        raise ValueError("SelfLift: 高清采样步数须为 1～10000")
    if not 0 <= int(seed) < 1 << 64:
        raise ValueError("SelfLift: Seed 超出 uint64 范围")
    validate_schedule(context["sigmas"], context["transition_step"])
    remaining_steps = context["sigmas"].numel() - 1 - context["transition_step"]
    if high_steps != remaining_steps:
        raise ValueError(f"SelfLift: 完整 SIGMAS 剩余 {remaining_steps} 步，高清步数设置为 {high_steps}。"
                         "请使低清步数 + 高清步数等于完整日程步数；改变总步数后须重新生成低清。")
    state, clean, source = (context[key] for key in ("state", "clean", "source"))
    for streams in (state, clean, source):
        if not isinstance(streams, list) or len(streams) != 2 or streams[0].ndim != 5 or streams[1].ndim != 4:
            raise ValueError("SelfLift: 过渡数据的音画形状不正确")
    if [tuple(x.shape) for x in state] != [tuple(x.shape) for x in clean] or tuple(state[1].shape) != tuple(source[1].shape) or state[0].shape[:3] != source[0].shape[:3]:
        raise ValueError("SelfLift: 低清与目标音画尺寸不一致")
    target = (height // 16, width // 16)
    if target[0] < source[0].shape[-2] or target[1] < source[0].shape[-1]:
        raise ValueError("SelfLift: 高清目标宽高不能小于输入低清 LATENT")
    # Only spatial geometry changes; duration, batch and the entire audio stream
    # come from the low stage. Kept video content is resized from its source.
    source = [spatial_resize(source[0], target), source[1]]
    masks = context["masks"]
    if masks is not None:
        masks = [spatial_resize(masks[0], target, framewise=True), masks[1]]
    saved = {**context, "source": source, "masks": masks, "manifest": {
        "checkpoint_id": "latent", "cfg": cfg, "seed": str(int(seed)),
        "transition_step": context["transition_step"], "batch_index": context.get("batch_index"),
        "low_video_shape": list(state[0].shape), "target_video_shape": list(source[0].shape),
    }}
    result = resume_highres(
        checkpoint=None, model=model, positive=resize_guides(positive, target),
        negative=resize_guides(negative, target), sampler=sampler,
        upscaler_model=upscaler_model, highres_tiling=highres_tiling, tiling_mode=tiling_mode,
        tiling_tiles=tiling_tiles, tiling_axis=tiling_axis, high_steps=high_steps,
        _saved=saved, _backend=_backend, _lifter=_lifter)
    result = {**latent, **result}
    result.pop(CONTEXT_KEY, None)
    if masks is not None:
        backend = _backend or ComfyBackend()
        result["noise_mask"] = backend.pack(masks)
    return result
