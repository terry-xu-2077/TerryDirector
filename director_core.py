from __future__ import annotations

import json
from typing import Any

FPS = 24
CONFIG_VERSION = 4
DOCUMENT_VERSION = 2
RUNTIME_CONFIG_VERSION = 2
RUNTIME_CONFIG_TYPE = "TERRYDIRECTOR_CONFIG"
SECOND_PASS_CONFIG_VERSION = 1
SECOND_PASS_CONFIG_TYPE = "TERRYDIRECTOR_SECOND_PASS_CONFIG"


def default_document() -> dict[str, Any]:
    return {
        "version": DOCUMENT_VERSION,
        "fps": FPS,
        "selected": "clip-1",
        "globalPrompt": "",
        "clips": [
            {
                "id": "clip-1",
                "name": "片段 01",
                "start": 0,
                "end": 10 * FPS,
                "prompt": "",
                "refs": [],
                "useGlobalPrompt": True,
                "transitionMode": "tail_reference",
                "suspended": False,
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
            "useGlobalPrompt": raw.get("useGlobalPrompt") is not False,
            "transitionMode": raw.get("transitionMode") if raw.get("transitionMode") in {"tail_reference", "tail_continuation", "independent"} else "tail_continuation",
            "suspended": raw.get("suspended") is True,
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
        "globalPrompt": str(value.get("globalPrompt") or ""),
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


def make_second_pass_config(
    *,
    high_res_model: Any = None,
    cfg: float = 1.0,
    transition_step: int = 5,
    lowres_scale: float = 0.5,
    rho: float = 0.0,
    w_min: float = 0.5,
    w_max: float = 1.0,
    upscaler_model: str = "none",
    sampling_steps: int = 6,
    sampling_denoise: float = 1.0,
    sigma_refine_enabled: bool = True,
    sigma_refine_extra_steps: int = 1,
    sigma_refine_start: float = 0.7,
    sigma_refine_end: float = 0.0,
    sigma_refine_spacing: str = "cosine",
    highres_tiling: bool = False,
    tiling_mode: str = "auto",
    tiling_tiles: int = 2,
    tiling_axis: str = "auto",
) -> dict[str, Any]:
    packet = {
        "type": SECOND_PASS_CONFIG_TYPE,
        "version": SECOND_PASS_CONFIG_VERSION,
        "method": "selflift",
        "high_res_model": high_res_model,
        "cfg": float(cfg),
        "transition_step": int(transition_step),
        "lowres_scale": float(lowres_scale),
        "rho": float(rho),
        "w_min": float(w_min),
        "w_max": float(w_max),
        "upscaler_model": str(upscaler_model or "none"),
        "sampling_steps": int(sampling_steps),
        "sampling_denoise": float(sampling_denoise),
        "sigma_refine_enabled": bool(sigma_refine_enabled),
        "sigma_refine_extra_steps": int(sigma_refine_extra_steps),
        "sigma_refine_start": float(sigma_refine_start),
        "sigma_refine_end": float(sigma_refine_end),
        "sigma_refine_spacing": str(sigma_refine_spacing or "cosine"),
        "highres_tiling": bool(highres_tiling),
        "tiling_mode": str(tiling_mode or "auto"),
        "tiling_tiles": int(tiling_tiles),
        "tiling_axis": str(tiling_axis or "auto"),
    }
    return require_second_pass_config(packet)


def require_second_pass_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("TerryDirector 二采配置必须来自 TerryDirector 二采配置节点")
    if value.get("type") != SECOND_PASS_CONFIG_TYPE:
        raise ValueError("TerryDirector 二采配置类型无效")
    if value.get("version") != SECOND_PASS_CONFIG_VERSION:
        raise ValueError(
            f"不支持的 TerryDirector 二采配置版本: {value.get('version')!r}"
        )
    if value.get("method") != "selflift":
        raise ValueError(f"不支持的二采方案: {value.get('method')!r}")

    cfg = float(value.get("cfg", 1.0))
    transition_step = int(value.get("transition_step", 5))
    lowres_scale = float(value.get("lowres_scale", 0.5))
    rho = float(value.get("rho", 0.0))
    w_min = float(value.get("w_min", 0.5))
    w_max = float(value.get("w_max", 1.0))
    sampling_steps = int(value.get("sampling_steps", 6))
    sampling_denoise = float(value.get("sampling_denoise", 1.0))
    extra_steps = int(value.get("sigma_refine_extra_steps", 1))
    refine_start = float(value.get("sigma_refine_start", 0.7))
    refine_end = float(value.get("sigma_refine_end", 0.0))
    spacing = str(value.get("sigma_refine_spacing", "cosine"))
    tiling_mode = str(value.get("tiling_mode", "auto"))
    tiling_tiles = int(value.get("tiling_tiles", 2))
    tiling_axis = str(value.get("tiling_axis", "auto"))

    if not 0.0 <= cfg <= 100.0:
        raise ValueError("SelfLift CFG 必须在 0 到 100 之间")
    if transition_step < 1:
        raise ValueError("SelfLift transition_step 必须至少为 1")
    if not 0.25 <= lowres_scale <= 1.0:
        raise ValueError("SelfLift 低清比例必须在 0.25 到 1.0 之间")
    if not 0.0 <= rho <= 1.0:
        raise ValueError("SelfLift rho 必须在 0 到 1 之间")
    if not 0.0 <= w_min <= w_max <= 1.0:
        raise ValueError("SelfLift 权重必须满足 0 <= w_min <= w_max <= 1")
    if sampling_steps < 2:
        raise ValueError("SelfLift 采样步数必须至少为 2")
    if not 0.0 < sampling_denoise <= 1.0:
        raise ValueError("SelfLift Denoise 必须在 0 到 1 之间")
    if extra_steps < 0 or extra_steps > 15:
        raise ValueError("SelfLift Sigma 精修加步必须在 0 到 15 之间")
    if refine_start < 0.0 or refine_end < 0.0:
        raise ValueError("SelfLift Sigma 精修范围不能为负数")
    if spacing not in {"cosine", "linear", "exponential"}:
        raise ValueError("SelfLift Sigma 精修分布无效")
    if tiling_mode not in {"auto", "manual"}:
        raise ValueError("SelfLift 高清分块模式无效")
    if tiling_tiles not in {2, 4, 6, 8}:
        raise ValueError("SelfLift 手动分块数必须为 2 / 4 / 6 / 8")
    if tiling_axis not in {"auto", "width", "height"}:
        raise ValueError("SelfLift 分块方向无效")

    normalized = dict(value)
    normalized.update({
        "type": SECOND_PASS_CONFIG_TYPE,
        "version": SECOND_PASS_CONFIG_VERSION,
        "method": "selflift",
        "cfg": cfg,
        "transition_step": transition_step,
        "lowres_scale": lowres_scale,
        "rho": rho,
        "w_min": w_min,
        "w_max": w_max,
        "upscaler_model": str(value.get("upscaler_model") or "none"),
        "sampling_steps": sampling_steps,
        "sampling_denoise": sampling_denoise,
        "sigma_refine_enabled": bool(value.get("sigma_refine_enabled", True)),
        "sigma_refine_extra_steps": extra_steps,
        "sigma_refine_start": refine_start,
        "sigma_refine_end": refine_end,
        "sigma_refine_spacing": spacing,
        "highres_tiling": bool(value.get("highres_tiling", False)),
        "tiling_mode": tiling_mode,
        "tiling_tiles": tiling_tiles,
        "tiling_axis": tiling_axis,
    })
    return normalized


def _disabled_second_pass() -> dict[str, Any]:
    return {
        "method": "none",
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
    ref_image_size: str = "match",
    second_pass: dict[str, Any] | None = None,
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
            "ref_image_size": image_size,
            "second_pass": (
                require_second_pass_config(second_pass)
                if second_pass is not None
                else _disabled_second_pass()
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

    second = params.get("second_pass")
    if not isinstance(second, dict):
        raise ValueError("TerryDirector 配置缺少 second_pass")
    method = str(second.get("method") or "none")
    if method == "selflift":
        require_second_pass_config(second)
        if second.get("sampler") is None or second.get("sigmas") is None:
            raise ValueError("TerryDirector SelfLift 二采运行配置缺少 sampler / sigmas")
    elif method != "none":
        raise ValueError(f"不支持的 TerryDirector 二采方案: {method!r}")

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
