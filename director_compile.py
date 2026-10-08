from __future__ import annotations

import re
from typing import Any

from .director_core import FPS

H3_MIN_FRAMES = 5
H3_FRAME_STEP = 17
H3_MAX_FRAMES = 3592
MAX_REFERENCE_IMAGES = 9
MAX_REFERENCE_VIDEOS = 3
MAX_REFERENCE_AUDIOS = 3
DEFAULT_TAIL_REFERENCE_PROMPT = (
    "[镜头连续性参考]\n"
    "{picture} 为上一镜头最终帧。"
    "仅参考人物与场景状态、色彩、光线和整体基调；"
    "当前镜头按照本段描述重新构图与运镜。"
)

_ASSET_LABEL = {
    "image": "Picture",
    "video": "Video",
    "audio": "Audio",
}
_ASSET_GROUP = {
    "image": "images",
    "video": "videos",
    "audio": "audios",
}
_TAG_RE = re.compile(r"<(Picture|Video|Audio)\s+(\d+)>", re.IGNORECASE)


def h3_align_frames(frame_count: int) -> int:
    """Round a requested output length up to H3's 5 + 17*n frame grid."""
    frames = max(H3_MIN_FRAMES, int(frame_count))
    return frames + (H3_MIN_FRAMES - frames) % H3_FRAME_STEP


def h3_guide_frames(frame_count: int) -> int:
    """Largest multi-frame H3 Guide length that fits inside frame_count."""
    frames = int(frame_count)
    if frames < H3_MIN_FRAMES:
        return 0
    return frames - (frames - H3_MIN_FRAMES) % H3_FRAME_STEP


def _asset_token(asset: dict[str, Any]) -> tuple[str, int]:
    label = _ASSET_LABEL[asset["kind"]]
    return label.lower(), int(asset["number"])


def _compile_assets(
    prompt: str,
    assets: list[dict[str, Any]],
) -> tuple[str, dict[str, list[dict[str, Any]]]]:
    by_token = {_asset_token(asset): asset for asset in assets}
    referenced: list[dict[str, Any]] = []
    seen: set[str] = set()

    for match in _TAG_RE.finditer(prompt):
        token = (match.group(1).lower(), int(match.group(2)))
        asset = by_token.get(token)
        if asset is None:
            raise ValueError(f"TerryDirector prompt references missing asset {match.group(0)}")
        if asset["id"] not in seen:
            seen.add(asset["id"])
            referenced.append(asset)

    groups: dict[str, list[dict[str, Any]]] = {
        "images": [],
        "videos": [],
        "audios": [],
    }
    remap: dict[tuple[str, int], int] = {}

    for kind in ("image", "video", "audio"):
        local_number = 0
        for asset in referenced:
            if asset["kind"] != kind:
                continue
            local_number += 1
            label = _ASSET_LABEL[kind]
            global_number = int(asset["number"])
            remap[(label.lower(), global_number)] = local_number
            groups[_ASSET_GROUP[kind]].append({
                "id": asset["id"],
                "name": asset["name"],
                "source": dict(asset["source"]),
                "global_number": global_number,
                "local_number": local_number,
                "global_tag": f"<{label} {global_number}>",
                "local_tag": f"<{label} {local_number}>",
            })

    limits = {
        "images": MAX_REFERENCE_IMAGES,
        "videos": MAX_REFERENCE_VIDEOS,
        "audios": MAX_REFERENCE_AUDIOS,
    }
    for group, limit in limits.items():
        if len(groups[group]) > limit:
            raise ValueError(
                f"TerryDirector segment exceeds MiniMax H3 {group} limit: "
                f"{len(groups[group])} > {limit}"
            )

    def replace_tag(match: re.Match[str]) -> str:
        label = match.group(1)
        global_number = int(match.group(2))
        local_number = remap[(label.lower(), global_number)]
        canonical = {
            "picture": "Picture",
            "video": "Video",
            "audio": "Audio",
        }[label.lower()]
        return f"<{canonical} {local_number}>"

    return _TAG_RE.sub(replace_tag, prompt), groups


def _tail_reference_prompt(template: str, picture_number: int) -> str:
    """Resolve the user template against the actual H3 image-reference slot."""
    number = max(1, int(picture_number))
    picture = f"<Picture {number}>"
    raw = str(template or "").strip() or DEFAULT_TAIL_REFERENCE_PROMPT
    had_placeholder = "{picture}" in raw or "{picture_number}" in raw
    raw = raw.replace("{picture}", picture).replace("{picture_number}", str(number))

    # A tail-reference prompt is specifically about this dynamic image. If the
    # user typed a literal Picture ordinal, normalize it to the actual slot so
    # later changes to ordinary references cannot silently desync the prompt.
    literal_picture = re.compile(r"<Picture\s+\d+>", re.IGNORECASE)
    if literal_picture.search(raw):
        raw = literal_picture.sub(picture, raw)
    elif not had_placeholder:
        raw = f"{picture} {raw}"
    return raw


def _append_tail_reference_prompt(prompt: str, template: str, picture_number: int) -> str:
    extra = _tail_reference_prompt(template, picture_number)
    if not prompt:
        return extra
    return f"{prompt.rstrip()}\n\n{extra}"


def _effective_prompt(document: dict[str, Any], clip: dict[str, Any]) -> str:
    """Build the exact prompt H3 receives for one segment."""
    segment_prompt = str(clip.get("prompt") or "")
    if clip.get("useGlobalPrompt") is False:
        return segment_prompt

    global_prompt = str(document.get("globalPrompt") or "")
    if not global_prompt:
        return segment_prompt
    if not segment_prompt:
        return global_prompt
    return f"{global_prompt.rstrip()}\n\n{segment_prompt.lstrip()}"


