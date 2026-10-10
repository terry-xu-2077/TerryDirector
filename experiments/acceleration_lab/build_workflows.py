"""Build private, standalone B0/B1/V0/V1 UI and API graphs from report 46's request.

No director execute method or ComfyUI server is called here. Private outputs go to
local/, which is ignored by Git. Run with ComfyUI's Python environment.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import types


LAB = Path(__file__).resolve().parent
REPO = LAB.parents[1]
COMFY = REPO.parents[1]
REQUEST_SHA256 = "fa15bd5cc127969374d565f2caad664dd9bdc0c41e800c5f59521544328e5a64"
CANONICAL_VAE_SHA256 = "52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e"


def digest(path):
    hash_ = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            hash_.update(chunk)
    return hash_.hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def add(graph, kind, **inputs):
    node_id = str(len(graph) + 1)
    graph[node_id] = {"class_type": kind, "inputs": inputs}
    return node_id


def link(node, output=0):
    return [node, output]


def _load_compiler():
    sys.path.insert(0, str(COMFY))
    # Resolve the frozen compiler as a source module without importing the
    # production root extension or registering server routes/nodes.
    package = types.ModuleType("TerryDirector")
    package.__path__ = [str(REPO)]
    sys.modules["TerryDirector"] = package
    from TerryDirector.director_compile import compile_timeline
    return compile_timeline


def build_sample(original, segment, variant):
    if variant not in ("B0", "B1"):
        raise ValueError(variant)
    source = original["prompt"]
    second = source["930010"]["inputs"]
    assert source["9700451"]["inputs"]["seed"] == 1000
    assert segment["id"] == "clip-1" and segment["continuity"]["kind"] == "independent"
    assert segment["h3_frames"] == 107 and segment["output_frames"] == 96
    assert len(segment["assets"]["images"]) == 7
    assert not segment["assets"]["videos"] and not segment["assets"]["audios"]
    assert (second["transition_step"], second["lowres_scale"], second["rho"], second["highres_tiling"]) == (5, .5, 0, False)
    graph = {}
    model = add(graph, "UNETLoader", **{k: v for k, v in source["333"]["inputs"].items()})
    lora = add(graph, "LoraLoaderModelOnly", model=link(model),
               lora_name=source["332"]["inputs"]["lora_name"],
               strength_model=source["332"]["inputs"]["strength_model"])
    kitchen = add(graph, "ModelAttentionBackend", model=link(lora), attention="comfy kitchen attention")
    lowvram = add(graph, "MiniMaxLowVRAMAttention", model=link(kitchen), head_chunks=4)
    ffn = add(graph, "MiniMaxChunkFeedForward", model=link(lowvram), chunks=2, seq_threshold=4096)
    final_model = ffn
    if variant == "B1":
        final_model = add(graph, "BlockSparseAttention", model=link(ffn),
            selection={"selection": "sol-attn", "tau": 1.0}, start_percent=.05,
            end_percent=1.0, dense_blocks="0,1,48,49", min_tokens=12288,
            extra_tokens=256, sink_conditioning="exact_kv_and_rows", verbose=True)
    clip = add(graph, "CLIPLoader", **source["331"]["inputs"])
    video_vae = add(graph, "VAELoader", **source["330"]["inputs"])
    audio_vae = add(graph, "VAELoader", **source["329"]["inputs"])
    loaded = []
    for asset in segment["assets"]["images"]:
        loaded.append(add(graph, "LoadImage", image=asset["source"]["path"]))
    condition_inputs = dict(clip=link(clip), vae=link(video_vae), audio_vae=link(audio_vae),
        prompt=segment["prompt"], width=1920, height=1088, length=107,
        ref_image_size=source["304"]["inputs"]["ref_image_size"], run_id=variant)
    condition_inputs.update({f"ref_image_{i}": link(node) for i, node in enumerate(loaded)})
    condition = add(graph, "TerryAccelLabCondition", **condition_inputs)
    negative = add(graph, "ConditioningZeroOut", conditioning=link(condition))
    schedule = add(graph, "BasicScheduler", model=link(final_model), scheduler="simple",
                   steps=6, denoise=1.0)
    refined = add(graph, "TerryAccelLabSigmaRefine", sigmas=link(schedule),
                  extra_steps=1, start_at_sigma=.7, end_at_sigma=0.0, spacing="cosine")
    sampler = add(graph, "KSamplerSelect", sampler_name="euler")
    sampled = add(graph, "TerryAccelLabSelfLift", model=link(final_model),
        positive=link(condition), negative=link(negative), vae=link(video_vae),
        latent_image=link(condition, 1), sampler=link(sampler), sigmas=link(refined),
        seed=1000, cfg=1.0, transition_step=5, lowres_scale=.5,
        rho=0.0, w_min=.5, w_max=1.0,
        upscaler_model=second["upscaler_model"], highres_tiling=False,
        run_id=variant, expect_sol=(variant == "B1"))
    checkpoint = add(graph, "TerryAccelLabCheckpointAV", latent=link(sampled),
                     filename=f"{variant}_AV.pt", run_id=variant)
    images = add(graph, "TerryAccelLabDecodeVideo", samples=link(checkpoint),
                 vae=link(video_vae), run_id=variant)
    trim = add(graph, "ImageFromBatch", image=link(images), batch_index=0, length=96)
    audio = add(graph, "TerryAccelLabDecodeAudio", samples=link(checkpoint),
                vae=link(audio_vae), run_id=variant)
    trimmed_audio = add(graph, "TrimAudioDuration", audio=link(audio),
                        start_index=0.0, duration=4.0)
    video = add(graph, "CreateVideo", images=link(trim), fps=24.0,
                audio=link(trimmed_audio))
    add(graph, "TerryAccelLabSaveVideo", video=link(video),
        filename_prefix=f"video/Lab_{variant}_Clip1", run_id=variant)
    return graph


def build_decode(original, variant):
    if variant not in ("V0", "V1"):
        raise ValueError(variant)
    graph = {}
    latent = add(graph, "TerryAccelLabLoadAV", filename="B0_AV.pt", run_id=variant)
    vae = add(graph, "VAELoader", **original["prompt"]["330"]["inputs"])
    decoded = add(graph, "TerryAccelLabDecodeVideo", samples=link(latent),
                  vae=link(vae), run_id=variant)
    trim = add(graph, "ImageFromBatch", image=link(decoded), batch_index=0, length=96)
    video = add(graph, "CreateVideo", images=link(trim), fps=24.0)
    add(graph, "TerryAccelLabSaveVideo", video=link(video),
        filename_prefix=f"video/Lab_{variant}_Clip1", run_id=variant)
    return graph


def build_ui(graph, object_info=None):
    """LiteGraph-format companion with the exact API input graph embedded."""
    output_types = {
        "UNETLoader": ["MODEL"], "LoraLoaderModelOnly": ["MODEL"],
        "ModelAttentionBackend": ["MODEL"], "MiniMaxLowVRAMAttention": ["MODEL"],
        "MiniMaxChunkFeedForward": ["MODEL"], "BlockSparseAttention": ["MODEL"],
        "CLIPLoader": ["CLIP"], "VAELoader": ["VAE"], "LoadImage": ["IMAGE", "MASK"],
        "TerryAccelLabCondition": ["CONDITIONING", "LATENT"],
        "ConditioningZeroOut": ["CONDITIONING"], "BasicScheduler": ["SIGMAS"],
        "TerryAccelLabSigmaRefine": ["SIGMAS"], "KSamplerSelect": ["SAMPLER"],
        "TerryAccelLabSelfLift": ["LATENT"], "TerryAccelLabCheckpointAV": ["LATENT"],
        "TerryAccelLabLoadAV": ["LATENT"], "TerryAccelLabDecodeVideo": ["IMAGE"],
        "TerryAccelLabDecodeAudio": ["AUDIO"], "ImageFromBatch": ["IMAGE"],
        "TrimAudioDuration": ["AUDIO"], "CreateVideo": ["VIDEO"],
        "TerryAccelLabSaveVideo": ["VIDEO"],
    }
    nodes, links = [], []
    for node_id, item in graph.items():
        kind = item["class_type"]
        if kind not in output_types:
            raise ValueError(f"Unknown UI output type for {kind}")
        inputs, named = [], {}
        for name, value in item["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] in graph:
                source_id, slot = value
                wire_type = output_types[graph[source_id]["class_type"]][slot]
                edge = len(links) + 1
                links.append([edge, int(source_id), slot, int(node_id), len(inputs), wire_type])
                inputs.append({"name": name, "type": wire_type, "link": edge})
            else:
                named[name] = value
                inputs.append({"name": name, "type": "*", "widget": {"name": name}, "link": None})
        outputs = []
        for slot, wire_type in enumerate(output_types[kind]):
            edges = [edge[0] for edge in links if edge[1] == int(node_id) and edge[2] == slot]
            outputs.append({"name": wire_type, "type": wire_type, "links": edges or None})
        nodes.append({"id": int(node_id), "type": kind,
            "pos": [100 + (int(node_id) % 6) * 350, 100 + (int(node_id) // 6) * 250],
            "size": [300, 180], "flags": {}, "order": int(node_id)-1, "mode": 0,
            "inputs": inputs, "outputs": outputs, "properties": {"Node name for S&R": kind},
            "widgets_values_named": named, "widgets_values": list(named.values())})
    # Fill producer links after every consuming node has been considered.
    for node in nodes:
        for slot, output in enumerate(node["outputs"]):
            edges = [edge[0] for edge in links if edge[1] == node["id"] and edge[2] == slot]
            output["links"] = edges or None
    return {"last_node_id": len(nodes), "last_link_id": len(links),
            "nodes": nodes, "links": links, "groups": [], "config": {},
            "extra": {"acceleration_lab_api": graph}, "version": .4}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--vae-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=LAB / "local" / "workflows")
    args = parser.parse_args()
    if digest(args.request) != REQUEST_SHA256:
        raise ValueError("Report 46 request hash mismatch")
    original = json.loads(args.request.read_text(encoding="utf-8"))
    document = json.loads(original["prompt"]["9700451"]["inputs"]["config_json"])["document"]
    plan = _load_compiler()(document)
    segment = plan["segments"][0]
    if len(plan["segments"]) != 1:
        raise ValueError("Expected one original four-second clip")
    assert segment["output_frames"] == 96 and segment["h3_frames"] == 107
    asset_rows = []
    for group in ("images", "videos", "audios"):
        for asset in segment["assets"][group]:
            path = args.input_dir / asset["source"]["path"]
            if not path.is_file():
                raise FileNotFoundError(path)
            asset_rows.append({"group": group, "id": asset["id"],
                               "global_number": asset["global_number"],
                               "local_number": asset["local_number"],
                               "filename": asset["source"]["path"], "sha256": digest(path)})
    selected_vae = original["prompt"]["330"]["inputs"]["vae_name"]
    vae_path = args.vae_dir / selected_vae
    if not vae_path.is_file():
        raise FileNotFoundError(vae_path)
    vae_hash = digest(vae_path)
    already_active = selected_vae == "minimax_h3_video_vae_int8_convrot.safetensors" and vae_hash == CANONICAL_VAE_SHA256
    args.output_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for variant, name in (("B0", "Lab_B0_Dense_Clip1"), ("B1", "Lab_B1_SolAttn_Clip1"),
                          ("V0", "Lab_V0_CurrentVAE_Decode"), ("V1", "Lab_V1_INT8VAE_Decode")):
        graph = build_sample(original, segment, variant) if variant.startswith("B") else build_decode(original, variant)
        ui = build_ui(graph)
        api_path = args.output_dir / (name + ".api.json")
        ui_path = args.output_dir / (name + ".json")
        api_path.write_text(json.dumps({"prompt": graph}, ensure_ascii=False, indent=2), encoding="utf-8")
        ui_path.write_text(json.dumps(ui, ensure_ascii=False, indent=2), encoding="utf-8")
        paths[variant] = {"api": str(api_path), "ui": str(ui_path), "api_sha256": digest(api_path),
                          "ui_sha256": digest(ui_path)}
    mapping = {"request_sha256": REQUEST_SHA256, "prompt_sha256": hashlib.sha256(segment["prompt"].encode("utf-8")).hexdigest(),
               "global_prompt_sha256": hashlib.sha256(document["globalPrompt"].encode("utf-8")).hexdigest(),
               "clip_prompt_sha256": hashlib.sha256(document["clips"][0]["prompt"].encode("utf-8")).hexdigest(),
               "use_global_prompt": document["clips"][0].get("useGlobalPrompt") is not False,
               "assets": asset_rows, "segment": {k: segment[k] for k in ("id", "output_frames", "h3_frames", "continuity", "assembly")},
               "selected_video_vae": selected_vae, "video_vae_sha256": vae_hash,
               "official_int8_already_active": already_active, "workflows": paths}
    (args.output_dir / "input_mapping.private.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"workflows": paths, "prompt_sha256": mapping["prompt_sha256"],
                      "asset_count": len(asset_rows), "official_int8_already_active": already_active}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
