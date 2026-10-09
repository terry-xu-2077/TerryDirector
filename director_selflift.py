"""TerryDirector-owned progressive-resolution H3 sampler.

Algorithm reference: slmonker/selflift-Avatar @ dc8e545601e3460bde6260c806c6893ce04597c5.
This is a local implementation, not an import, wrapper, or vendored node from that
plugin. See docs/30_SELFLIFT_INTERNAL.md for equations, scope and differences.
Only ComfyUI core and PyTorch are required at runtime.
"""
from __future__ import annotations

import logging
import math
from types import SimpleNamespace

import torch
import torch.nn.functional as F

ENGINE_VERSION = "terry-selflift-v1"
LOG = logging.getLogger(__name__)


def spatial_resize(value, size, *, nearest=False):
    """Resize H/W independently for every channel and temporal position."""
    if tuple(value.shape[-2:]) == tuple(size):
        return value
    leading = value.shape[:-2]
    flat = value.reshape(-1, 1, *value.shape[-2:]).float()
    options = {} if nearest else {"align_corners": False}
    out = F.interpolate(flat, size=tuple(size), mode="nearest" if nearest else "bilinear", **options)
    return out.reshape(*leading, *size).to(value.dtype)


def validate_schedule(sigmas, transition):
    if not isinstance(sigmas, torch.Tensor) or sigmas.ndim != 1 or not sigmas.is_floating_point():
        raise ValueError("TerryDirector SelfLift: SIGMAS 必须是一维浮点 Tensor")
    if sigmas.numel() < 3 or not 1 <= int(transition) <= sigmas.numel() - 2:
        raise ValueError("TerryDirector SelfLift: 低清和高清阶段必须各保留至少一步")
    if not bool(torch.isfinite(sigmas).all()) or bool((sigmas < 0).any()):
        raise ValueError("TerryDirector SelfLift: Sigma 不能包含负数或 NaN/Inf")
    if bool((sigmas[1:] > sigmas[:-1]).any()) or bool((sigmas[:-1] <= 0).any()):
        raise ValueError("TerryDirector SelfLift: Sigma 必须非递增，且仅末项允许为零")
    if float(sigmas[int(transition)]) >= 1:
        raise ValueError("TerryDirector SelfLift: 高清阶段起始 Sigma 必须小于 1")


def euler_advance(state, clean, sigma, sigma_next):
    ratio = torch.as_tensor((sigma_next - sigma) / sigma, device=state.device, dtype=state.dtype)
    return state + (state - clean.to(state)) * ratio


def correct_lift(direct, anchor, rho, w_min, w_max, mask=None):
    """Correct high-disagreement locations, independently within each batch item."""
    if rho <= 0 or w_max <= 0:
        if direct is None:
            raise ValueError("SelfLift direct lift is missing")
        return direct
    if anchor is None:
        raise ValueError("SelfLift pixel anchor is missing")
    if rho == 1 and w_min == 1:
        return anchor
    if direct is None or direct.shape != anchor.shape:
        raise ValueError("SelfLift paired lifts have different shapes")
    direct = direct.float()
    delta = anchor.to(direct) - direct
    risk_delta = delta if mask is None else delta * mask.to(delta)
    risk = risk_delta.abs().mean(1)
    active = torch.ones_like(risk, dtype=torch.bool) if mask is None else (
        mask.to(delta).expand_as(delta).amax(1) > 0
    )
    weights = torch.zeros_like(risk)
    for b in range(risk.shape[0]):
        eligible = risk[b][active[b]]
        if eligible.numel() == 0:
            continue
        cutoff = torch.quantile(eligible, 1.0 - float(rho))
        chosen = active[b] & (risk[b] >= cutoff)
        values = risk[b][chosen]
        lo, hi = values.amin(), values.amax()
        weights[b][chosen] = w_min + (w_max - w_min) * (values - lo) / (hi - lo + 1e-8)
    return direct + weights.unsqueeze(1) * delta


