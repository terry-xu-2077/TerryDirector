from __future__ import annotations

import json
from typing import Any

FPS = 24
CONFIG_VERSION = 3
DOCUMENT_VERSION = 1
RUNTIME_CONFIG_VERSION = 1
RUNTIME_CONFIG_TYPE = "TERRYDIRECTOR_CONFIG"


def default_document() -> dict[str, Any]:
    return {
        "version": DOCUMENT_VERSION,
        "fps": FPS,
        "selected": "clip-1",
        "clips": [
            {
                "id": "clip-1",
                "name": "片段 01",
                "start": 0,
                "end": 10 * FPS,
                "prompt": "",
                "refs": [],
            }
        ],
        "assets": [],
    }


def default_config() -> dict[str, Any]:
    """Serialized state owned by the TerryDirector creative node.

    Generation/runtime settings deliberately live in the dedicated
    TerryDirectorConfig node and are not duplicated here.
    """

    return {
        "version": CONFIG_VERSION,
        "document": default_document(),
    }


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_document(value: Any) -> dict[str, Any]:
    base = default_document()
    if not isinstance(value, dict):
        return base

    clips: list[dict[str, Any]] = []
    seen_clip_ids: set[str] = set()
    for index, raw in enumerate(value.get("clips") or []):
        if not isinstance(raw, dict):
            continue
        clip_id = str(raw.get("id") or f"clip-{index + 1}")
        if clip_id in seen_clip_ids:
            clip_id = f"clip-{index + 1}-{len(seen_clip_ids) + 1}"
        seen_clip_ids.add(clip_id)
        start = max(0, _as_int(raw.get("start"), 0))
        end = max(start + 1, _as_int(raw.get("end"), start + 10 * FPS))
        refs = [str(x) for x in (raw.get("refs") or []) if isinstance(x, (str, int))]
        clips.append({
            "id": clip_id,
            "name": str(raw.get("name") or f"片段 {index + 1:02d}")[:120],
            "start": start,
            "end": end,
            "prompt": str(raw.get("prompt") or ""),
            "refs": refs,
        })

    if not clips:
        clips = base["clips"]

    assets: list[dict[str, Any]] = []
    seen_asset_ids: set[str] = set()
    for raw in value.get("assets") or []:
        if not isinstance(raw, dict):
            continue
        asset_id = str(raw.get("id") or "").strip()
        kind = str(raw.get("kind") or "").lower()
        source = raw.get("source") if isinstance(raw.get("source"), dict) else {}
        path = str(source.get("path") or "").replace("\\", "/").lstrip("/")
        if not asset_id or asset_id in seen_asset_ids or kind not in {"image", "video", "audio"} or not path:
            continue
        number = max(1, _as_int(raw.get("number"), 1))
        seen_asset_ids.add(asset_id)
        assets.append({
            "id": asset_id,
            "name": str(raw.get("name") or path.rsplit("/", 1)[-1])[:240],
            "kind": kind,
            "number": number,
            "source": {"type": "comfy-input", "path": path},
        })

    valid_asset_ids = {item["id"] for item in assets}
    for clip in clips:
        clip["refs"] = [ref for ref in clip["refs"] if ref in valid_asset_ids]

    selected = str(value.get("selected") or "")
    if selected not in {clip["id"] for clip in clips}:
        selected = clips[0]["id"]

    return {
        "version": DOCUMENT_VERSION,
        "fps": FPS,
        "selected": selected,
        "clips": clips,
        "assets": assets,
    }


def normalize_config(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("TerryDirector config_json is not valid JSON") from exc

    if not isinstance(value, dict):
        raise ValueError("TerryDirector config must be an object")
    if value.get("version") != CONFIG_VERSION:
        raise ValueError(
            f"Unsupported TerryDirector config version: {value.get('version')!r}"
        )
    if not isinstance(value.get("document"), dict):
        raise ValueError("TerryDirector config is missing document")

    return {
        "version": CONFIG_VERSION,
        "document": normalize_document(value["document"]),
    }


def config_json(value: Any | None = None) -> str:
    normalized = normalize_config(default_config() if value is None else value)
    return json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))


