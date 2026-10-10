"""TerryDirector-owned two-stage Euler SelfLift for MiniMax H3 AV latents.

Only ComfyUI/PyTorch APIs are used at runtime. No custom-node lookup, dynamic
import of another plugin, or fallback to an external sampler is performed.
"""
from __future__ import annotations

import logging
import torch
from torch.nn import functional as F

from .director_selflift_math import (
    ENGINE_ID, advance_euler, correct_endpoint, low_resolution, normalize_masks,
    resize_guides, spatial_resize, validate_options, validate_schedule,
)


class ComfyBackend:
    """Thin native-ComfyUI boundary; numerical orchestration lives below."""
    def __init__(self):
        import comfy.model_management as mm
        import comfy.sample as sample
        import comfy.samplers as samplers
        import comfy.nested_tensor as nested
        import comfy.model_sampling as model_sampling
        import comfy.k_diffusion.sampling as k_sampling
        import comfy.patcher_extension as extensions
        import comfy.utils as utils
        import latent_preview
        self.mm, self.noise_api, self.samplers = mm, sample, samplers
        self.nested, self.model_sampling, self.k_sampling = nested, model_sampling, k_sampling
        self.extensions, self.utils, self.latent_preview = extensions, utils, latent_preview
        self.device = mm.intermediate_device()
        self.dtype = mm.intermediate_dtype()

    def split(self, samples):
        if not getattr(samples, "is_nested", False):
            raise ValueError("TerryDirector SelfLift: 需要 MiniMax H3 音画双流 latent")
        streams = list(samples.unbind())
        if len(streams) != 2 or streams[0].ndim != 5 or streams[1].ndim != 4:
            raise ValueError("TerryDirector SelfLift: H3 视频/音频 latent 维度不匹配")
        return streams

    def pack(self, streams):
        return self.nested.NestedTensor(streams)

    def fix(self, model, latent):
        return self.noise_api.fix_empty_latent_channels(
            model, latent["samples"], latent.get("downscale_ratio_spacial"), latent.get("downscale_ratio_temporal"))

    def noise(self, latent, seed, batch_index):
        return self.noise_api.prepare_noise(latent, seed, batch_index)

    def interrupt(self):
        self.mm.throw_exception_if_processing_interrupted()

    def validate(self, model, high_model, sampler):
        for selected in (model, high_model):
            if not isinstance(selected.get_model_object("model_sampling"), self.model_sampling.CONST):
                raise ValueError("TerryDirector SelfLift: 需要 rectified-flow 模型")
        if not isinstance(sampler, self.samplers.KSAMPLER) or sampler.sampler_function is not self.k_sampling.sample_euler:
            raise ValueError("TerryDirector SelfLift: 必须使用标准 Euler 采样器")
        if sampler.extra_options.get("s_churn", 0) != 0:
            raise ValueError("TerryDirector SelfLift: Euler s_churn 必须为零")
        low_format, high_format = [m.get_model_object("latent_format") for m in (model, high_model)]
        if type(low_format) is not type(high_format):
            raise ValueError("TerryDirector SelfLift: 两阶段模型必须使用同一 H3 latent 格式")
        for field in ("latent_channels", "scale_factor", "shift_factor"):
            a, b = getattr(low_format, field, None), getattr(high_format, field, None)
            if a is not None and b is not None and not bool(torch.as_tensor(a).eq(torch.as_tensor(b)).all()):
                raise ValueError(f"TerryDirector SelfLift: 两阶段 latent {field} 不一致")

    def sample(self, model, noise, positive, negative, cfg, sampler, sigmas, latent, callback, seed):
        return self.samplers.sample(
            model, noise, positive, negative, cfg, model.load_device, sampler, sigmas,
            model.model_options, latent_image=latent, callback=callback,
            disable_pbar=not self.utils.PROGRESS_BAR_ENABLED, seed=seed,
        )

    def preview(self, model, steps):
        return self.latent_preview.prepare_callback(model, steps)

    def mask_model(self, model, anchors, masks):
        if masks is None:
            return model
        if model.model_options.get("denoise_mask_function") is not None:
            raise ValueError("TerryDirector SelfLift: 静态 AV mask 暂不与动态 denoise_mask_function 混用")
        clone = model.clone()
        flat_anchor, _ = self.utils.pack_latents(anchors)
        flat_mask, _ = self.utils.pack_latents([m.to(a).expand_as(a) for m, a in zip(masks, anchors)])
        samplers = self.samplers
        load_device = clone.load_device

        def inject(executor, noise, latent_image, sampler, sigmas, denoise_mask=None,
                   callback=None, disable_pbar=False, seed=None, latent_shapes=None):
            # The resumed initial state is noisy. The inpaint anchor must remain
            # the original clean content, not that resumed state.
            def euler_with_clean_anchor(model_k, value, schedule, **options):
                inner = model_k.inner_model.inner_model
                model_k.latent_image = inner.process_latent_in(flat_anchor.to(value))
                return sampler.sampler_function(model_k, value, schedule, **options)
            anchored = samplers.KSAMPLER(euler_with_clean_anchor, dict(sampler.extra_options), dict(sampler.inpaint_options))
            return executor(noise, latent_image, anchored, sigmas,
                            flat_mask.to(device=load_device), callback, disable_pbar, seed,
                            latent_shapes=latent_shapes)
        clone.add_wrapper_with_key(self.extensions.WrappersMP.OUTER_SAMPLE, ENGINE_ID + ".mask", inject)
        return clone

    def tiled_model(self, model, shapes, mode, tiles, axis):
        from .director_selflift_tiling import configure_tiling
        return configure_tiling(model, shapes, mode, tiles, axis)


