"""Trusted local AV latent checkpoint; retains both streams and mask metadata."""
from pathlib import Path
import torch


def _parts(value):
    return list(value.unbind()) if getattr(value, "is_nested", False) else value


def _cpu(value):
    if isinstance(value, torch.Tensor):
        return value.detach().to("cpu")
    if isinstance(value, list):
        return [_cpu(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_cpu(v) for v in value)
    if isinstance(value, dict):
        return {k: _cpu(v) for k, v in value.items()}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"Unsupported latent metadata: {type(value).__name__}")


def flatten(latent):
    streams = _parts(latent["samples"])
    if not isinstance(streams, list) or len(streams) != 2 or streams[0].ndim != 5 or streams[1].ndim != 4:
        raise ValueError("Expected full MiniMax H3 video/audio nested latent")
    value = {"format": "terry_accel_lab_av_v1", "samples": _cpu(streams)}
    for key, item in latent.items():
        if key == "samples":
            continue
        value[key] = _cpu(_parts(item))
    return value


def restore(payload, pack):
    if payload.get("format") != "terry_accel_lab_av_v1":
        raise ValueError("Unrecognized AV checkpoint")
    samples = payload["samples"]
    if len(samples) != 2 or samples[0].ndim != 5 or samples[1].ndim != 4:
        raise ValueError("AV checkpoint streams incomplete")
    result = {k: v for k, v in payload.items() if k not in ("format", "samples")}
    result["samples"] = pack(samples)
    if isinstance(result.get("noise_mask"), list):
        result["noise_mask"] = pack(result["noise_mask"])
    return result


def save(path, latent, pack):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = flatten(latent)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(payload, temporary)
    checked = restore(torch.load(temporary, map_location="cpu", weights_only=True), pack)
    for before, after in zip(_parts(latent["samples"]), _parts(checked["samples"])):
        if not torch.equal(before.cpu(), after):
            temporary.unlink(missing_ok=True)
            raise RuntimeError("AV checkpoint tensor roundtrip mismatch")
    if set(checked) != set(latent):
        temporary.unlink(missing_ok=True)
        raise RuntimeError("AV checkpoint metadata keys changed")
    temporary.replace(path)
    return checked


def load(path, pack):
    return restore(torch.load(path, map_location="cpu", weights_only=True), pack)
