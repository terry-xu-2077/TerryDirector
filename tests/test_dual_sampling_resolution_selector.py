"""CPU-only tests for the dual sampling resolution math."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "terrydirector_resolution_math_test", ROOT / "director_resolution_math.py"
)
MATH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATH)


class DualSamplingResolutionTests(unittest.TestCase):
    def test_matches_h3_16_by_9_grid_previews(self):
        self.assertEqual(MATH.compute_resolution(0.2, "16:9 (Widescreen)"), (608, 352))
        self.assertEqual(MATH.compute_resolution(0.8, "16:9 (Widescreen)"), (1216, 672))
        self.assertEqual(MATH.compute_resolution(2.0, "16:9 (Widescreen)"), (1888, 1088))

    def test_rounds_both_dimensions_up_to_32(self):
        for megapixels in (0.05, 0.2, 0.8, 2.0, 4.0):
            width, height = MATH.compute_resolution(megapixels, "16:9 (Widescreen)")
            self.assertEqual(width % 32, 0)
            self.assertEqual(height % 32, 0)
            self.assertGreaterEqual(width * height, megapixels * 1_000_000)

    def test_portrait_ratio_is_supported(self):
        width, height = MATH.compute_resolution(0.2, "9:16 (Portrait)")
        self.assertEqual((width, height), (352, 608))
        self.assertLess(width, height)

    def test_actual_pixel_area_is_reported_after_rounding(self):
        width, height = MATH.compute_resolution(0.2, "16:9 (Widescreen)")
        self.assertAlmostEqual(MATH.actual_megapixels(width, height), 0.214016)

    def test_rejects_invalid_megapixels_and_ratio(self):
        for value in (0, -0.1, float("inf"), float("nan"), "not a number"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MATH.compute_resolution(value, "16:9")
        with self.assertRaises(ValueError):
            MATH.compute_resolution(0.2, "wide")


if __name__ == "__main__":
    unittest.main()
