"""Resume a SelfLift H3 high-resolution pass from native ComfyUI sampler outputs.

Low resolution is performed by stock SamplerCustom / SamplerCustomAdvanced with
a *prefix* of the original sigma schedule. The native output at sigma[k] gives
the already-advanced audio state, while denoised_output supplies the last x0.
"""
from __future__ import annotations

import logging

import torch

from .director_selflift import ComfyBackend, _pixel_endpoint
from .director_selflift_math import correct_endpoint, validate_options


def resume_highres(*, checkpoint, model, positive, negative, vae, sampler,
                   rho, w_min, w_max, upscaler_model,
                   highres_tiling=False, tiling_mode="auto", tiling_tiles=2,
                   tiling_axis="auto", _backend=None, _lifter=None):
    from .director_selflift_checkpoint import load_checkpoint
    if isinstance(checkpoint, dict):
        checkpoint = checkpoint.get("checkpoint_id")
    saved = load_checkpoint(checkpoint)
    manifest = saved["manifest"]
    cfg = float(manifest["cfg"])
    seed = int(manifest["seed"])
    k = int(manifest["transition_step"])
    validate_options(cfg, 0.5, rho, w_min, w_max)
    need_pixel = rho > 0 and w_max > 0
    need_direct = not (rho == 1 and w_min == 1)
    if need_direct and upscaler_model == "none" and not need_pixel:
        raise ValueError("SelfLift: 请提供 H3 latent upscaler 或开启 rho 像素锚修正")
    if highres_tiling and (tiling_mode not in {"auto", "manual"}
                           or tiling_axis not in {"auto", "width", "height"}
                           or tiling_tiles not in {2, 4, 6, 8}):
        raise ValueError("SelfLift: 高清空间分块参数无效")
    backend = _backend or ComfyBackend()
    backend.validate(model, model, sampler)
    backend.interrupt()
    source = [s.to(backend.device) for s in saved["source"]]
    low_clean = [s.to(backend.device) for s in saved["clean"]]
    low_state = [s.to(backend.device) for s in saved["state"]]
    masks = ([m.to(backend.device) for m in saved["masks"]]
             if saved["masks"] is not None else None)
    if highres_tiling and masks is not None:
        if not bool((masks[0] == 1).all()) or not bool((masks[1] == 0).all()):
            raise ValueError("SelfLift: 空间分块仅支持视频全生成、音频全保留")
    target = tuple(source[0].shape[-2:])
    fmt = model.get_model_object("latent_format")
    # Native SamplerCustom's denoised_output has already undergone
    # model.process_latent_out; convert it back to the model's x0 domain.
    clean_internal = model.model.process_latent_in(low_clean[0].float())
    clean_video_vae = fmt.process_out(clean_internal)
    direct = anchor = None
    if need_direct:
        if upscaler_model != "none":
            if _lifter is None:
                from .director_selflift_upscaler import learned_lift
                _lifter = learned_lift
            direct = _lifter(clean_video_vae, target, upscaler_model)
        else:
            from .director_selflift_math import spatial_resize
            direct = spatial_resize(clean_video_vae, target, mode="nearest")
    if need_pixel:
        anchor = _pixel_endpoint(clean_video_vae, vae, target, backend.interrupt)
    for value in (direct, anchor):
        if value is not None and tuple(value.shape) != tuple(source[0].shape):
            raise ValueError("SelfLift: 放大 Latent 形状错误")
    direct = fmt.process_in(direct) if direct is not None else None
    anchor = fmt.process_in(anchor) if anchor is not None else None
    clean_high = correct_endpoint(direct, anchor, rho, w_min, w_max,
                                  None if masks is None else masks[0])
    if masks is not None:
        mask = masks[0].to(clean_high)
        clean_high = clean_high * mask + fmt.process_in(source[0].to(clean_high)) * (1 - mask)
    clean_high = clean_high.to(backend.device)
    flow = model.get_model_object("model_sampling")
    sigma_old, sigma_resume = (s.to(backend.device) for s in
                               (saved["sigmas"][k-1], saved["sigmas"][k]))
    noise = backend.noise(clean_high, (seed + 1) % (1 << 64),
                          manifest.get("batch_index")).to(clean_high)
    from .director_selflift_math import advance_euler
    video_state = flow.noise_scaling(sigma_old, noise, clean_high)
    video_next = advance_euler(video_state, clean_high, sigma_old, sigma_resume)
    unscaled_video = flow.inverse_noise_scaling(sigma_resume, video_next)
    # Native SamplerCustom's ordinary output already carries the audio stream
    # through the final low-res Euler interval. Do NOT advance audio twice.
    video_resume = model.model.process_latent_out(unscaled_video)
    resume = backend.pack([video_resume, low_state[1]])
    zero_noise = backend.pack([torch.zeros_like(video_resume),
                              torch.zeros_like(low_state[1])])
    del low_clean, low_state, noise, direct, anchor, clean_video_vae
    del clean_high, clean_internal, video_state, video_next, unscaled_video
    backend.interrupt()
    high_model = model
    if highres_tiling:
        high_model = backend.tiled_model(
            high_model, [tuple(s.shape) for s in source],
            tiling_mode, tiling_tiles, tiling_axis)
    high_model = backend.mask_model(high_model, source, masks)
    sigmas = saved["sigmas"].to(backend.device)
    total_steps = sigmas.numel() - 1
    preview = backend.preview(model, total_steps)
    high_calls = 0

    def callback(step, clean, state, total):
        nonlocal high_calls
        high_calls += 1
        if high_calls > total_steps - k:
            raise RuntimeError("SelfLift: 高清采样超过预期步数")
        if preview is not None:
            preview(k + high_calls - 1, clean, state, total_steps)

    output = backend.sample(high_model, zero_noise, positive, negative, cfg,
                            sampler, sigmas[k:], resume, callback, seed)
    if high_calls != total_steps - k:
        raise RuntimeError("SelfLift: 高清采样步数不符")
    streams = backend.split(output)
    if [tuple(s.shape) for s in streams] != [tuple(s.shape) for s in source]:
        raise RuntimeError("SelfLift: 高清视频/音频尺寸不匹配")
    if masks is not None:
        streams = [torch.where(m.to(s.device) == 0, original.to(s), s)
                   for s, original, m in zip(streams, source, masks)]
    logging.info("[TerryDirector SelfLift split] checkpoint=%s high_steps=%d",
                 manifest["checkpoint_id"], high_calls)
    return {"samples": backend.pack(
        [s.to(device=backend.device, dtype=backend.dtype) for s in streams])}
