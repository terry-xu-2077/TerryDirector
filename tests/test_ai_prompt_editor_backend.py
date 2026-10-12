"""CPU-only checks for the standalone prompt enhancement backend."""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "_td_test_prompt_editor_ai"


def _load_module(path: str, target: str):
    spec = importlib.util.spec_from_file_location(target, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[target] = module
    spec.loader.exec_module(module)
    return module


def test_standalone_prompt_uses_shared_skill_and_preserves_tags():
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

        source = "荒原上的女人回头看向镜头。<Picture 1>"
        messages, required = mod._make_standalone_prompt_messages(source)
        assert required == {("picture", 1)}
        assert len(messages) == 2
        assert "standalone H3 editor task" in messages[0]["content"]
        assert source in messages[1]["content"][0]["text"]

        custom, _ = mod._make_standalone_prompt_messages(
            source, system_prompt="  必须输出中文。  "
        )
        assert custom[0]["content"] == "必须输出中文。"

        fallback, _ = mod._make_standalone_prompt_messages(
            source, system_prompt=" \n\t ", system_prompt_preset="H3 Skill"
        )
        assert "standalone H3 editor task" in fallback[0]["content"]

        sample = "电影感荒原镜头，女人缓慢回头。<Picture 1>"
        class FakeSession:
            def __init__(self, cfg):
                self.config = cfg
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, traceback):
                return False
            def chat(self, messages, seed, cancel):
                return sample

        mod._LlamaSession = FakeSession
        cfg = {
            "type": core.AI_CONFIG_TYPE,
            "version": 1,
            "model": "Qwen3.8-27B-Q4_K_M.gguf",
            "vision_model": "None",
            "seed": 8888,
        }
        result = mod.AIManager().enhance_prompt(cfg, source)
        assert result["id"] == "__prompt__"
        assert result["prompt"] == sample
        assert result["metadata"]["sourcePrompt"] == source
        assert result["metadata"]["skill"] == "h3-prompt-writing-standalone"

        try:
            mod._validate_output("丢失参考标签", required, required)
            raise AssertionError("Missing Picture tag unexpectedly accepted")
        except ValueError as exc:
            assert "丢失" in str(exc)
    finally:
        for name in list(sys.modules):
            if name == PREFIX or name.startswith(PREFIX + "."):
                sys.modules.pop(name, None)
        if old_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = old_folder_paths
