"""Offline structural validation only; GPU/ComfyUI import needs a real local run."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


DEFAULT = Path(__file__).with_name("TerryDirector_AI_3clips_0.2MP.json")


def verify(workflow: dict) -> dict:
    nodes = workflow["nodes"]
    links = workflow["links"]
    by_id = {n["id"]: n for n in nodes}
    assert len(nodes) == len(by_id) == 10, "Expected ten unique nodes"
    assert len(links) == 10, "Expected ten links"
    kinds = [n["type"] for n in nodes]
    for kind in ("UNETLoader", "CLIPLoader", "TerryDirectorConfig",
                 "TerryDirectorLlamaConfig", "TerryDirector",
                 "TerryDirectorOutput", "CreateVideo", "SaveVideo"):
        assert kinds.count(kind) == 1, kind
    assert kinds.count("VAELoader") == 2
    assert not any("SelfLift" in k or "Advanced" in k or "Looper" in k for k in kinds)

    for link_id, src_id, src_index, dst_id, dst_index, wire_type in links:
        src = by_id[src_id]["outputs"][src_index]
        dst = by_id[dst_id]["inputs"][dst_index]
        assert src["type"] == dst["type"] == wire_type, f"Link {link_id} type mismatch"
        assert link_id in (src.get("links") or []), f"Producer missing link {link_id}"
        assert dst.get("link") == link_id, f"Consumer missing link {link_id}"

    def node(kind):
        return next(n for n in nodes if n["type"] == kind)

    cfg = node("TerryDirectorConfig")
    assert any(i["name"] == "second_pass_config" and i.get("link") is None
               for i in cfg["inputs"]), "SelfLift input must be disconnected"
    cw = cfg["widgets_values_named"]
    assert cw["aspect_ratio"] == "16:9 (Widescreen)"
    assert float(cw["megapixels"]) == 0.2 and int(cw["multiple"]) == 32
    scale = math.sqrt(0.2 * 1024 * 1024 / (16 * 9))
    size = [round(16 * scale / 32) * 32, round(9 * scale / 32) * 32]
    assert size == [608, 352], size

    lw = node("TerryDirectorLlamaConfig")["widgets_values_named"]
    dw = node("TerryDirector")["widgets_values_named"]
    assert (lw["seed"], dw["seed"]) == (8888, 9)
    assert lw["control_after_generate"] == dw["control_after_generate"] == "fixed"
    doc = json.loads(dw["config_json"])["document"]
    assert doc["fps"] == 24 and doc["autoAiEnhance"] is True
    assert doc["assets"] == [] and len(doc["clips"]) == 3
    assert [(x["start"], x["end"]) for x in doc["clips"]] == [
        (0, 96), (96, 168), (168, 288)]
    assert all(x["prompt"] and x["aiPrompt"] == ""
               and x["promptMode"] == "user" and not x["aiMetadata"]
               and not x["aiOptOut"] and not x["suspended"]
               and x["transitionMode"] == "independent" and not x["refs"]
               for x in doc["clips"])

    pairs = {(by_id[s]["type"], by_id[d]["type"], by_id[d]["inputs"][i]["name"])
             for _, s, _, d, i, _ in links}
    required = {
        ("UNETLoader", "TerryDirectorConfig", "model"),
        ("CLIPLoader", "TerryDirectorConfig", "clip"),
        ("VAELoader", "TerryDirectorConfig", "vae"),
        ("VAELoader", "TerryDirectorConfig", "audio_vae"),
        ("TerryDirectorConfig", "TerryDirector", "director_config"),
        ("TerryDirectorLlamaConfig", "TerryDirector", "llama_config"),
        ("TerryDirector", "TerryDirectorOutput", "director_output"),
        ("TerryDirectorOutput", "CreateVideo", "images"),
        ("TerryDirectorOutput", "CreateVideo", "audio"),
        ("CreateVideo", "SaveVideo", "video"),
    }
    assert pairs == required, f"Unexpected edges: {pairs ^ required}"
    assert node("CreateVideo")["widgets_values_named"]["fps"] == 24
    assert node("SaveVideo")["widgets_values_named"]["filename_prefix"].startswith(
        "video/TerryDirector_AI_3clips_0p2MP")

    return {"status": "STATIC_STRUCTURE_VALIDATED_ONLY",
            "nodes": len(nodes), "links": len(links),
            "resolution": size, "fps": 24,
            "output_frames": 288, "duration_seconds": 12,
            "clip_frames": [96, 72, 120],
            "h3_aligned_frames": [107, 73, 124],
            "selflift": False, "ai_seed": 8888,
            "video_seed": 9, "auto_enhance": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow", type=Path, default=DEFAULT)
    args = parser.parse_args()
    workflow = json.loads(args.workflow.read_text(encoding="utf-8"))
    print(json.dumps(verify(workflow), ensure_ascii=False, indent=2))
