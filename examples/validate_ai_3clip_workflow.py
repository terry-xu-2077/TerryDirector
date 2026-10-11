"""Offline structural validation only; GPU/ComfyUI import needs a real local run."""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path


DEFAULT = Path(__file__).with_name("TerryDirector_AI_3clips_0.2MP.json")

# Grounded in the previously tested 9-clip official H3 looper workflow.
# The original prompt text and image paths must NOT be replaced by placeholders.
SOURCE_WORKFLOW = "TerryDirector_循环器_官方H3_示例工作流.json"
REFERENCE_FILES = [
    "00_特瑞_Terry.jpeg",
    "Generate_vehicle_multi-view_images_2K_202608132251.jpeg",
    "开场遗迹.png",
    "荒星地貌.jpeg",
    "codex_9ea39e8314544c10aa7c0e140ba871d5.png",
    "Designing_custom_coin_grid_2K_202608170722.jpeg",
    "地下虫群-个体 拷贝.jpg",
]
SEGMENT_NAMES = ["特瑞的面部与粗糙的手", "破损的电子屏幕", "“蚂蚱”载具驶入"]
SEGMENT_PROMPT_MARKERS = [
    ["特瑞脸颊带有轻微油污", "黄色的工业绝缘胶带", "Foley 音效"],
    ["“剩余电量”", "电弧短路", "再撑一段。"],
    ["“蚂蚱”载具", "“ORC”", "呼啸的荒原风声"],
]


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
    assert len(doc["assets"]) == 7 and len(doc["clips"]) == 3
    assert [(x["start"], x["end"]) for x in doc["clips"]] == [
        (0, 96), (96, 168), (168, 288)]
    assert [c["name"] for c in doc["clips"]] == SEGMENT_NAMES
    assert all(x["prompt"] and x["aiPrompt"] == ""
               and x["promptMode"] == "user" and not x["aiMetadata"]
               and not x["aiOptOut"] and not x["suspended"]
               and x["transitionMode"] == "tail_reference" and not x["refs"]
               for x in doc["clips"])
    for clip, markers in zip(doc["clips"], SEGMENT_PROMPT_MARKERS):
        assert all(marker in clip["prompt"] for marker in markers), (
            f"Source prompt was changed: {clip['name']}"
        )
    assert [a["source"]["path"] for a in doc["assets"]] == REFERENCE_FILES
    assert [a["number"] for a in doc["assets"]] == list(range(1, 8))
    assert all(a["kind"] == "image" and a["source"]["type"] == "comfy-input"
               for a in doc["assets"])
    assert re.findall(r"<Picture\\s+(\\d+)>", doc["globalPrompt"]) == [
        "4", "1", "2", "3", "5", "6", "7"
    ], "All seven original asset references must remain in the global prompt"
    assert "特瑞在极端荒原生存" in doc["globalPrompt"]
    assert "Sony Venice 2" in doc["globalPrompt"]
    assert "2.39:1" in doc["globalPrompt"]
    assert len(doc["assets"]) + 1 <= 9, "Tail frame requires a spare image slot"
    assert workflow.get("extra", {}).get("td_acceptance", {}).get("source_workflow") == SOURCE_WORKFLOW
    # First clip has no previous tail; the next two must receive the preceding
    # generated frame at runtime, not through the AI prompt enhancer.
    assert workflow["extra"]["td_acceptance"]["tail_reference_from_clip"] == 2
    assert node("UNETLoader")["widgets_values_named"]["unet_name"] == (
        "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    )
    assert node("CLIPLoader")["widgets_values_named"]["clip_name"] == (
        "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
    )

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
            "video_seed": 9, "auto_enhance": True,
            "source_workflow": SOURCE_WORKFLOW,
            "images": len(doc["assets"]),
            "image_paths": REFERENCE_FILES,
            "transition_modes": [c["transitionMode"] for c in doc["clips"]],
            "effective_tail_reference_on": [2, 3]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow", type=Path, default=DEFAULT)
    args = parser.parse_args()
    workflow = json.loads(args.workflow.read_text(encoding="utf-8"))
    print(json.dumps(verify(workflow), ensure_ascii=False, indent=2))
