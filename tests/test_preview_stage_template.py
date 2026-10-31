"""CPU-only regression for reusable 预演台 workflow configurations."""
import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_preview_stage_template_testpkg"


class PreviewStageTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pkg = types.ModuleType(PACKAGE)
        pkg.__path__ = [str(ROOT)]
        cls.original_pkg = sys.modules.get(PACKAGE)
        cls.original_cp = sys.modules.get(PACKAGE + ".director_selflift_checkpoint")
        cls.original_paths = sys.modules.get("folder_paths")
        sys.modules[PACKAGE] = pkg
        checkpoints = types.ModuleType(PACKAGE + ".director_selflift_checkpoint")
        checkpoints.list_checkpoints = lambda: []
        checkpoints.read_manifest = lambda _: {}
        sys.modules[PACKAGE + ".director_selflift_checkpoint"] = checkpoints
        sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: "")
        cls.store = importlib.import_module(PACKAGE + ".director_selflift_task_store")

    @classmethod
    def tearDownClass(cls):
        for name, value in ((PACKAGE, cls.original_pkg),
                            (PACKAGE + ".director_selflift_checkpoint", cls.original_cp),
                            ("folder_paths", cls.original_paths)):
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        sys.modules["folder_paths"].get_output_directory = lambda: self.temp.name

    def template(self):
        return {
            "schema": 2,
            "workflow_name": "首阶段工作流",
            "workflow": {"nodes": [
                {"id": 13, "type": "TerryDirectorSelfLiftPauseResume"},
                {"id": 6, "type": "MiniMaxH3ReferenceToVideo"},
                {"id": 33, "type": "SeedNode"},
            ], "links": []},
            "pause_node_id": 13,
            "prompt_binding": {"node_id": 6, "widget_name": "prompt"},
            "seed_binding": {"node_id": 33, "widget_name": "seed"},
            "api_prompt": {
                "13": {"class_type": "TerryDirectorSelfLiftPauseResume",
                       "inputs": {"mode": "暂停并保存", "checkpoint_id": "", "name": "demo"}},
                "6": {"class_type": "MiniMaxH3ReferenceToVideo",
                      "inputs": {"prompt": "example"}},
                "33": {"class_type": "SeedNode", "inputs": {"seed": 8}},
                "22": {"class_type": "SaveVideo", "inputs": {"video": ["13", 0]}},
            },
            "pause_target": "13",
            "highres_target": "22",
            "decoded_target": None,
            "seed_min": 0,
            "seed_max": 1125899906842624,
        }

    def test_empty_then_roundtrip(self):
        self.assertEqual(self.store.load_preview_template(), {})
        template = self.template()
        self.store.save_preview_template(template)
        self.assertEqual(self.store.load_preview_template(), template)
        root = Path(self.temp.name) / "TerryDirector" / "preview_stage"
        self.assertTrue((root / "config.json").is_file())
        self.assertTrue((root / "workflow.json").is_file())
        self.assertTrue((root / "api_prompt.json").is_file())

    def test_bad_pause_or_mapping_rejected_without_clobbering(self):
        valid = self.template()
        self.store.save_preview_template(valid)
        for patch in (
            {"pause_node_id": 1234},
            {"prompt_binding": {"node_id": 555, "widget_name": "prompt"}},
            {"seed_binding": None},
            {"highres_target": "999"},
            {"seed_max": -1},
            {"schema": 1},
        ):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.store.save_preview_template({**valid, **patch})
            self.assertEqual(self.store.load_preview_template(), valid)

    def test_size_limit(self):
        item = self.template()
        item["workflow_name"] = "A" * (16 * 1024 * 1024)
        with self.assertRaises(ValueError):
            self.store.save_preview_template(item)


if __name__ == "__main__":
    unittest.main()
