from __future__ import annotations

import json
import math
from typing import Any

FPS = 24
CONFIG_VERSION = 1
DOCUMENT_VERSION = 1

ASPECTS: dict[str, tuple[int, int]] = {
    "1:1": (1, 1),
    "2:3": (2, 3),
    "3:2": (3, 2),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "9:16": (9, 16),
    "16:9": (16, 9),
    "21:9": (21, 9),
}


def _round_even(value: float) -> int:
    return int(round(value))


def calculate_resolution(aspect_ratio: str, megapixels: float, multiple: int) -> tuple[int, int]:
    if aspect_ratio not in ASPECTS:
        raise ValueError(f"Unsupported aspect ratio: {aspect_ratio}")
    megapixels = float(megapixels)
    multiple = int(multiple)
    if not 0.1 <= megapixels <= 16:
        raise ValueError("Megapixels must be between 0.1 and 16")
    if multiple < 8 or multiple > 128 or multiple % 4:
        raise ValueError("Resolution multiple must be 8-128 in steps of 4")
    aw, ah = ASPECTS[aspect_ratio]
    scale = math.sqrt(megapixels * 1024 * 1024 / (aw * ah))
    width = _round_even(aw * scale / multiple) * multiple
    height = _round_even(ah * scale / multiple) * multiple
    return max(multiple, width), max(multiple, height)


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
    return {
        "version": CONFIG_VERSION,
        "params": {
            "resolution": {
                "aspect_ratio": "16:9",
                "megapixels": 1.2,
                "multiple": 32,
            },
            "seed": 0,
            "continue_audio_latent": True,
            "ref_image_size": "match",
            "preview_enabled": True,
            "selflift": {
                "enabled": False,
                "model": "",
                "high_steps": 4,
            },
        },
        "document": default_document(),
    }


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
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
    base = default_config()
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("TerryDirector config_json is not valid JSON") from exc
    if not isinstance(value, dict):
        return base

    raw_params = value.get("params") if isinstance(value.get("params"), dict) else {}
    raw_res = raw_params.get("resolution") if isinstance(raw_params.get("resolution"), dict) else {}

    ratio = str(raw_res.get("aspect_ratio") or base["params"]["resolution"]["aspect_ratio"])
    if ratio not in ASPECTS:
        ratio = base["params"]["resolution"]["aspect_ratio"]
    mp = _as_float(raw_res.get("megapixels"), base["params"]["resolution"]["megapixels"])
    multiple = _as_int(raw_res.get("multiple"), base["params"]["resolution"]["multiple"])
    try:
        calculate_resolution(ratio, mp, multiple)
    except ValueError:
        ratio = base["params"]["resolution"]["aspect_ratio"]
        mp = base["params"]["resolution"]["megapixels"]
        multiple = base["params"]["resolution"]["multiple"]

    raw_selflift = raw_params.get("selflift") if isinstance(raw_params.get("selflift"), dict) else {}
    high_steps = max(1, _as_int(raw_selflift.get("high_steps"), 4))
    seed = max(0, min(0xFFFFFFFFFFFFFFFF, _as_int(raw_params.get("seed"), 0)))
    ref_image_size = str(raw_params.get("ref_image_size") or "match")
    if ref_image_size not in {"match", "max"}:
        ref_image_size = "match"

    return {
        "version": CONFIG_VERSION,
        "params": {
            "resolution": {
                "aspect_ratio": ratio,
                "megapixels": mp,
                "multiple": multiple,
            },
            "seed": seed,
            "continue_audio_latent": bool(raw_params.get("continue_audio_latent", True)),
            "ref_image_size": ref_image_size,
            "preview_enabled": bool(raw_params.get("preview_enabled", True)),
            "selflift": {
                "enabled": bool(raw_selflift.get("enabled", False)),
                "model": str(raw_selflift.get("model") or ""),
                "high_steps": high_steps,
            },
        },
        "document": normalize_document(value.get("document")),
    }


def config_json(value: Any | None = None) -> str:
    normalized = normalize_config(default_config() if value is None else value)
    return json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))


def arrangement_frames(document: dict[str, Any]) -> int:
    clips = document.get("clips") or []
    return max((int(clip.get("end") or 0) for clip in clips if isinstance(clip, dict)), default=0)


def summary(config: dict[str, Any]) -> dict[str, Any]:
    config = normalize_config(config)
    document = config["document"]
    resolution = config["params"]["resolution"]
    width, height = calculate_resolution(
        resolution["aspect_ratio"], resolution["megapixels"], resolution["multiple"]
    )
    frames = arrangement_frames(document)
    return {
        "clips": len(document["clips"]),
        "frames": frames,
        "seconds": frames / FPS,
        "width": width,
        "height": height,
        "assets": len(document["assets"]),
    }
