"""Portable SelfLift transition checkpoints from ComfyUI's native SamplerCustom outputs.

This module deliberately has no dependency on SelfLift-Avatar. The caller must
provide both native sampler outputs: output (state at sigma[k]) and
denoised_output (the final x0 prediction). A terminal sigma=0 is NOT valid.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

SCHEMA = 1
_ID = re.compile(r"^[0-9a-f]{32}$")


def _root() -> Path:
    import folder_paths
    return Path(folder_paths.get_output_directory()) / "TerryDirector" / "checkpoints"


def _streams(latent: dict, label: str) -> list[torch.Tensor]:
    if not isinstance(latent, dict) or "samples" not in latent:
        raise ValueError(f"{label}: 需要 LATENT 输入")
    samples = latent["samples"]
    if not getattr(samples, "is_nested", False):
        raise ValueError(f"{label}: 需要 H3 NestedTensor 音视频双流")
    streams = list(samples.unbind())
    if (len(streams) != 2 or streams[0].ndim != 5 or streams[1].ndim != 4
            or streams[0].shape[0] != streams[1].shape[0]):
        raise ValueError(f"{label}: 无效的 H3 音视频 latent 形状")
    return streams


def _prepare(low_state, low_clean, source, sigmas, transition_step):
    from .director_selflift_math import validate_schedule, normalize_masks
    states = _streams(low_state, "低清 output")
    cleans = _streams(low_clean, "低清 denoised_output")
    originals = _streams(source, "目标分辨率 latent")
    k = int(transition_step)
    validate_schedule(sigmas, k)
    if [tuple(x.shape) for x in states] != [tuple(x.shape) for x in cleans]:
        raise ValueError("output 与 denoised_output 形状不同")
    if states[0].shape[:3] != originals[0].shape[:3] or tuple(states[1].shape) != tuple(originals[1].shape):
        raise ValueError("低清和高清参考必须具有一致的视频帧数、通道及音频 latent")
    if any(a > b for a, b in zip(states[0].shape[-2:], originals[0].shape[-2:])):
        raise ValueError("低清画面不能大于目标分辨率")
    # Preserve the full AV source, including keep-region anchors and masks.
    masks = normalize_masks(source.get("noise_mask"), originals)
    return states, cleans, originals, masks, k


def _cpu(t: torch.Tensor) -> torch.Tensor:
    return t.detach().to("cpu").contiguous().clone()


def _digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def save_checkpoint(*, low_state, low_clean, source, sigmas, transition_step, seed,
                    cfg, name="未命名低清镜头") -> str:
    states, cleans, originals, masks, k = _prepare(
        low_state, low_clean, source, sigmas, transition_step)
    if not (0 <= int(seed) < 1 << 64):
        raise ValueError("Seed 超出 uint64 范围")
    if not 0 <= float(cfg) <= 100:
        raise ValueError("CFG 超出范围")
    tensors = {"sigmas": _cpu(sigmas)}
    for group, values in (("state", states), ("clean", cleans), ("source", originals)):
        for i, value in enumerate(values):
            tensors[f"{group}_{i}"] = _cpu(value)
    if masks is not None:
        for i, value in enumerate(masks):
            tensors[f"mask_{i}"] = _cpu(value)
    batch_index = source.get("batch_index")
    if batch_index is not None:
        if isinstance(batch_index, torch.Tensor):
            batch_index = batch_index.detach().cpu().tolist()
        batch_index = [int(x) for x in batch_index]
    checkpoint_id = uuid.uuid4().hex
    root = _root()
    folder = root / checkpoint_id
    folder.mkdir(parents=True, exist_ok=False)
    tmp = folder / "state.partial"
    target = folder / "state.safetensors"
    try:
        save_file(tensors, str(tmp))
        tmp.replace(target)
        manifest = {
            "schema": SCHEMA,
            "engine": "terrydirector-selflift-transition",
            "checkpoint_id": checkpoint_id,
            "name": str(name).strip()[:120] or "未命名低清镜头",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "draft",
            "transition_step": k,
            "seed": str(int(seed)),
            "cfg": float(cfg),
            "batch_index": batch_index,
            "low_video_shape": list(states[0].shape),
            "target_video_shape": list(originals[0].shape),
            "audio_shape": list(states[1].shape),
            "sha256": _digest(target),
        }
        stage = folder / "manifest.partial"
        stage.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        stage.replace(folder / "manifest.json")
    except BaseException:
        for file in folder.iterdir():
            if file.is_file():
                file.unlink()
        folder.rmdir()
        raise
    return checkpoint_id


def _directory(checkpoint_id: str) -> Path:
    if not isinstance(checkpoint_id, str) or not _ID.fullmatch(checkpoint_id):
        raise ValueError("无效的检查点 ID")
    return _root() / checkpoint_id


def read_manifest(checkpoint_id: str) -> dict:
    path = _directory(checkpoint_id) / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if (manifest.get("schema") != SCHEMA
            or manifest.get("engine") != "terrydirector-selflift-transition"
            or manifest.get("checkpoint_id") != checkpoint_id):
        raise ValueError("检查点格式或版本不兼容")
    return manifest


def list_checkpoints() -> list[dict]:
    root = _root()
    if not root.is_dir():
        return []
    items = []
    for folder in root.iterdir():
        if not folder.is_dir() or not _ID.fullmatch(folder.name):
            continue
        try:
            m = read_manifest(folder.name)
            if (folder / "state.safetensors").is_file():
                items.append(m)
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
    return sorted(items, key=lambda m: m["created_at"], reverse=True)


def load_checkpoint(checkpoint_id: str) -> dict:
    manifest = read_manifest(checkpoint_id)
    path = _directory(checkpoint_id) / "state.safetensors"
    if _digest(path) != manifest["sha256"]:
        raise ValueError("Latent 文件校验失败，已拒绝继续高清")
    tensors = load_file(str(path), device="cpu")
    from .director_selflift_math import validate_schedule
    sigmas = tensors["sigmas"]
    validate_schedule(sigmas, int(manifest["transition_step"]))
    pairs = {}
    for group in ("state", "clean", "source"):
        pairs[group] = [tensors[f"{group}_{i}"] for i in range(2)]
    for group in ("state", "clean", "source"):
        expected = manifest["target_video_shape"] if group == "source" else manifest["low_video_shape"]
        if list(pairs[group][0].shape) != expected or list(pairs[group][1].shape) != manifest["audio_shape"]:
            raise ValueError("检查点音视频维度与清单不符")
    masks = ([tensors["mask_0"], tensors["mask_1"]]
             if "mask_0" in tensors and "mask_1" in tensors else None)
    return dict(manifest=manifest, sigmas=sigmas, state=pairs["state"],
                clean=pairs["clean"], source=pairs["source"], masks=masks)
