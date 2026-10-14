"""Offline tests for H3 temporal window indexing (no ComfyUI or GPU)."""

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "_terrydirector_x2_windows_test", ROOT / "director_loop_x2_windows.py"
)
WINDOWS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = WINDOWS
SPEC.loader.exec_module(WINDOWS)


class TestH3X2DecodeWindows(unittest.TestCase):
    def test_legal_video_lengths(self):
        cases = {2: 5, 7: 22, 17: 56, 72: 243, 87: 294, 107: 362}
        for latent_t, frames in cases.items():
            with self.subTest(latent_t=latent_t):
                self.assertEqual(WINDOWS.h3_total_frames(latent_t), frames)

    def test_reject_invalid_grid(self):
        for latent_t in (-5, 0, 1, 3, 6, 8):
            with self.subTest(latent_t=latent_t):
                with self.assertRaises(ValueError):
                    WINDOWS.h3_total_frames(latent_t)

    def test_partition_covers_each_video_frame(self):
        for latent_t in (2, 7, 17, 72, 87, 107):
            for tile_frames in (17, 51, 85, 136):
                for context in (5, 22, 39, 73):
                    with self.subTest(latent_t=latent_t, tile=tile_frames, context=context):
                        windows = WINDOWS.h3_decode_windows(latent_t, tile_frames, context)
                        pos = 0
                        for part in windows:
                            self.assertEqual(part.destination_start, pos)
                            self.assertEqual(
                                WINDOWS.h3_total_frames(part.latent_stop-part.latent_start),
                                part.decoded_frames,
                            )
                            self.assertEqual(
                                part.decoded_frames-part.discard_frames,
                                part.keep_frames,
                            )
                            self.assertLessEqual(part.latent_stop, latent_t)
                            self.assertGreater(part.keep_frames, 0)
                            pos += part.keep_frames
                        self.assertEqual(pos, WINDOWS.h3_total_frames(latent_t))

    def test_long_clip_uses_small_windows(self):
        windows = WINDOWS.h3_decode_windows(72, 51, 39)
        self.assertGreater(len(windows), 1)
        self.assertLess(max(w.decoded_frames for w in windows), 243)
        self.assertEqual(windows[0].discard_frames, 0)
        self.assertEqual(sum(w.keep_frames for w in windows), 243)


if __name__ == "__main__":
    unittest.main()
