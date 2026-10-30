"""Regression tests for KJNodes fragmented MP4 sampling-preview finalization.

Run: python -m unittest discover -s tests -p test_preview_mp4_normalization.py
Requires ffmpeg for the integration tests. No GPU or ComfyUI session needed.
"""
from __future__ import annotations
import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "director_preview_mp4.py"
SPEC = importlib.util.spec_from_file_location("td_preview_mp4_test", SOURCE)
mp4 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mp4)


def _generate_fragment(path: Path, duration: int = 2):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise unittest.SkipTest("FFmpeg not installed")
    command = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=" + str(duration),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "8",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", str(path),
    ]
    result = subprocess.run(command, capture_output=True, timeout=30)
    if result.returncode:
        raise unittest.SkipTest("FFmpeg cannot encode synthetic H.264: " +
                                result.stderr.decode("utf-8", errors="replace"))


class PreviewMP4NormalizationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)

    def test_fmp4_finalized_and_verified(self):
        src = self.folder / "kj_preview.mp4"
        _generate_fragment(src)
        data = src.read_bytes()
        self.assertTrue(mp4.is_fragmented_mp4(data))
        saved = mp4.finalize_preview_mp4(data, self.folder)
        self.assertEqual(saved.name, "sampling_preview.mp4")
        self.assertTrue(saved.is_file())
        self.assertFalse(mp4.is_fragmented_mp4(saved.read_bytes()))
        self.assertIn(b"moov", set(mp4._atoms(saved.read_bytes())))
        self.assertIn(b"mdat", set(mp4._atoms(saved.read_bytes())))
        mp4._verify_video(saved, mp4._ffmpeg())

    def test_sampling_frames_retimed_to_fifteen_seconds(self):
        source = self.folder / "short_kj.mp4"
        _generate_fragment(source, duration=8)
        original_duration = mp4._video_duration(source, mp4._ffmpeg())
        self.assertAlmostEqual(original_duration, 8.0, delta=0.3)
        result = mp4.finalize_preview_mp4(
            source.read_bytes(), self.folder, target_seconds=15
        )
        duration = mp4._video_duration(result, mp4._ffmpeg())
        self.assertAlmostEqual(duration, 15.0, delta=0.7)
        self.assertFalse(mp4.is_fragmented_mp4(result.read_bytes()))
        mp4._verify_video(result, mp4._ffmpeg())

    def test_invalid_target_duration_preserves_original_file(self):
        path = self.folder / "sampling_preview.mp4"
        _generate_fragment(path)
        original = path.read_bytes()
        with self.assertRaises(ValueError):
            mp4.finalize_preview_mp4(original, self.folder, target_seconds=30)
        self.assertEqual(path.read_bytes(), original)

    def test_missing_duration_probe_keeps_playable_original_duration(self):
        with patch.object(mp4, "_video_duration", return_value=None):
            self.assertEqual(mp4._time_scale(self.folder / "x.mp4", 15, "ffmpeg"), 1.0)

    def test_timestamp_remux_failure_retries_without_timing_change(self):
        attempts = []
        def remux(source, output, executable, scale=1.0):
            attempts.append(("remux", scale))
            if scale != 1.0:
                raise ValueError("invalid timestamps")
        def transcode(source, output, executable, scale=1.0):
            attempts.append(("transcode", scale))
            if scale != 1.0:
                raise ValueError("invalid timestamps")
        with patch.object(mp4, "_ffmpeg", return_value="ffmpeg"), \
             patch.object(mp4, "_time_scale", return_value=1.875), \
             patch.object(mp4, "_remux", side_effect=remux), \
             patch.object(mp4, "_transcode", side_effect=transcode):
            mp4._normalize(self.folder / "input.mp4", self.folder / "out.mp4", 15)
        self.assertEqual(attempts, [
            ("remux", 1.875), ("transcode", 1.875), ("remux", 1.0),
        ])

    def test_strict_failure_attempts_tolerant_salvage(self):
        output = self.folder / "recovered.mp4"
        with patch.object(mp4, "_ffmpeg", return_value="ffmpeg"), \
             patch.object(mp4, "_time_scale", return_value=1.0), \
             patch.object(mp4, "_remux", side_effect=ValueError("broken NAL")), \
             patch.object(mp4, "_transcode", side_effect=ValueError("broken NAL")), \
             patch.object(mp4, "_recover_video") as recovered:
            mp4._normalize(self.folder / "broken.mp4", output)
        recovered.assert_called_once_with(self.folder / "broken.mp4", output, "ffmpeg")

    def test_salvage_requires_a_strictly_decodable_output(self):
        target = self.folder / "recovered.mp4"
        with patch.object(mp4.subprocess, "run", return_value=subprocess.CompletedProcess(
            args=[], returncode=1, stdout=b"", stderr=b"partial file"
        )), patch.object(mp4, "_verify_video", side_effect=ValueError("no frames")):
            with self.assertRaisesRegex(ValueError, "partial file"):
                mp4._recover_video(self.folder / "broken.mp4", target, "ffmpeg")

    def test_repair_old_fragmented_file_without_rerun(self):
        target = self.folder / "sampling_preview.mp4"
        _generate_fragment(target)
        self.assertTrue(mp4.repair_legacy_preview_mp4(target))
        self.assertFalse(mp4.is_fragmented_mp4(target.read_bytes()))
        self.assertFalse(mp4.repair_legacy_preview_mp4(target))
        mp4._verify_video(target, mp4._ffmpeg())

    def test_invalid_mp4_does_not_replace_existing_preview(self):
        original = self.folder / "sampling_preview.mp4"
        original.write_bytes(b"existing playable mp4 placeholder")
        with self.assertRaises(ValueError):
            mp4.finalize_preview_mp4(
                b"\x00\x00\x00\x18ftypisom00000000moof0000",
                self.folder,
            )
        self.assertEqual(original.read_bytes(), b"existing playable mp4 placeholder")
        self.assertFalse(any(self.folder.glob(".taeh3_mp4_*")))

    def test_unrepairable_legacy_data_preserved(self):
        broken = self.folder / "sampling_preview.mp4"
        broken.write_bytes(
            b"\x00\x00\x00\x10ftypisom0000" +
            b"\x00\x00\x00\x08moof",
        )
        original = broken.read_bytes()
        self.assertTrue(mp4.is_fragmented_mp4(original))
        with self.assertRaises(ValueError):
            mp4.repair_legacy_preview_mp4(broken)
        self.assertEqual(broken.read_bytes(), original)

    def test_nonfragmented_video_untouched(self):
        path = self.folder / "sampling_preview.mp4"
        path.write_bytes(b"not a fragmented MP4")
        self.assertFalse(mp4.repair_legacy_preview_mp4(path))
        self.assertEqual(path.read_bytes(), b"not a fragmented MP4")


if __name__ == "__main__":
    unittest.main()
