"""Native TerryDirector preview regression (no sampler, GPU, or KJNodes needed).

Run: python -m unittest discover -s tests -p test_preview_native.py
"""
from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PKG = "_td_native_preview_test"
package = types.ModuleType(PKG)
package.__path__ = [str(ROOT / "nodes")]
sys.modules.setdefault(PKG, package)

# ComfyUI's V3 API need not be installed to validate the pure encoder.
try:
    from comfy_api.latest import io
except ImportError:
    api = types.ModuleType("comfy_api")
    latest = types.ModuleType("comfy_api.latest")
    latest.io = types.SimpleNamespace(ComfyNode=object)
    sys.modules.setdefault("comfy_api", api)
    sys.modules.setdefault("comfy_api.latest", latest)

for name in ("director_preview_mp4", "director_preview_native"):
    path = ROOT / "nodes" / (name + ".py")
    spec = importlib.util.spec_from_file_location(PKG + "." + name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

mp4 = sys.modules[PKG + ".director_preview_mp4"]
native = sys.modules[PKG + ".director_preview_native"]


class NativePreviewTests(unittest.TestCase):
    def test_decoder_construction_preserves_workflow_rng(self):
        import torch
        import torch.nn as nn
        comfy = types.ModuleType("comfy")
        mm = types.ModuleType("comfy.model_management")
        mm.vae_device = lambda: torch.device("cpu")
        utils = types.ModuleType("comfy.utils")
        utils.load_torch_file = lambda *a, **kw: {
            "decoder.1.weight": torch.ones(3, 4, 3, 3),
            "decoder.1.bias": torch.zeros(3),
        }
        comfy.utils = utils
        taesd = types.ModuleType("comfy.taesd.taesd")
        taesd.Block = nn.Identity
        taesd.Clamp = nn.Identity
        taesd.conv = lambda a, b, bias=True: nn.Conv2d(a, b, 3, padding=1, bias=bias)
        paths = types.ModuleType("folder_paths")
        paths.get_filename_list = lambda _: ["taeh3.safetensors"]
        paths.get_full_path = lambda *args: "test-weights.safetensors"
        modules = {"comfy": comfy, "comfy.utils": utils, "comfy.model_management": mm,
                   "comfy.taesd": types.ModuleType("comfy.taesd"),
                   "comfy.taesd.taesd": taesd, "folder_paths": paths}
        with patch.dict(sys.modules, modules):
            torch.manual_seed(314159)
            before = torch.random.get_rng_state().clone()
            decoder, *_ = native._decoder("taeh3.safetensors")
            self.assertTrue(torch.equal(before, torch.random.get_rng_state()))
            self.assertTrue(torch.equal(decoder[1].weight, torch.ones_like(decoder[1].weight)))

    def test_temporal_sampling_covers_entire_clip(self):
        points = native._indices(181, 72)
        self.assertEqual(len(points), 72)
        self.assertEqual(points[0], 0)
        self.assertEqual(points[-1], 180)
        self.assertEqual(len(set(points)), 72)
        self.assertEqual(native._indices(6, 72), list(range(6)))

    def test_packed_video_unwrap(self):
        import torch
        shape = [1, 24, 12, 8, 8]
        size = 24 * 12 * 8 * 8
        # Match ComfyUI pack_latents: each stream is flattened to B x 1 x N.
        packed = torch.arange(size).reshape(1, 1, size)
        clip = native._video_latent(packed, [shape])
        self.assertEqual(list(clip.shape), shape)

    def test_live_webp_not_fragmented_mp4(self):
        from PIL import Image
        frames = [Image.new("RGB", (64, 32), (n * 40, 40, 80))
                  for n in range(5)]
        mime, payload = native._live_payload(frames, 12)
        self.assertEqual(mime, "image/webp")
        self.assertTrue(payload)
        self.assertNotIn("video/mp4", mime)

    def test_complete_final_video_has_requested_duration(self):
        if not shutil.which("ffmpeg"):
            self.skipTest("FFmpeg unavailable")
        from PIL import Image
        images = [Image.new("RGB", (160, 90), (n * 30, 20, 90))
                  for n in range(6)]
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "completed.mp4"
            native._encode_final(images, target, 15)
            self.assertTrue(target.is_file())
            self.assertFalse(mp4.is_fragmented_mp4(target.read_bytes()))
            self.assertAlmostEqual(mp4._video_duration(target, mp4._ffmpeg()),
                                   15.0, delta=0.2)
            mp4._verify_video(target, mp4._ffmpeg())

    def test_failure_does_not_leave_published_mp4(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "not-written.mp4"
            with self.assertRaises(ValueError):
                native._encode_final([Image.new("RGB", (64, 32))], target, 100)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
