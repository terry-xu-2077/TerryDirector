"""CPU-only tests for the default-off Kitchen backend call observer."""
import importlib.util
import os
from pathlib import Path
import random
import types
import unittest
from unittest.mock import patch
import uuid


SOURCE = Path(__file__).resolve().parents[1] / "tools" / "selflift_kitchen_backend_verify.py"


def load():
    spec = importlib.util.spec_from_file_location("_kitchen_" + uuid.uuid4().hex, SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Sigma:
    device = types.SimpleNamespace(type="cpu")
    def detach(self):
        return self
    def tolist(self):
        return [1.0, 0.5, 0.0]


class KitchenVerifierTests(unittest.TestCase):
    def setUp(self):
        self.observer = load()
        self.records = []
        self.events = []
        self.observer._TRACE = types.SimpleNamespace(
            identity=lambda: {"prompt_id": "p1", "director_id": "d1", "segment_id": "clip-1"},
            event=lambda name, **data: self.events.append((name, data)))
        self.observer._TARGET_DIRECTOR = "d1"
        self.observer._TARGET_SEGMENT = "clip-1"
        self.write = patch.object(self.observer, "write", self.records.append)
        self.write.start(); self.addCleanup(self.write.stop)
        self.file = patch.object(self.observer, "output_file", lambda: Path("synthetic.jsonl"))
        self.file.start(); self.addCleanup(self.file.stop)
        self.env = patch.dict(os.environ, TERRYDIRECTOR_TRACE="1", TERRYDIRECTOR_BACKEND_VERIFY="1")
        self.env.start(); self.addCleanup(self.env.stop)

    def test_disabled_is_inert(self):
        os.environ["TERRYDIRECTOR_BACKEND_VERIFY"] = "0"
        self.assertFalse(self.observer.install(None))
        self.assertIsNone(self.observer._PATH)
        self.assertFalse(self.observer._PATCHES)

    def test_call_once_identity_rng_counts_and_alias_restore(self):
        calls = []
        override = object()
        def boundary(*args, **kwargs):
            calls.append((args, kwargs))
            return args[0]
        def original(*args, **kwargs):
            calls.append((args, kwargs))
            api(args[0], args[1], args[2], attn_mask=None)
            extension(args[0], args[1], args[2])
            return args[0]
        aliases = {"optimized_attention": original}
        self.observer._model_state = lambda model: (override, aliases, {"head_chunks": 4})
        api = self.observer._wrap("kitchen_api_regular", boundary)
        extension = self.observer._wrap("kitchen_extension_sdpa", boundary)
        q, k, v = object(), object(), object()
        rng = random.getstate()
        with self.observer.sampling_phase("low_sampling", {"model": object(), "sigmas": Sigma()}):
            assert aliases["optimized_attention"](q, k, v, transformer_options={"optimized_attention_override": override}) is q
            self.observer.on_callback(1)
        self.assertEqual(len(calls), 3)
        self.assertIs(calls[0][0][0], q)
        self.assertIs(aliases["optimized_attention"], original)
        self.assertEqual(random.getstate(), rng)
        self.assertEqual(self.records[0]["sigma_values"], [1.0, 0.5, 0.0])
        self.assertEqual(self.records[0]["counts"]["kitchen_extension_sdpa"], 1)
        self.assertTrue(self.records[0]["first_callback_check_ok"])

    def test_unrelated_director_not_observed(self):
        self.observer._TARGET_DIRECTOR = "elsewhere"
        with self.observer.sampling_phase("low_sampling", {"model": object(), "sigmas": Sigma()}):
            self.observer.on_callback(1)
        self.assertEqual(self.records, [])

    def test_fallback_stops_at_first_callback_and_restores_alias(self):
        override = object()
        def boundary(*args, **kwargs):
            return args[0]
        def original(*args, **kwargs):
            api(args[0], args[0], args[0])
            extension(args[0])
            return args[0]
        aliases = {"optimized_attention": original}
        self.observer._model_state = lambda model: (override, aliases, {"head_chunks": 4})
        api = self.observer._wrap("kitchen_api_regular", boundary)
        extension = self.observer._wrap("kitchen_extension_sdpa", boundary)
        with self.assertRaisesRegex(RuntimeError, "fallback"):
            with self.observer.sampling_phase("low_sampling", {"model": object(), "sigmas": Sigma()}):
                aliases["optimized_attention"](object(), transformer_options={})
                self.observer.on_callback(1)
        self.assertIs(aliases["optimized_attention"], original)
        self.assertEqual(self.records[0]["counts"]["fallback_missing_or_changed_override"], 1)

    def test_original_error_not_masked_by_write_failure(self):
        override = object()
        def original(*args, **kwargs):
            return None
        aliases = {"optimized_attention": original}
        self.observer._model_state = lambda model: (override, aliases, {"head_chunks": 4})
        self.observer.write = lambda record: (_ for _ in ()).throw(OSError("sink failed"))
        error = MemoryError("original oom")
        with self.assertRaises(MemoryError) as caught:
            with self.observer.sampling_phase("high_sampling", {"model": object(), "sigmas": Sigma()}):
                raise error
        self.assertIs(caught.exception, error)
        self.assertIs(aliases["optimized_attention"], original)


if __name__ == "__main__":
    unittest.main()
