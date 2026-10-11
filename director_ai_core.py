"""Pure TerryDirector AI prompt state rules.

Auto-rewrite is controlled solely by the AI seed (or missing result).
Changes to the source text are informational: they never auto-invalidate a take.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

AI_CONFIG_TYPE = "TERRYDIRECTOR_LLAMA_CONFIG"
AI_CONFIG_VERSION = 1
AI_SKILL = "h3-prompt-writing"


def require_ai_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("type") != AI_CONFIG_TYPE:
        raise ValueError("请连接 TerryDirector Llama 配置节点")
    if value.get("version") != AI_CONFIG_VERSION:
        raise ValueError("TerryDirector Llama 配置版本不受支持")
    model = str(value.get("model") or "").strip()
    if not model or not model.lower().endswith(".gguf"):
        raise ValueError("Llama 配置缺少有效 GGUF 模型")
    result = dict(value)
    result["model"] = model
    result["vision_model"] = str(value.get("vision_model") or "None")
    result["seed"] = int(value.get("seed", 0))
    result["n_ctx"] = max(1024, int(value.get("n_ctx", 16384)))
    result["max_tokens"] = max(256, int(value.get("max_tokens", 8192)))
    result["gpu_layers"] = int(value.get("gpu_layers", -1))
    result["think_mode"] = bool(value.get("think_mode", False))
    result["temperature"] = float(value.get("temperature", 0.7))
    result["top_p"] = float(value.get("top_p", 0.8))
    return result


def source_signature(clip: dict, global_prompt: str = "", assets: list | None = None) -> str:
    source = {
        "prompt": str(clip.get("prompt") or ""),
        "global": str(global_prompt or "") if clip.get("useGlobalPrompt") is not False else "",
        "duration_frames": int(clip.get("end", 0)) - int(clip.get("start", 0)),
        "assets": [
            (str(a.get("id")), str(a.get("source", {}).get("path")))
            for a in (assets or [])
        ],
    }
    return hashlib.sha256(json.dumps(source, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]


def needs_enhancement(clip: dict, seed: int) -> bool:
    """No source-hash, model, skill or duration check belongs here."""
    if not str(clip.get("aiPrompt") or "").strip():
        return True
    metadata = clip.get("aiMetadata")
    if not isinstance(metadata, dict):
        return True
    try:
        return int(metadata.get("seed")) != int(seed)
    except (TypeError, ValueError):
        return True


def effective_local_prompt(clip: dict) -> str:
    if clip.get("promptMode") == "ai" and str(clip.get("aiPrompt") or "").strip():
        return str(clip["aiPrompt"])
    return str(clip.get("prompt") or "")


def ai_targets(document: dict, seed: int, *, force: bool = False) -> list[dict]:
    return [
        clip for clip in document.get("clips", [])
        if not clip.get("suspended")
        and not clip.get("aiOptOut")
        and str(clip.get("prompt") or "").strip()
        and (force or needs_enhancement(clip, seed))
    ]


def assign_ai_result(clip: dict, result: dict, *, activate: bool = True) -> None:
    clip["aiPrompt"] = str(result["prompt"])
    clip["aiMetadata"] = dict(result["metadata"])
    if activate:
        clip["promptMode"] = "ai"


def clip_seed(global_seed: int, clip_id: str) -> int:
    """Stable across timeline reordering; changing the master seed changes all clips."""
    salt = int.from_bytes(hashlib.blake2s(str(clip_id).encode(), digest_size=4).digest(), "big")
    return (int(global_seed) ^ salt) & 0xFFFFFFFF
