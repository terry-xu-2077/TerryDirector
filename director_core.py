from __future__ import annotations

import json
from typing import Any

FPS = 24
CONFIG_VERSION = 2
DOCUMENT_VERSION = 1
SECOND_PASS_METHODS = {"none", "selflift"}


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
            "seed": 0,
            "continue_audio_latent": True,
            "ref_image_size": "match",
            "second_pass": {
                "method": "none",
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


def _second_pass_from_params(raw_params: dict[str, Any]) -> dict[str, Any]:
    raw = raw_params.get("second_pass")
    if isinstance(raw, dict):
        method = str(raw.get("method") or "none").strip().lower()
        model = str(raw.get("model") or "")
        high_steps = max(1, _as_int(raw.get("high_steps"), 4))
    else:
        # Migrate the first UI test build where SelfLift was represented as a toggle.
        legacy = raw_params.get("selflift")
        if not isinstance(legacy, dict):
            legacy = {}
        method = "selflift" if bool(legacy.get("enabled", False)) else "none"
        model = str(legacy.get("model") or "")
        high_steps = max(1, _as_int(legacy.get("high_steps"), 4))

    if method in {"selflift", "self_lift", "self-lift"}:
        method = "selflift"
    elif method not in SECOND_PASS_METHODS:
        method = "none"

    return {
        "method": method,
        "model": model,
        "high_steps": high_steps,
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
    seed = max(0, min(0xFFFFFFFFFFFFFFFF, _as_int(raw_params.get("seed"), 0)))
    ref_image_size = str(raw_params.get("ref_image_size") or "match")
    if ref_image_size not in {"match", "max"}:
        ref_image_size = "match"

    return {
        "version": CONFIG_VERSION,
        "params": {
            "seed": seed,
            "continue_audio_latent": bool(raw_params.get("continue_audio_latent", True)),
            "ref_image_size": ref_image_size,
            "second_pass": _second_pass_from_params(raw_params),
        },
        "document": normalize_document(value.get("document")),
    }


def config_json(value: Any | None = None) -> str:
    normalized = normalize_config(default_config() if value is None else value)
    return json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))


def arrangement_frames(document: dict[str, Any]) -> int:
    clips = document.get("clips") or []
    return max((int(clip.get("end") or 0) for clip in clips if isinstance(clip, dict)), default=0)


def summary(config: dict[str, Any], width: int | None = None, height: int | None = None) -> dict[str, Any]:
    config = normalize_config(config)
    document = config["document"]
    frames = arrangement_frames(document)
    return {
        "clips": len(document["clips"]),
        "frames": frames,
        "seconds": frames / FPS,
        "width": int(width) if width is not None else None,
        "height": int(height) if height is not None else None,
        "assets": len(document["assets"]),
        "second_pass": config["params"]["second_pass"]["method"],
    }
