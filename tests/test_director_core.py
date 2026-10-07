import json
import unittest

from director_core import (
    FPS,
    RUNTIME_CONFIG_TYPE,
    default_config,
    make_runtime_config,
    normalize_config,
    require_runtime_config,
    summary,
)


class DirectorCoreTests(unittest.TestCase):
    def _runtime(self, **overrides):
        values = {
            "model": object(),
            "clip": object(),
            "vae": object(),
            "audio_vae": object(),
            "width": 1344,
            "height": 768,
            "sampler": object(),
            "sigmas": object(),
            "seed": 123,
            "ref_image_size": "match",
            "second_pass_method": "none",
            "second_pass_model": "",
            "second_pass_high_steps": 4,
        }
        values.update(overrides)
        return make_runtime_config(**values)

    def test_creative_config_contains_no_runtime_params(self):
        config = default_config()
        self.assertNotIn("params", config)
        self.assertIn("document", config)

    def test_runtime_packet_has_no_manual_audio_continuity_flag(self):
        runtime = self._runtime()
        self.assertNotIn("continue_audio_latent", runtime["params"])

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

    def test_rejects_old_creative_config_version(self):
        payload = default_config()
        payload["version"] = 2
        with self.assertRaises(ValueError):
            normalize_config(payload)

    def test_rejects_old_runtime_config_version(self):
        runtime = self._runtime()
        runtime["version"] = 0
        with self.assertRaises(ValueError):
            require_runtime_config(runtime)

    def test_runtime_packet_contains_generation_dependencies(self):
        runtime = self._runtime(second_pass_method="selflift", second_pass_model="h3.safetensors")
        self.assertEqual(runtime["type"], RUNTIME_CONFIG_TYPE)
        self.assertEqual(runtime["width"], 1344)
        self.assertEqual(runtime["params"]["seed"], 123)
        self.assertEqual(runtime["params"]["second_pass"]["method"], "selflift")
        self.assertEqual(runtime["params"]["second_pass"]["model"], "h3.safetensors")

    def test_require_runtime_config_rejects_wrong_type(self):
        with self.assertRaises(ValueError):
            require_runtime_config({"type": "OTHER"})

    def test_summary_uses_runtime_packet(self):
        payload = default_config()
        payload["document"]["clips"] = [
            {"id": "a", "name": "a", "start": 0, "end": 5 * FPS, "prompt": "", "refs": []},
            {"id": "b", "name": "b", "start": 4 * FPS, "end": 11 * FPS, "prompt": "", "refs": []},
        ]
        info = summary(payload, self._runtime())
        self.assertEqual(info["clips"], 2)
        self.assertEqual(info["seconds"], 11)
        self.assertEqual((info["width"], info["height"]), (1344, 768))

    def test_accepts_serialized_json(self):
        payload = default_config()
        normalized = normalize_config(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(normalized["version"], 3)


if __name__ == "__main__":
    unittest.main()
