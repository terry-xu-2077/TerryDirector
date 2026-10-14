"""CPU-only checks for global AI backend. No ComfyUI or GGUF model needed."""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "_td_test_global_ai"


def _load_module(path: str, target: str):
    spec = importlib.util.spec_from_file_location(target, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[target] = module
    spec.loader.exec_module(module)
    return module


def test_global_vlm_scope_and_asset_integrity():
    package = types.ModuleType(PREFIX)
    package.__path__ = [str(ROOT)]
    sys.modules[PREFIX] = package
    old_folder_paths = sys.modules.get("folder_paths")
    fake_folder_paths = types.SimpleNamespace(
        models_dir=str(ROOT),
        get_input_directory=lambda: str(ROOT),
        get_output_directory=lambda: str(ROOT),
    )
    sys.modules["folder_paths"] = fake_folder_paths
    try:
        core = _load_module("director_ai_core.py", PREFIX + ".director_ai_core")
        mod = _load_module("director_ai.py", PREFIX + ".director_ai")
        mod._image_data_url = lambda asset: "data:image/jpeg;base64,Zg=="
        doc = {
            "globalPrompt":
                "Photorealistic art direction. " +
                " ".join(f"<Picture {i}>" for i in range(1, 8)),
            "globalPromptMode": "user",
            "assets": [
                {"id": f"asset-{i}", "number": i, "kind": "image",
                 "name": f"reference-{i}.jpg",
                 "source": {"type": "comfy-input", "path": f"reference-{i}.jpg"}}
                for i in range(1, 8)
            ],
        }
        messages, required = mod._make_global_messages(doc)
        assert required == {("picture", i) for i in range(1, 8)}
        assert len(messages) == 2
        user = messages[1]["content"]
        assert len([p for p in user if p.get("type") == "image_url"]) == 7
        system = messages[0]["content"]
        assert "GLOBAL, not a segment" in system
        assert "Do not add clip-specific actions" in system
        assert "Never renumber an asset" in system

        sample_result = (
            "[Global direction]\nPhotorealistic wasteland.\n\n"
            "[Visual language]\nHandheld live action.\n\n"
            "[Lighting and palette]\nCold shadows.\n\n"
            "[Shared reference definitions]\n" +
            "\n".join(f"<Picture {i}> is reference {i}." for i in range(1, 8))
        )
        call_seeds = []
        class FakeSession:
            def __init__(self, cfg):
                self.config = cfg
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, traceback):
                return False
            def chat(self, messages, seed, cancel, *, comfy_interrupt=False):
                call_seeds.append(seed)
                return sample_result

        mod._LlamaSession = FakeSession
        cfg = {
            "type": core.AI_CONFIG_TYPE, "version": 1,
            "model": "Qwen3.8-27B-Q4_K_M.gguf", "vision_model": "mmproj.gguf",
            "seed": 8888,
        }
        result = mod.AIManager().enhance_global(cfg, doc)
        assert result["id"] == "__global__"
        assert result["prompt"] == sample_result
        assert result["metadata"]["seed"] == 8888
        assert result["metadata"]["sourcePrompt"] == doc["globalPrompt"]
        assert result["metadata"]["skill"] == "h3-prompt-writing-global"
        assert call_seeds == [core.clip_seed(8888, "__global__")]
        assert "aiGlobalPrompt" not in doc and doc["globalPromptMode"] == "user"

        doc["globalPromptMode"] = "ai"
        doc["aiGlobalPrompt"] = result["prompt"]
        assert core.effective_global_prompt(doc) == sample_result

        # Reject a rewrite that loses a reference even when it otherwise looks valid.
        try:
            mod._validate_output("<Picture 1> only", required, required)
            raise AssertionError("Missing global Picture tags unexpectedly accepted")
        except ValueError as e:
            assert "丢失" in str(e)
        # Do not silently let one-shot enhancement invent a dynamic tail image.
        try:
            mod._validate_output(sample_result + "\n<Picture 8>", required, required)
            raise AssertionError("Invented Picture 8 unexpectedly accepted")
        except ValueError as e:
            assert "不存在" in str(e)
    finally:
        for name in list(sys.modules):
            if name == PREFIX or name.startswith(PREFIX + "."):
                sys.modules.pop(name, None)
        if old_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = old_folder_paths