def condition_at_resolution(conditioning, size):
    """Only target-grid keyframes change; reference images/audio stay untouched."""
    result = []
    for text, metadata in conditioning:
        keyframes = metadata.get("minimax_keyframes")
        if not keyframes:
            result.append((text, metadata))
            continue
        updated = []
        for keyframe in keyframes:
            item = dict(keyframe)
            latent = item.get("latent")
            if latent is not None and tuple(latent.shape[-2:]) != tuple(size):
                resized = spatial_resize(latent.float(), size)
                # Keep each channel/frame mean rather than amplifying missing variance.
                resized += latent.float().mean((-2, -1), keepdim=True) - resized.mean((-2, -1), keepdim=True)
                item["latent"] = resized.to(latent.dtype)
            updated.append(item)
        result.append((text, {**metadata, "minimax_keyframes": updated}))
    return result


def unpack(value):
    return list(value.unbind()) if getattr(value, "is_nested", False) else [value]


def normalize_masks(value, streams):
    if value is None:
        return None
    if getattr(value, "is_nested", False):
        parts = unpack(value)
    elif isinstance(value, torch.Tensor):
        counts = [math.prod(s.shape[1:]) for s in streams]
        if len(streams) > 1 and value.ndim == 3 and tuple(value.shape[1:]) == (1, sum(counts)):
            parts = [part.reshape(value.shape[0], *s.shape[1:])
                     for part, s in zip(value.split(counts, -1), streams)]
        else:
            parts = [value] + [None] * (len(streams) - 1)
    else:
        raise ValueError("SelfLift noise_mask 必须为 Tensor 或 H3 NestedTensor")
    if len(parts) != len(streams):
        raise ValueError("SelfLift 遮罩与音视频流数量不一致")
    masks = []
    for index, (part, stream) in enumerate(zip(parts, streams)):
        if part is None:
            masks.append(torch.ones((1,) * stream.ndim, dtype=torch.float32, device=stream.device))
            continue
        if not isinstance(part, torch.Tensor) or part.numel() == 0 or not bool(torch.isfinite(part).all()):
            raise ValueError(f"SelfLift 第 {index} 个遮罩为空或包含 NaN/Inf")
        m = part.float().clamp(0, 1)
        if index == 0:
            if m.ndim == 3:
                m = m[:, None]
            if m.ndim == 4:
                m = m[:, :, None]
            if m.ndim != 5:
                raise ValueError("SelfLift 视频遮罩应为 BHW/BCHW/BCTHW")
            if any(a not in (1, b) for a, b in zip(m.shape[:3], stream.shape[:3])):
                raise ValueError("SelfLift 视频遮罩的批次/通道/时间维度不匹配")
            if any(a not in (1, b) for a, b in zip(m.shape[-2:], stream.shape[-2:])):
                m = spatial_resize(m, stream.shape[-2:])
        else:
            if stream.ndim != 4 or m.ndim not in (1, 2, 3, 4):
                raise ValueError("SelfLift 音频遮罩应为 T/BT/BST/BCST")
            if m.ndim == 1:
                m = m[None, None, None]
            elif m.ndim == 2:
                m = m[:, None, None]
            elif m.ndim == 3:
                m = m[:, None]
            if any(a not in (1, b) for a, b in zip(m.shape, stream.shape)):
                constant = m[..., :1, :1]
                if torch.equal(m, constant.expand_as(m)):
                    m = constant
                else:
                    raise ValueError("SelfLift 不对音频遮罩做空间或时间插值，请使用匹配的 BCST 或常量遮罩")
        if any(a not in (1, b) for a, b in zip(m.shape, stream.shape)):
            raise ValueError(f"SelfLift 遮罩形状 {tuple(m.shape)} 无法匹配 {tuple(stream.shape)}")
        masks.append(m)
    return masks


