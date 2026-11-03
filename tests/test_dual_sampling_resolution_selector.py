"""CPU-only tests for the dual sampling resolution math."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "terrydirector_resolution_math_test", ROOT / "nodes" / "director_resolution_math.py"
)
MATH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATH)


class DualSamplingResolutionTests(unittest.TestCase):
    def test_matches_h3_16_by_9_grid_previews(self):
        self.assertEqual(MATH.compute_resolution(0.2, "16:9 (Widescreen)"), (608, 352))
        self.assertEqual(MATH.compute_resolution(0.8, "16:9 (Widescreen)"), (1216, 672))
        self.assertEqual(MATH.compute_resolution(2.0, "16:9 (Widescreen)"), (1888, 1088))

    def test_single_highres_mp_derives_lowres_by_quarter_area(self):
        for high_mp, expected_low, expected_high in (
            (0.8, (608, 352), (1216, 672)),
            (2.0, (960, 544), (1888, 1088)),
        ):
            with self.subTest(highres_megapixels=high_mp):
                self.assertEqual(
                    MATH.compute_sampling_resolutions(high_mp, "16:9 (Widescreen)"),
                    (expected_low, expected_high),
                )

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

    def test_selflift_examples_share_resolution_length_and_seed(self):
        import json
        for path in sorted((ROOT / "examples").glob("TerryDirector_SelfLift_*.json")):
            with self.subTest(workflow=path.name):
                graph = json.loads(path.read_text(encoding="utf-8"))
                nodes = {n["id"]: n for n in graph["nodes"]}
                links = {l[0]: l for l in graph["links"]}
                def origin(node, name):
                    inp = next(i for i in node["inputs"] if i["name"] == name)
                    return links[inp["link"]][1:3]
                selector = nodes[36]
                self.assertEqual(selector["type"], "TerryDirectorDualSamplingResolutionSelector")
                self.assertEqual(selector["widgets_values"], ["16:9 (Widescreen)", .8])
                self.assertEqual(origin(nodes[6],"width"), [36,0])
                self.assertEqual(origin(nodes[6],"height"), [36,1])
                self.assertEqual(origin(nodes[6],"length"), [30,0])
                self.assertEqual(nodes[30]["widgets_values"], [124,"fixed"])
                self.assertEqual(nodes[33]["widgets_values"], [8,"fixed"])
                self.assertFalse(any(i["name"] == "seed" for i in nodes[13]["inputs"]))
                if 11 in nodes:
                    self.assertEqual(origin(nodes[11],"latent_image"),[6,1])
                    self.assertEqual(origin(nodes[11],"seed"),[33,0])
                if 18 in nodes:
                    self.assertEqual(origin(nodes[18],"width"),[36,2])
                    self.assertEqual(origin(nodes[18],"height"),[36,3])
                    self.assertEqual(origin(nodes[18],"seed"),[33,0])
                    self.assertNotIn("length",[i["name"] for i in nodes[18]["inputs"]])

    def test_rejects_invalid_megapixels_and_ratio(self):
        for value in (0, -0.1, float("inf"), float("nan"), "not a number"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MATH.compute_resolution(value, "16:9")
        with self.assertRaises(ValueError):
            MATH.compute_resolution(0.2, "wide")

        for bad in (0, -1.0, float("nan"), float("inf"), "bad"):
            with self.subTest(single_input=bad), self.assertRaises(ValueError):
                MATH.compute_sampling_resolutions(bad, "16:9")


if __name__ == "__main__":
    unittest.main()
