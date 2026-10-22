"""CPU-only tests for visible numbered loop output allocation."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


class TestLoopStorage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="td_visible_storage_")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)

        def get_save_image_path(prefix, output_dir, _width=0, _height=0):
            normalized = os.path.normpath(str(prefix))
            subfolder = os.path.dirname(normalized)
            filename = os.path.basename(normalized)
            folder = Path(output_dir) / subfolder
            folder.mkdir(parents=True, exist_ok=True)
            counters = []
            for item in folder.iterdir():
                if not item.name.startswith(filename + "_"):
                    continue
                tail = item.name[len(filename) + 1:].split(".")[0].split("_")[0]
                if tail.isdigit():
                    counters.append(int(tail))
            return str(folder), filename, max(counters, default=0) + 1, subfolder, normalized

        paths = types.SimpleNamespace(
            get_output_directory=lambda: str(self.output),
            get_save_image_path=get_save_image_path,
        )
        self.patcher = patch.dict(sys.modules, {"folder_paths": paths})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        spec = importlib.util.spec_from_file_location(
            "_td_loop_storage_test", ROOT / "director_loop_storage.py",
        )
        self.storage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.storage)

    def test_resolves_connected_savevideo_and_allocates_flat_numbered_groups(self):
        prompt = {
            "10": {"class_type": "TerryDirectorLoopEnd", "inputs": {}},
            "11": {"class_type": "SaveVideo", "inputs": {
                "video": ["10", 0],
                "filename_prefix": "video/四驱车_VAE放大/timeline",
                "format": "auto",
            }},
        }
        profile = self.storage.resolve_output_profile(prompt, "10")
        self.assertEqual(profile["subfolder"], "video/四驱车_VAE放大")
        self.assertEqual(profile["filename"], "timeline")
        first = self.storage.allocate_run(
            profile, fingerprint="secret-hash", segment_format="MOV", loop_id="298",
        )
        second = self.storage.allocate_run(
            profile, fingerprint="other-hash", segment_format="MOV", loop_id="298",
        )
        self.assertEqual(Path(first["manifest"]).name, "timeline_segments_00001.json")
        self.assertEqual(Path(second["manifest"]).name, "timeline_segments_00002.json")
        self.assertEqual(Path(first["manifest"]).parent, self.output / "video" / "四驱车_VAE放大")
        self.assertNotIn("secret-hash", first["manifest"])
        self.assertNotIn(first["run_signature"], first["manifest"])
        self.assertIn("secret-hash", Path(first["manifest"]).read_text("utf-8"))

    def test_changed_prefix_resolves_to_a_different_task_location(self):
        first = self.storage.output_profile_from_prefix("video/A/timeline")
        second = self.storage.output_profile_from_prefix("video/B/timeline")
        self.assertNotEqual(first["subfolder"], second["subfolder"])
        self.assertNotEqual(
            self.storage.profile_directory(first),
            self.storage.profile_directory(second),
        )


if __name__ == "__main__":
    unittest.main()
