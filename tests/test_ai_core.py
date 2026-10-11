"""Regression checks for the AI Seed-only refresh contract (no ComfyUI required)."""
import importlib.util
from pathlib import Path

module_path = Path(__file__).resolve().parents[1] / "director_ai_core.py"
spec = importlib.util.spec_from_file_location("td_ai_core", module_path)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def _clip():
    return dict(id="clip-a", prompt="first", aiPrompt="enhanced", promptMode="ai",
                aiMetadata={"seed": 8888, "sourceHash": "old"}, start=0, end=240,
                suspended=False, aiOptOut=False)


def test_ai_seed_alone_decides_refresh():
    item = _clip()
    assert core.needs_enhancement(item, 8888) is False
    item["prompt"] = "different"
    item["end"] = 600
    assert core.needs_enhancement(item, 8888) is False
    assert core.needs_enhancement(item, 8889) is True


def test_missing_result_triggers_once():
    item = _clip()
    item["aiPrompt"] = ""
    assert core.needs_enhancement(item, 8888)
    core.assign_ai_result(item, {"prompt": "fresh", "metadata": {"seed": 8888}})
    assert not core.needs_enhancement(item, 8888)
    assert item["prompt"] == "first"


def test_skips_explicit_user_and_suspended():
    doc = {"clips": [_clip(), _clip() | {"id": "b", "aiOptOut": True},
                     _clip() | {"id": "c", "suspended": True}]}
    assert [x["id"] for x in core.ai_targets(doc, 8889)] == ["clip-a"]


def test_output_selection_and_deterministic_clip_seed():
    item = _clip()
    assert core.effective_local_prompt(item) == "enhanced"
    item["promptMode"] = "user"
    assert core.effective_local_prompt(item) == "first"
    assert core.clip_seed(10, "a") == core.clip_seed(10, "a")
    assert core.clip_seed(10, "a") != core.clip_seed(11, "a")


def test_document_round_trip_keeps_ai_metadata_and_auto_flag():
    import runpy
    values = runpy.run_path(str(module_path.with_name("director_core.py")))
    defaults = values["default_document"]()
    defaults["autoAiEnhance"] = True
    defaults["clips"][0].update({
        "prompt": "source", "aiPrompt": "enhanced",
        "promptMode": "ai", "aiOptOut": False,
        "aiMetadata": {"seed": 8888, "sourcePrompt": "source"},
    })
    doc = values["normalize_document"](defaults)
    assert doc["autoAiEnhance"] is True
    assert doc["clips"][0]["prompt"] == "source"
    assert doc["clips"][0]["aiPrompt"] == "enhanced"
    assert doc["clips"][0]["promptMode"] == "ai"
    assert doc["clips"][0]["aiMetadata"]["seed"] == 8888
