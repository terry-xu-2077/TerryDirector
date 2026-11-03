"""CPU-only round trips for a model-independent, lazy LATENT boundary."""
import importlib
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_generic_pause_testpkg"


class Output:
    def __init__(self, *args, ui=None):
        self.args, self.ui = args, ui


class Blocker:
    def __init__(self, message):
        self.message = message


class PauseResumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        names = (PACKAGE, PACKAGE + ".director_pause_resume", PACKAGE + ".director_latent_checkpoint",
                 "comfy_api", "comfy_api.latest", "comfy_execution", "comfy_execution.graph_utils",
                 "comfy.nested_tensor", "folder_paths")
        cls.before = {name: sys.modules.get(name) for name in names}
        pkg = types.ModuleType(PACKAGE)
        pkg.__path__ = [str(ROOT / "nodes")]
        sys.modules[PACKAGE] = pkg
        for name in ("comfy_api", "comfy_api.latest", "comfy_execution", "comfy_execution.graph_utils"):
            sys.modules[name] = types.ModuleType(name)
        def field(*args, **kwargs):
            return types.SimpleNamespace(id=args[0], options=kwargs)
        io = types.SimpleNamespace(ComfyNode=object, NodeOutput=Output,
                                   Schema=lambda **kwargs: types.SimpleNamespace(**kwargs))
        for name in ("Combo", "String", "Latent"):
            setattr(io, name, types.SimpleNamespace(Input=field, Output=field))
        sys.modules["comfy_api.latest"].io = io
        sys.modules["comfy_execution.graph_utils"].ExecutionBlocker = Blocker
        # Use ComfyUI's actual lightweight NestedTensor implementation.
        spec = importlib.util.spec_from_file_location("comfy.nested_tensor", ROOT.parents[1] / "comfy/nested_tensor.py")
        nested = importlib.util.module_from_spec(spec)
        sys.modules["comfy.nested_tensor"] = nested
        spec.loader.exec_module(nested)
        cls.Nested = nested.NestedTensor
        cls.module = importlib.import_module(PACKAGE + ".director_pause_resume")
        cls.cache = importlib.import_module(PACKAGE + ".director_latent_checkpoint")
        cls.node = cls.module.TerryDirectorPauseResume

    @classmethod
    def tearDownClass(cls):
        for name, value in cls.before.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: str(self.root))

    def test_schema_has_no_sampling_or_preview_controls_and_no_legacy_registration(self):
        schema = self.node.define_schema()
        self.assertEqual(schema.node_id, "TerryDirectorPauseResume")
        self.assertEqual(schema.category, "TerryDirector")
        self.assertEqual([field.id for field in schema.inputs], ["mode", "checkpoint_id", "name", "latent"])
        self.assertEqual([field.id for field in schema.outputs], ["latent", "checkpoint_id"])
        self.assertTrue(schema.inputs[-1].options["lazy"])
        self.assertEqual(schema.inputs[0].options["options"], ["暂停并保存", "继续执行"])
        source = (ROOT / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("TerryDirectorPauseResume", source)
        self.assertNotIn("TerryDirectorSelfLiftPauseResume", source)
        for name in ("director_pause_resume.py", "director_latent_checkpoint.py"):
            self.assertNotIn("director_selflift", (ROOT / "nodes" / name).read_text(encoding="utf-8"))

    def test_plain_image_latent_and_metadata_round_trip_without_upstream(self):
        latent = {"samples": torch.arange(128, dtype=torch.float32).reshape(1, 4, 4, 8),
                  "noise_mask": torch.ones(1, 4, 8), "batch_index": [7],
                  "metadata": {"format": "custom", "nested": (True, None, 3.5)}}
        paused = self.node.execute("暂停并保存", "", "普通图片", latent)
        self.assertIsInstance(paused.args[0], Blocker)
        cid = paused.args[1]
        self.assertEqual(paused.ui["terrydirector_checkpoint"][0]["mode"], "paused")
        # A continue call has no upstream value; it must read the disk cache.
        resumed = self.node.execute("继续执行", cid, "ignored")
        restored = resumed.args[0]
        self.assertTrue(torch.equal(restored["samples"], latent["samples"]))
        self.assertTrue(torch.equal(restored["noise_mask"], latent["noise_mask"]))
        self.assertEqual(restored["metadata"], latent["metadata"])
        self.assertEqual(restored["batch_index"], [7])
        self.assertNotIn("seed", self.cache.read_manifest(cid))
        self.assertNotIn("seed", restored)
        self.assertEqual(resumed.args[1], cid)

    def test_video_and_nested_av_do_not_require_h3_shapes_or_sigma_schedule(self):
        samples = torch.ones(2, 7, 9, 3, 5, dtype=torch.bfloat16)
        cid = self.cache.save_checkpoint({"samples": samples}, "任意视频")
        loaded = self.cache.load_checkpoint(cid)["latent"]["samples"]
        self.assertEqual(loaded.dtype, torch.bfloat16)
        self.assertTrue(torch.equal(loaded, samples))
        streams = [torch.randn(1, 8, 7, 2, 3), torch.randn(1, 3, 19)]
        latent = {"samples": self.Nested(streams), "noise_mask": self.Nested([torch.ones_like(x) for x in streams])}
        cid = self.cache.save_checkpoint(latent)
        loaded = self.cache.load_checkpoint(cid)["latent"]
        self.assertIsInstance(loaded["samples"], self.Nested)
        for actual, expected in zip(loaded["samples"].unbind(), streams):
            self.assertTrue(torch.equal(actual, expected))

    def test_pause_is_immutable_and_continuation_is_independent_of_input_changes(self):
        latent = {"samples": torch.zeros(1, 4, 2, 2)}
        first = self.node.execute("暂停并保存", "", "a", latent).args[1]
        latent["samples"].fill_(9)
        second = self.node.execute("暂停并保存", first, "a", latent).args[1]
        self.assertNotEqual(first, second)
        old = self.node.execute("继续执行", first, "a", latent).args[0]
        self.assertEqual(old["samples"].sum().item(), 0)
        self.assertEqual(len(self.cache.list_checkpoints()), 2)

    def test_lazy_v3_dynamic_tuples_request_only_latent_in_pause(self):
        self.assertEqual(self.node.check_lazy_status(("暂停并保存", "mode"), latent=(None, "latent")), ["latent"])
        self.assertEqual(self.node.check_lazy_status(("继续执行", "mode"), latent=(None, "latent")), [])
        self.assertEqual(self.node.check_lazy_status("暂停并保存"), [])
        self.assertEqual(self.node.check_lazy_status("暂停并保存", latent={"samples": "cached"}), [])

    def test_invalid_inputs_paths_and_corrupt_tensor_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "缺少 LATENT"):
            self.node.execute("暂停并保存", "", "x")
        with self.assertRaises(ValueError):
            self.cache.save_checkpoint({"samples": torch.ones(1), "bad": object()})
        with self.assertRaises(ValueError):
            self.node.execute("继续执行", "../outside", "x")
        cid = self.cache.save_checkpoint({"samples": torch.ones(1)})
        path = self.root / "TerryDirector/checkpoints" / cid / "state.safetensors"
        with path.open("ab") as file:
            file.write(b"corrupt")
        with self.assertRaisesRegex(ValueError, "校验失败"):
            self.node.execute("继续执行", cid, "x")


if __name__ == "__main__":
    unittest.main()