def pixel_anchor(video, vae, size):
    """Decode/resize/re-encode one clip at a time; never merge latent batches."""
    outputs = []
    for single in video.split(1):
        frames = vae.decode(single)
        if frames.ndim == 5:
            frames = frames.reshape(-1, *frames.shape[-3:])
        if frames.ndim != 4 or frames.shape[-1] not in (3, 4):
            raise ValueError("SelfLift VAE 解码输出不是帧序列")
        sy, sx = frames.shape[1] / single.shape[-2], frames.shape[2] / single.shape[-1]
        target = (round(size[0] * sy), round(size[1] * sx))
        # CPU fp32 bicubic has consistent support; capped frame chunks limit scratch memory.
        enlarged = torch.empty((frames.shape[0], *target, frames.shape[-1]), device="cpu", dtype=torch.float32)
        for start in range(0, len(frames), 8):
            chunk = frames[start:start + 8].movedim(-1, 1).float().cpu()
            enlarged[start:start + 8] = F.interpolate(
                chunk, size=target, mode="bicubic", align_corners=False, antialias=True
            ).movedim(1, -1)
        del frames
        encoded = vae.encode(enlarged)
        if encoded.shape[2] != single.shape[2] or tuple(encoded.shape[-2:]) != tuple(size):
            raise ValueError("SelfLift 像素锚点重编码后的时间/空间尺寸不匹配")
        outputs.append(encoded.float())
    return torch.cat(outputs)


def _native():
    import comfy.k_diffusion.sampling
    import comfy.model_management
    import comfy.model_sampling
    import comfy.nested_tensor
    import comfy.patcher_extension
    import comfy.sample
    import comfy.samplers
    import comfy.utils
    import latent_preview
    return SimpleNamespace(
        mm=comfy.model_management, sampling=comfy.samplers, sample=comfy.sample,
        utils=comfy.utils, const=comfy.model_sampling.CONST,
        euler=comfy.k_diffusion.sampling.sample_euler,
        nested=comfy.nested_tensor.NestedTensor,
        wrappers=comfy.patcher_extension.WrappersMP, preview=latent_preview,
    )


def _with_static_masks(native, model, anchors, masks, nested):
    if masks is None:
        return model
    packed_anchor = native.utils.pack_latents(anchors)[0] if nested else anchors[0]
    expanded = [m.to(a.device).expand_as(a) for a, m in zip(anchors, masks)]
    packed_mask = native.utils.pack_latents(expanded)[0] if nested else expanded[0]
    patched = model.clone()
    if "denoise_mask_function" in patched.model_options:
        raise ValueError("SelfLift 静态遮罩不能与动态 denoise_mask_function 同时使用")

    def outer(executor, noise, latent_image, sampler, sigmas, denoise_mask=None,
              callback=None, disable_pbar=False, seed=None, latent_shapes=None):
        def with_anchor(model_k, state, schedule, **kwargs):
            # Resume state may be noisy. The keep-region anchor must still be clean.
            owner = model_k.inner_model.inner_model
            model_k.latent_image = owner.process_latent_in(packed_anchor.to(state))
            return sampler.sampler_function(model_k, state, schedule, **kwargs)
        anchored = native.sampling.KSAMPLER(
            with_anchor, sampler.extra_options.copy(), sampler.inpaint_options.copy()
        )
        return executor(noise, latent_image, anchored, sigmas,
                        denoise_mask=packed_mask.to(model.load_device), callback=callback,
                        disable_pbar=disable_pbar, seed=seed, latent_shapes=latent_shapes)
    patched.add_wrapper_with_key(native.wrappers.OUTER_SAMPLE, "terry_selflift_mask", outer)
    return patched


