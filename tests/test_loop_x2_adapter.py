"""Mocked integration test: TerryDirector X2 adapter never edits FastDecode.

No VAE weights or video generation are needed. The mock FastDecode returns
deterministic causal frames for each H3 latent window.
"""

import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


try:
    import torch
except ImportError:
    torch = None


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipIf(torch is None, "PyTorch is not installed (offline planning tests still run)")
class TestLowRAMX2Adapter(unittest.TestCase):
    def test_unmodified_fastdecode_called_on_small_windows(self):
        pkg_name = "_terrydirector_x2_adapter_test"
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ROOT)]

        class FakeNodeOutput:
            def __init__(self, *outputs):
                self.outputs = outputs

        fake_io = types.SimpleNamespace(ComfyNode=object, NodeOutput=FakeNodeOutput)
        comfy_api = types.ModuleType("comfy_api")
        comfy_latest = types.ModuleType("comfy_api.latest")
        comfy_latest.io = fake_io

        calls = []

        class FakeFastDecode:
            def decode(self, samples, **kwargs):
                latent = samples["samples"]
                # Start latent index is encoded into each time slice.
                start_latent = int(latent[0, 0, 0, 0, 0].item())
                count = 5 + 17 * ((latent.shape[2] - 2) // 5)
                start_frame = 17 * (start_latent // 5)
                calls.append((start_latent, count, kwargs))
                pixel = torch.arange(
                    start_frame, start_frame + count, dtype=torch.float32
                ) / 1000
                return (pixel[:, None, None, None].expand(count, 3, 4, 3).clone(),)

        fake_nodes = types.ModuleType("nodes")
        fake_nodes.NODE_CLASS_MAPPINGS = {"MiniMaxH3VAEDecodeFast": FakeFastDecode}

        stubs = {
            pkg_name: pkg,
            "comfy_api": comfy_api,
            "comfy_api.latest": comfy_latest,
            "nodes": fake_nodes,
        }
        with patch.dict(sys.modules, stubs):
            spec = importlib.util.spec_from_file_location(
                f"{pkg_name}.director_loop_x2_decode",
                ROOT / "director_loop_x2_decode.py",
            )
            module = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, {spec.name: module}):
                spec.loader.exec_module(module)
                latent = torch.arange(72, dtype=torch.float32).reshape(
                    1, 1, 72, 1, 1
                ).expand(1, 24, 72, 1, 1)
                images = module.TerryDirectorH3X2LowRAMDecode.execute(
                    {"samples": latent}, vae=object(),
                    temporal_tile_frames=51,
                    temporal_context_frames=39,
                ).outputs[0]

        self.assertEqual(tuple(images.shape), (243, 3, 4, 3))
        expected = torch.arange(243, dtype=torch.float32) / 1000
        self.assertTrue(torch.equal(images[:, 0, 0, 0], expected))
        self.assertGreater(len(calls), 1)
        self.assertLess(max(c[1] for c in calls), 243)
        self.assertTrue(all(c[2]["temporal_tiling"] is False for c in calls))
        self.assertTrue(all(c[2]["output_device"] == "cpu" for c in calls))


if __name__ == "__main__":
    unittest.main()
