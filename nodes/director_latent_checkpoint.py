"""Model-independent LATENT snapshots: safetensors plus typed JSON metadata.

No sampler, sigma schedule, upscaler or model adapter is involved. Tensor values
and LATENT metadata round-trip without executing Python object deserialization.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

ENGINE = "terrydirector-latent-cache"
SCHEMA = 1
_ID = re.compile(r"^[0-9a-f]{32}$")


def _root() -> Path:
    import folder_paths
    return Path(folder_paths.get_output_directory()) / "TerryDirector" / "checkpoints"


def _directory(checkpoint_id: str) -> Path:
    if not isinstance(checkpoint_id, str) or not _ID.fullmatch(checkpoint_id):
        raise ValueError("无效的检查点 ID")
    root = _root().resolve()
    folder = root / checkpoint_id
    if folder.is_symlink() or folder.resolve().parent != root:
        raise ValueError("检查点目录异常")
    return folder


def _digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def _encode(value, tensors: dict, depth=0):
    import torch
    if depth > 32:
        raise ValueError("LATENT 元数据嵌套超过 32 层")
    if getattr(value, "is_nested", False):
        kind = "torch_nested" if isinstance(value, torch.Tensor) else "comfy_nested"
        return {"kind": kind, "items": [_encode(x, tensors, depth + 1) for x in value.unbind()]}
    if isinstance(value, torch.Tensor):
        if value.layout != torch.strided:
            raise ValueError("LATENT 缓存只支持普通稠密 Tensor")
        key = "tensor_" + str(len(tensors))
        tensors[key] = value.detach().to(device="cpu", copy=True).contiguous()
        return {"kind": "tensor", "key": key}
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("LATENT 元数据的键必须为字符串")
        return {"kind": "dict", "items": {key: _encode(item, tensors, depth + 1)
                                             for key, item in value.items()}}
    if isinstance(value, (tuple, list)):
        return {"kind": "tuple" if isinstance(value, tuple) else "list",
                "items": [_encode(item, tensors, depth + 1) for item in value]}
    if value is None or type(value) in (bool, int, str) or (type(value) is float and math.isfinite(value)):
        return {"kind": "value", "value": value}
    raise ValueError(f"LATENT 元数据包含不支持的类型：{type(value).__name__}")


def _decode(value: dict, tensors: dict, depth=0):
    import torch
    if not isinstance(value, dict) or depth > 32:
        raise ValueError("LATENT 检查点元数据损坏")
    kind = value.get("kind")
    if kind == "tensor":
        return tensors[value["key"]]
    if kind == "value":
        item = value.get("value")
        if item is not None and type(item) not in (bool, int, float, str):
            raise ValueError("LATENT 检查点值格式错误")
        return item
    if kind == "dict":
        return {key: _decode(item, tensors, depth + 1) for key, item in value["items"].items()}
    if kind in ("tuple", "list", "comfy_nested", "torch_nested"):
        items = [_decode(item, tensors, depth + 1) for item in value["items"]]
        if kind == "comfy_nested":
            from comfy.nested_tensor import NestedTensor
            return NestedTensor(items)
        if kind == "torch_nested":
            return torch.nested.nested_tensor(items)
        return tuple(items) if kind == "tuple" else items
    raise ValueError("LATENT 检查点包含未知的数据类型")


def _validate_latent(latent):
    import torch
    if not isinstance(latent, dict) or "samples" not in latent:
        raise ValueError("暂停/继续需要包含 samples 的 LATENT 输入")
    samples = latent["samples"]
    if not isinstance(samples, torch.Tensor) and not getattr(samples, "is_nested", False):
        raise ValueError("LATENT samples 必须为 Tensor 或 NestedTensor")


def save_checkpoint(latent: dict, name="未命名缓存") -> str:
    from safetensors.torch import save_file
    _validate_latent(latent)
    tensors = {}
    structure = _encode(latent, tensors)
    checkpoint_id = uuid.uuid4().hex
    folder = _directory(checkpoint_id)
    folder.mkdir(parents=True, exist_ok=False)
    try:
        stage = folder / "state.partial"
        save_file(tensors, str(stage))
        stage.replace(folder / "state.safetensors")
        manifest = {
            "schema": SCHEMA, "engine": ENGINE, "checkpoint_id": checkpoint_id,
            "name": str(name).strip()[:120] or "未命名缓存",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "structure": structure, "sha256": _digest(folder / "state.safetensors"),
        }
        raw = json.dumps(manifest, ensure_ascii=False, allow_nan=False)
        if len(raw.encode("utf-8")) > 16 * 1024 * 1024:
            raise ValueError("LATENT 元数据超过 16 MB")
        stage = folder / "manifest.partial"
        stage.write_text(raw, encoding="utf-8")
        stage.replace(folder / "manifest.json")
    except BaseException:
        # This fresh UUID directory was created above and never accepted as a
        # caller-supplied path. Failed saves must not appear as usable caches.
        shutil.rmtree(folder)
        raise
    return checkpoint_id


def read_manifest(checkpoint_id: str, *, engines=(ENGINE,)) -> dict:
    path = _directory(checkpoint_id) / "manifest.json"
    if path.is_symlink() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("检查点清单文件异常")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA or
            manifest.get("engine") not in engines or manifest.get("checkpoint_id") != checkpoint_id):
        raise ValueError("检查点格式或版本不兼容")
    return manifest


def list_checkpoints(*, engines=(ENGINE,)) -> list[dict]:
    root = _root()
    if not root.is_dir():
        return []
    items = []
    for folder in root.iterdir():
        if not folder.is_dir() or folder.is_symlink() or not _ID.fullmatch(folder.name):
            continue
        try:
            manifest = read_manifest(folder.name, engines=engines)
            if (folder / "state.safetensors").is_file():
                items.append(manifest)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return sorted(items, key=lambda item: str(item.get("created_at", "")), reverse=True)


def load_checkpoint(checkpoint_id: str) -> dict:
    from safetensors.torch import load_file
    manifest = read_manifest(checkpoint_id)
    path = _directory(checkpoint_id) / "state.safetensors"
    if path.is_symlink() or _digest(path) != manifest["sha256"]:
        raise ValueError("LATENT 文件校验失败，已拒绝继续执行")
    # safetensors may memory-map the file. Own the restored tensors so a
    # Windows cache file can be removed while downstream still uses its data.
    mapped = load_file(str(path), device="cpu")
    tensors = {key: value.clone() for key, value in mapped.items()}
    del mapped
    latent = _decode(manifest["structure"], tensors)
    _validate_latent(latent)
    return {"manifest": manifest, "latent": latent}