def _second_pass(method: str, model: str, high_steps: int) -> dict[str, Any]:
    if method not in {"none", "selflift"}:
        raise ValueError(f"Unsupported second-pass method: {method!r}")
    if int(high_steps) < 1:
        raise ValueError("SelfLift high_steps must be at least 1")
    return {
        "method": method,
        "model": str(model),
        "high_steps": int(high_steps),
    }


def make_runtime_config(
    *,
    model: Any,
    clip: Any,
    vae: Any,
    audio_vae: Any,
    width: int,
    height: int,
    sampler: Any,
    sigmas: Any,
    seed: int = 0,
    ref_image_size: str = "match",
    second_pass_method: str = "none",
    second_pass_model: str = "",
    second_pass_high_steps: int = 4,
) -> dict[str, Any]:
    width = _as_int(width, 0)
    height = _as_int(height, 0)
    if width < 32 or height < 32:
        raise ValueError("TerryDirector width and height must both be at least 32")

    image_size = str(ref_image_size or "match")
    if image_size not in {"match", "max"}:
        image_size = "match"

    return {
        "type": RUNTIME_CONFIG_TYPE,
        "version": RUNTIME_CONFIG_VERSION,
        "model": model,
        "clip": clip,
        "vae": vae,
        "audio_vae": audio_vae,
        "width": width,
        "height": height,
        "sampler": sampler,
        "sigmas": sigmas,
        "params": {
            "seed": max(0, min(0xFFFFFFFFFFFFFFFF, _as_int(seed, 0))),
            "ref_image_size": image_size,
            "second_pass": _second_pass(
                second_pass_method, second_pass_model, second_pass_high_steps
            ),
        },
    }


def require_runtime_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Director Config must come from the TerryDirector 配置 node")
    if value.get("type") != RUNTIME_CONFIG_TYPE:
        raise ValueError("Invalid TerryDirector runtime config type")
    if value.get("version") != RUNTIME_CONFIG_VERSION:
        raise ValueError(
            f"Unsupported TerryDirector runtime config version: {value.get('version')!r}"
        )

    required = ("model", "clip", "vae", "audio_vae", "sampler", "sigmas")
    missing = [key for key in required if value.get(key) is None]
    if missing:
        raise ValueError(
            "TerryDirector 配置缺少运行输入：" + ", ".join(missing)
        )

    width = value.get("width")
    height = value.get("height")
    if not isinstance(width, int) or width < 32:
        raise ValueError("TerryDirector 配置 width 无效")
    if not isinstance(height, int) or height < 32:
        raise ValueError("TerryDirector 配置 height 无效")

    params = value.get("params")
    if not isinstance(params, dict):
        raise ValueError("TerryDirector 配置缺少 params")
    if params.get("ref_image_size") not in {"match", "max"}:
        raise ValueError("TerryDirector 配置 reference image size 无效")
    if not isinstance(params.get("seed"), int):
        raise ValueError("TerryDirector 配置 seed 无效")

    second = params.get("second_pass")
    if not isinstance(second, dict):
        raise ValueError("TerryDirector 配置缺少 second_pass")
    _second_pass(
        second.get("method"),
        second.get("model", ""),
        second.get("high_steps"),
    )

    return value


def arrangement_frames(document: dict[str, Any]) -> int:
    clips = document.get("clips") or []
    return max((int(clip.get("end") or 0) for clip in clips if isinstance(clip, dict)), default=0)


def summary(config: dict[str, Any], runtime: dict[str, Any] | None = None) -> dict[str, Any]:
    config = normalize_config(config)
    document = config["document"]
    frames = arrangement_frames(document)
    runtime = require_runtime_config(runtime) if runtime is not None else None
    return {
        "clips": len(document["clips"]),
        "frames": frames,
        "seconds": frames / FPS,
        "width": runtime["width"] if runtime else None,
        "height": runtime["height"] if runtime else None,
        "assets": len(document["assets"]),
        "second_pass": runtime["params"]["second_pass"]["method"] if runtime else "none",
    }
