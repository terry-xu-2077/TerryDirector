"""Resume H3 SelfLift from a raw stage boundary or a native-sampler checkpoint.

Stage boundaries retain callback x/x0 before the final low Euler update. Older
stock SamplerCustom checkpoints instead carry audio already advanced to sigma[k].
Both paths consume the unchanged suffix of the complete sigma schedule.
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
                   _backend=None, _lifter=None, _saved=None, high_steps=None):
    if isinstance(checkpoint, dict):
        checkpoint = checkpoint.get("checkpoint_id")
    started = perf_counter()
    if _saved is None:
        from .director_selflift_checkpoint import load_checkpoint
        saved = load_checkpoint(checkpoint)
    else:
        saved = _saved
    manifest = saved["manifest"]
    remaining_steps = saved["sigmas"].numel() - 1 - int(manifest["transition_step"])
    if high_steps is not None and (type(high_steps) is not int or high_steps != remaining_steps):
        raise ValueError(f"SelfLift: 高清步数必须与完整 SIGMAS 的剩余 {remaining_steps} 步一致")
    raw_boundary = saved.get("state_space") == "sampler"
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
    # Raw callback video needs format conversion; native SamplerCustom
    # denoised_output has already been converted to VAE latent space.
    clean_video_vae = (fmt.process_out(low_clean[0].float()) if raw_boundary else low_clean[0].float())
    spatial_anchor = clean_video_vae.detach().clone() if raw_boundary and highres_tiling else None
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
    if raw_boundary:
        # The transition belongs to the low model, even when the high model uses
        # a different audio/video shift. Only its CONST noise scale is needed.
        import copy
        flow = copy.copy(flow)
        flow.noise_scale = saved["noise_scale"]
    sigma_old, sigma_resume = (s.to(backend.device) for s in
                               (saved["sigmas"][k-1], saved["sigmas"][k]))
    noise = backend.noise(clean_high, (seed + 1) % (1 << 64),
                          manifest.get("batch_index")).to(clean_high)
    from .director_selflift_math import advance_euler
    video_state = flow.noise_scaling(sigma_old, noise, clean_high)
    video_next = advance_euler(video_state, clean_high, sigma_old, sigma_resume)
    unscaled_video = flow.inverse_noise_scaling(sigma_resume, video_next)
    # Raw callbacks are before the final low Euler interval. Native checkpoint
    # output has already completed it, so only raw audio needs that update.
    if raw_boundary:
        audio_next = advance_euler(low_state[1], low_clean[1], sigma_old, sigma_resume)
        unscaled_audio = flow.inverse_noise_scaling(sigma_resume, audio_next)
        # MiniMaxH3.process_latent_out with the LOW model's audio scale. The
        # high model may not have latent_shapes initialized after a disk resume.
        unscaled_audio = unscaled_audio * (1.0 / saved["audio_scale"])
        resume = fmt.process_out(backend.pack([unscaled_video, unscaled_audio]))
        zero_noise = backend.pack([torch.zeros_like(unscaled_video), torch.zeros_like(unscaled_audio)])
    else:
        video_resume = fmt.process_out(unscaled_video)
        resume = backend.pack([video_resume, low_state[1]])
        zero_noise = backend.pack([torch.zeros_like(video_resume), torch.zeros_like(low_state[1])])
    del low_clean, low_state, noise, clean_lift, clean_video_vae
    del clean_high, video_state, video_next, unscaled_video
    backend.interrupt()
    if highres_tiling:
        logging.info(
            "[TerryDirector SelfLift split] 高清 H3 空间分块：mode=%s tiles=%d axis=%s",
            tiling_mode, tiling_tiles, tiling_axis,
        )
        options = {}
        if spatial_anchor is not None:
            from .director_selflift_tiling import append_spatial_reference, spatial_scores
            positive = append_spatial_reference(positive, spatial_anchor)
            options = {"overlap": 6, "scores": spatial_scores(spatial_anchor)}
        model = backend.tiled_model(
            model, [tuple(s.shape) for s in source],
            tiling_mode, tiling_tiles, tiling_axis, **options)
    model = backend.mask_model(model, source, masks)
    sigmas = saved["sigmas"].to(backend.device)
    remaining = sigmas[k:]
    remaining_steps = remaining.numel() - 1
    # ComfyUI's latent_preview callback owns the native ProgressBar and emits
    # progress events for the executing SelfLiftHighres node. Track only the
    # remaining high-resolution Euler steps (1/N, 2/N...) rather than 7/9.
    preview = backend.preview(model, remaining_steps)
    high_calls = 0

    def callback(step, clean, state, total):
        nonlocal high_calls
        high_calls += 1
        if high_calls > remaining_steps:
            raise RuntimeError("SelfLift: 高清采样超过预期步数")
        if preview is not None:
            preview(high_calls - 1, clean, state, remaining_steps)

    logging.info(
        "[TerryDirector SelfLift split] 进入高清 Euler 采样 %d 步（初始化已用 %.1fs）",
        remaining_steps, perf_counter() - started,
    )
    sample_at = perf_counter()
    output = backend.sample(model, zero_noise, positive, negative, cfg,
                            sampler, remaining, resume, callback, seed)
    logging.info(
        "[TerryDirector SelfLift split] 高清 Euler 采样完成 %.1fs",
        perf_counter() - sample_at,
    )
    if high_calls != remaining_steps:
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
