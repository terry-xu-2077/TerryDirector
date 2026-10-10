"""No-GPU checks of real lab wrapper call count, identity and cleanup."""
import os
from pathlib import Path
import random
import sys
import types
import unittest
from unittest.mock import patch


LAB = Path(__file__).resolve().parents[1]
COMFY = LAB.parents[3]
sys.path.insert(0, str(COMFY))
sys.path.insert(0, str(LAB.parent))
from acceleration_lab import lab_nodes


class FakeSigma:
    def detach(self): return self
    def cpu(self): return self
    def tolist(self): return [1.0, 0.5, 0.0]


class FakeModel:
    def get_model_object(self, name):
        return types.SimpleNamespace(percent_to_sigma=lambda value: 1.0 - value)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.records = []
        self.record = patch.object(lab_nodes, "_record", lambda *args, **kwargs: self.records.append((args, kwargs)))
        self.record.start(); self.addCleanup(self.record.stop)

    def test_condition_calls_native_once_with_same_refs(self):
        from comfy_extras import nodes_minimax_h3
        image = object()
        clip, vae, audio_vae = object(), object(), object()
        calls = []
        def native(**kwargs):
            calls.append(kwargs)
            return ("conditioning", "latent")
        with patch.object(nodes_minimax_h3.MiniMaxH3ReferenceToVideo, "execute", side_effect=native):
            output = lab_nodes.TerryAccelLabCondition.execute(
                clip, vae, audio_vae, "private text", 1920, 1088, 107, "match", "B0",
                **{f"ref_image_{i}": image for i in range(7)})
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0]["clip"], clip)
        self.assertIs(calls[0]["vae"], vae)
        self.assertIs(calls[0]["ref_images"]["ref_image_0"], image)
        self.assertEqual(output.result, ("conditioning", "latent"))

    def test_selflift_passes_original_objects_once_and_restores_sparse_wrapper_after_error(self):
        import comfy_kitchen as ck
        original = ck.sol_attn_chunked
        model, positive, negative, vae, latent, sampler, sigmas = (
            FakeModel(), object(), object(), object(), object(), object(), FakeSigma())
        calls = []
        class Backend:
            def __init__(self): pass
        def source(**kwargs):
            calls.append(kwargs)
            raise MemoryError("synthetic original OOM")
        rng = random.getstate()
        with patch.object(lab_nodes.frozen, "selflift_core", return_value=(Backend, source)):
            with self.assertRaisesRegex(MemoryError, "synthetic original OOM"):
                lab_nodes.TerryAccelLabSelfLift.execute(
                    model, positive, negative, vae, latent, sampler, sigmas,
                    1000, 1.0, 5, .5, 0.0, .5, 1.0, "h3.safetensors", False, "B1", True)
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0]["model"], model)
        self.assertIs(calls[0]["positive"], positive)
        self.assertIs(calls[0]["latent_image"], latent)
        self.assertIs(ck.sol_attn_chunked, original)
        self.assertEqual(random.getstate(), rng)

    def test_frozen_import_does_not_import_root_registration(self):
        with patch.dict(sys.modules, {"TerryDirector": None}):
            refine = lab_nodes.frozen.refine_sigmas()
            backend, sample = lab_nodes.frozen.selflift_core()
        self.assertEqual(refine.__name__, "_refine_sigmas")
        self.assertEqual(sample.__name__, "sample_selflift")
        self.assertEqual(backend.__name__, "ComfyBackend")


if __name__ == "__main__":
    unittest.main()