def _continuity(
    previous: dict[str, Any] | None,
    clip: dict[str, Any],
) -> tuple[dict[str, Any], int, int]:
    if previous is None:
        gap = int(clip["start"])
        return {"kind": "independent"}, gap, 0

    delta = int(clip["start"]) - int(previous["end"])
    if delta > 0:
        return {"kind": "gap", "frames": delta}, delta, 0

    if delta == 0:
        mode = clip.get("transitionMode") or "tail_continuation"
        if mode == "independent":
            return {"kind": "independent"}, 0, 0
        if mode == "tail_reference":
            return {
                "kind": "tail_reference",
                "source_segment_id": previous["id"],
                "source_frame": int(previous["end"]) - int(previous["start"]) - 1,
            }, 0, 0
        return {
            "kind": "tail_frame",
            "source_segment_id": previous["id"],
            "source_frame": int(previous["end"]) - int(previous["start"]) - 1,
            "target_frame": 0,
        }, 0, 0

    overlap = -delta
    previous_frames = int(previous["end"]) - int(previous["start"])
    current_frames = int(clip["end"]) - int(clip["start"])
    if overlap >= min(previous_frames, current_frames):
        raise ValueError("TerryDirector overlap must be shorter than both adjacent segments")

    guide_frames = h3_guide_frames(overlap)
    boundary_frame = overlap - 1 if guide_frames != overlap else None
    return {
        "kind": "overlap",
        "frames": overlap,
        "source_segment_id": previous["id"],
        "source_start_frame": previous_frames - overlap,
        "video_guide_frames": guide_frames,
        "boundary_target_frame": boundary_frame,
        "audio_guide_frames": overlap,
    }, 0, overlap


def compile_timeline(
    document: dict[str, Any],
    tail_reference_prompt: str = DEFAULT_TAIL_REFERENCE_PROMPT,
) -> dict[str, Any]:
    """Compile TerryDirector's creative timeline into deterministic H3 segment tasks."""
    if not isinstance(document, dict):
        raise ValueError("TerryDirector document must be an object")
    if document.get("fps") != FPS:
        raise ValueError(f"TerryDirector timeline FPS must be {FPS}")

    clips = document.get("clips")
    assets = document.get("assets")
    if not isinstance(clips, list) or not clips:
        raise ValueError("TerryDirector timeline requires at least one segment")
    if not isinstance(assets, list):
        raise ValueError("TerryDirector assets must be a list")

    total_frames = max(int(clip["end"]) for clip in clips)
    active_clips = [
        (index, clip)
        for index, clip in enumerate(clips)
        if not clip.get("suspended", False)
    ]
    if not active_clips:
        raise ValueError("TerryDirector timeline requires at least one active segment")

    segments: list[dict[str, Any]] = []
    previous: dict[str, Any] | None = None
    assembled_frames = 0

    for index, clip in active_clips:
        if not isinstance(clip, dict):
            raise ValueError(f"TerryDirector segment {index + 1} must be an object")

        start = int(clip["start"])
        end = int(clip["end"])
        if start < 0 or end <= start:
            raise ValueError(f"TerryDirector segment {index + 1} has an invalid frame range")
        if previous is not None:
            if start <= int(previous["start"]) or end <= int(previous["end"]):
                raise ValueError("TerryDirector active segments must advance forward in timeline order")

        output_frames = end - start
        generated_frames = h3_align_frames(output_frames)
        if generated_frames > H3_MAX_FRAMES:
            raise ValueError(
                f"TerryDirector segment {index + 1} exceeds H3 maximum length "
                f"({H3_MAX_FRAMES} frames at {FPS} fps)"
            )
        effective_prompt = _effective_prompt(document, clip)
        prompt, local_assets = _compile_assets(effective_prompt, assets)
        continuity, gap_before, trim_head = _continuity(previous, clip)
        if continuity["kind"] == "tail_reference":
            if len(local_assets["images"]) >= MAX_REFERENCE_IMAGES:
                raise ValueError(
                    "TerryDirector 尾帧参考需要占用 1 个图片参考位；当前片段最多可再引用 8 张图片"
                )
            picture_number = len(local_assets["images"]) + 1
            continuity["picture_number"] = picture_number
            prompt = _append_tail_reference_prompt(
                prompt,
                tail_reference_prompt,
                picture_number,
            )
        trim_tail = generated_frames - output_frames

        segment = {
            "index": index,
            "id": str(clip["id"]),
            "name": str(clip["name"]),
            "start_frame": start,
            "end_frame": end,
            "output_frames": output_frames,
            "h3_frames": generated_frames,
            "prompt": prompt,
            "uses_global_prompt": clip.get("useGlobalPrompt") is not False,
            "transition_mode": clip.get("transitionMode") or "tail_continuation",
            "assets": local_assets,
            "continuity": continuity,
            "assembly": {
                "gap_before_frames": gap_before,
                "gap_after_frames": 0,
                "trim_head_frames": trim_head,
                "trim_tail_frames": trim_tail,
            },
        }
        segments.append(segment)
        assembled_frames += gap_before + output_frames - trim_head
        previous = clip

    trailing_gap = max(0, total_frames - int(previous["end"]))
    segments[-1]["assembly"]["gap_after_frames"] = trailing_gap
    assembled_frames += trailing_gap
    if assembled_frames != total_frames:
        raise ValueError(
            f"TerryDirector compiled timeline length mismatch: {assembled_frames} != {total_frames}"
        )

    return {
        "fps": FPS,
        "total_frames": total_frames,
        "segments": segments,
        "suspended_segment_ids": [
            str(clip["id"]) for clip in clips if clip.get("suspended", False)
        ],
    }
