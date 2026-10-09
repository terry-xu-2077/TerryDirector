"""Isolated CPU tests for SelfLift configuration and sampler graph wiring.

Run from the repository root:
    python -m unittest discover -s tests -p 'test_selflift_runtime.py' -v

Load the actual helper AST and its own torch import, not the ComfyUI plugin
entrypoint. This catches missing production imports without requiring ComfyUI,
a GPU, H3 weights, or selflift-Avatar. The scheduler and GraphBuilder are stubs;
these tests do not validate real sampling, decoding, UI, or peak memory.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

try:
    import torch
except ImportError:
    torch = None

ROOT = Path(__file__).resolve().parents[1]
UPSCALER = "minimax_h3_latent_upscaler_3d_fp16.safetensors"


def load_helpers(filename, names, *, constants=(), namespace=None):
    path = ROOT / filename
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    body = []
    found = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            aliases = [a for a in node.names if a.name in {"math", "hashlib", "json", "torch"}]
            if aliases:
                body.append(ast.Import(names=aliases))
        elif isinstance(node, ast.ImportFrom) and node.module in {"__future__", "typing"}:
            body.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in constants for target in node.targets
        ):
            body.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in names:
            body.append(node)
            found.add(node.name)
    missing = set(names) - found
    if missing:
        raise AssertionError(f"Missing production helpers in {filename}: {sorted(missing)}")
    scope = {"__name__": f"_isolated_{path.stem}", **(namespace or {})}
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    exec(compile(module, str(path), "exec"), scope)
    return scope


class RecordingGraph:
    def __init__(self):
        self.calls = []

    def node(self, class_type, node_id, **inputs):
        self.calls.append((class_type, node_id, inputs))
        return SimpleNamespace(out=lambda index: [node_id, index])


@unittest.skipIf(torch is None, "PyTorch is required for SelfLift CPU regression tests")
class SelfLiftRuntimeTests(unittest.TestCase):
    def setUp(self):
        core = load_helpers(
            "director_core.py",
            {"make_second_pass_config", "require_second_pass_config"},
            constants={"SECOND_PASS_CONFIG_TYPE", "SECOND_PASS_CONFIG_VERSION"},
        )
        self.make_config = core["make_second_pass_config"]
        self.base_sigmas = torch.tensor([1.0, 0.95, 0.82, 0.65, 0.45, 0.25, 0.0])
        self.euler = object()
        self.samplers = SimpleNamespace(
            calculate_sigmas=Mock(return_value=self.base_sigmas),
            sampler_object=Mock(return_value=self.euler),
        )
        self.model = Mock()
        self.helpers = load_helpers(
            "director_node.py",
            {"_second_pass_signature", "_refine_sigmas", "_prepare_second_pass_runtime", "_resolve_sigmas"},
            namespace={
                "comfy": SimpleNamespace(samplers=self.samplers),
                "require_second_pass_config": core["require_second_pass_config"],
            },
        )
        self.prepare = self.helpers["_prepare_second_pass_runtime"]
        self.refine = self.helpers["_refine_sigmas"]
        self.sample = load_helpers("director_h3.py", {"_sample_segment"})["_sample_segment"]

    def config(self, **overrides):
        return self.make_config(**{"upscaler_model": UPSCALER, **overrides})

    def runtime(self, second):
        return {
            "model": self.model,
            "vae": object(),
            "sampler": object(),
            "sigmas": self.base_sigmas,
            "params": {"second_pass": second},
        }

    def test_default_preset_builds_seven_step_schedule(self):
        # torch must come from the production module, never injected by the test.
        self.assertIs(self.helpers.get("torch"), torch)
        result = self.prepare(self.config(), self.model)
        self.assertEqual(result["sigmas"].numel() - 1, 7)
        self.assertEqual(result["transition_step"], 5)
        self.assertEqual(result["sigmas"].numel() - 1 - result["transition_step"], 2)
        self.assertLess(float(result["sigmas"][5]), 1.0)
        self.assertIs(result["sampler"], self.euler)
        self.samplers.sampler_object.assert_called_once_with("euler")
        self.samplers.calculate_sigmas.assert_called_once_with(
            self.model.get_model_object.return_value, "simple", 6
        )

    def test_no_second_pass_has_no_scheduler_work(self):
        self.assertIsNone(self.prepare(None, self.model))
        self.samplers.calculate_sigmas.assert_not_called()
        self.samplers.sampler_object.assert_not_called()

    def test_refine_spacing_preserves_prefix_and_tensor_contract(self):
        for dtype in (torch.float32, torch.float64):
            for spacing in ("cosine", "linear", "exponential"):
                with self.subTest(dtype=dtype, spacing=spacing):
                    source = self.base_sigmas.to(dtype)
                    before = source.clone()
                    result = self.refine(source, extra_steps=1, start_at_sigma=0.7,
                                         end_at_sigma=0.0, spacing=spacing)
                    self.assertEqual(result.numel(), source.numel() + 1)
                    self.assertEqual(result.dtype, source.dtype)
                    self.assertEqual(result.device, source.device)
                    self.assertTrue(torch.equal(result[:3], source[:3]))
                    self.assertTrue(torch.equal(source, before))
                    self.assertTrue(bool(torch.isfinite(result).all()))
                    self.assertTrue(bool((result[1:] <= result[:-1]).all()))
                    self.assertAlmostEqual(float(result[-1]), 0.0, places=6)

    def test_zero_extra_steps_is_noop(self):
        result = self.refine(self.base_sigmas, extra_steps=0, start_at_sigma=0.7,
                             end_at_sigma=0.0, spacing="cosine")
        self.assertIs(result, self.base_sigmas)

    def test_start_below_schedule_is_noop(self):
        result = self.refine(self.base_sigmas, extra_steps=1, start_at_sigma=0.0,
                             end_at_sigma=0.0, spacing="cosine")
        self.assertIs(result, self.base_sigmas)

    def test_positive_end_restores_terminal_zero(self):
        result = self.refine(self.base_sigmas, extra_steps=1, start_at_sigma=0.7,
                             end_at_sigma=0.1, spacing="linear")
        self.assertAlmostEqual(float(result[-2]), 0.1, places=6)
        self.assertEqual(float(result[-1]), 0.0)
        self.assertEqual(result.numel(), self.base_sigmas.numel() + 2)

    def test_refinement_can_be_disabled(self):
        result = self.prepare(self.config(sigma_refine_enabled=False), self.model)
        self.assertTrue(torch.equal(result["sigmas"], self.base_sigmas))

    def test_invalid_transition_rejected(self):
        with self.assertRaisesRegex(ValueError, "transition_step"):
            self.prepare(self.config(transition_step=7), self.model)

    def test_high_sigma_boundary_rejected(self):
        self.samplers.calculate_sigmas.return_value = torch.tensor([1., 1., 1., 1., 1., 1., 0.])
        with self.assertRaisesRegex(ValueError, "Sigma"):
            self.prepare(self.config(transition_step=1), self.model)

    def test_missing_upscaler_rejected_for_default_rho(self):
        with self.assertRaisesRegex(ValueError, "upscaler"):
            self.prepare(self.config(upscaler_model="none"), self.model)

    def test_preparation_does_not_mutate_config(self):
        packet = self.config()
        before = dict(packet)
        result = self.prepare(packet, self.model)
        self.assertEqual(packet, before)
        self.assertNotIn("sigmas", packet)
        self.assertNotIn("sampler", packet)
        self.assertNotIn("cache_signature", packet)
        self.assertIsNot(result, packet)

    def test_signatures_stable_and_sensitive_to_settings(self):
        first = self.prepare(self.config(), self.model)["cache_signature"]
        second = self.prepare(self.config(), self.model)["cache_signature"]
        self.assertEqual(first, second)
        for changes in ({"rho": 0.2}, {"lowres_scale": 0.75}, {"sigma_refine_enabled": False},
                        {"highres_tiling": True}, {"tiling_tiles": 4}):
            with self.subTest(changes=changes):
                changed = self.prepare(self.config(**changes), self.model)["cache_signature"]
                self.assertNotEqual(first, changed)

    def test_current_graph_forwards_config_and_guide(self):
        second = self.prepare(self.config(), self.model)
        runtime = self.runtime(second)
        graph = RecordingGraph()
        positive, latent = ["overlap_guide", 0], ["conditioning", 1]
        result = self.sample(graph, runtime, positive, latent, "segment_1", 1000)
        self.assertEqual([call[0] for call in graph.calls],
                         ["ConditioningZeroOut", "TerryDirectorSelfLiftSampler"])
        call = graph.calls[-1]
        inputs = call[2]
        self.assertEqual(result, [call[1], 0])
        self.assertIs(inputs["model"], self.model)
        self.assertNotIn("high_res_model", inputs)
        self.assertNotIn("low_res_model", inputs)
        self.assertNotIn("model_hires", inputs)
        self.assertIs(inputs["positive"], positive)
        self.assertIs(inputs["latent_image"], latent)
        self.assertIs(inputs["sampler"], self.euler)
        self.assertIs(inputs["sigmas"], second["sigmas"])
        self.assertIs(inputs["vae"], runtime["vae"])
        self.assertEqual(inputs["seed"], 1000)
        self.assertEqual(inputs["negative"], ["segment_1_selflift_negative", 0])
        for key in ("cfg", "transition_step", "lowres_scale", "rho", "w_min", "w_max",
                    "upscaler_model", "highres_tiling", "tiling_mode", "tiling_tiles", "tiling_axis"):
            self.assertEqual(inputs[key], second[key])

    def test_current_graph_forwards_optional_high_model(self):
        high_model = object()
        second = self.prepare(self.config(high_res_model=high_model), self.model)
        graph = RecordingGraph()
        self.sample(graph, self.runtime(second), object(), object(), "segment_2", 1001)
        self.assertIs(graph.calls[-1][2]["high_res_model"], high_model)

    def test_disabled_graph_uses_native_sampler(self):
        runtime = self.runtime({"method": "none"})
        graph = RecordingGraph()
        self.sample(graph, runtime, object(), object(), "segment_1", 1000)
        self.assertEqual([call[0] for call in graph.calls],
                         ["RandomNoise", "BasicGuider", "SamplerCustomAdvanced"])
        self.assertIs(graph.calls[-1][2]["sampler"], runtime["sampler"])
        self.assertIs(graph.calls[-1][2]["sigmas"], runtime["sigmas"])

    def test_parameter_validation(self):
        for changes in ({"lowres_scale": 0.1}, {"rho": -0.1}, {"w_min": 0.9, "w_max": 0.1},
                        {"sampling_denoise": 0}, {"tiling_tiles": 3}, {"transition_step": 0}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.config(**changes)


if __name__ == "__main__":
    unittest.main()
