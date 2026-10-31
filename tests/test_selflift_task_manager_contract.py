"""Low-risk, model-free contracts for SelfLift task manager example wiring."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _graph():
    return json.loads((ROOT / "examples/TerryDirector_SelfLift_03_Pause_Continue.json").read_text(encoding="utf-8"))


def test_checkpoint_local_review_sink_is_wired_from_clean_latent():
    graph = _graph()
    nodes = {node["id"]: node for node in graph["nodes"]}
    links = {link[0]: link for link in graph["links"]}
    pause = nodes[13]
    sampler = nodes[11]
    review = nodes[39]

    assert pause["type"] == "TerryDirectorSelfLiftPauseResume"
    assert review["type"] == "TerryDirectorLowresReviewSave"
    assert sampler["type"] == "SamplerCustom"
    assert review["inputs"][0]["name"] == "checkpoint_id"
    assert links[review["inputs"][0]["link"]][1:5] == [13, 1, 39, 0]
    assert links[nodes[37]["inputs"][0]["link"]][1:3] == [11, 1]
    assert links[nodes[38]["inputs"][0]["link"]][1:3] == [11, 1]
    assert links[review["inputs"][1]["link"]][1:5] == [37, 0, 39, 1]
    assert links[review["inputs"][2]["link"]][1:5] == [38, 0, 39, 2]


def test_every_comfy_graph_link_is_consistent():
    graph = _graph()
    nodes = {node["id"]: node for node in graph["nodes"]}
    for id_, source, source_slot, target, target_slot, _type in graph["links"]:
        assert id_ in (nodes[source]["outputs"][source_slot]["links"] or [])
        assert nodes[target]["inputs"][target_slot]["link"] == id_


def test_highres_route_still_runs_through_pause_checkpoint():
    graph = _graph()
    nodes = {node["id"]: node for node in graph["nodes"]}
    links = {link[0]: link for link in graph["links"]}
    highres = nodes[18]
    assert links[highres["inputs"][0]["link"]][1:5] == [13, 0, 18, 0]
    assert nodes[22]["type"] == "SaveVideo"
    # The example now uses TerryDirector's independently encoded WebP preview.
    native = next(n for n in graph["nodes"] if n["type"] == "TerryDirectorH3Preview")
    assert native["widgets_values"][0] == "taeh3.safetensors"
    assert any(input_["name"] == "preview_frames" and input_["link"] is not None
               for input_ in native["inputs"])
    assert any(input_["name"] == "preview_tiny_vae" for input_ in pause["inputs"])
