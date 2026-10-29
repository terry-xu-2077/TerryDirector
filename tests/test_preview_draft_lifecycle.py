"""CPU-only tests: creating Preview Stage tasks never queues ComfyUI."""
import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_draft_lifecycle_testpkg"


class PreviewDraftLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = {name: sys.modules.get(name) for name in
                      [PACKAGE, PACKAGE + ".director_preview_draft_store", "folder_paths"]}
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(ROOT)]
        sys.modules[PACKAGE] = package
        sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: "")
        cls.store = importlib.import_module(PACKAGE + ".director_preview_draft_store")

    @classmethod
    def tearDownClass(cls):
        for name, original in cls.before.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.output = Path(temp.name)
        sys.modules["folder_paths"].get_output_directory = lambda: str(self.output)

    def sample(self):
        return {
            "name": "E01_S01", "prompt": "A shot of the horizon",
            "seed": "456", "seed_min": 0, "seed_max": 1125899906842624,
            "previewType": "sampling", "assets": [{"node_id": 12, "widget_name": "image", "value": "ref.png"}],
            "workflow": {"nodes": [{"id": 13, "type": "TerryDirectorSelfLiftPauseResume"}]},
            "api_prompt": {"13": {"class_type": "TerryDirectorSelfLiftPauseResume",
                                   "inputs": {"mode": "暂停并保存", "name": "E01_S01"}}},
            "pause_node_id": 13, "preview_node_id": 5, "pause_target": "13",
            "prompt_binding": {"node_id": 63, "widget_name": "prompt"},
            "seed_binding": {"node_id": 77, "widget_name": "seed"},
            "highres_target": "42", "workflow_name": "Main",
        }

    def test_creation_only_saves_pending_task_and_time(self):
        store = self.store
        created = store.save_draft(self.sample())
        self.assertEqual(created["status"], "low_pending")
        item = store.get_draft(created["id"])
        self.assertEqual(item["status"], "low_pending")
        self.assertIsNone(item["low_started_at"])
        self.assertIsNone(item["low_finished_at"])
        self.assertIsNone(item["high_started_at"])
        self.assertIsNone(item["high_finished_at"])
        self.assertEqual(len(store.list_drafts()), 1)
        self.assertEqual(item["created_at"], store.list_drafts()[0]["created_at"])
        self.assertTrue((self.output / "TerryDirector" / "preview_stage" /
                         "drafts" / (created["id"] + ".json")).is_file())

    def test_six_states_and_two_generation_time_ranges(self):
        store = self.store
        task_id = store.save_draft(self.sample())["id"]
        checkpoint = "a" * 32
        store.transition_draft(task_id, "claim_low")
        self.assertEqual(store.get_draft(task_id)["status"], "low_pending")
        with self.assertRaises(ValueError):
            store.transition_draft(task_id, "claim_low")
        store.transition_draft(task_id, "ack", prompt_id="low-prompt")
        store.transition_draft(task_id, "start", prompt_id="low-prompt")
        self.assertEqual(store.get_draft(task_id)["status"], "low_running")
        with self.assertRaises(ValueError):
            store.transition_draft(task_id, "finish")
        store.transition_draft(task_id, "checkpoint", checkpoint_id=checkpoint)
        store.transition_draft(task_id, "finish")
        low = store.get_draft(task_id)
        self.assertEqual(low["status"], "low_complete")
        self.assertTrue(low["low_started_at"])
        self.assertTrue(low["low_finished_at"])
        self.assertIsNone(low["high_started_at"])
        self.assertIsNone(low["high_finished_at"])
        self.assertEqual(low["checkpoint_id"], checkpoint)
        store.transition_draft(task_id, "claim_high")
        self.assertEqual(store.get_draft(task_id)["status"], "high_pending")
        store.transition_draft(task_id, "ack", prompt_id="high-prompt")
        store.transition_draft(task_id, "start", prompt_id="high-prompt")
        self.assertEqual(store.get_draft(task_id)["status"], "high_running")
        store.transition_draft(task_id, "finish")
        high = store.get_draft(task_id)
        self.assertEqual(high["status"], "high_complete")
        self.assertTrue(high["high_started_at"])
        self.assertTrue(high["high_finished_at"])
        self.assertEqual(high["low_finished_at"], low["low_finished_at"])
        self.assertEqual(len(store.list_drafts()), 1)

    def test_failures_do_not_mark_completed_and_can_retry(self):
        store = self.store
        task_id = store.save_draft(self.sample())["id"]
        store.transition_draft(task_id, "claim_low")
        store.transition_draft(task_id, "start", prompt_id="x")
        store.transition_draft(task_id, "fail", error="GPU out of memory")
        draft = store.get_draft(task_id)
        self.assertEqual(draft["status"], "low_pending")
        self.assertIn("GPU", draft["error"])
        store.transition_draft(task_id, "claim_low")
        self.assertNotIn("error", store.get_draft(task_id))
        store.transition_draft(task_id, "ack", prompt_id="new-job")
        store.transition_draft(task_id, "checkpoint", checkpoint_id="c" * 32)
        store.transition_draft(task_id, "finish")
        store.transition_draft(task_id, "claim_high")
        store.transition_draft(task_id, "fail", error="highres failed")
        self.assertEqual(store.get_draft(task_id)["status"], "low_complete")

    def test_edit_only_unqueued_pending_and_delete_guard(self):
        store = self.store
        created = store.save_draft(self.sample())
        edited = self.sample()
        edited["prompt"] = "Revised"
        store.save_draft(edited, created["id"])
        self.assertEqual(store.get_draft(created["id"])["prompt"], "Revised")
        store.transition_draft(created["id"], "claim_low")
        with self.assertRaises(ValueError):
            store.save_draft(edited, created["id"])
        with self.assertRaises(ValueError):
            store.delete_drafts([created["id"]])
        store.transition_draft(created["id"], "fail")
        store.delete_drafts([created["id"]])
        self.assertEqual(store.list_drafts(), [])

    def test_fast_ack_after_completion_is_idempotent(self):
        store = self.store
        task_id = store.save_draft(self.sample())["id"]
        store.transition_draft(task_id, "claim_low")
        store.transition_draft(task_id, "start", prompt_id="quick")
        store.transition_draft(task_id, "checkpoint", checkpoint_id="b" * 32)
        store.transition_draft(task_id, "finish")
        accepted = store.transition_draft(task_id, "ack", prompt_id="quick")
        self.assertEqual(accepted["status"], "low_complete")


if __name__ == "__main__":
    unittest.main()
