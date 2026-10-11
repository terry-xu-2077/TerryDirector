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


def test_global_ai_version_round_trip_and_clip_seed_is_unchanged():
    import runpy
    values = runpy.run_path(str(module_path.with_name("director_core.py")))
    defaults = values["default_document"]()
    defaults.update({
        "globalPrompt": "original <Picture 1>",
        "aiGlobalPrompt": "enhanced <Picture 1>",
        "globalPromptMode": "ai",
        "globalAiMetadata": {"seed": 8888, "sourcePrompt": "original <Picture 1>"},
    })
    doc = values["normalize_document"](defaults)
    assert doc["globalPrompt"] == "original <Picture 1>"
    assert doc["aiGlobalPrompt"] == "enhanced <Picture 1>"
    assert doc["globalPromptMode"] == "ai"
    assert doc["globalAiMetadata"]["seed"] == 8888
    assert core.effective_global_prompt(doc) == "enhanced <Picture 1>"
    doc["globalPromptMode"] = "user"
    assert core.effective_global_prompt(doc) == "original <Picture 1>"
    doc["globalPromptMode"] = "ai"
    doc["aiGlobalPrompt"] = ""
    assert core.effective_global_prompt(doc) == "original <Picture 1>"
    c = _clip()
    assert not core.needs_enhancement(c, 8888)
    doc["globalPrompt"] = "different <Picture 1>"
    assert not core.needs_enhancement(c, 8888)


def test_global_ai_compiler_uses_selected_version_without_extra_tail():
    import importlib.util
    import sys
    import types
    import uuid
    from pathlib import Path
    root = module_path.parent
    name = "_terry_global_test_" + uuid.uuid4().hex
    package = types.ModuleType(name)
    package.__path__ = [str(root)]
    sys.modules[name] = package
    try:
        for base in ("director_core", "director_ai_core", "director_compile"):
            key = name+"."+base
            spec = importlib.util.spec_from_file_location(key, root/(base+".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[key] = module
            spec.loader.exec_module(module)
        comp = sys.modules[name+".director_compile"]
        doc = {
            "fps":24,
            "globalPrompt":"ORIGINAL GLOBAL",
            "aiGlobalPrompt":"AI GLOBAL",
            "globalPromptMode":"ai",
            "assets":[],
            "clips":[{"id":"clip-1","name":"One","start":0,"end":96,
                      "prompt":"ORIGINAL CLIP","aiPrompt":"","promptMode":"user",
                      "transitionMode":"tail_reference","useGlobalPrompt":True,
                      "suspended":False},
                     {"id":"clip-2","name":"Two","start":96,"end":168,
                      "prompt":"NEXT CLIP","aiPrompt":"","promptMode":"user",
                      "transitionMode":"tail_reference","useGlobalPrompt":True,
                      "suspended":False}],
        }
        plan=comp.compile_timeline(doc)
        segments=plan["segments"]
        assert segments[0]["prompt"].startswith("AI GLOBAL\n\nORIGINAL CLIP")
        assert segments[1]["prompt"].startswith("AI GLOBAL\n\nNEXT CLIP")
        assert segments[0]["continuity"]["kind"] == "independent"
        assert segments[1]["continuity"]["kind"] == "tail_reference"
        assert segments[1]["continuity"]["picture_number"] == 1
        doc["globalPromptMode"]="user"
        assert comp.compile_timeline(doc)["segments"][0]["prompt"].startswith("ORIGINAL GLOBAL")
    finally:
        for key in list(sys.modules):
            if key == name or key.startswith(name+"."):
                sys.modules.pop(key,None)