def _pixel_endpoint(video, vae, target, interrupt):
    """A separate decode/resize/encode per batch member; no temporal resampling."""
    endpoints = []
    for item in video.split(1):
        interrupt()
        frames = vae.decode(item)
        if frames.ndim == 5:
            frames = frames.reshape(-1, *frames.shape[-3:])
        if frames.ndim != 4 or any(n == 0 for n in frames.shape) or frames.shape[1] % video.shape[-2] or frames.shape[2] % video.shape[-1]:
            raise ValueError("TerryDirector SelfLift: VAE 解码尺寸无法对应输入 latent")
        pixels = (target[0] * (frames.shape[1] // video.shape[-2]), target[1] * (frames.shape[2] // video.shape[-1]))
        device = torch.device(vae.device)
        dtype = vae.vae_dtype if vae.vae_dtype in (torch.float16, torch.bfloat16, torch.float32) else torch.float32
        if device.type == "cpu":
            dtype = torch.float32
        resized = torch.empty((frames.shape[0], *pixels, frames.shape[-1]), dtype=dtype, device="cpu")
        for start in range(0, frames.shape[0], 32):
            interrupt()
            chunk = frames[start:start + 32].movedim(-1, 1).to(device=device, dtype=dtype)
            chunk = F.interpolate(chunk, size=pixels, mode="bicubic", align_corners=False, antialias=True)
            resized[start:start + 32] = chunk.movedim(1, -1).to(device="cpu")
        del frames, chunk
        encoded = vae.encode(resized).float()
        expected = (*item.shape[:3], *target)
        if tuple(encoded.shape) != expected:
            raise ValueError(f"TerryDirector SelfLift: VAE 回编码改变了时长/形状 {tuple(encoded.shape)} != {expected}")
        endpoints.append(encoded)
        del resized
    return torch.cat(endpoints, dim=0)


def _snapshot(backend, samples):
    return [stream.detach().to(backend.device).clone() for stream in backend.split(samples)]


def sample_selflift(*, model, positive, negative, vae, latent_image, sampler, sigmas,
                    seed, cfg, transition_step, lowres_scale, rho, w_min, w_max,
                    upscaler_model, high_res_model=None, highres_tiling=False,
                    tiling_mode="auto", tiling_tiles=2, tiling_axis="auto",
                    _backend=None, _lifter=None):
    """One schedule: k low-resolution evaluations and N-k high-resolution ones.

    The last low-resolution x0 prediction is reused at the resolution boundary.
    Video is lifted and re-noised; audio completes the SAME Euler interval and
    is never reinitialized, resized, or replaced with independent noise.
    Private injectable boundaries are solely for CPU regression tests.
    """
    validate_schedule(sigmas, transition_step)
    validate_options(cfg, lowres_scale, rho, w_min, w_max)
    if not 0 <= int(seed) < 1 << 64:
        raise ValueError("TerryDirector SelfLift: Seed 超出 64 位无符号范围")
    need_pixel = rho > 0 and w_max > 0
    need_direct = not (rho == 1 and w_min == 1)
    if need_direct and upscaler_model == "none" and not need_pixel:
        raise ValueError("TerryDirector SelfLift: 请选择 latent 放大模型，或启用有效的像素锚定修正")
    if highres_tiling and (tiling_mode not in {"auto", "manual"}
                           or tiling_axis not in {"auto", "width", "height"}
                           or tiling_tiles not in {2, 4, 6, 8}):
        raise ValueError("TerryDirector SelfLift: 高清分块参数无效")
    backend = _backend if _backend is not None else ComfyBackend()
    high_model = high_res_model if high_res_model is not None else model
    backend.validate(model, high_model, sampler)
    backend.interrupt()
    source = backend.split(backend.fix(model, latent_image))
    if any(s.numel() == 0 or s.shape[0] != source[0].shape[0] for s in source):
        raise ValueError("TerryDirector SelfLift: 音画 latent 为空或 batch 不一致")
    masks = normalize_masks(latent_image.get("noise_mask"), source)
    source = [s.to(backend.device) for s in source]
    if highres_tiling and masks is not None:
        if not bool((masks[0] == 1).all()) or not bool((masks[1] == 0).all()):
            raise ValueError("TerryDirector SelfLift: 高清分块的 mask 只支持全视频生成、全音频保留")
    target = tuple(source[0].shape[-2:])
    low_size = low_resolution(*target, lowres_scale)
    small_video = spatial_resize(source[0], low_size)
    low_anchors = [small_video, *source[1:]]
    low_masks = [spatial_resize(masks[0], low_size), *masks[1:]] if masks is not None else None
    low_model = backend.mask_model(model, low_anchors, low_masks)
    low_latent = backend.pack(low_anchors)
    batch_index = latent_image.get("batch_index")
    noise = backend.noise(low_latent, int(seed), batch_index)
    steps = sigmas.numel() - 1
    preview = backend.preview(model, steps)
    boundary = {}
    low_calls = 0
    logging.info("[TerryDirector SelfLift] engine=%s low=%s target=%s steps=%d+%d rho=%g tiling=%s",
                 ENGINE_ID, tuple(small_video.shape), tuple(source[0].shape), transition_step,
                 steps - transition_step, rho, highres_tiling)

    def low_callback(step, clean, state, total):
        nonlocal low_calls
        low_calls += 1
        if low_calls > transition_step:
            raise RuntimeError("TerryDirector SelfLift: 低清采样调用数超过日程")
        if low_calls == transition_step:
            boundary["state"] = _snapshot(backend, state)
            boundary["clean"] = _snapshot(backend, clean)
        # Preview gets target-sized video, but never changes the actual state.
        if preview is not None:
            clean_streams = backend.split(clean)
            display = backend.pack([spatial_resize(clean_streams[0], target), *clean_streams[1:]])
            preview(low_calls - 1, display, display, steps)

    backend.sample(low_model, noise, resize_guides(positive, low_size), resize_guides(negative, low_size),
                   cfg, sampler, sigmas[:transition_step + 1], low_latent, low_callback, int(seed))
    if low_calls != transition_step:
        raise RuntimeError(f"TerryDirector SelfLift: 低清采样应调用 {transition_step} 次，实际 {low_calls} 次")
    backend.interrupt()
    states, cleans = boundary.pop("state"), boundary.pop("clean")
    sigma_old, sigma_resume = sigmas[transition_step - 1], sigmas[transition_step]
    audio_next = [advance_euler(x, z, sigma_old, sigma_resume) for x, z in zip(states[1:], cleans[1:])]
    latent_format = model.get_model_object("latent_format")
    clean_video_vae = latent_format.process_out(cleans[0].float())
    del states, cleans, low_latent, low_anchors, small_video, noise, low_model, low_masks
    direct = anchor = None
    if need_direct:
        if upscaler_model != "none":
            if _lifter is None:
                from .director_selflift_upscaler import learned_lift
                _lifter = learned_lift
            direct = _lifter(clean_video_vae, target, upscaler_model)
        else:
            direct = spatial_resize(clean_video_vae, target, mode="nearest")
    if need_pixel:
        anchor = _pixel_endpoint(clean_video_vae, vae, target, backend.interrupt)
    expected = tuple(source[0].shape)
    for endpoint in (direct, anchor):
        if endpoint is not None and tuple(endpoint.shape) != expected:
            raise ValueError("TerryDirector SelfLift: 放大器改变了视频的 batch、通道或时长")
    direct = latent_format.process_in(direct) if direct is not None else None
    anchor = latent_format.process_in(anchor) if anchor is not None else None
    clean_high = correct_endpoint(direct, anchor, rho, w_min, w_max, None if masks is None else masks[0])
    if masks is not None:
        mask = masks[0].to(clean_high)
        clean_high = clean_high * mask + latent_format.process_in(source[0].to(clean_high)) * (1 - mask)
    clean_high = clean_high.to(backend.device)
    del clean_video_vae, direct, anchor
    backend.interrupt()
    flow = model.get_model_object("model_sampling")
    new_noise = backend.noise(clean_high, (int(seed) + 1) % (1 << 64), batch_index).to(clean_high)
    video_state = flow.noise_scaling(sigma_old, new_noise, clean_high)
    video_next = advance_euler(video_state, clean_high, sigma_old, sigma_resume)
    next_streams = [video_next, *audio_next]
    # sample() will apply noise_scaling again. Undo only its signal scaling;
    # pass zero new noise, so audio/video resume exactly at sigma_resume.
    unscaled = [flow.inverse_noise_scaling(sigma_resume, s) for s in next_streams]
    resume = model.model.process_latent_out(backend.pack(unscaled))
    zero_noise = backend.pack([torch.zeros_like(s) for s in unscaled])
    del clean_high, new_noise, video_state, video_next, audio_next, next_streams, unscaled
    if highres_tiling:
        high_model = backend.tiled_model(high_model, [tuple(s.shape) for s in source], tiling_mode, tiling_tiles, tiling_axis)
    high_model = backend.mask_model(high_model, source, masks)
    high_calls = 0

    def high_callback(step, clean, state, total):
        nonlocal high_calls
        high_calls += 1
        if high_calls > steps - transition_step:
            raise RuntimeError("TerryDirector SelfLift: 高清采样调用数超过日程")
        if preview is not None:
            preview(transition_step + high_calls - 1, clean, state, steps)

    backend.interrupt()
    output = backend.sample(high_model, zero_noise, positive, negative, cfg, sampler,
                            sigmas[transition_step:], resume, high_callback, int(seed))
    if high_calls != steps - transition_step:
        raise RuntimeError("TerryDirector SelfLift: 高清采样调用数与日程不符")
    output_streams = backend.split(output)
    if [tuple(s.shape) for s in output_streams] != [tuple(s.shape) for s in source]:
        raise RuntimeError("TerryDirector SelfLift: 输出音画 latent 形状发生变化")
    if masks is not None:
        output_streams = [torch.where(m.to(s.device) == 0, original.to(s), s)
                          for s, original, m in zip(output_streams, source, masks)]
    result = dict(latent_image)
    result["samples"] = backend.pack([s.to(device=backend.device, dtype=backend.dtype) for s in output_streams])
    logging.info("[TerryDirector SelfLift] completed low=%d high=%d; audio/video dimensions preserved", low_calls, high_calls)
    return result
