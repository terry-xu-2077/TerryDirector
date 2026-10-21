"""CPU-only contract tests for the SelfLift pause/resume convenience node.

Works without an installed ComfyUI. V3 io and the execution blocker are
represented by minimal stubs, while disk checkpoints use the actual
TerryDirector checkpoint implementation.
"""
from __future__ import annotations

import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch
from safetensors.torch import save_file

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_selflift_pause_resume_testpkg"
if PACKAGE not in sys.modules:
    module = types.ModuleType(PACKAGE)
    module.__path__ = [str(ROOT)]
    sys.modules[PACKAGE] = module


class FakeNested:
    is_nested = True

    def __init__(self, video, audio):
        self.values = (video, audio)

    def unbind(self):
        return self.values


class FakeNodeOutput:
    def __init__(self, *args, ui=None):
        self.args = args
        self.ui = ui


class ExecutionBlocker:
    def __init__(self, message=None):
        self.message = message


class PauseResumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Stub only the external ComfyUI registration/runtime layers.
        cls.injected = []
        for key, value in (
            ("comfy_api", types.ModuleType("comfy_api")),
            ("comfy_api.latest", types.ModuleType("comfy_api.latest")),
            ("comfy_execution", types.ModuleType("comfy_execution")),
            ("comfy_execution.graph_utils", types.ModuleType("comfy_execution.graph_utils")),
        ):
            if key not in sys.modules:
                sys.modules[key] = value
                cls.injected.append(key)
        typesys = types.SimpleNamespace()
        def input_widget(*args, **kwargs):
            return types.SimpleNamespace(id=args[0], options=kwargs)
        for type_id in ("String", "Int", "Float", "Latent", "Sigmas", "Model",
                        "Conditioning", "Vae", "Sampler", "Combo"):
            setattr(typesys, type_id, types.SimpleNamespace(
                Input=input_widget, Output=input_widget))
        typesys.Custom = lambda value: types.SimpleNamespace(
            Input=input_widget, Output=input_widget)
        typesys.ComfyNode = object
        typesys.NodeOutput = FakeNodeOutput
        typesys.Schema = lambda **kwargs: types.SimpleNamespace(**kwargs)
        sys.modules["comfy_api.latest"].io = typesys
        sys.modules["comfy_execution.graph_utils"].ExecutionBlocker = ExecutionBlocker
        cls.module = importlib.import_module(PACKAGE + ".director_selflift_split_node")
        cls.checkpoints = importlib.import_module(PACKAGE + ".director_selflift_checkpoint")

    @classmethod
    def tearDownClass(cls):
        for key in cls.injected:
            sys.modules.pop(key, None)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        folder_paths = types.ModuleType("folder_paths")
        folder_paths.get_output_directory = lambda: self.tmp.name
        self.old = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = folder_paths
        self.addCleanup(self.restore_folder_paths)

    def restore_folder_paths(self):
        if self.old is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self.old

    def data(self):
        video_low = torch.ones(1, 24, 4, 4, 4)
        video_full = torch.zeros(1, 24, 4, 8, 8)
        audio = torch.ones(1, 32, 2, 16)
        return {
            "low_state": {"samples": FakeNested(video_low, audio)},
            "low_clean": {"samples": FakeNested(video_low * 2, audio * 3)},
            "source": {"samples": FakeNested(video_full, audio * 4)},
            "sigmas": torch.tensor([1.0, 0.8, 0.6, 0.4, 0.2, 0.0]),
            "transition_step": 3,
            "seed": 42,
            "cfg": 5.0,
            "name": "夜晚城市航拍",
            "checkpoint_id": "",
        }

    def test_schema_requires_only_mode_and_parameters(self):
        schema = self.module.TerryDirectorSelfLiftPauseResume.define_schema()
        self.assertTrue(schema.is_output_node)
        self.assertEqual(schema.node_id, "TerryDirectorSelfLiftPauseResume")
        lazy = {i.id: i.options for i in schema.inputs if i.id in (
            "low_state", "low_clean", "source", "sigmas")}
        self.assertEqual(set(lazy), {"low_state", "low_clean", "source", "sigmas"})
        self.assertTrue(all(v.get("lazy") and v.get("optional") for v in lazy.values()))

    def test_continue_does_not_request_lowres_upstream(self):
        node = self.module.TerryDirectorSelfLiftPauseResume
        self.assertEqual(node.check_lazy_status(
            mode="继续高清", low_state=None, low_clean=None,
            source=None, sigmas=None), [])
        self.assertEqual(node.check_lazy_status(
            mode="暂停并保存", low_state=None, low_clean=None,
            source=None, sigmas=None),
            ["low_state", "low_clean", "source", "sigmas"])

    def test_pause_blocks_highres_and_continue_uses_same_disk_id(self):
        node = self.module.TerryDirectorSelfLiftPauseResume
        saved = node.execute(mode="暂停并保存", **self.data())
        self.assertIsInstance(saved.args[0], ExecutionBlocker)
        self.assertIsNone(saved.args[0].message)
        checkpoint_id = saved.args[1]
        self.assertEqual(len(checkpoint_id), 32)
        self.assertEqual(saved.ui["terrydirector_selflift_checkpoint"][0]["mode"], "paused")

        # Continue does not receive low-res inputs at all.
        output = node.execute(mode="继续高清", checkpoint_id=checkpoint_id,
                              name="ignored", transition_step=3, seed=42, cfg=5)
        self.assertEqual(output.args[0]["checkpoint_id"], checkpoint_id)
        self.assertEqual(output.args[1], checkpoint_id)
        self.assertEqual(output.ui["terrydirector_selflift_checkpoint"][0]["mode"], "continued")
        self.assertEqual(len(self.checkpoints.list_checkpoints()), 1)

    def test_pause_generates_immutable_versions(self):
        node = self.module.TerryDirectorSelfLiftPauseResume
        first = node.execute(mode="暂停并保存", **self.data()).args[1]
        second = node.execute(mode="暂停并保存", **self.data()).args[1]
        self.assertNotEqual(first, second)
        self.assertEqual(len(self.checkpoints.list_checkpoints()), 2)

    def test_pause_requires_inputs(self):
        node = self.module.TerryDirectorSelfLiftPauseResume
        with self.assertRaisesRegex(ValueError, "缺少输入"):
            node.execute(mode="暂停并保存", checkpoint_id="", name="x",
                         transition_step=3, seed=42, cfg=5)

    def test_continue_requires_existing_valid_checkpoint(self):
        node = self.module.TerryDirectorSelfLiftPauseResume
        with self.assertRaisesRegex(ValueError, "没有可继续的检查点"):
            node.execute(mode="继续高清", checkpoint_id="", name="x",
                         transition_step=3, seed=42, cfg=5)
        with self.assertRaisesRegex(ValueError, "不存在或已被删除"):
            node.execute(mode="继续高清", checkpoint_id="0" * 32,
                         name="x", transition_step=3, seed=42, cfg=5)
        valid_id = node.execute(mode="暂停并保存", **self.data()).args[1]
        checkpoint_path = (Path(self.tmp.name) / "TerryDirector" / "checkpoints" /
                           valid_id / "state.safetensors")
        with checkpoint_path.open("ab") as file:
            file.write(b"damage")
        with self.assertRaisesRegex(ValueError, "损坏或不兼容"):
            node.execute(mode="继续高清", checkpoint_id=valid_id,
                         name="x", transition_step=3, seed=42, cfg=5)


if __name__ == "__main__":
    unittest.main()
