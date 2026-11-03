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

    assert pause["type"] == "TerryDirectorPauseResume"
    assert review["type"] == "SaveVideo"
    assert sampler["type"] == "TerryDirectorSelfLiftLowres"
    assert links[nodes[37]["inputs"][0]["link"]][1:3] == [11, 0]
    assert links[nodes[38]["inputs"][0]["link"]][1:3] == [11, 0]
    create = nodes[40]
    assert create["type"] == "CreateVideo"
    assert links[review["inputs"][0]["link"]][1:5] == [40, 0, 39, 0]
    assert links[create["inputs"][0]["link"]][1:5] == [37, 0, 40, 0]
    assert links[next(i for i in create["inputs"] if i["name"] == "audio")["link"]][1:5] == [38, 0, 40, 2]


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
    assert highres["type"] == "TerryDirectorSelfLiftHighresSampler"
    assert links[highres["inputs"][0]["link"]][1:5] == [13, 0, 18, 0]
    assert nodes[22]["type"] == "SaveVideo"
    # The example now uses TerryDirector's independently encoded WebP preview.
    native = next(n for n in graph["nodes"] if n["type"] == "TerryDirectorH3Preview")
    assert native["widgets_values"][0] == "taeh3.safetensors"
    assert native["widgets_values"][1] == 6
    assert [i["name"] for i in nodes[13]["inputs"]] == ["mode", "checkpoint_id", "name", "latent"]
    assert any(i["name"] == "low_steps" for i in nodes[11]["inputs"])
    assert any(i["name"] == "high_steps" for i in highres["inputs"])


def test_seed_control_serialization_keeps_cfg_dimensions_and_combos_aligned():
    files = sorted((ROOT / "examples").glob("TerryDirector_SelfLift_*.json"))
    assert len(files) == 3
    for file in files:
        graph = json.loads(file.read_text(encoding="utf-8"))
        for node in graph["nodes"]:
            values = node.get("widgets_values", [])
            if node["type"] == "TerryDirectorSelfLiftLowres":
                assert values == [6, 8, "fixed", 1.0]
            elif node["type"] == "TerryDirectorSelfLiftHighresSampler":
                assert values[:6] == [3, 8, "fixed", 1.0, 1216, 672]
                assert values[6].endswith(".safetensors")
                assert values[7:] == [False, "manual", 4, "auto"]
            elif node["type"] == "PrimitiveInt":
                assert values[1] == "fixed"
        assert not any(n["type"] == "EmptyMiniMaxH3LatentAV" for n in graph["nodes"])
