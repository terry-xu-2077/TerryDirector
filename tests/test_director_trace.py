"""CPU-only trace smoke tests; native registry, V3 locking and models are stubs.

The integration test calls the actual internal SelfLift node, actual engine and
actual ComfyBackend.sample boundary with a synthetic CPU denoiser. No weights,
GPU, ComfyUI installation, external custom-node imports or queue are required.
"""
from __future__ import annotations
from contextvars import ContextVar
import importlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import uuid

import torch
import test_selflift_internal as toy

ROOT = Path(__file__).resolve().parents[1]


def load_trace():
    spec = importlib.util.spec_from_file_location("_trace_" + uuid.uuid4().hex, ROOT / "director_trace.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TraceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, TERRYDIRECTOR_TRACE="1", TERRYDIRECTOR_TRACE_DIR=self.temp.name)
        self.env.start(); self.addCleanup(self.env.stop)
        self.trace = load_trace()
        self.context = ContextVar("test_context", default=None)
        utils = types.ModuleType("comfy_execution.utils")
        utils.get_executing_context = self.context.get
        self.modules = patch.dict(sys.modules, {"comfy_execution.utils": utils})
        self.modules.start(); self.addCleanup(self.modules.stop)
        self.set_context("p", "900.0.0.td_s1_selflift_sample")
        self.stdout = patch("sys.stdout", new_callable=io.StringIO)
        self.stdout.start(); self.addCleanup(self.stdout.stop)

    def set_context(self, prompt, node):
        self.context.set(types.SimpleNamespace(prompt_id=prompt, node_id=node, list_index=0))

    def records(self):
        path = self.trace._PATH
        return [] if path is None else [json.loads(line) for line in path.read_text().splitlines()]

    def test_disabled_installs_nothing_and_creates_no_file(self):
        os.environ["TERRYDIRECTOR_TRACE"] = "0"
        self.trace.install("nonexistent_package", [])
        with self.trace.span("disabled"): pass
        self.assertIsNone(self.trace._PATH)
        self.assertFalse(self.trace._INSTALLED)

    def test_nested_spans_preserve_parent_and_utc(self):
        with self.trace.span("outer") as outer:
            with self.trace.span("inner") as inner: pass
        data = self.records()
        self.assertEqual([x["event"] for x in data], ["begin", "begin", "end", "end"])
        self.assertEqual(data[1]["parent_id"], outer)
        self.assertEqual(data[2]["span_id"], inner)
        self.assertTrue(all(x["utc"].endswith("+00:00") for x in data))
        self.assertTrue(all(x["prompt_id"] == "p" for x in data))
        self.assertIsNone(self.trace._PARENT.get())

    def test_exception_and_parent_are_restored(self):
        error = InterruptedError("unchanged")
        with self.assertRaises(InterruptedError) as caught:
            with self.trace.span("test"): raise error
        self.assertIs(caught.exception, error)
        self.assertEqual(self.records()[-1]["error_type"], "InterruptedError")
        self.assertIsNone(self.trace._PARENT.get())

    def test_trace_write_error_does_not_mask_generation_error(self):
        original = self.trace.event
        def broken(kind, **kwargs):
            if kind == "end": raise OSError("full")
            original(kind, **kwargs)
        with patch.object(self.trace, "event", broken), self.assertRaisesRegex(ValueError, "model"):
            with self.trace.span("test"): raise ValueError("model")

    def test_unwritable_sink_fails_before_function(self):
        self.trace._PATH = Path(self.temp.name) / "missing" / "bad.jsonl"
        called = []
        def target(): called.append(True)
        with self.assertRaises(FileNotFoundError):
            self.trace.wrap(target, "test", node=True)()
        self.assertFalse(called)

    def test_unrelated_native_node_does_not_emit(self):
        def target(value): return value
        wrapped = self.trace.wrap(target, "conditioning", native=True)
        self.set_context("other", "44")
        marker = object()
        self.assertIs(wrapped(marker), marker)
        self.assertEqual(self.records(), [])

    def test_classmethod_preserves_signature_and_locked_subclass(self):
        class Base:
            @classmethod
            def execute(cls, value, optional=2): return cls, value, optional
        signature = inspect.signature(Base.execute)
        self.trace.patch(Base, "execute", "test", node=True)
        class Locked(Base): pass
        self.assertEqual(inspect.signature(Base.execute), signature)
        self.assertEqual(Locked.execute(1), (Locked, 1, 2))
        wrapped = Base.__dict__["execute"].__func__
        self.trace.patch(Base, "execute", "test", node=True)
        self.assertIs(wrapped, Base.__dict__["execute"].__func__)

    def test_model_load_unload_events_are_nested(self):
        class Loaded:
            def __init__(self):
                self.model = types.SimpleNamespace(model=object(), load_device="cpu", loaded_size=lambda: 10)
            def model_unload(self, memory_to_free=None): return False
        self.trace.patch(Loaded, "model_unload", "model_unload_call")
        with self.trace.span("high_sampling") as parent:
            self.assertFalse(Loaded().model_unload(5))
        records = self.records()
        returned = next(r for r in records if r["event"] == "model_return")
        self.assertFalse(returned["complete_unload"])
        begin = next(r for r in records if r["event"] == "begin" and r["name"] == "model_unload_call")
        self.assertEqual(begin["parent_id"], parent)
        self.assertEqual(begin["models_before"][0]["loaded_bytes"], 10)

    def test_extension_bootstrap_calls_install_with_exact_node_list(self):
        import ast
        tree = ast.parse((ROOT / "__init__.py").read_text())
        extension = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "TerryDirectorExtension")
        method = next(n for n in extension.body if isinstance(n, ast.AsyncFunctionDef))
        declared = next(n for n in method.body if isinstance(n, ast.Assign))
        self.assertEqual(declared.targets[0].id, "node_classes")
        self.assertIn("TerryDirectorSelfLiftSampler", [n.id for n in declared.value.elts])
        install = next(n.value for n in method.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call))
        self.assertEqual(install.func.id, "install")
        self.assertEqual([x.id for x in install.args], ["__package__", "node_classes"])
        self.assertEqual(method.body[-1].value.id, "node_classes")

    def test_no_cuda_initialization_or_forced_sync(self):
        with patch.object(torch.cuda, "is_initialized", return_value=False), \
             patch.object(torch.cuda, "init", side_effect=AssertionError("init")), \
             patch.object(torch.cuda, "synchronize", side_effect=AssertionError("sync")):
            with self.trace.span("cpu"): pass
        self.assertEqual(self.records()[0]["memory"], {"cuda_initialized": False})

    def test_missing_conditioning_fails_before_sampler(self):
        self.trace._INSTALLED = True
        called = []
        def target(): called.append(True)
        with self.assertRaisesRegex(RuntimeError, "conditioning"):
            self.trace.wrap_selflift(target)()
        self.assertFalse(called)

    def test_plan_resolves_same_index_under_multiple_directors(self):
        def build(plan): return plan
        wrapped = self.trace.wrap_plan(build)
        for root, segment in (("900", "alice"), ("901", "bob")):
            self.set_context("p", root)
            wrapped({"segments": [{"id": segment, "index": 0, "h3_frames": 5, "output_frames": 4}]})
        self.set_context("p", "901.0.0.td_s1_conditioning")
        self.assertEqual(self.trace.identity()["segment_id"], "bob")
        self.set_context("p", "900.0.0.td_s1_conditioning")
        self.assertEqual(self.trace.identity()["segment_id"], "alice")

    def test_integration_actual_node_engine_boundary_and_live_registry(self):
        package_name = "_td_trace_fixture_" + uuid.uuid4().hex
        package = types.ModuleType(package_name); package.__path__ = [str(ROOT)]
        sys.modules[package_name] = package
        self.addCleanup(lambda: [sys.modules.pop(k, None) for k in list(sys.modules) if k.startswith(package_name)])
        api = types.ModuleType("comfy_api.latest")
        api.io = types.SimpleNamespace(ComfyNode=object, NodeOutput=lambda x: x)
        api_patch = patch.dict(sys.modules, {"comfy_api.latest": api})
        api_patch.start(); self.addCleanup(api_patch.stop)
        engine = importlib.import_module(package_name + ".director_selflift")
        node = importlib.import_module(package_name + ".director_selflift_node")
        lifter = importlib.import_module(package_name + ".director_selflift_upscaler")
        director = types.ModuleType(package_name + ".director_node"); director.__file__ = __file__
        def build_timeline_graph(runtime, plan, seed): return plan
        director.build_timeline_graph = build_timeline_graph
        sys.modules[director.__name__] = director
        # Keep the real ComfyBackend.sample implementation; provide a CPU host.
        def backend_init(self):
            toy.Backend.__init__(self)
            def native_sample(model, noise, positive, negative, cfg, device, sampler, sigmas,
                              model_options, latent_image, callback, disable_pbar, seed):
                return toy.Backend.sample(self, model, noise, positive, negative, cfg, sampler,
                                          sigmas, latent_image, callback, seed)
            self.samplers = types.SimpleNamespace(sample=native_sample)
            self.utils = types.SimpleNamespace(PROGRESS_BAR_ENABLED=False)
        engine.ComfyBackend.__init__ = backend_init
        for name, member in toy.Backend.__dict__.items():
            if not name.startswith("__") and name != "sample": setattr(engine.ComfyBackend, name, member)
        def cpu_lift(video, target, name): return engine.spatial_resize(video, target)
        lifter.learned_lift = cpu_lift
        kwargs = dict(model=toy.Model(), positive=[], negative=[], vae=toy.VAE(),
                      latent_image={"samples": toy.AV([torch.ones(1,2,3,8,12), torch.ones(1,2,1,9)])},
                      sampler=object(), sigmas=torch.tensor([1., .8, .5, .2, 0.]), seed=1000,
                      cfg=1, transition_step=2, lowres_scale=.5, rho=0, w_min=.5, w_max=1,
                      upscaler_model="synthetic.safetensors")
        with patch.dict(os.environ, TERRYDIRECTOR_TRACE="0"):
            baseline = node.TerryDirectorSelfLiftSampler.execute(**kwargs)
        class Native:
            @classmethod
            def execute(cls, value): return value
        registry = types.ModuleType("nodes")
        registry.NODE_CLASS_MAPPINGS = {"MiniMaxH3ReferenceToVideo": Native, "MiniMaxH3AddGuide": type("Guide", (), {"execute": classmethod(lambda cls, value: value)})}
        class HostVAE:
            def encode(self, value): return value
            def decode(self, value): return value
        class Loaded:
            def model_load(self): return None
            def model_unload(self): return True
        mm = types.ModuleType("comfy.model_management"); mm.LoadedModel = Loaded
        mm.load_models_gpu = lambda models, **kwargs: None
        sd = types.ModuleType("comfy.sd"); sd.VAE = HostVAE
        comfy = types.ModuleType("comfy"); comfy.model_management = mm; comfy.sd = sd
        with patch.dict(sys.modules, {"nodes": registry, "comfy": comfy, "comfy.sd": sd, "comfy.model_management": mm}), \
             patch.object(torch, "save", torch.save), patch.object(torch, "load", torch.load):
            self.trace.install(package_name, [])
            self.assertIs(engine.sample_selflift, node.sample_selflift)
            self.trace.install_native()
            self.set_context("p", "900")
            director.build_timeline_graph({}, {"segments": [{"id":"clip-1", "index":0,"h3_frames":5,"output_frames":4}]}, 1000)
            self.set_context("p", "900.0.0.td_s1_conditioning")
            marker = object()
            self.assertIs(registry.NODE_CLASS_MAPPINGS["MiniMaxH3ReferenceToVideo"].execute(marker), marker)
            self.set_context("p", "900.0.0.td_s1_selflift_sample")
            result = node.TerryDirectorSelfLiftSampler.execute(**kwargs)
        for before, after in zip(baseline["samples"].unbind(), result["samples"].unbind()):
            self.assertTrue(torch.equal(before, after))
        events = self.records()
        ends = {x["name"]: x for x in events if x["event"] == "end"}
        for name in ("conditioning", "selflift", "low_sampling", "resolution_transition", "latent_upscale", "high_sampling"):
            self.assertEqual(ends[name]["status"], "ok", name)
        self.assertEqual(ends["latent_upscale"]["parent_id"], ends["resolution_transition"]["span_id"])
        steps = [x for x in events if x["event"] == "step_callback"]
        self.assertEqual([x["name"] for x in steps], ["low_sampling"]*2 + ["high_sampling"]*2)
        self.assertTrue(all(x["segment_id"] == "clip-1" for x in steps))
        self.assertIsNone(self.trace._PARENT.get()); self.assertIsNone(self.trace._ENGINE.get())


if __name__ == "__main__": unittest.main()
