"""CPU-only checks for per-clip AI Seed execution."""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "_td_test_ai_clip_seed_backend"


def _load_module(path: str, target: str):
    spec = importlib.util.spec_from_file_location(target, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[target] = module
    spec.loader.exec_module(module)
    return module


def test_batch_uses_clip_ai_seed_or_global_fallback():
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

        calls = []

        class FakeSession:
            def __init__(self, cfg):
                self.config = cfg

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def chat(self, messages, seed, cancel=None, *, comfy_interrupt=False):
                calls.append(seed)
                return "A concise cinematic H3 prompt."

        mod._LlamaSession = FakeSession
        config = {
            "type": core.AI_CONFIG_TYPE,
            "version": 1,
            "model": "Qwen3.8-27B-Q4_K_M.gguf",
            "vision_model": "None",
            "seed": 8888,
        }
        clips = [
            {
                "id": "clip-a",
                "name": "A",
                "start": 0,
                "end": 96,
                "prompt": "A person turns toward camera.",
                "aiSeed": "12345678901234567890",
                "useGlobalPrompt": False,
                "suspended": False,
                "aiOptOut": False,
            },
            {
                "id": "clip-b",
                "name": "B",
                "start": 96,
                "end": 192,
                "prompt": "A person walks away.",
                "aiSeed": None,
                "useGlobalPrompt": False,
                "suspended": False,
                "aiOptOut": False,
            },
        ]
        document = {
            "globalPrompt": "",
            "globalPromptMode": "user",
            "assets": [],
            "clips": clips,
        }

        results = mod.AIManager().enhance_batch(config, document, clips)

        assert [r["metadata"]["seed"] for r in results] == [
            "12345678901234567890",
            "8888",
        ]
        assert calls == [
            core.clip_seed(12345678901234567890, "clip-a"),
            core.clip_seed(8888, "clip-b"),
        ]
    finally:
        for name in list(sys.modules):
            if name == PREFIX or name.startswith(PREFIX + "."):
                sys.modules.pop(name, None)
        if old_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = old_folder_paths
