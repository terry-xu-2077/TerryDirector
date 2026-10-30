"""Task-name-derived Preview Stage media filenames remain safe and addressable."""
from __future__ import annotations
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_preview_task_filename_testpkg"


class PreviewTaskFilenameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.names = (PACKAGE, PACKAGE + ".director_selflift_checkpoint",
                     PACKAGE + ".director_selflift_task_store", "folder_paths")
        cls.previous = {name: sys.modules.get(name) for name in cls.names}
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(ROOT)]
        sys.modules[PACKAGE] = package
        checkpoint = types.ModuleType(PACKAGE + ".director_selflift_checkpoint")
        checkpoint.list_checkpoints = lambda: []
        checkpoint.read_manifest = lambda _id: {"checkpoint_id": _id}
        sys.modules[PACKAGE + ".director_selflift_checkpoint"] = checkpoint
        sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: "")
        cls.store = importlib.import_module(PACKAGE + ".director_selflift_task_store")

    @classmethod
    def tearDownClass(cls):
        for name, module in cls.previous.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        sys.modules["folder_paths"].get_output_directory = lambda: str(self.root)
        self.checkpoint_id = "a" * 32
        self.folder = self.root / "TerryDirector" / "checkpoints" / self.checkpoint_id
        self.folder.mkdir(parents=True)
        (self.folder / "state.safetensors").write_bytes(b"state")
        (self.folder / "manifest.json").write_text("{}", encoding="utf-8")

    def test_filename_sanitizer_preserves_chinese_and_filters_windows_chars(self):
        safe = self.store.safe_task_filename("批次01｜场景/镜头: A?.")
        self.assertEqual(safe, "批次01_场景_镜头_A")
        self.assertEqual(self.store.safe_task_filename("CON"), "_CON")
        self.assertEqual(self.store.safe_task_filename("/batch/"), "batch")
        self.assertEqual(self.store.safe_task_filename("  "), "TerryDirector")

    def test_metadata_keeps_named_media_pointers_across_task_updates(self):
        self.store.save_metadata(self.checkpoint_id, {
            "sampling_video_filename": "批次01_低清预览.mp4",
            "review_video_filename": "批次01_低清解码.mp4",
        })
        self.store.save_metadata(self.checkpoint_id, {"workflow_name": "测试工作流"})
        value = json.loads((self.folder / "task.json").read_text(encoding="utf-8"))
        self.assertEqual(value["sampling_video_filename"], "批次01_低清预览.mp4")
        self.assertEqual(value["review_video_filename"], "批次01_低清解码.mp4")

    def test_named_sampling_and_decoded_media_are_resolved(self):
        sampling = "批次01_低清预览.mp4"
        decoded = "批次01_低清解码.mp4"
        (self.folder / sampling).write_bytes(b"video")
        (self.folder / decoded).write_bytes(b"video")
        (self.folder / "task.json").write_text(json.dumps({
            "sampling_video_filename": sampling,
            "review_video_filename": decoded,
        }), encoding="utf-8")
        self.assertEqual(self.store.media_path(self.checkpoint_id, "sampling"), self.folder / sampling)
        self.assertEqual(self.store.media_path(self.checkpoint_id, "decoded"), self.folder / decoded)

    def test_legacy_fixed_media_names_work_without_task_metadata(self):
        sampling = self.folder / "sampling_preview.mp4"
        decoded = self.folder / "review.mp4"
        sampling.write_bytes(b"video")
        decoded.write_bytes(b"video")
        self.assertEqual(self.store.media_path(self.checkpoint_id, "sampling"), sampling)
        self.assertEqual(self.store.media_path(self.checkpoint_id, "decoded"), decoded)


if __name__ == "__main__":
    unittest.main()
