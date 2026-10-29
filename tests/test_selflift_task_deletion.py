"""CPU-only tests for 预演台 batch deletion and queued checkpoint protection."""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_task_delete_testpkg"


class TaskDeletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pkg = types.ModuleType(PACKAGE)
        pkg.__path__ = [str(ROOT)]
        cls.previous_package = sys.modules.get(PACKAGE)
        cls.previous_checkpoint = sys.modules.get(PACKAGE + ".director_selflift_checkpoint")
        sys.modules[PACKAGE] = pkg

        checkpoint = types.ModuleType(PACKAGE + ".director_selflift_checkpoint")

        def read_manifest(checkpoint_id):
            root = Path(sys.modules["folder_paths"].get_output_directory())
            path = root / "TerryDirector" / "checkpoints" / checkpoint_id / "manifest.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("checkpoint_id") != checkpoint_id:
                raise ValueError("检查点 ID 不匹配")
            return value

        checkpoint.read_manifest = read_manifest
        checkpoint.list_checkpoints = lambda: []
        sys.modules[PACKAGE + ".director_selflift_checkpoint"] = checkpoint
        cls.previous_paths = sys.modules.get("folder_paths")
        fake_paths = types.ModuleType("folder_paths")
        sys.modules["folder_paths"] = fake_paths
        cls.module = importlib.import_module(PACKAGE + ".director_selflift_task_store")

    @classmethod
    def tearDownClass(cls):
        for key, value in ((PACKAGE, cls.previous_package),
                           (PACKAGE + ".director_selflift_checkpoint",
                            cls.previous_checkpoint),
                           ("folder_paths", cls.previous_paths)):
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        sys.modules["folder_paths"].get_output_directory = lambda: self.temp.name
        self.root = Path(self.temp.name) / "TerryDirector" / "checkpoints"
        self.root.mkdir(parents=True)

    def task(self, char):
        checkpoint_id = char * 32
        folder = self.root / checkpoint_id
        folder.mkdir()
        (folder / "manifest.json").write_text(
            json.dumps({"checkpoint_id": checkpoint_id}), encoding="utf-8")
        (folder / "state.safetensors").write_bytes(b"checkpoint")
        (folder / "task.json").write_text("{}", encoding="utf-8")
        (folder / "review.mp4").write_bytes(b"video")
        (folder / "sampling_preview.webp").write_bytes(b"preview")
        return checkpoint_id

    def test_delete_multiple_checkpoint_folders_only(self):
        first, second, kept = self.task("a"), self.task("b"), self.task("c")
        outside = Path(self.temp.name) / "keep.mp4"
        outside.write_bytes(b"outside")
        removed = self.module.delete_checkpoints([first, second])
        self.assertEqual(removed, [first, second])
        self.assertFalse((self.root / first).exists())
        self.assertFalse((self.root / second).exists())
        self.assertTrue((self.root / kept / "state.safetensors").exists())
        self.assertEqual(outside.read_bytes(), b"outside")

    def test_reject_invalid_or_missing_before_removing_any(self):
        existing = self.task("a")
        for ids in ([existing, "../outside"], [existing, "b" * 32],
                    [existing, existing], [], [existing] * 501):
            with self.subTest(ids=ids[:3]), self.assertRaises(ValueError):
                self.module.delete_checkpoints(ids)
            self.assertTrue((self.root / existing).exists())

    def test_reject_folder_symlink(self):
        valid = self.task("a")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        linked = self.root / ("d" * 32)
        try:
            linked.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink privilege not available")
        with self.assertRaises(ValueError):
            self.module.delete_checkpoints([valid, "d" * 32])
        self.assertTrue((self.root / valid).exists())
        self.assertTrue(outside.exists())

    def test_queued_and_running_highres_protect_selected_checkpoint(self):
        cid = self.task("a")
        prompt = {"13": {"class_type": "TerryDirectorSelfLiftPauseResume",
                         "inputs": {"mode": "继续高清", "checkpoint_id": cid}}}
        item = (0, "p-1", prompt)
        self.assertEqual(self.module.checkpoint_ids_in_queue([item], {cid}), {cid})
        self.assertEqual(self.module.checkpoint_ids_in_queue([item], {"b" * 32}), set())

    def test_running_first_stage_blocks_all_deletion(self):
        item = (0, "p-2", {
            "13": {"class_type": "TerryDirectorSelfLiftPauseResume",
                   "inputs": {"mode": "暂停并保存", "checkpoint_id": ""}},
        })
        self.assertEqual(
            self.module.checkpoint_ids_in_queue([item], {"a" * 32}, running=True),
            {"*"},
        )
        self.assertEqual(self.module.checkpoint_ids_in_queue([item], {"a" * 32}),
                         set())

    def test_read_checkpoint_queue_reference_is_protected(self):
        cid = self.task("a")
        item = (1, "p-3", {
            "7": {"class_type": "TerryDirectorReadLowresCheckpoint",
                  "inputs": {"task": "S1_E1 · " + cid[:8]}},
        })
        self.assertEqual(self.module.checkpoint_ids_in_queue([item], {cid}), {cid})


if __name__ == "__main__":
    unittest.main()
