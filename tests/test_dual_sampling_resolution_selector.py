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

    def test_selflift_examples_share_resolution_length_and_seed(self):
        import json

        files = (
            "TerryDirector_SelfLift_01_Lowres_Checkpoint.json",
            "TerryDirector_SelfLift_03_Pause_Continue.json",
            "TerryDirector_SelfLift_04_Reference_2MP_Highres.json",
        )
        for filename in files:
            with self.subTest(workflow=filename):
                workflow = json.loads(
                    (ROOT / "examples" / filename).read_text(encoding="utf-8")
                )
                nodes = {node["id"]: node for node in workflow["nodes"]}
                links = {link[0]: link for link in workflow["links"]}

                def node_type(name):
                    return next(node for node in nodes.values() if node["type"] == name)

                def origin(target, input_name):
                    socket = next(item for item in target["inputs"]
                                  if item["name"] == input_name)
                    return links[socket["link"]][1:3]

                selector = node_type("TerryDirectorDualSamplingResolutionSelector")
                low = node_type("MiniMaxH3ReferenceToVideo")
                high = node_type("EmptyMiniMaxH3LatentAV")
                sampler = node_type("SamplerCustom")
                checkpoint = next(node for node in nodes.values() if node["type"] in {
                    "TerryDirectorSelfLiftPauseResume",
                    "TerryDirectorSaveLowresCheckpoint",
                })
                seed_node = node_type("SeedNode")

                self.assertEqual(origin(low, "width"), [selector["id"], 0])
                self.assertEqual(origin(low, "height"), [selector["id"], 1])
                self.assertEqual(origin(high, "width"), [selector["id"], 2])
                self.assertEqual(origin(high, "height"), [selector["id"], 3])
                self.assertEqual(origin(low, "length"), origin(high, "length"))
                duration_origin = origin(low, "length")
                self.assertEqual(nodes[duration_origin[0]]["type"], "ComfyMathExpression")
                self.assertEqual(duration_origin[1], 1)
                self.assertEqual(origin(sampler, "noise_seed"), [seed_node["id"], 0])
                self.assertEqual(origin(checkpoint, "seed"), [seed_node["id"], 0])
                self.assertEqual(len([node for node in nodes.values()
                                      if node["type"] == "TerryDirectorDualSamplingResolutionSelector"]), 1)

    def test_rejects_invalid_megapixels_and_ratio(self):
        for value in (0, -0.1, float("inf"), float("nan"), "not a number"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MATH.compute_resolution(value, "16:9")
        with self.assertRaises(ValueError):
            MATH.compute_resolution(0.2, "wide")


if __name__ == "__main__":
    unittest.main()
