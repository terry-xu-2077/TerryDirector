"""Resume a SelfLift H3 high-resolution pass from native ComfyUI sampler outputs.

Low resolution is performed by stock SamplerCustom / SamplerCustomAdvanced with
a *prefix* of the original sigma schedule. The native output at sigma[k] gives
the already-advanced audio state, while denoised_output supplies the last x0.
"""
from __future__ import annotations

import logging
from time import perf_counter

import torch

from .director_selflift import ComfyBackend
from .director_selflift_math import validate_options


def resume_highres(*, checkpoint, model, positive, negative, sampler,
                   upscaler_model,
                   highres_tiling=False, tiling_mode="auto", tiling_tiles=2,
                   tiling_axis="auto",
                   _backend=None, _lifter=None):
    from .director_selflift_checkpoint import load_checkpoint
    if isinstance(checkpoint, dict):
        checkpoint = checkpoint.get("checkpoint_id")
    started = perf_counter()
    saved = load_checkpoint(checkpoint)
    manifest = saved["manifest"]
    cfg = float(manifest["cfg"])
    seed = int(manifest["seed"])
    k = int(manifest["transition_step"])
    validate_options(cfg, 0.5)
    if not upscaler_model or upscaler_model in {"none", "nearest"}:
        raise ValueError("SelfLift: 高清续采只支持 H3 3D Latent Upscaler，请选择有效的模型文件")
    logging.info(
        "[TerryDirector SelfLift split] 开始 Latent-only 续采 checkpoint=%s "
        "low=%s high=%s upscaler=%s",
        manifest["checkpoint_id"], manifest["low_video_shape"],
        manifest["target_video_shape"], upscaler_model,
    )
    if highres_tiling and (tiling_mode not in {"auto", "manual"}
                           or tiling_axis not in {"auto", "width", "height"}
                           or tiling_tiles not in {2, 4, 6, 8}):
        raise ValueError("SelfLift: 高清空间分块参数无效")
    backend = _backend or ComfyBackend()
    # One selected MODEL drives format, flow and Euler. The workflow itself
    # chooses between the original H3 model and a separately optimized branch.
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
    # Native SamplerCustom has already processed denoised_output into VAE
    # latent space. Do not pass a bare video tensor through MiniMaxH3's
    # AV process_latent_in/out (those methods also rescale packed audio).
    clean_video_vae = low_clean[0].float()
    logging.info("[TerryDirector SelfLift split] 开始 H3 3D Latent Upscaler")
    lifted_at = perf_counter()
    if _lifter is None:
        from .director_selflift_upscaler import learned_lift
        _lifter = learned_lift
    clean_lift = _lifter(clean_video_vae, target, upscaler_model)
    logging.info("[TerryDirector SelfLift split] H3 3D Latent Upscaler 完成 %.1fs",
                 perf_counter() - lifted_at)
    if tuple(clean_lift.shape) != tuple(source[0].shape):
        raise ValueError("SelfLift: Latent 放大后视频形状不匹配")
    clean_high = fmt.process_in(clean_lift)
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
    video_resume = fmt.process_out(unscaled_video)
    resume = backend.pack([video_resume, low_state[1]])
    zero_noise = backend.pack([torch.zeros_like(video_resume),
                              torch.zeros_like(low_state[1])])
    del low_clean, low_state, noise, clean_lift, clean_video_vae
    del clean_high, video_state, video_next, unscaled_video
    backend.interrupt()
    if highres_tiling:
        logging.info(
            "[TerryDirector SelfLift split] 高清 H3 空间分块：mode=%s tiles=%d axis=%s",
            tiling_mode, tiling_tiles, tiling_axis,
        )
        model = backend.tiled_model(
            model, [tuple(s.shape) for s in source],
            tiling_mode, tiling_tiles, tiling_axis)
    model = backend.mask_model(model, source, masks)
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

    logging.info(
        "[TerryDirector SelfLift split] 进入高清 Euler 采样 %d 步（初始化已用 %.1fs）",
        total_steps - k, perf_counter() - started,
    )
    sample_at = perf_counter()
    output = backend.sample(model, zero_noise, positive, negative, cfg,
                            sampler, sigmas[k:], resume, callback, seed)
    logging.info(
        "[TerryDirector SelfLift split] 高清 Euler 采样完成 %.1fs",
        perf_counter() - sample_at,
    )
    if high_calls != total_steps - k:
        raise RuntimeError("SelfLift: 高清采样步数不符")
    streams = backend.split(output)
    if [tuple(s.shape) for s in streams] != [tuple(s.shape) for s in source]:
        raise RuntimeError("SelfLift: 高清视频/音频尺寸不匹配")
    if masks is not None:
        streams = [torch.where(m.to(s.device) == 0, original.to(s), s)
                   for s, original, m in zip(streams, source, masks)]
    logging.info("[TerryDirector SelfLift split] checkpoint=%s high_steps=%d total=%.1fs",
                 manifest["checkpoint_id"], high_calls, perf_counter() - started)
    return {"samples": backend.pack(
        [s.to(device=backend.device, dtype=backend.dtype) for s in streams])}
