"""CPU-only tests for TerryDirector's native-sampler split checkpoints.

Run: python -m unittest discover -s tests -p 'test_selflift_split_checkpoint.py'
No ComfyUI, H3 weights, GPU or SelfLift-Avatar required.
"""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch


ROOT = Path(__file__).resolve().parents[1]
PKG = "td_split_checkpoint_testpkg"
if PKG not in sys.modules:
    pkg = types.ModuleType(PKG)
    pkg.__path__ = [str(ROOT)]
    sys.modules[PKG] = pkg


class Nested:
    is_nested = True

    def __init__(self, video, audio):
        self.values = (video, audio)

    def unbind(self):
        return self.values


class CheckpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = importlib.import_module(PKG + ".director_selflift_checkpoint")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        fake = types.ModuleType("folder_paths")
        fake.get_output_directory = lambda: self.temp.name
        self.old_folder_paths = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = fake
        self.addCleanup(self.restore_folder_paths)

    def restore_folder_paths(self):
        if self.old_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self.old_folder_paths

    def inputs(self):
        # Very small H3-shaped AV tensors. They are intentionally different in
        # the clean and state tracks to catch accidental substitutions.
        state = {"samples": Nested(torch.ones(1, 4, 3, 2, 4),
                                   torch.ones(1, 2, 4, 3) * 2)}
        clean = {"samples": Nested(torch.ones(1, 4, 3, 2, 4) * 3,
                                   torch.ones(1, 2, 4, 3) * 4)}
        source = {"samples": Nested(torch.zeros(1, 4, 3, 4, 8),
                                    torch.ones(1, 2, 4, 3) * 5),
                  "batch_index": [0]}
        sigmas = torch.tensor([1., .8, .6, .3, 0.])
        return dict(low_state=state, low_clean=clean, source=source,
                    sigmas=sigmas, transition_step=2,
                    seed=42, cfg=5.0, name="镜头 03 人物近景")

    def test_save_load_roundtrip_and_metadata(self):
        cp = self.module
        cid = cp.save_checkpoint(**self.inputs())
        self.assertEqual(len(cid), 32)
        saved = cp.load_checkpoint(cid)
        self.assertEqual(saved["manifest"]["name"], "镜头 03 人物近景")
        self.assertEqual(saved["manifest"]["batch_index"], [0])
        self.assertEqual(saved["manifest"]["transition_step"], 2)
        self.assertEqual(len(cp.list_checkpoints()), 1)
        self.assertTrue(torch.equal(saved["state"][0], torch.ones(1, 4, 3, 2, 4)))
        self.assertTrue(torch.equal(saved["clean"][0], torch.ones(1, 4, 3, 2, 4) * 3))
        self.assertTrue(torch.equal(saved["state"][1], torch.ones(1, 2, 4, 3) * 2))
        self.assertTrue(torch.equal(saved["source"][1], torch.ones(1, 2, 4, 3) * 5))
        self.assertEqual(saved["manifest"]["status"], "draft")

    def test_reject_terminal_lowres_sigmas(self):
        args = self.inputs()
        args["sigmas"] = torch.tensor([1., .8, 0., 0.])
        with self.assertRaises(ValueError):
            self.module.save_checkpoint(**args)

    def test_reject_mismatched_frames(self):
        args = self.inputs()
        args["low_clean"]["samples"] = Nested(
            torch.ones(1, 4, 4, 2, 4), torch.ones(1, 2, 4, 3))
        with self.assertRaises(ValueError):
            self.module.save_checkpoint(**args)

    def test_reject_unsafe_ids_and_corrupted_latent(self):
        with self.assertRaises(ValueError):
            self.module.load_checkpoint("../test")
        cid = self.module.save_checkpoint(**self.inputs())
        file = Path(self.temp.name) / "TerryDirector" / "checkpoints" / cid / "state.safetensors"
        with file.open("ab") as handle:
            handle.write(b"oops")
        with self.assertRaisesRegex(ValueError, "校验失败"):
            self.module.load_checkpoint(cid)

    def test_highres_consumes_only_remaining_sigmas_and_preserves_audio(self):
        from torch.nn import functional as F
        resume = importlib.import_module(PKG + ".director_selflift_resume")
        cid = self.module.save_checkpoint(**self.inputs())

        class Format:
            def process_in(self, x): return x
            def process_out(self, x): return x

        class Flow:
            def noise_scaling(self, sigma, noise, clean): return sigma * noise + (1 - sigma) * clean
            def inverse_noise_scaling(self, sigma, x): return x / (1 - sigma)

        class Model:
            def __init__(self):
                self.model = self
                self.format = Format()
                self.flow = Flow()
            def get_model_object(self, name):
                return self.format if name == "latent_format" else self.flow

        class Backend:
            device = torch.device("cpu")
            dtype = torch.float32
            def __init__(self):
                self.sample_calls = []
            def validate(self, model, high_model, sampler): pass
            def interrupt(self): pass
            def noise(self, latent, seed, batch_index): return torch.zeros_like(latent)
            def pack(self, streams): return Nested(*streams)
            def split(self, value): return list(value.unbind())
            def mask_model(self, model, source, masks): return model
            def preview(self, model, steps): return None
            def sample(self, model, noise, positive, negative, cfg, sampler, sigmas,
                       latent, callback, seed):
                self.sample_calls.append(sigmas.cpu().tolist())
                for step in range(len(sigmas) - 1):
                    callback(step, None, None, len(sigmas) - 1)
                return latent

        backend = Backend()
        result = resume.resume_highres(
            checkpoint={"checkpoint_id": cid}, model=Model(), positive=[],
            negative=[], vae=None, sampler=None, rho=0.0, w_min=0.5,
            w_max=1.0, upscaler_model="fake",
            _backend=backend,
            _lifter=lambda x, target, _: F.interpolate(
                x, size=(x.shape[2], *target), mode="nearest"))
        self.assertEqual(len(backend.sample_calls), 1)
        self.assertEqual(len(backend.sample_calls[0]), 3)  # remaining two steps
        av = result["samples"].unbind()
        self.assertEqual(tuple(av[0].shape), (1, 4, 3, 4, 8))
        self.assertTrue(torch.equal(av[1], torch.ones(1, 2, 4, 3) * 2))

    def test_checkpoint_is_immutable_version(self):
        cid1 = self.module.save_checkpoint(**self.inputs())
        cid2 = self.module.save_checkpoint(**self.inputs())
        self.assertNotEqual(cid1, cid2)
        self.assertEqual(len(self.module.list_checkpoints()), 2)


if __name__ == "__main__":
    unittest.main()
