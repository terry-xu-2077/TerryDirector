"""CPU-only synthetic checks for the opt-in operator adapter."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import random
import sys
import types
import unittest
from unittest.mock import patch
import uuid


SOURCE = Path(__file__).resolve().parents[1] / "tools" / "selflift_operator_profile.py"


def load_adapter():
    spec = importlib.util.spec_from_file_location("_op_" + uuid.uuid4().hex, SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeWindow:
    instances = []

    def __init__(self, phase, forward_index, callback_index, model, x, timestep, options):
        self.phase = phase
        self.forward_index = forward_index
        self.callback_index = callback_index
        self.closed = False
        self.inputs = (model, x, timestep, options)
        self.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def result(self, error=None):
        return {"capture_ok": error is None, "profiler_error": None, "counts": {}}


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.adapter = load_adapter()
        FakeWindow.instances = []
        self.adapter._TRACE = types.SimpleNamespace(identity=lambda: {"prompt_id": "p", "segment_id": "clip-1"},
                                                    event=lambda *a, **k: None)
        self.adapter._MODE = "cpu_events"
        self.env = patch.dict(os.environ, TERRYDIRECTOR_OP_PROFILE="1", TERRYDIRECTOR_TRACE="1")
        self.env.start(); self.addCleanup(self.env.stop)
        self.window = patch.object(self.adapter, "Window", FakeWindow)
        self.window.start(); self.addCleanup(self.window.stop)

    def test_disabled_import_and_no_gpu_or_files(self):
        os.environ["TERRYDIRECTOR_OP_PROFILE"] = "0"
        self.assertFalse(self.adapter.install(None, "cpu_events"))
        self.assertFalse(self.adapter._INSTALLED)
        self.assertIsNone(self.adapter._PATH)

    def test_installs_actual_h3_class_and_uninstalls(self):
        class MiniMaxH3Model:
            def forward(self, x, timestep, context):
                return x
        original = MiniMaxH3Model.forward
        fake = types.ModuleType("comfy.ldm.minimax.model")
        fake.__file__ = str(SOURCE)
        fake.MiniMaxH3Model = MiniMaxH3Model
        ready = []
        trace = types.SimpleNamespace(event=lambda name, **data: ready.append((name, data)))
        comfy = types.ModuleType("comfy"); comfy.__path__ = []
        ldm = types.ModuleType("comfy.ldm"); ldm.__path__ = []
        minimax = types.ModuleType("comfy.ldm.minimax"); minimax.__path__ = []
        comfy.ldm = ldm; ldm.minimax = minimax; minimax.model = fake
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.ldm": ldm,
                                      "comfy.ldm.minimax": minimax, "comfy.ldm.minimax.model": fake}):
            self.assertTrue(self.adapter.install(trace, "cpu_events"))
            self.assertIsNot(MiniMaxH3Model.forward, original)
            self.assertEqual(ready[0][0], "op_profile_ready")
            self.assertEqual(ready[0][1]["adapter_version"], 1)
            self.adapter.uninstall()
        self.assertIs(MiniMaxH3Model.forward, original)

    def test_second_real_forward_once_preserves_inputs_output_and_rng(self):
        calls = []
        def original(self, x, timestep, context, transformer_options=None):
            calls.append((self, x, timestep, context, transformer_options))
            return x
        wrapped = self.adapter.wrap_forward(original)
        model, x, t, context, options = object(), object(), object(), object(), {"head": 4}
        rng = random.getstate()
        with self.adapter.sampling_phase("low_sampling", lambda: 1):
            self.assertIs(wrapped(model, x, t, context, options), x)
            self.assertIs(wrapped(model, x, t, context, options), x)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(calls[1], (model, x, t, context, options))
        self.assertEqual(len(FakeWindow.instances), 1)
        self.assertTrue(FakeWindow.instances[0].closed)
        self.assertEqual(FakeWindow.instances[0].forward_index, 2)
        self.assertEqual(FakeWindow.instances[0].callback_index, 1)
        self.assertEqual(random.getstate(), rng)

    def test_high_first_forward_and_exception_not_masked(self):
        error = MemoryError("original oom")
        calls = 0
        def original(self, x, timestep, context, transformer_options=None):
            nonlocal calls
            calls += 1
            raise error
        wrapped = self.adapter.wrap_forward(original)
        with self.adapter.sampling_phase("high_sampling", lambda: 0):
            with self.assertRaises(MemoryError) as caught:
                wrapped(object(), object(), object(), object())
        self.assertIs(caught.exception, error)
        self.assertEqual(calls, 1)
        self.assertEqual(len(FakeWindow.instances), 1)
        self.assertTrue(FakeWindow.instances[0].closed)

    def test_incomplete_capture_stops_without_repeat(self):
        class Incomplete(FakeWindow):
            def result(self, error=None):
                return {"capture_ok": False, "profiler_error": "missing GPU", "counts": {}}
        self.adapter.Window = Incomplete
        calls = 0
        def original(self, x, timestep, context, transformer_options=None):
            nonlocal calls
            calls += 1
            return x
        wrapped = self.adapter.wrap_forward(original)
        with self.adapter.sampling_phase("low_sampling", lambda: 0):
            wrapped(object(), object(), object(), object())
            with self.assertRaisesRegex(RuntimeError, "diagnostic_incomplete"):
                wrapped(object(), object(), object(), object())
        self.assertEqual(calls, 2)

    def test_real_cpu_hooks_are_removed_after_exception(self):
        import torch
        self.window.stop()
        self.adapter.Window = self.window.get_original()[0]

        class Attention(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.qkv_proj = torch.nn.Linear(2, 2)
                self.out_proj = torch.nn.Linear(2, 2)

            def forward(self, value):
                return self.out_proj(self.qkv_proj(value))

        class MLP(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.fc1 = torch.nn.Linear(2, 2)
                self.fc2 = torch.nn.Linear(2, 2)

            def forward(self, value):
                return self.fc2(self.fc1(value))

        block = types.SimpleNamespace(attn=Attention(), mlp=MLP())
        model = types.SimpleNamespace(blocks=[block])
        tensor = torch.ones(1, 2)
        state = torch.random.get_rng_state().clone()
        with patch.object(self.adapter.Window, "_install_leaf"):
            window = self.adapter.Window("low_sampling", 2, 0, model, [tensor], tensor, {})
            with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
                with window:
                    block.mlp(block.attn(tensor))
                    raise RuntimeError("synthetic failure")
        self.assertEqual(window.counts["attention"], 1)
        self.assertEqual(window.counts["mlp"], 1)
        self.assertEqual(window.counts["qkv_proj"], 1)
        self.assertEqual(window.counts["fc1"], 1)
        self.assertEqual(len(block.attn._forward_hooks), 0)
        self.assertEqual(len(block.mlp._forward_pre_hooks), 0)
        self.assertTrue(torch.equal(torch.random.get_rng_state(), state))


if __name__ == "__main__":
    unittest.main()