def sample_h3(*, model, positive, negative, vae, latent_image, sampler, sigmas, seed,
              cfg, transition_step, lowres_scale, rho, w_min, w_max, upscaler_model,
              high_res_model=None, highres_tiling=False, tiling_mode="auto",
              tiling_tiles=2, tiling_axis="auto"):
    """Use native H3 denoisers; own the resolution transition and state hand-off."""
    validate_schedule(sigmas, transition_step)
    if not 0.25 <= lowres_scale <= 1 or not 0 <= rho <= 1 or not 0 <= w_min <= w_max <= 1:
        raise ValueError("SelfLift 低清比例或纠偏权重无效")
    if not math.isfinite(float(cfg)) or not 0 <= cfg <= 100:
        raise ValueError("SelfLift CFG 无效")
    if upscaler_model == "none" and rho == 0:
        raise ValueError("SelfLift rho=0 时必须选择 H3 Latent 放大模型")
    n = _native()
    high = model if high_res_model is None else high_res_model
    for selected in (model, high):
        if not isinstance(selected.get_model_object("model_sampling"), n.const):
            raise ValueError("SelfLift 需要兼容的 rectified-flow 模型")
    if not isinstance(sampler, n.sampling.KSAMPLER) or sampler.sampler_function is not n.euler:
        raise ValueError("SelfLift 只支持标准 Euler 采样器")
    if sampler.extra_options.get("s_churn", 0) != 0:
        raise ValueError("SelfLift Euler s_churn 必须为零")
    if type(model.get_model_object("latent_format")) is not type(high.get_model_object("latent_format")):
        raise ValueError("SelfLift 两阶段模型的 latent format 必须一致")
    samples = n.sample.fix_empty_latent_channels(
        model, latent_image["samples"], latent_image.get("downscale_ratio_spacial"),
        latent_image.get("downscale_ratio_temporal")
    )
    nested = bool(getattr(samples, "is_nested", False))
    streams = unpack(samples)
    if len(streams) != 2 or streams[0].ndim != 5 or streams[1].ndim != 4:
        raise ValueError("TerryDirector SelfLift 需要 H3 音视频双流 LATENT")
    if any(s.numel() == 0 or s.shape[0] != streams[0].shape[0] for s in streams):
        raise ValueError("SelfLift 音视频流为空或批次数不同")
    pack = lambda items: n.nested(items) if nested else items[0]
    device = n.mm.intermediate_device()
    originals = [s.to(device) for s in streams]
    masks = normalize_masks(latent_image.get("noise_mask"), streams)
    if highres_tiling and masks is not None and not (
        bool((masks[0] == 1).all()) and bool((masks[1] == 0).all())
    ):
        raise ValueError("SelfLift 高清分块仅支持无遮罩，或视频全生成/音频全保留；其他遮罩请关闭分块")
    H, W = originals[0].shape[-2:]
    low_hw = tuple(max(2, round(x * lowres_scale / 2) * 2) for x in (H, W))
    low_streams = [spatial_resize(originals[0], low_hw), originals[1]]
    low_masks = None if masks is None else [spatial_resize(masks[0], low_hw), masks[1]]
    low_model = _with_static_masks(n, model, low_streams, low_masks, nested)
    low_latent = pack(low_streams)
    noise = n.sample.prepare_noise(low_latent, int(seed), latent_image.get("batch_index"))
    total = sigmas.numel() - 1
    boundary = {}
    counts = [0, 0]
    preview = n.preview.prepare_callback(model, total)

    def low_callback(step, clean, state, steps):
        index = counts[0]
        counts[0] += 1
        if counts[0] == transition_step:
            boundary["state"] = [s.detach().clone().to(device) for s in unpack(state)]
            boundary["clean"] = [s.detach().clone().to(device) for s in unpack(clean)]
        shown = unpack(clean)
        shown[0] = spatial_resize(shown[0], (H, W))
        preview(index, pack(shown), pack(shown), total)

    LOG.info("[TerryDirector SelfLift] backend=%s low=%s target=%s low_steps=%d high_steps=%d rho=%.3f",
             ENGINE_VERSION, low_hw, (H, W), transition_step, total - transition_step, rho)
    with torch.no_grad():
        n.sampling.sample(
            low_model, noise, condition_at_resolution(positive, low_hw),
            condition_at_resolution(negative, low_hw), cfg, low_model.load_device,
            sampler, sigmas[:transition_step + 1], low_model.model_options,
            latent_image=low_latent, callback=low_callback,
            disable_pbar=not n.utils.PROGRESS_BAR_ENABLED, seed=int(seed)
        )
        if counts[0] != transition_step or not boundary:
            raise RuntimeError("SelfLift 低清回调次数不匹配，无法安全复用边界步")
        del low_latent, noise, low_streams, low_model
        sigma_before, sigma_after = sigmas[transition_step - 1:transition_step + 1]
        audio_next = euler_advance(boundary["state"][1], boundary["clean"][1], sigma_before, sigma_after)
        fmt_low = model.get_model_object("latent_format")
        fmt_high = high.get_model_object("latent_format")
        endpoint = fmt_low.process_out(boundary["clean"][0].float())
        boundary.clear()
        pure_anchor = rho == 1 and w_min == 1
        direct = anchor = None
        if not pure_anchor:
            if upscaler_model == "none":
                lifted = spatial_resize(endpoint, (H, W), nearest=True)
            else:
                from .director_lift_model import lift_video
                lifted = lift_video(endpoint, (H, W), upscaler_model)
            direct = fmt_high.process_in(lifted.float()).to(device)
        if rho > 0 and w_max > 0:
            anchor = fmt_high.process_in(pixel_anchor(endpoint, vae, (H, W))).to(device)
        clean_high = correct_lift(direct, anchor, rho, w_min, w_max, None if masks is None else masks[0])
        if masks is not None:
            m = masks[0].to(clean_high)
            clean_high = clean_high * m + fmt_high.process_in(originals[0].to(clean_high)) * (1 - m)
        del endpoint, direct, anchor
        flow = high.get_model_object("model_sampling")
        high_noise = n.sample.prepare_noise(clean_high, (int(seed) + 1) % (1 << 64), latent_image.get("batch_index")).to(clean_high)
        video_next = euler_advance(flow.noise_scaling(sigma_before, high_noise, clean_high),
                                   clean_high, sigma_before, sigma_after)
        # Native sampling reapplies noise_scaling: remove that scale first, with zero new noise.
        next_streams = [flow.inverse_noise_scaling(sigma_after, s) for s in (video_next, audio_next)]
        resume = high.model.process_latent_out(pack(next_streams))
        no_noise = pack([torch.zeros_like(s) for s in next_streams])
        del clean_high, high_noise, video_next, audio_next, next_streams
        if highres_tiling:
            from .director_selflift_tiling import patch_tiling
            high = patch_tiling(high, [tuple(s.shape) for s in originals], tiling_mode, tiling_tiles, tiling_axis)
        high = _with_static_masks(n, high, originals, masks, nested)

        def high_callback(step, clean, state, steps):
            index = counts[1]
            counts[1] += 1
            preview(transition_step + index, clean, state, total)

        result = n.sampling.sample(
            high, no_noise, positive, negative, cfg, high.load_device, sampler,
            sigmas[transition_step:], high.model_options, latent_image=resume,
            callback=high_callback, disable_pbar=not n.utils.PROGRESS_BAR_ENABLED, seed=int(seed)
        )
        if counts[1] != total - transition_step:
            raise RuntimeError("SelfLift 高清回调次数不匹配")
        if masks is not None:
            result = pack([torch.where(m.to(s.device) == 0, a.to(s), s)
                           for s, a, m in zip(unpack(result), originals, masks)])
        LOG.info("[TerryDirector SelfLift] complete: low=%d high=%d", *counts)
        return {**latent_image, "samples": result.to(device=device, dtype=n.mm.intermediate_dtype())}
