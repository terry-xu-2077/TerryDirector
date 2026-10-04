import json
import unittest

from director_core import FPS, calculate_resolution, default_config, normalize_config, summary


class DirectorCoreTests(unittest.TestCase):
    def test_resolution_matches_selector_math(self):
        width, height = calculate_resolution("16:9", 1.2, 32)
        self.assertEqual((width, height), (1504, 832))

    def test_normalizes_document_and_drops_invalid_asset_refs(self):
        payload = default_config()
        payload["document"] = {
            "selected": "missing",
            "clips": [{"id": "a", "start": 5, "end": 5, "prompt": "x", "refs": ["bad"]}],
            "assets": [{"id": "ok", "kind": "image", "number": 2, "source": {"path": "ref/a.png"}}],
        }
        config = normalize_config(payload)
        self.assertEqual(config["document"]["selected"], "a")
        self.assertEqual(config["document"]["clips"][0]["end"], 6)
        self.assertEqual(config["document"]["clips"][0]["refs"], [])

    def test_summary_uses_arrangement_end(self):
        payload = default_config()
        payload["document"]["clips"] = [
            {"id": "a", "name": "a", "start": 0, "end": 5 * FPS, "prompt": "", "refs": []},
            {"id": "b", "name": "b", "start": 4 * FPS, "end": 11 * FPS, "prompt": "", "refs": []},
        ]
        info = summary(payload)
        self.assertEqual(info["clips"], 2)
        self.assertEqual(info["seconds"], 11)

    def test_accepts_serialized_json(self):
        payload = default_config()
        payload["params"]["seed"] = 123
        normalized = normalize_config(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(normalized["params"]["seed"], 123)


if __name__ == "__main__":
    unittest.main()
