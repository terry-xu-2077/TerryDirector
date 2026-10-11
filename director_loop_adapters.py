"""Model-specific policies for TerryDirector's *external-node* timeline loop.

Only this file owns loop-only decisions about H3 frame grids, reference
images, conditioning continuity and sampled LATENT decoding. The independent
native loop engine, timeline editor and streamed VIDEO output remain shared.

LTX 2.5 is deliberately a registered, unavailable placeholder. Do not silently
run LTX inputs through the H3 guide or H3 audio decoder.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType

DEFAULT_LOOP_ADAPTER = "minimax_h3"
LTX25_LOOP_ADAPTER = "ltx_2_5"


class LoopAdapterNotReadyError(RuntimeError):
    """A known generator needs a real adapter before it may be queued."""


@dataclass(frozen=True)
class LoopAdapterInfo:
    adapter_id: str
    display_name: str
    ready: bool
    description: str


class LoopModelAdapter:
    """Boundary between one creative timeline and a generator's native graph.

    No ComfyUI imports live in this base contract. The existing nodes pass
    their official compiler, guide node, image loader and cache decoder in.
    That lets H3 retain its exact behaviour without modifying Base/Advanced.
    """

    info: LoopAdapterInfo

    def compile_plan(self, document, tail_reference_prompt, *, compiler):
        raise NotImplementedError

    def sampling_frames(self, segment: dict) -> int:
        raise NotImplementedError

    def reference_images(self, segment: dict, previous_context, *, load_image):
        raise NotImplementedError

    def apply_continuity(self, segment: dict, positive, latent, vae,
                         audio_vae, *, guide_node):
        raise NotImplementedError

    def cache_segment(self, segment: dict, samples, vae, audio_vae, *,
                      cache_node):
        raise NotImplementedError


class MiniMaxH3LoopAdapter(LoopModelAdapter):
    """Preserve all currently shipped loop-specific H3 semantics."""

    info = LoopAdapterInfo(
        adapter_id=DEFAULT_LOOP_ADAPTER,
        display_name="MiniMax H3",
        ready=True,
        description="当前已接入的 H3 帧数、图片、Guide 与音画缓存适配。",
    )

    def compile_plan(self, document, tail_reference_prompt, *, compiler):
        return compiler(document, tail_reference_prompt=tail_reference_prompt)

    def sampling_frames(self, segment: dict) -> int:
        # The H3 5+17n rule stays inside director_compile.py. Other model
        # adapters MUST NOT reuse the 'h3_frames' schema field.
        return int(segment["h3_frames"])

    def reference_images(self, segment: dict, previous_context, *, load_image):
        assets = segment["assets"]
        if assets.get("videos") or assets.get("audios"):
            raise ValueError(
                "循环信息当前版本支持图片参考；视频/音频资产适配尚未实现，"
                "请先使用图片参考工作流测试。"
            )
        images = [load_image(asset) for asset in assets["images"]]
        if segment["continuity"]["kind"] == "tail_reference":
            previous = (previous_context or {}).get("images")
            if previous is None or previous.shape[0] < 1:
                raise ValueError("尾帧参考需要上一片段生成的真实尾帧")
            slot = int(segment["continuity"]["picture_number"]) - 1
            if slot != len(images):
                raise ValueError("尾帧参考序号与参考图输入位置不一致")
            images.append(previous[-1:].clone())
        if len(images) > 9:
            raise ValueError("当前循环信息节点最多提供 9 个参考图片输入")
        return images

    def apply_continuity(self, segment: dict, positive, latent, vae,
                         audio_vae, *, guide_node):
        previous_context = segment["previous_context"]
        continuity = segment["continuity"]
        kind = continuity["kind"]
        if kind in ("independent", "gap", "tail_reference"):
            return positive
        previous = previous_context or {}
        images = previous.get("images")
        audio = previous.get("audio")
        if images is None or audio is None:
            raise ValueError(f"{kind} 承接需要上一片段的真实 IMAGE/AUDIO")
        if kind == "tail_frame":
            return guide_node.execute(
                positive=positive, latent=latent, vae=vae,
                image=images[-1:], frame_idx=0,
            )[0]
        if kind != "overlap":
            raise ValueError(f"无法识别的循环条件模式: {kind}")
        frames = int(continuity["frames"])
        if images.shape[0] < frames:
            raise ValueError("上一片段保留的重叠图像帧不足")
        waveform = audio["waveform"]
        rate = int(audio["sample_rate"])
        samples = round(frames * rate / 24)
        if waveform.shape[-1] < samples:
            raise ValueError("上一片段保留的重叠音频不足")
        overlap_audio = {
            "waveform": waveform[..., -samples:].clone(),
            "sample_rate": rate,
        }
        image_frames = int(continuity["video_guide_frames"])
        result = guide_node.execute(
            positive=positive, latent=latent,
            audio_vae=audio_vae, audio=overlap_audio,
            vae=vae if image_frames else None,
            image=images[-frames:][:image_frames] if image_frames else None,
            frame_idx=0,
        )[0]
        boundary_frame = continuity.get("boundary_target_frame")
        if boundary_frame is not None:
            result = guide_node.execute(
                positive=result, latent=latent, vae=vae,
                image=images[-1:], frame_idx=int(boundary_frame),
            )[0]
        return result

    def cache_segment(self, segment: dict, samples, vae, audio_vae, *,
                      cache_node):
        loop = segment["_loop"]
        assembly = segment["assembly"]
        # The Base cache itself remains untouched and retains its already
        # verified H3 AV decode, overlap trim and compact next-step context.
        return cache_node.execute(
            samples=samples,
            vae=vae,
            audio_vae=audio_vae,
            cache_key=loop["cache_key"],
            run_signature=loop["run_signature"],
            segment_id=segment["id"],
            signature=loop["signature"],
            output_frames=int(segment["output_frames"]),
            trim_head_frames=int(assembly["trim_head_frames"]),
            gap_frames=int(assembly["gap_before_frames"]),
            gap_after_frames=int(assembly["gap_after_frames"]),
            context_frames=int(loop["context_frames"]),
            fps=24,
        )


class LTX25ReservedAdapter(LoopModelAdapter):
    """Stable registration only; no unsupported LTX 2.5 runtime behaviour."""

    info = LoopAdapterInfo(
        adapter_id=LTX25_LOOP_ADAPTER,
        display_name="LTX 2.5（预留）",
        ready=False,
        description=(
            "尚未适配 LTX 2.5 的 8n+1 帧数规则、图片/潜变量条件、"
            "联合音视频解码及逐段缓存；不可用于生成。"
        ),
    )


_REGISTRY = MappingProxyType({
    DEFAULT_LOOP_ADAPTER: MiniMaxH3LoopAdapter(),
    LTX25_LOOP_ADAPTER: LTX25ReservedAdapter(),
})


def loop_adapter_catalog() -> tuple[LoopAdapterInfo, ...]:
    """For future UI capability reporting; does not expose unusable controls."""
    return tuple(adapter.info for adapter in _REGISTRY.values())


def get_loop_adapter(adapter_id: str = DEFAULT_LOOP_ADAPTER,
                     *, require_ready: bool = True) -> LoopModelAdapter:
    """Select a known adapter, fail closed for unknown/unimplemented models."""
    key = str(adapter_id or "").strip()
    adapter = _REGISTRY.get(key)
    if adapter is None:
        raise ValueError(
            f"未知的 TerryDirector 循环模型适配器：{key!r}。"
            f"已登记：{', '.join(_REGISTRY)}"
        )
    if require_ready and not adapter.info.ready:
        raise LoopAdapterNotReadyError(
            f"{adapter.info.display_name} 尚未接入 TerryDirector 循环器。"
            f"{adapter.info.description}"
        )
    return adapter


def adapter_from_segment(segment: dict) -> LoopModelAdapter:
    """Resolve the adapter used for this run; legacy H3 packets stay H3."""
    if not isinstance(segment, dict):
        raise ValueError("循环片段数据无效")
    loop = segment.get("_loop")
    if loop is None:
        loop = {}
    if not isinstance(loop, dict):
        raise ValueError("循环片段中的模型适配信息无效")
    return get_loop_adapter(loop.get("adapter_id", DEFAULT_LOOP_ADAPTER))
