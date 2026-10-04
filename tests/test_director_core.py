import json
import unittest

from director_core import FPS, default_config, normalize_config, summary


class DirectorCoreTests(unittest.TestCase):
    def test_defaults_remove_local_resolution_and_preview(self):
        config = default_config()
        self.assertNotIn("resolution", config["params"])
        self.assertNotIn("preview_enabled", config["params"])
        self.assertEqual(config["params"]["second_pass"]["method"], "none")

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

    def test_migrates_legacy_selflift_toggle_to_second_pass_method(self):
        payload = default_config()
        payload["params"].pop("second_pass")
        payload["params"]["selflift"] = {"enabled": True, "model": "h3.safetensors", "high_steps": 3}
        normalized = normalize_config(payload)
        self.assertEqual(normalized["params"]["second_pass"]["method"], "selflift")
        self.assertEqual(normalized["params"]["second_pass"]["model"], "h3.safetensors")
        self.assertEqual(normalized["params"]["second_pass"]["high_steps"], 3)

    def test_summary_uses_external_dimensions(self):
        payload = default_config()
        payload["document"]["clips"] = [
            {"id": "a", "name": "a", "start": 0, "end": 5 * FPS, "prompt": "", "refs": []},
            {"id": "b", "name": "b", "start": 4 * FPS, "end": 11 * FPS, "prompt": "", "refs": []},
        ]
        info = summary(payload, 1344, 768)
        self.assertEqual(info["clips"], 2)
        self.assertEqual(info["seconds"], 11)
        self.assertEqual((info["width"], info["height"]), (1344, 768))

    def test_accepts_serialized_json(self):
        payload = default_config()
        payload["params"]["seed"] = 123
        normalized = normalize_config(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(normalized["params"]["seed"], 123)


if __name__ == "__main__":
    unittest.main()
