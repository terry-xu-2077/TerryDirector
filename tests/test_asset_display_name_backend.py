"""Run: python -m unittest discover -s tests -p test_asset_display_name_backend.py"""
import importlib.util
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "director_core.py"
spec = importlib.util.spec_from_file_location("td_asset_core", path)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


class AssetDisplayNameTest(unittest.TestCase):
    def test_alias_survives_normalize_without_mutating_source_filename_or_tokens(self):
        doc = core.default_document()
        doc["assets"] = [{
            "id": "asset-1", "name": "snow.png", "displayName": "雪地战壕",
            "kind": "image", "number": 3,
            "source": {"type": "comfy-input", "path": "ref/snow.png"}
        }]
        doc["clips"][0]["prompt"] = "Shot: <Picture 3>"
        doc["clips"][0]["refs"] = ["asset-1"]
        result = core.normalize_document(doc)
        asset = result["assets"][0]
        self.assertEqual(asset["displayName"], "雪地战壕")
        self.assertEqual(asset["name"], "snow.png")
        self.assertEqual(asset["source"]["path"], "ref/snow.png")
        self.assertEqual(asset["number"], 3)
        self.assertEqual(result["clips"][0]["prompt"], "Shot: <Picture 3>")
        self.assertEqual(result["clips"][0]["refs"], ["asset-1"])

    def test_unaliased_asset_remains_unchanged(self):
        doc = core.default_document()
        doc["assets"] = [{
            "id": "asset-1", "name": "snow.png", "kind": "image",
            "number": 3, "source": {"path": "snow.png"}
        }]
        asset = core.normalize_document(doc)["assets"][0]
        self.assertNotIn("displayName", asset)

    def test_alias_whitespace_and_length_are_normalized(self):
        doc = core.default_document()
        doc["assets"] = [{
            "id": "a", "name": "clip.mp4", "displayName": "  视频\n场景  " + "a" * 100,
            "kind": "video", "number": 1, "source": {"path": "clip.mp4"}
        }]
        value = core.normalize_document(doc)["assets"][0]["displayName"]
        self.assertTrue(value.startswith("视频 场景"))
        self.assertEqual(len(value), 80)


if __name__ == "__main__":
    unittest.main()
