"""Offline invariants for independent ProRes clips and final edit assembly.

No ComfyUI, PyTorch or FFmpeg binaries are required for these tests.
"""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "director_loop_mov.py"


def load_mov_module():
    stubs = {
        "folder_paths": types.SimpleNamespace(get_output_directory=lambda: "/tmp"),
        "numpy": types.ModuleType("numpy"),
        "torch": types.ModuleType("torch"),
    }
    with mock.patch.dict(sys.modules, stubs):
        spec = importlib.util.spec_from_file_location("_td_loop_mov_test", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


MOV = load_mov_module()


class TestLoopProResManifest(unittest.TestCase):
    def test_frame_trim_sample_precision_and_no_reencode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = root / "001_A.mov", root / "002_B.mov"
            a.write_bytes(b"original A")
            b.write_bytes(b"original B")
            descriptors = [
                dict(index=0, segment_id="a", path=str(a),
                     frames=240, trim_head_frames=0, gap_before_frames=0,
                     width=1920, height=1088, channels=2),
                dict(index=1, segment_id="b", path=str(b),
                     frames=168, trim_head_frames=48, gap_before_frames=0,
                     width=1920, height=1088, channels=2),
            ]
            calls = []
            inputs = {}

            def emulate_ffmpeg(args, **kwargs):
                output = Path(args[-1])
                if "-f" not in args:
                    raise AssertionError("Unrecognized ffmpeg invocation")
                if "-safe" in args:
                    ffconcat = Path(args[args.index("-i") + 1])
                    inputs["concat"] = ffconcat.read_text(encoding="utf-8")
                    self.assertIn("copy", args)
                    self.assertIn("inpoint 2.000000000", inputs["concat"])
                    self.assertIn("outpoint 7.000000000", inputs["concat"])
                if "-filter_complex_script" in args:
                    script = Path(args[args.index("-filter_complex_script") + 1])
                    inputs["audio"] = script.read_text(encoding="utf-8")
                    self.assertIn("atrim=start_sample=96000:end_sample=336000", inputs["audio"])
                calls.append(args)
                output.write_bytes(b"mock-data")

            with mock.patch.object(MOV, "_ffmpeg_run", side_effect=emulate_ffmpeg), \
                    mock.patch.object(MOV, "_inspect_mov", return_value={
                        "frames": 360, "width": 1920, "height": 1088, "channels": 2,
                    }):
                final = MOV.merge_loop_mov_clips(descriptors)

            self.assertTrue(final.endswith("Final.mov"))
            self.assertEqual(Path(final).read_bytes(), b"mock-data")
            self.assertEqual(a.read_bytes(), b"original A")
            self.assertEqual(b.read_bytes(), b"original B")
            self.assertEqual(len(calls), 3)
            self.assertEqual(json.loads((root / "manifest.json").read_text())["final_frames"], 360)
            self.assertIn("concat=n=2:v=0:a=1", inputs["audio"])

    def test_reject_missing_clips_without_destroying_existing_ones(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            available = root / "001.mov"
            available.write_bytes(b"keep")
            data = [
                {"index": 0, "path": str(available), "frames": 24,
                 "trim_head_frames": 0, "gap_before_frames": 0, "height": 1088,
                 "width": 1920, "channels": 2},
                {"index": 1, "path": str(root / "missing.mov"), "frames": 24,
                 "trim_head_frames": 0, "gap_before_frames": 0, "height": 1088,
                 "width": 1920, "channels": 2},
            ]
            with self.assertRaises(FileNotFoundError):
                MOV.merge_loop_mov_clips(data)
            self.assertEqual(available.read_bytes(), b"keep")

    def test_safe_file_names(self):
        self.assertEqual(MOV._safe_name("a/b:c*?\"<>|"), "a_b_c_____")
        self.assertEqual(MOV._safe_name("..."), "clip")

    def test_overlap_and_gaps_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = root / "A.mov", root / "B.mov"
            a.write_bytes(b"a")
            b.write_bytes(b"b")
            clips = [
                {"index": 0, "path": str(a), "frames": 240,
                 "trim_head_frames": 0, "gap_before_frames": 0,
                 "width": 1920, "height": 1088, "channels": 2},
                {"index": 1, "path": str(b), "frames": 168,
                 "trim_head_frames": 48, "gap_before_frames": 12,
                 "width": 1920, "height": 1088, "channels": 2},
            ]
            with mock.patch.object(MOV, "_make_gap", return_value=root / "gap.mov"):
                entries = MOV._timeline_entries(root, clips)
            self.assertEqual(
                [(entry["frames"], entry["trim"]) for entry in entries],
                [(240, 0), (12, 0), (168, 48)],
            )


if __name__ == "__main__":
    unittest.main()
