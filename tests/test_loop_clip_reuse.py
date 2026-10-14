"""Offline backend regression for physical timeline and history MOV lookup."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "_terrydirector_clip_reuse_test"


def load(path, target):
    spec = importlib.util.spec_from_file_location(target, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[target] = module
    spec.loader.exec_module(module)
    return module


class TestPhysicalClips(unittest.TestCase):
    def setUp(self):
        self._package = types.ModuleType(PREFIX)
        self._package.__path__ = [str(ROOT)]
        sys.modules[PREFIX] = self._package
        self.core = load("director_core.py", PREFIX + ".director_core")
        load("director_ai_core.py", PREFIX + ".director_ai_core")
        self.compiler = load("director_compile.py", PREFIX + ".director_compile")

    def tearDown(self):
        for key in list(sys.modules):
            if key == PREFIX or key.startswith(PREFIX + "."):
                sys.modules.pop(key, None)

    def test_entity_uses_video_asset_no_sampler_and_supplies_overlap(self):
        doc = self.core.default_document()
        doc["assets"] = [{
            "id": "video-1", "kind": "video", "number": 1,
            "name": "External.mov",
            "source": {"type": "comfy-input", "path": "External.mov"},
        }]
        doc["clips"] = [
            {
                **doc["clips"][0], "id": "A", "name": "Physical A",
                "kind": "entity", "sourceAssetId": "video-1",
                "end": 240, "suspended": False,
            },
            {
                **doc["clips"][0], "id": "B", "name": "Generated B",
                "kind": "generated", "sourceAssetId": "",
                "start": 216, "end": 456,
            },
        ]
        normalized = self.core.normalize_document(doc)
        self.assertEqual(normalized["clips"][0]["sourceAssetId"], "video-1")
        plan = self.compiler.compile_timeline(normalized)
        self.assertEqual([p["kind"] for p in plan["segments"]], ["entity", "generated"])
        self.assertFalse(plan["segments"][0]["include_in_final"])
        self.assertEqual(plan["segments"][0]["h3_frames"], 240)
        self.assertEqual(plan["segments"][1]["continuity"]["kind"], "overlap")
        self.assertEqual(plan["segments"][1]["continuity"]["frames"], 24)
        self.assertEqual(plan["segments"][1]["assembly"]["trim_head_frames"], 24)
        self.assertEqual(plan["segments"][0]["source_asset"]["source"]["path"], "External.mov")

    def test_missing_video_must_error_and_never_silently_generate(self):
        doc = self.core.default_document()
        doc["clips"][0]["kind"] = "entity"
        doc["clips"][0]["sourceAssetId"] = "unknown"
        with self.assertRaisesRegex(ValueError, "缺少有效的视频资产"):
            self.compiler.compile_timeline(self.core.normalize_document(doc))

    def _plan(self, doc, target, *, prior_available=True):
        import ast
        import copy
        import uuid
        from types import SimpleNamespace

        source = (ROOT / "director_loop.py").read_text("utf-8")
        tree = ast.parse(source)
        node = next(item for item in tree.body
                    if isinstance(item, ast.FunctionDef) and item.name == "_plan_items")
        adapter = SimpleNamespace(
            info=SimpleNamespace(adapter_id="minimax_h3"),
            compile_plan=lambda document, prompt, compiler: compiler(document, prompt),
            sampling_frames=lambda segment: segment["h3_frames"],
        )
        scope = {
            "DEFAULT_LOOP_ADAPTER": "minimax_h3",
            "get_loop_adapter": lambda _: adapter,
            "normalize_config": lambda config: {
                "document": self.core.normalize_document(config["document"]),
            },
            "prepare_document_for_queue": lambda document, _llama, _id: copy.deepcopy(document),
            "compile_timeline": self.compiler.compile_timeline,
            "find_saved_clip": lambda _loop, clip_id, required_frames=None: (
                {"path": "/fake/prior.mov"}
                if prior_available and clip_id == "A" else None
            ),
            "safe_input_video": lambda _asset: "/fake/entity.mov",
            "uuid": uuid,
        }
        exec(compile(ast.Module(body=[node], type_ignores=[]),
                     "director_loop.py", "exec"), scope)
        return scope["_plan_items"](
            {"document": doc}, 77, "Tail: {picture}", "42",
            rerun_clip_id=target,
        )

    def test_single_rerun_preserves_original_overlap_and_only_two_steps(self):
        doc = self.core.default_document()
        base = dict(doc["clips"][0])
        doc["clips"] = [
            {**base, "id": "A", "name": "A", "start": 0, "end": 240},
            {**base, "id": "B", "name": "B", "start": 216, "end": 456},
            {**base, "id": "C", "name": "C", "start": 456, "end": 696},
        ]
        items = self._plan(doc, "B")
        self.assertEqual([x["id"] for x in items], ["A", "B"])
        self.assertEqual(
            [x["_loop"]["action"] for x in items], ["reuse_result", "generate"]
        )
        self.assertEqual(items[0]["_loop"]["context_frames"], 24)
        self.assertEqual(items[1]["continuity"]["kind"], "overlap")
        self.assertEqual(items[1]["assembly"]["trim_head_frames"], 24)
        self.assertEqual(items[1]["_loop"]["authored_index"], 1)
        self.assertEqual(items[1]["_loop"]["rerun_target"], "B")
        with self.assertRaisesRegex(FileNotFoundError, "缺少承接上下文"):
            self._plan(doc, "B", prior_available=False)

    def test_entity_anchor_rerun_keeps_entire_generated_head(self):
        doc = self.core.default_document()
        doc["assets"] = [{
            "id": "v", "kind": "video", "number": 1,
            "name": "anchor.mov",
            "source": {"type": "comfy-input", "path": "anchor.mov"},
        }]
        base = dict(doc["clips"][0])
        doc["clips"] = [
            {**base, "id": "A", "name": "Physical A",
             "kind": "entity", "sourceAssetId": "v",
             "start": 0, "end": 240},
            {**base, "id": "B", "name": "B",
             "start": 216, "end": 456},
        ]
        items = self._plan(doc, "B")
        self.assertEqual(items[0]["_loop"]["action"], "entity")
        self.assertEqual(items[1]["_loop"]["action"], "generate")
        self.assertEqual(items[1]["continuity"]["frames"], 24)
        self.assertEqual(items[1]["assembly"]["trim_head_frames"], 0)

    def test_legacy_clips_remain_generated(self):
        doc = self.core.default_document()
        del doc["clips"][0]["kind"]
        normalized = self.core.normalize_document(doc)
        self.assertEqual(normalized["clips"][0]["kind"], "generated")


class TestSavedMovieDiscovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="td_clip_history_test")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        paths = types.ModuleType("folder_paths")
        paths.get_output_directory = lambda: str(self.root)
        paths.get_input_directory = lambda: str(self.root / "input")
        self._mod_stubs = {
            "folder_paths": paths,
            "torch": types.ModuleType("torch"),
            "numpy": types.ModuleType("numpy"),
        }
        self.patcher = mock.patch.dict(sys.modules, self._mod_stubs)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        package = types.ModuleType(PREFIX + "_lookup")
        package.__path__ = [str(ROOT)]
        sys.modules[package.__name__] = package
        self.module_name = package.__name__ + ".director_loop_reuse"
        self.reuse = load("director_loop_reuse.py", self.module_name)
        self.addCleanup(lambda: [
            sys.modules.pop(key, None)
            for key in [self.module_name, package.__name__]
        ])

    def save(self, run, clip_id="A", frames=240, movie_name="001.mov", path_override=None):
        root = self.root / "TerryDirector" / "renders" / "loop-42" / run
        root.mkdir(parents=True, exist_ok=True)
        movie = root / "clips" / movie_name
        movie.parent.mkdir(exist_ok=True)
        movie.write_bytes(b"test-mov")
        data = {
            "clips": [{
                "segment_id": clip_id, "frames": frames,
                "fps": 24, "path": path_override or str(movie),
            }],
        }
        (root / "timeline.json").write_text(json.dumps(data), "utf-8")
        return movie

    def test_finds_most_recent_compatible_clip(self):
        older = self.save("old")
        latest = self.save("new", frames=300)
        self.assertEqual(
            self.reuse.find_saved_clip("42", "A", 300)["path"],
            str(latest.resolve()),
        )
        self.assertEqual(
            self.reuse.find_saved_clip("42", "A", 240)["path"],
            str(older.resolve()),
        )
        self.assertIsNone(self.reuse.find_saved_clip("42", "C", 240))

    def test_does_not_follow_manifest_outside_output_root(self):
        outside = self.root / "outside.mov"
        outside.write_bytes(b"data")
        self.save("malicious", path_override=str(outside))
        self.assertIsNone(self.reuse.find_saved_clip("42", "A", 240))


if __name__ == "__main__":
    unittest.main()
