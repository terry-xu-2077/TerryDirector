"""CPU media regression: ProRes originals, frame-accurate overlap, PCM timing.

Run with Python/PyTorch and FFmpeg installed:
    python -m unittest discover -s tests -p test_loop_media.py -v
No ComfyUI, video model or GPU required.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

try:
    import torch
    import numpy as np
except ImportError:
    torch = None
    np = None


class TestLoopMedia(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if torch is None or np is None:
            raise unittest.SkipTest("CPU media tests need PyTorch and numpy")
        if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
            raise unittest.SkipTest("CPU media tests need FFmpeg and ffprobe")
        ffmpeg = shutil.which("ffmpeg")
        check = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"], capture_output=True,
        )
        if b"prores_ks" not in check.stdout:
            raise unittest.SkipTest("FFmpeg build does not provide prores_ks")

        cls._tempdir = tempfile.TemporaryDirectory(prefix="td_loop_media_test_")
        cls.base = Path(cls._tempdir.name)
        paths = types.ModuleType("folder_paths")
        paths.get_output_directory = lambda: str(cls.base)
        cls._original_folder_paths = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = paths
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location(
            "_terry_loop_media_cpu_test", root / "director_loop_media.py"
        )
        cls.media = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.media)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "_original_folder_paths"):
            if cls._original_folder_paths is None:
                sys.modules.pop("folder_paths", None)
            else:
                sys.modules["folder_paths"] = cls._original_folder_paths
        if hasattr(cls, "_tempdir"):
            cls._tempdir.cleanup()

    def _segment(self, index, frames, trim_head, gap=0, fmt=None):
        fmt = fmt or self.media.MOV_HQ
        h, w = 64, 96
        images = torch.linspace(0, 1, h * w * 3).reshape(1, h, w, 3)
        images = images.repeat(frames, 1, 1, 1)
        wave_count = round(frames * 32000 / 24)
        waveform = torch.zeros(1, 2, wave_count)
        waveform[0, 0] = 0.02
        waveform[0, 1] = -0.03
        segment = {
            "id": f"clip-{index}", "name": f"镜头{index}",
            "output_frames": frames,
            "assembly": {
                "trim_head_frames": trim_head, "trim_tail_frames": 0,
                "gap_before_frames": gap, "gap_after_frames": 0,
            },
            "_loop": {
                "index": index, "context_frames": 12,
                "cache_key": "loop-test", "run_signature": "fixedtest",
                "loop_id": "test",
            },
        }
        item, carry_images, carry_audio = self.media.save_loop_segment(
            images=images,
            audio={"waveform": waveform, "sample_rate": 32000},
            segment=segment, format_name=fmt,
        )
        data = json.loads(item)
        self.assertTrue(Path(data["path"]).is_file())
        self.assertEqual(carry_images.shape[0], 12)
        self.assertEqual(carry_audio["sample_rate"], 32000)
        self.assertEqual(data["frames"], frames)
        return data

    def _count_frames(self, path):
        p = subprocess.run(
            [shutil.which("ffprobe"), "-v", "error", "-count_frames",
             "-select_streams", "v:0", "-show_entries",
             "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        )
        return int(p.stdout.strip())

    def _pcm_sample_count(self, path, channels=2):
        p = subprocess.run(
            [shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
             "-i", str(path), "-map", "0:a:0", "-ar", "48000",
             "-ac", str(channels), "-c:a", "pcm_s24le", "-f", "s24le", "-"],
            capture_output=True, check=True,
        )
        return len(p.stdout) // (3 * channels)

    def test_mov_originals_and_final_trim_audio(self):
        first = self._segment(0, 24, 0)
        second = self._segment(1, 36, 12, gap=5)
        self.assertEqual(self._count_frames(second["path"]), 36)
        final = self.media.merge_loop_clips([first, second], merge_final=True)
        self.assertTrue(final.endswith("Final.mov"))
        self.assertTrue(Path(first["path"]).is_file())
        self.assertTrue(Path(second["path"]).is_file())
        self.assertEqual(self._count_frames(final), 24 + 5 + 36 - 12)
        self.assertEqual(self._pcm_sample_count(final), 53 * 2000)
        manifest = json.loads((Path(final).parent / "timeline.json").read_text("utf-8"))
        self.assertEqual(manifest["status"], "completed")
        self.assertEqual(manifest["final_frames"], 53)
        self.assertFalse(list(Path(final).parent.glob("**/*.pt")))

    def test_mp4_can_skip_merge(self):
        # A different run must not inherit a previous run's cached data.
        fmt = self.media.MP4_H264
        part = self._segment(2, 24, 0, fmt=fmt)
        self.assertIsNone(self.media.merge_loop_clips([part], merge_final=False))
        self.assertTrue(Path(part["path"]).is_file())
        self.assertEqual(self._count_frames(part["path"]), 24)


if __name__ == "__main__":
    unittest.main()
