"""CPU-only integration contracts for named Preview Stage templates."""
from __future__ import annotations
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_named_preview_catalog_testpkg"


class NamedPreviewTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.saved = {name: sys.modules.get(name) for name in (
            PACKAGE, PACKAGE + ".director_selflift_checkpoint",
            PACKAGE + ".director_selflift_task_store",
            PACKAGE + ".director_preview_template_catalog", "folder_paths"
        )}
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(ROOT)]
        sys.modules[PACKAGE] = package
        checkpoint = types.ModuleType(PACKAGE + ".director_selflift_checkpoint")
        checkpoint.list_checkpoints = lambda: []
        checkpoint.read_manifest = lambda _: {}
        sys.modules[PACKAGE + ".director_selflift_checkpoint"] = checkpoint
        sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: "")
        cls.catalog = importlib.import_module(PACKAGE + ".director_preview_template_catalog")

    @classmethod
    def tearDownClass(cls):
        for name, module in cls.saved.items():
            if module is None: sys.modules.pop(name, None)
            else: sys.modules[name] = module

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name)
        sys.modules["folder_paths"].get_output_directory = lambda: str(self.path)

    def preset(self, name):
        return {
            "schema": 2,
            "workflow_name": name,
            "workflow": {"nodes": [{"id": 13, "type": "TerryDirectorSelfLiftPauseResume"},
                                    {"id": 6, "type": "MiniMaxH3ReferenceToVideo"}], "links": []},
            "api_prompt": {
                "13": {"class_type": "TerryDirectorSelfLiftPauseResume",
                       "inputs": {"mode": "暂停并保存", "checkpoint_id": "", "name": "demo"}},
                "6": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {"prompt": "test"}},
                "77": {"class_type": "SeedNode", "inputs": {"seed": 8}},
                "22": {"class_type": "SaveVideo", "inputs": {"video": ["13", 0]}}},
            "pause_node_id": 13,
            "prompt_binding": {"node_id": 6, "widget_name": "prompt"},
            "seed_binding": {"node_id": 77, "widget_name": "seed"},
            "pause_target": "13", "highres_target": "22", "decoded_target": None,
            "seed_min": 0, "seed_max": 1125899906842624,
        }

    def test_names_defaults_rename_and_delete_dont_touch_checkpoints(self):
        catalog = self.catalog
        self.assertEqual(catalog.list_preview_templates()["templates"], [])
        a = catalog.save_preview_template(self.preset("第一套"))
        b = catalog.save_preview_template(self.preset("第二套"))
        self.assertNotEqual(a["id"], b["id"])
        index = catalog.list_preview_templates()
        self.assertEqual(len(index["templates"]), 2)
        self.assertEqual(index["default_id"], a["id"])
        self.assertEqual(catalog.load_preview_template()["workflow_name"], "第一套")
        catalog.set_default_preview_template(b["id"])
        self.assertEqual(catalog.load_preview_template()["workflow_name"], "第二套")
        catalog.rename_preview_template(b["id"], "第二套改名")
        self.assertEqual(catalog.load_preview_template(b["id"])["workflow_name"], "第二套改名")
        self.assertEqual(catalog.load_preview_template(a["id"])["workflow_name"], "第一套")
        checkpoint = self.path / "TerryDirector" / "checkpoints" / "abc"
        checkpoint.mkdir(parents=True)
        (checkpoint / "state.safetensors").write_bytes(b"keep")
        catalog.delete_preview_template(b["id"])
        self.assertEqual(catalog.list_preview_templates()["default_id"], a["id"])
        self.assertTrue((checkpoint / "state.safetensors").exists())
        self.assertEqual(len(catalog.list_preview_templates()["templates"]), 1)

    def test_edit_existing_does_not_create_second_entry(self):
        catalog = self.catalog
        saved = catalog.save_preview_template(self.preset("初版"))
        edited = self.preset("修订版")
        edited["template_id"] = saved["id"]
        result = catalog.save_preview_template(edited)
        self.assertEqual(result["id"], saved["id"])
        self.assertEqual(len(catalog.list_preview_templates()["templates"]), 1)
        self.assertEqual(catalog.load_preview_template()["workflow_name"], "修订版")

    def test_bad_ids_and_missing_input_are_rejected(self):
        catalog = self.catalog
        template = self.preset("合法")
        template["prompt_binding"] = {"node_id": 5, "widget_name": "preview"}
        with self.assertRaises(ValueError): catalog.save_preview_template(template)
        saved = catalog.save_preview_template(self.preset("合法"))
        for invalid in ("../outside", "", "x"*32):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError): catalog.delete_preview_template(invalid)
        self.assertEqual(catalog.load_preview_template(saved["id"])["workflow_name"], "合法")

    def test_legacy_single_workflow_is_migrated_without_removing_original(self):
        root = self.path / "TerryDirector" / "preview_stage"
        root.mkdir(parents=True)
        original = self.preset("历史配置")
        for name, data in (("config.json",{k:v for k,v in original.items() if k not in ("workflow","api_prompt")}),
                           ("workflow.json",original["workflow"]),
                           ("api_prompt.json",original["api_prompt"])):
            (root / name).write_text(json.dumps(data),encoding="utf-8")
        items = self.catalog.list_preview_templates()
        self.assertEqual(len(items["templates"]),1)
        self.assertEqual(self.catalog.load_preview_template()["workflow_name"],"历史配置")
        self.assertTrue((root / "workflow.json").is_file())


if __name__ == "__main__":
    unittest.main()
