"""CPU-only regression tests for authored per-clip generation seeds."""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "_td_test_clip_seed"


def _load(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_clip_seed_round_trip_and_compile():
    package = types.ModuleType(PREFIX)
    package.__path__ = [str(ROOT)]
    sys.modules[PREFIX] = package
    try:
        core = _load("director_core.py", PREFIX + ".director_core")
        _load("director_ai_core.py", PREFIX + ".director_ai_core")
        compile_mod = _load("director_compile.py", PREFIX + ".director_compile")

        doc = core.default_document()
        doc["clips"] = [
            {
                **doc["clips"][0],
                "id": "a",
                "name": "A",
                "start": 0,
                "end": 96,
                "seed": "18446744073709551615",
            },
            {
                **doc["clips"][0],
                "id": "b",
                "name": "B",
                "start": 96,
                "end": 192,
                "seed": None,
                "transitionMode": "independent",
            },
        ]
        normalized = core.normalize_document(doc)
        assert normalized["clips"][0]["seed"] == "18446744073709551615"
        assert normalized["clips"][1]["seed"] is None

        plan = compile_mod.compile_timeline(normalized)
        assert plan["segments"][0]["seed"] == 18446744073709551615
        assert plan["segments"][1]["seed"] is None


def test_clip_seed_is_clamped_without_browser_precision_loss():
    package = types.ModuleType(PREFIX + "_clamp")
    package.__path__ = [str(ROOT)]
    sys.modules[package.__name__] = package
    name = package.__name__ + ".director_core"
    try:
        core = _load("director_core.py", name)
        doc = core.default_document()
        doc["clips"][0]["seed"] = "999999999999999999999999999999999"
        normalized = core.normalize_document(doc)
        assert normalized["clips"][0]["seed"] == "18446744073709551615"

        doc["clips"][0]["seed"] = ""
        normalized = core.normalize_document(doc)
        assert normalized["clips"][0]["seed"] is None
    finally:
        for key in list(sys.modules):
            if key == package.__name__ or key.startswith(package.__name__ + "."):
                sys.modules.pop(key, None)
