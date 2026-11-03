from __future__ import annotations

import json
from typing import Any

FPS = 24
CONFIG_VERSION = 4
DOCUMENT_VERSION = 2


def default_document() -> dict[str, Any]:
    return {
        "version": DOCUMENT_VERSION,
        "fps": FPS,
        "selected": "clip-1",
        "globalPrompt": "",
        "aiGlobalPrompt": "",
        "globalPromptMode": "user",
        "globalAiMetadata": {},
        "autoAiEnhance": False,
        "clips": [
            {
                "id": "clip-1",
                "name": "片段 01",
                "start": 0,
                "end": 10 * FPS,
                "seed": None,
                "aiSeed": None,
                "prompt": "",
                "aiPrompt": "",
                "promptMode": "user",
                "aiOptOut": False,
                "aiMetadata": {},
                "refs": [],
                "useGlobalPrompt": True,
                "transitionMode": "tail_reference",
                "suspended": False,
                "kind": "generated",
            }
        ],
        "assets": [],
    }


def default_config() -> dict[str, Any]:
    """Serialized state owned by the TerryDirector creative node.

    Generation/runtime settings deliberately live in the dedicated
    TerryDirector loop UI and are not duplicated in external sampler nodes.
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


def _normalize_seed(value: Any) -> str | None:
    """Keep authored 64-bit seeds as decimal strings so browser JSON never loses precision."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        seed = int(text, 10)
    except (TypeError, ValueError):
        return None
    seed = max(0, min(0xFFFFFFFFFFFFFFFF, seed))
    return str(seed)


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
            "seed": _normalize_seed(raw.get("seed")),
            "aiSeed": _normalize_seed(raw.get("aiSeed")),
            "prompt": str(raw.get("prompt") or ""),
            "aiPrompt": str(raw.get("aiPrompt") or ""),
            "promptMode": "ai" if raw.get("promptMode") == "ai" else "user",
            "aiOptOut": raw.get("aiOptOut") is True,
            "aiMetadata": dict(raw["aiMetadata"]) if isinstance(raw.get("aiMetadata"), dict) else {},
            "refs": refs,
            "useGlobalPrompt": raw.get("useGlobalPrompt") is not False,
            "transitionMode": raw.get("transitionMode") if raw.get("transitionMode") in {"tail_reference", "tail_continuation", "independent"} else "tail_continuation",
            "suspended": raw.get("suspended") is True,
            "kind": "entity" if raw.get("kind") == "entity" else "generated",
            "sourceAssetId": str(raw.get("sourceAssetId") or ""),
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
        asset = {
            "id": asset_id,
            "name": str(raw.get("name") or path.rsplit("/", 1)[-1])[:240],
            "kind": kind,
            "number": number,
            "source": {"type": "comfy-input", "path": path},
        }
        # UI alias is independent of the filesystem name and H3 token.
        alias = " ".join(str(raw.get("displayName") or "").split())[:80]
        if alias:
            asset["displayName"] = alias
        assets.append(asset)

    valid_asset_ids = {item["id"] for item in assets}
    valid_video_asset_ids = {item["id"] for item in assets if item["kind"] == "video"}
    for clip in clips:
        clip["refs"] = [ref for ref in clip["refs"] if ref in valid_asset_ids]
        if clip["kind"] == "entity" and clip["sourceAssetId"] not in valid_video_asset_ids:
            # Keep the clip visible with its unresolved ID. The compiler
            # will explain the missing video rather than generating a fake
            # clip or silently switching it to independent.
            pass

    selected = str(value.get("selected") or "")
    if selected not in {clip["id"] for clip in clips}:
        selected = clips[0]["id"]

    return {
        "version": DOCUMENT_VERSION,
        "fps": FPS,
        "selected": selected,
        "globalPrompt": str(value.get("globalPrompt") or ""),
        "aiGlobalPrompt": str(value.get("aiGlobalPrompt") or ""),
        "globalPromptMode": "ai" if value.get("globalPromptMode") == "ai" else "user",
        "globalAiMetadata": dict(value["globalAiMetadata"]) if isinstance(value.get("globalAiMetadata"), dict) else {},
        "autoAiEnhance": value.get("autoAiEnhance") is True,
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
