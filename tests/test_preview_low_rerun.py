"""Low-res replacement uses temporary results only; never runs a sampler."""
import importlib
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_low_rerun_testpkg"


class LowRerunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.previous = {key: sys.modules.get(key) for key in (
            "folder_paths", PACKAGE, PACKAGE + ".director_selflift_checkpoint",
            PACKAGE + ".director_preview_draft_store", PACKAGE + ".director_preview_task_store")}
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(ROOT / "nodes")]
        sys.modules[PACKAGE] = package
        sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: "")
        checkpoint = types.ModuleType(PACKAGE + ".director_selflift_checkpoint")

        def read_manifest(cid):
            root = Path(sys.modules["folder_paths"].get_output_directory())
            value = json.loads((root / "TerryDirector" / "checkpoints" / cid /
                                "manifest.json").read_text(encoding="utf-8"))
            if value["checkpoint_id"] != cid:
                raise ValueError("检查点 ID 不匹配")
            return value

        checkpoint.read_manifest = read_manifest
        checkpoint.list_checkpoints = lambda: []
        sys.modules[checkpoint.__name__] = checkpoint
        cls.tasks = importlib.import_module(PACKAGE + ".director_preview_task_store")
        cls.drafts = importlib.import_module(PACKAGE + ".director_preview_draft_store")

    @classmethod
    def tearDownClass(cls):
        for key, original in cls.previous.items():
            if original is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = original

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        sys.modules["folder_paths"].get_output_directory = lambda: str(self.root)
        self.queue = types.SimpleNamespace(mutex=threading.RLock(),
                                          get_current_queue_volatile=lambda: ([], []))
        self.cid = "a" * 32
        self.folder = self.root / "TerryDirector" / "checkpoints" / self.cid
        self.folder.mkdir(parents=True)
        (self.folder / "manifest.json").write_text(json.dumps({
            "schema": 1, "engine": "terrydirector-latent-cache", "checkpoint_id": self.cid, "name": "批次01", "created_at": "2026-11-02"}), encoding="utf-8")
        for name in ("state.safetensors", "review.mp4", "sampling_preview.webp"):
            (self.folder / name).write_bytes(b"old result")
        (self.folder / "task.json").write_text("{}", encoding="utf-8")
        self.snapshot = {
            "name": "批次01", "prompt": "A shot", "seed": "123", "seed_min": 0, "seed_max": 999,
            "previewType": "decoded", "sampling_preview_enabled": False, "vae_decode_enabled": True,
            "workflow": {"nodes": []}, "api_prompt": {}, "assets": [{"value": "ref.png"}],
            "prompt_binding": {"node_id": 1}, "seed_binding": {"node_id": 2},
            "duration_seconds": 14, "highres_megapixels": 2.0,
            "batch_group_id": "episode", "batch_index": 1, "workflow_name": "H3",
        }

    def completed_draft(self, high=False):
        task_id = self.drafts.save_draft(self.snapshot)["id"]
        self.drafts.transition_draft(task_id, "claim_low")
        self.drafts.transition_draft(task_id, "start", prompt_id="low-job")
        self.drafts.transition_draft(task_id, "checkpoint", checkpoint_id=self.cid)
        self.drafts.transition_draft(task_id, "finish")
        if high:
            self.drafts.transition_draft(task_id, "claim_high")
            self.drafts.transition_draft(task_id, "start", prompt_id="high-job")
            self.drafts.transition_draft(task_id, "finish")
        return task_id

    def test_replaces_completed_result_and_preserves_task_configuration(self):
        task_id = self.completed_draft(high=True)
        before = self.drafts.get_draft(task_id)
        outside = self.root / "high-final.mp4"
        outside.write_bytes(b"final")
        result = self.tasks.prepare_low_rerun(task_id, "789", queue=self.queue)
        self.assertEqual(result, {"id": task_id, "status": "low_pending"})
        self.assertFalse(self.folder.exists())
        self.assertEqual(outside.read_bytes(), b"final")
        after = self.drafts.get_draft(task_id)
        self.assertEqual(after["seed"], "789")
        for key in (*self.snapshot.keys(), "created_at"):
            if key != "seed":
                self.assertEqual(before[key], after[key], key)
        for key in ("checkpoint_id", "prompt_id", "queued_stage", "low_started_at",
                    "low_finished_at", "high_started_at", "high_finished_at"):
            self.assertIsNone(after[key], key)
        self.drafts.transition_draft(task_id, "claim_low")
        self.drafts.transition_draft(task_id, "ack", prompt_id="new-job")
        self.drafts.transition_draft(task_id, "checkpoint", checkpoint_id="b" * 32)
        self.drafts.transition_draft(task_id, "finish")
        self.assertEqual(self.drafts.get_draft(task_id)["checkpoint_id"], "b" * 32)

    def test_replacement_removes_native_low_output_but_preserves_high(self):
        task_id=self.completed_draft()
        low=self.root/"native-low.mp4"
        high=self.root/"native-high.mp4"
        low.write_bytes(b"low");high.write_bytes(b"high")
        self.tasks.save_metadata(self.cid,{
            "lowres_video":{"filename":low.name,"subfolder":"","type":"output"},
            "lowres_prompt_id":"old-low-job",
            "highres_video":{"filename":high.name,"subfolder":"","type":"output"}})
        self.tasks.prepare_low_rerun(task_id,"789",queue=self.queue)
        self.assertFalse(low.exists())
        self.assertTrue(high.exists())

    def test_replacement_keeps_native_low_output_shared_by_another_checkpoint(self):
        task_id=self.completed_draft()
        low=self.root/"shared-low.mp4"
        low.write_bytes(b"shared")
        pointer={"filename":low.name,"subfolder":"","type":"output"}
        self.tasks.save_metadata(self.cid,{"lowres_video":pointer})
        other=self.folder.parent/("b"*32)
        other.mkdir()
        (other/"task.json").write_text(json.dumps({"lowres_video":pointer}),encoding="utf-8")
        self.tasks.prepare_low_rerun(task_id,"789",queue=self.queue)
        self.assertTrue(low.exists())

    def test_invalid_seed_or_staging_failure_keeps_old_result(self):
        task_id = self.completed_draft()
        before = self.drafts.get_draft(task_id)
        for seed in ("1000", "-1", "2.5", "01", "bad"):
            with self.assertRaises(ValueError):
                self.tasks.prepare_low_rerun(task_id, seed, queue=self.queue)
        with patch.object(Path, "write_text", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.tasks.prepare_low_rerun(task_id, "789", queue=self.queue)
        self.assertTrue((self.folder / "review.mp4").exists())
        self.assertEqual(self.drafts.get_draft(task_id), before)

    def test_running_queued_and_shared_checkpoints_are_rejected(self):
        task_id = self.completed_draft()
        self.drafts.transition_draft(task_id, "claim_high")
        with self.assertRaises(ValueError):
            self.tasks.prepare_low_rerun(task_id, "789", queue=self.queue)
        self.drafts.transition_draft(task_id, "fail")
        item = (0, "other-client", {"13": {"class_type": "TerryDirectorPauseResume",
                                          "inputs": {"checkpoint_id": self.cid}}})
        self.queue.get_current_queue_volatile = lambda: ([item], [])
        with self.assertRaises(ValueError):
            self.tasks.prepare_low_rerun(task_id, "789", queue=self.queue)
        self.queue.get_current_queue_volatile = lambda: ([], [])
        with self.assertRaises(ValueError):
            self.tasks.prepare_low_rerun(self.cid, "789", queue=self.queue, legacy_snapshot=self.snapshot)
        self.assertTrue(self.folder.exists())

    def test_legacy_checkpoint_becomes_durable_task_without_duplicate_result(self):
        result = self.tasks.prepare_low_rerun(self.cid, "789", queue=self.queue,
                                             legacy_snapshot=self.snapshot)
        self.assertTrue(result["id"].startswith("draft_"))
        self.assertFalse(self.folder.exists())
        after = self.drafts.get_draft(result["id"])
        self.assertEqual((after["seed"], after["name"], after["created_at"]),
                         ("789", "批次01", "2026-11-02"))

    def test_legacy_running_lifecycle_cannot_be_reset(self):
        for status in ("high_running", "low_running", "high_pending"):
            (self.folder / "task.json").write_text(json.dumps({
                "lifecycle_status": status}), encoding="utf-8")
            with self.assertRaises(ValueError):
                self.tasks.prepare_low_rerun(self.cid, "789", queue=self.queue,
                                             legacy_snapshot=self.snapshot)
            self.assertTrue(self.folder.exists())

    def test_unrelated_first_stage_does_not_block_next_batch_rerun(self):
        task_id = self.completed_draft()
        self.queue.get_current_queue_volatile = lambda: ([(0, "unrelated", {
            "13": {"class_type": "TerryDirectorPauseResume",
                   "inputs": {"mode": "暂停并保存", "checkpoint_id": ""}}})], [])
        self.tasks.prepare_low_rerun(task_id, "789", queue=self.queue)
        with self.assertRaises(ValueError):
            self.tasks.prepare_low_rerun(task_id, "790", queue=self.queue)


if __name__ == "__main__":
    unittest.main()
