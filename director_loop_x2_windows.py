"""Pure MiniMax H3 temporal window planner for low-peak 2X VAE decode.

The layout follows H3's causal latent grid: 2 base latents produce 5 frames,
and each further group of 5 latents adds 17 video frames.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class H3DecodeWindow:
    latent_start: int
    latent_stop: int
    decoded_frames: int
    discard_frames: int
    keep_frames: int
    destination_start: int


def h3_total_frames(latent_frames: int) -> int:
    latent_frames = int(latent_frames)
    if latent_frames < 2 or (latent_frames - 2) % 5:
        raise ValueError(
            f"H3 视频 Latent 必须遵循 2+5n 时间网格，实际 T={latent_frames}"
        )
    return 5 + 17 * ((latent_frames - 2) // 5)


def h3_decode_windows(
    latent_frames: int, tile_frames: int = 51, context_frames: int = 39
) -> list[H3DecodeWindow]:
    """Produce overlapping decoder windows; only copy each window's new frames.

    Later windows include causal context, which is decoded again and discarded.
    This avoids concatenating complete decoded pieces in system RAM.
    """
    total_frames = h3_total_frames(latent_frames)
    groups = (int(latent_frames) - 2) // 5
    core_groups = max(1, round(max(17, int(tile_frames)) / 17))
    context_groups = max(0, round((max(5, int(context_frames)) - 5) / 17))
    if groups == 0:
        return [H3DecodeWindow(0, 2, 5, 0, 5, 0)]

    windows: list[H3DecodeWindow] = []
    completed = 0
    destination = 0
    while completed < groups:
        core = min(core_groups, groups - completed)
        if completed == 0:
            start = 0
            stop = 2 + 5 * core
            discard = 0
            keep = 5 + 17 * core
        else:
            overlap = min(context_groups, completed)
            start = 5 * (completed - overlap)
            stop = 2 + 5 * (completed + core)
            discard = 5 + 17 * overlap
            keep = 17 * core
        local_frames = h3_total_frames(stop - start)
        if local_frames - discard != keep:
            raise RuntimeError("H3 时间分块输出帧数不匹配")
        windows.append(H3DecodeWindow(start, stop, local_frames, discard, keep, destination))
        completed += core
        destination += keep

    if destination != total_frames:
        raise RuntimeError("H3 时间分块未覆盖所有输出帧")
    return windows
