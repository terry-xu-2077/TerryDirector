"""CPU regression tests. No external custom nodes, H3 weights or GPU required.

Run: python -m unittest discover -s tests -p 'test_selflift_internal.py' -v
The denoiser, ComfyUI host and VAE are synthetic; real generation is not tested.
"""
from __future__ import annotations
import ast
import importlib
import inspect
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

import torch
from torch import nn
from torch.nn import functional as F

ROOT = Path(__file__).resolve().parents[1]
PKG = "_terrydirector_selflift_test"
package = types.ModuleType(PKG)
package.__path__ = [str(ROOT)]
sys.modules[PKG] = package
maths = importlib.import_module(PKG + ".director_selflift_math")
engine = importlib.import_module(PKG + ".director_selflift")
up = importlib.import_module(PKG + ".director_selflift_upscaler")
til ing = importlib.import_module(PKG + ".director_selflift_tiling")


class AV:
    is_nested = True
    def __init__(self, streams): self.streams = list(streams)
    def unbind(self): return tuple(self.streams)
    def to(self, *args, **kwargs): return AV([x.to(*args, **kwargs) for x in self.streams])


class Format:
    latent_channels = 2
    scale_factor = 2.0
    shift_factor = 1.0
    def process_in(self, value): return value * 2 + 1
    def process_out(self, value): return (value - 1) / 2


class Flow:
    def noise_scaling(self, sigma, noise, latent):
        return sigma * noise + (1 - sigma) * latent
    def inverse_noise_scaling(self, sigma, value):
        return value / (1 - sigma)


class Model:
    def __init__(self, clean=0.8):
        self.load_device = torch.device("cpu")
        self.model_options = {}
        self.format, self.flow = Format(), Flow()
        self.model = self
        self.clean = clean
    def get_model_object(self, name):
        return {"latent_format": self.format, "model_sampling": self.flow}[name]
    def process_latent_in(self, packed):
        video, audio = packed.unbind()
        return AV([self.format.process_in(video), audio * 3 - 2])
    def process_latent_out(self, packed):
        video, audio = packed.unbind()
        return AV([self.format.process_out(video), (audio + 2) / 3])


class Backend:
    """Toy implementation of ComfyUI's signal/noise scaling boundary."""
    def __init__(self):
        self.device, self.dtype = torch.device("cpu"), torch.float32
        self.calls, self.preview_calls, self.noise_seeds, self.tile_calls = [], [], [], []
        self.interrupt_calls, self.interrupt_at = 0, None
    def split(self, value): return list(value.unbind())
    def pack(self, streams): return AV(streams)
    def fix(self, model, latent): return latent["samples"]
    def validate(self, model, high_model, sampler): pass
    def interrupt(self):
        self.interrupt_calls += 1
        if self.interrupt_calls == self.interrupt_at:
            raise InterruptedError("test interruption")
    def mask_model(self, model, anchors, masks): return model
    def tiled_model(self, model, shapes, mode, tiles, axis):
        self.tile_calls.append((model, shapes, mode, tiles, axis))
        return model
    def preview(self, model, steps):
        return lambda step, clean, state, total: self.preview_calls.append((step, total, self.split(clean)[0].shape))
    def noise(self, latent, seed, batch_index):
        self.noise_seeds.append(seed)
        def tensor(value):
            return torch.randn(value.shape, generator=torch.Generator().manual_seed(seed), dtype=value.dtype)
        return AV([tensor(s) for s in self.split(latent)]) if isinstance(latent, AV) else tensor(latent)
    @staticmethod
    def denoise(model, streams, sigma):
        # Audio depends on its running state; reinitializing it cannot pass tests.
        return [0.2 * streams[0] + model.clean + float(sigma) * 0.02,
                0.3 * streams[1] + model.clean * 0.1 + float(sigma) * 0.04]
    def sample(self, model, noise, positive, negative, cfg, sampler, sigmas, latent, callback, seed):
        normalized = self.split(model.process_latent_in(latent))
        streams = [model.flow.noise_scaling(sigmas[0], n, x) for n, x in zip(self.split(noise), normalized)]
        initial = [x.clone() for x in streams]
        self.calls.append(dict(model=model, sigmas=sigmas.clone(), positive=positive, latent=latent,
                               initial=initial, noise=noise))
        for step in range(len(sigmas) - 1):
            clean = self.denoise(model, streams, sigmas[step])
            callback(step, AV(clean), AV(streams), len(sigmas) - 1)
            # Independent Euler expression, not the production advance_euler().
            ratio = sigmas[step + 1] / sigmas[step]
            streams = [ratio * x + (1 - ratio) * z for x, z in zip(streams, clean)]
        return model.process_latent_out(AV(streams))


class VAE:
    device, vae_dtype = torch.device("cpu"), torch.float32
    def __init__(self): self.decoded = []; self.encoded = []
    def decode(self, value):
        self.decoded.append(value.shape)
        return value[0].permute(1, 2, 3, 0)
    def encode(self, frames):
        self.encoded.append(frames.shape)
        return frames.permute(3, 0, 1, 2).unsqueeze(0)


class MathTests(unittest.TestCase):
    def test_schedule_validates_boundaries(self):
        sigmas = torch.tensor([1., .8, .5, .2, 0.])
        for k in (1, 2, 3): maths.validate_schedule(sigmas, k)
        for k in (0, 4, 1.5, True):
            with self.subTest(k=k), self.assertRaises(ValueError): maths.validate_schedule(sigmas, k)
    def test_bad_schedules_rejected(self):
        values = [[1., 0.], [1., .1, .2, 0.], [1., 0., 0.], [1., float('nan'), 0.],
                  [1., float('inf'), 0.], [1., -.1, 0.], [1., 1., 0.]]
        for values in values:
            with self.subTest(values=values), self.assertRaises(ValueError):
                maths.validate_schedule(torch.tensor(values), 1)
        for value in (torch.ones(2, 2), torch.tensor([1, 1, 0]), [1., .5, 0.]):
            with self.assertRaises(ValueError): maths.validate_schedule(value, 1)
    def test_nonfinite_options_rejected(self):
        for value in (float('nan'), float('inf')):
            with self.assertRaises(ValueError): maths.validate_options(1, .5, value, .5, 1)
    def test_patch_grid_resolution(self):
        self.assertEqual(maths.low_resolution(48, 84, .5), (24, 42))
        self.assertEqual(maths.low_resolution(7, 11, .5), (4, 6))
    def test_resize_never_mixes_time(self):
        value = torch.stack([torch.full((1, 2, 3, 5), float(i)) for i in range(4)], dim=2)
        result = maths.spatial_resize(value, (6, 10))
        self.assertEqual(result.shape, (1, 2, 4, 6, 10))
        for i in range(4): self.assertTrue(torch.allclose(result[:, :, i], torch.full_like(result[:, :, i], float(i))))
    def test_guides_are_copied_but_references_are_not_resized(self):
        latent = torch.randn(1, 2, 3, 8, 12)
        refs = [{"latent": torch.randn(1, 2, 1, 7, 9)}]
        original = [(torch.zeros(1), {"minimax_keyframes": [{"latent": latent, "frame_idx": 5}], "minimax_refs": refs})]
        result = maths.resize_guides(original, (4, 6))
        self.assertEqual(result[0][1]["minimax_keyframes"][0]["latent"].shape, (1, 2, 3, 4, 6))
        self.assertIs(result[0][1]["minimax_refs"], refs)
        self.assertIs(original[0][1]["minimax_keyframes"][0]["latent"], latent)
        self.assertTrue(torch.allclose(latent.mean((-2, -1)), result[0][1]["minimax_keyframes"][0]["latent"].mean((-2, -1)), atol=1e-6))
    def test_euler_boundary_formula(self):
        value, clean = torch.tensor([4., 6.]), torch.tensor([2., 2.])
        self.assertTrue(torch.equal(maths.advance_euler(value, clean, .5, .25), torch.tensor([3., 4.])))
    def test_quantile_correction(self):
        direct = torch.zeros(1, 2, 1, 1, 4)
        anchor = torch.tensor([0., 1., 2., 3.]).reshape(1, 1, 1, 1, 4).expand_as(direct)
        result = maths.correct_endpoint(direct, anchor, .5, .5, 1.)
        self.assertTrue(torch.equal(result[0, 0].flatten(), torch.tensor([0., 0., 1., 3.])))
    def test_correction_branches_skip_unused_endpoints(self):
        direct, anchor = torch.randn(1, 2, 1, 4, 4), torch.randn(1, 2, 1, 4, 4)
        self.assertIs(maths.correct_endpoint(direct, None, 0, .5, 1), direct)
        self.assertIs(maths.correct_endpoint(None, anchor, 1, 1, 1), anchor)
    def test_masked_empty_batch_is_finite(self):
        direct, anchor = torch.zeros(2, 2, 1, 1, 4), torch.ones(2, 2, 1, 1, 4)
        mask = torch.ones_like(direct); mask[0] = 0
        result = maths.correct_endpoint(direct, anchor, .5, .5, 1, mask)
        self.assertTrue(torch.isfinite(result).all())
        self.assertTrue(torch.equal(result[0], direct[0]))
        self.assertTrue(torch.equal(result[1], torch.full_like(result[1], .5)))
    def test_video_and_audio_masks_remain_separate(self):
        streams = [torch.zeros(1, 2, 3, 8, 12), torch.zeros(1, 2, 1, 9)]
        masks = AV([torch.ones(1, 1, 1, 8, 12), torch.zeros(1, 1, 1, 9)])
        result = maths.normalize_masks(masks, streams)
        self.assertEqual([x.shape for x in result], [x.shape for x in streams])
        self.assertTrue((result[0] == 1).all()); self.assertTrue((result[1] == 0).all())
    def test_bad_masks_rejected(self):
        streams = [torch.zeros(1, 2, 3, 8, 12), torch.zeros(1, 2, 1, 9)]
        for mask in (torch.full((1, 8, 12), float('nan')), torch.full((1, 8, 12), -1.), AV([torch.ones(1)])):
            with self.assertRaises(ValueError): maths.normalize_masks(mask, streams)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.backend, self.model, self.vae = Backend(), Model(), VAE()
        self.video = torch.randn((1, 2, 3, 8, 12), generator=torch.Generator().manual_seed(1))
        self.audio = torch.randn((1, 2, 1, 9), generator=torch.Generator().manual_seed(2))
        self.latent = {"samples": AV([self.video, self.audio]), "batch_index": [0], "metadata": "keep"}
        self.positive = [(torch.zeros(1), {"minimax_keyframes": [{"latent": self.video.clone(), "frame_idx": 0}]})]
        self.lifter = Mock(side_effect=lambda v, hw, name: maths.spatial_resize(v, hw, mode="nearest"))
        self.options = dict(model=self.model, positive=self.positive, negative=[], vae=self.vae,
                            latent_image=self.latent, sampler=object(), sigmas=torch.tensor([1., .9, .8, .65, .4, .2, .1, 0.]),
                            seed=1000, cfg=1., transition_step=5, lowres_scale=.5,
                            rho=0., w_min=.5, w_max=1., upscaler_model="h3.safetensors", _backend=self.backend, _lifter=self.lifter)
    def run_sample(self, **changes): return engine.sample_selflift(**{**self.options, **changes})
    def test_two_stages_and_original_nfe(self):
        result = self.run_sample()
        self.assertEqual(len(self.backend.calls), 2)
        self.assertEqual([len(c["sigmas"]) - 1 for c in self.backend.calls], [5, 2])
        self.assertEqual([s.shape for s in result["samples"].unbind()], [self.video.shape, self.audio.shape])
        self.assertEqual(result["metadata"], "keep")
        self.assertEqual(self.backend.noise_seeds, [1000, 1001])
        self.assertEqual([v[0] for v in self.backend.preview_calls], list(range(7)))
    def test_audio_is_unbroken_euler_trajectory(self):
        result = self.run_sample()
        state = self.backend.calls[0]["initial"][1]
        sigmas = self.options["sigmas"]
        for a, b in zip(sigmas[:-1], sigmas[1:]):
            clean = .3 * state + self.model.clean * .1 + float(a) * .04
            state = (b / a) * state + (1 - b / a) * clean
        expected = (state + 2) / 3  # external audio latent format
        torch.testing.assert_close(result["samples"].unbind()[1], expected)
    def test_high_input_has_no_fresh_noise(self):
        self.run_sample()
        self.assertTrue(all(bool((s == 0).all()) for s in self.backend.calls[1]["noise"].unbind()))
    def test_no_pixel_vae_roundtrip_in_default_route(self):
        self.run_sample()
        self.assertEqual(self.vae.decoded, [])
        self.assertEqual(self.vae.encoded, [])
        self.lifter.assert_called_once()
    def test_pixel_only_route(self):
        result = self.run_sample(rho=1., w_min=1., upscaler_model="none")
        self.assertEqual(len(self.vae.decoded), 1)
        self.lifter.assert_not_called()
        self.assertEqual(result["samples"].unbind()[0].shape, self.video.shape)
    def test_hybrid_correction(self):
        result = self.run_sample(rho=.5)
        self.lifter.assert_called_once()
        self.assertEqual(len(self.vae.decoded), 1)
        self.assertTrue(all(torch.isfinite(s).all() for s in result["samples"].unbind()))
    def test_source_tensors_and_guides_unchanged(self):
        before_video, before_audio = self.video.clone(), self.audio.clone()
        result = self.run_sample()
        torch.testing.assert_close(self.video, before_video); torch.testing.assert_close(self.audio, before_audio)
        self.assertIs(self.backend.calls[1]["positive"], self.positive)
        self.assertEqual(self.backend.calls[0]["positive"][0][1]["minimax_keyframes"][0]["latent"].shape[-2:], (4, 6))
        self.assertEqual(self.positive[0][1]["minimax_keyframes"][0]["latent"].shape[-2:], (8, 12))
        self.assertIsNot(result, self.latent)
    def test_optional_high_model(self):
        high = Model(clean=1.3)
        self.run_sample(high_res_model=high)
        self.assertIs(self.backend.calls[0]["model"], self.model)
        self.assertIs(self.backend.calls[1]["model"], high)
    def test_seed_wraparound(self):
        self.run_sample(seed=(1 << 64) - 1)
        self.assertEqual(self.backend.noise_seeds[-1], 0)
    def test_invalid_config_fails_before_sampling(self):
        for params in ({"transition_step": 7}, {"rho": float('nan')}, {"seed": -1}, {"upscaler_model": "none"}):
            with self.subTest(params=params), self.assertRaises(ValueError): self.run_sample(**params)
        self.assertEqual(self.backend.calls, [])
    def test_interrupt_between_stages_does_not_start_high(self):
        self.backend.interrupt_at = 2
        with self.assertRaises(InterruptedError): self.run_sample()
        self.assertEqual(len(self.backend.calls), 1)
        self.lifter.assert_not_called()
    def test_lifter_exception_propagates(self):
        self.lifter.side_effect = RuntimeError("lifter failed")
        with self.assertRaisesRegex(RuntimeError, "lifter failed"): self.run_sample()
        self.assertEqual(len(self.backend.calls), 1)
    def test_lifter_wrong_temporal_length_rejected(self):
        self.lifter.side_effect = lambda v, hw, name: maths.spatial_resize(v[:, :, :1], hw)
        with self.assertRaisesRegex(ValueError, "时长"): self.run_sample()
    def test_audio_preservation_mask(self):
        self.latent["noise_mask"] = AV([torch.ones_like(self.video), torch.zeros_like(self.audio)])
        result = self.run_sample()
        torch.testing.assert_close(result["samples"].unbind()[1], self.audio, rtol=0, atol=0)
    def test_tiling_only_uses_high_stage(self):
        self.run_sample(highres_tiling=True, tiling_mode="manual", tiling_tiles=4, tiling_axis="width")
        self.assertEqual(len(self.backend.tile_calls), 1)
        self.assertEqual(self.backend.tile_calls[0][2:], ("manual", 4, "width"))
    def test_tiling_mask_restriction(self):
        self.latent["noise_mask"] = AV([torch.zeros_like(self.video), torch.zeros_like(self.audio)])
        with self.assertRaisesRegex(ValueError, "mask"): self.run_sample(highres_tiling=True)
        self.assertEqual(self.backend.calls, [])
    def test_pixel_anchor_keeps_batch_members_separate(self):
        value = torch.cat([torch.zeros_like(self.video), torch.ones_like(self.video)], dim=0)
        result = engine._pixel_endpoint(value, self.vae, (16, 24), lambda: None)
        self.assertEqual(result.shape, (2, 2, 3, 16, 24))
        self.assertTrue((result[0] == 0).all()); self.assertTrue(torch.allclose(result[1], torch.ones_like(result[1])))
    def test_missing_callbacks_are_not_silently_accepted(self):
        self.backend.sample = Mock(return_value=self.latent["samples"])
        with self.assertRaisesRegex(RuntimeError, "实际 0"): self.run_sample()
    def test_preview_dimensions_are_target_grid(self):
        self.run_sample()
        self.assertTrue(all(v[2] == self.video.shape for v in self.backend.preview_calls))


    def test_high_video_signal_is_not_scaled_twice(self):
        self.run_sample()
        state = self.backend.calls[0]["initial"][0]
        schedule = self.options["sigmas"]
        for index in range(self.options["transition_step"]):
            a, b = schedule[index:index + 2]
            clean = .2 * state + self.model.clean + float(a) * .02
            state = (b / a) * state + (1 - b / a) * clean
        raw_low = (clean - 1) / 2
        raw_high = maths.spatial_resize(raw_low, (8, 12), mode="nearest")
        normalized_high = raw_high * 2 + 1
        noise = torch.randn(normalized_high.shape, generator=torch.Generator().manual_seed(1001))
        sigma = schedule[5]
        expected = (1 - sigma) * normalized_high + sigma * noise
        torch.testing.assert_close(self.backend.calls[1]["initial"][0], expected)


def small_checkpoint():
    """Synthetic checkpoint with the public layer-key layout; NOT H3 weights."""
    state = {}
    generator = torch.Generator().manual_seed(7)
    def add(prefix, module):
        for key, value in module.state_dict().items():
            state[prefix + key] = torch.randn(value.shape, generator=generator) * .02
    add("conv_in.", nn.Conv3d(24, 32, 3, padding=1))
    add("conv_out.", nn.Conv3d(32, 24, 3, padding=1))
    add("norm_out.", nn.GroupNorm(32, 32))
    add("embed.", nn.Sequential(nn.Linear(1, 64), nn.SiLU(), nn.Linear(64, 64)))
    for section in ("in_blocks.", "out_blocks."):
        prefix = section + "0."
        add(prefix + "in_layers.", nn.Sequential(nn.GroupNorm(32, 32), nn.SiLU(), nn.Conv3d(32, 32, 3, padding=1)))
        add(prefix + "emb_layers.", nn.Sequential(nn.SiLU(), nn.Linear(64, 64)))
        add(prefix + "out_norm.", nn.GroupNorm(32, 32))
        add(prefix + "out_layers.", nn.Sequential(nn.SiLU(), nn.Identity(), nn.Conv3d(32, 32, 3, padding=1)))
        add(section + "1.norm.", nn.GroupNorm(32, 32))
        add(section + "1.dwconv.", nn.Conv3d(32, 32, (5, 1, 1), padding=(2, 0, 0), groups=32))
        add(section + "1.pwconv.", nn.Conv3d(32, 32, 1))
    return state


class UpscalerTests(unittest.TestCase):
    def setUp(self):
        self.state = small_checkpoint()
        self.network = up.H3LatentUpscaler(self.state).eval()
        self.network.load_state_dict(self.state, strict=True)
    def test_strict_checkpoint_layout(self):
        self.assertEqual(set(self.network.state_dict()), set(self.state))
        self.assertEqual(self.network.halo, 5)
        self.assertEqual(self.network.conv_in.in_channels, 24)
    def test_inference_shape(self):
        with torch.inference_mode():
            result = self.network(torch.zeros(1, 24, 2, 2, 2), (4, 4))
        self.assertEqual(result.shape, (1, 24, 2, 4, 4))
        self.assertTrue(torch.isfinite(result).all())
    def test_identity_skips_network(self):
        value = torch.zeros(1, 24, 2, 2, 2)
        self.assertIs(self.network(value, (2, 2)), value)
    def test_temporal_chunks_cover_every_frame(self):
        value = torch.arange(70.).reshape(1, 1, 70, 1, 1).expand(1, 24, 70, 2, 2)
        calls = []
        def window(x, target, scale):
            calls.append(x.shape[2]); return maths.spatial_resize(x, target, mode="nearest")
        self.network._window = window
        result = self.network(value, (4, 4))
        torch.testing.assert_close(result, maths.spatial_resize(value, (4, 4), mode="nearest"))
        self.assertEqual(len(calls), 3)
        self.assertLessEqual(max(calls), 52)
    def test_interrupt_in_temporal_window(self):
        self.network._window = lambda x, target, scale: maths.spatial_resize(x, target, mode="nearest")
        with self.assertRaises(InterruptedError):
            self.network(torch.zeros(1, 24, 40, 2, 2), (4, 4), interrupt=Mock(side_effect=InterruptedError))
    def test_missing_or_unknown_layout_rejected(self):
        bad = dict(self.state); bad["in_blocks.8.q.weight"] = torch.ones(32, 32, 1, 1, 1)
        with self.assertRaises(ValueError): up.H3LatentUpscaler(bad)
    def test_checkpoint_prefix_and_cpu_dtype(self):
        raw = {"model": {"upscaler." + k: v.half() for k, v in self.state.items()}}
        restored = up._state_dict(raw, torch.device("cpu"))
        self.assertEqual(set(restored), set(self.state))
        self.assertTrue(all(v.dtype == torch.float32 for v in restored.values()))


class TileTests(unittest.TestCase):
    def test_region_alignment_and_coverage(self):
        for length in (2, 7, 8, 31, 48, 84):
            for count in (2, 4, 6, 8):
                with self.subTest(length=length, count=count):
                    regions = tiling.tile_regions(length, count)
                    coverage = torch.zeros(length)
                    for index, (start, end) in enumerate(regions):
                        self.assertEqual(start % 2, 0)
                        self.assertTrue(end == length or end % 2 == 0)
                        coverage[start:end] += tiling.tile_weights(regions, index)
                    self.assertTrue((coverage > 0).all())
    def test_feathering_reconstructs_identity(self):
        value = torch.randn(1, 2, 3, 4, 37)
        result, weights = torch.zeros_like(value), torch.zeros(37)
        regions = tiling.tile_regions(37, 4)
        for index, (a, b) in enumerate(regions):
            weight = tiling.tile_weights(regions, index)
            result[..., a:b] += value[..., a:b] * weight
            weights[a:b] += weight
        torch.testing.assert_close(result / weights, value)
    def test_expired_model_references_are_skipped(self):
        mm = types.ModuleType("comfy.model_management")
        mm.loaded_models = lambda: [None, types.SimpleNamespace(model=None), types.SimpleNamespace(model=None)]
        mm.get_total_memory = lambda device: 1000
        mm.get_free_memory = lambda device: 600
        mm.MIN_WEIGHT_MEMORY_RATIO = .4
        mm.minimum_inference_memory = lambda: 50
        model = types.SimpleNamespace(load_device="cpu", model_size=lambda: 300)
        comfy = types.ModuleType("comfy"); comfy.model_management = mm
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": mm}):
            self.assertEqual(tiling._workspace(model), 310)
    def test_runtime_sources_have_no_external_dependency(self):
        for path in ROOT.glob("director_selflift*.py"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("SelfLiftAvatarH3Sampler", text)
            self.assertNotIn("NODE_CLASS_MAPPINGS", text)
            self.assertNotIn("sys.path", text)
            ast.parse(text)



class NativeBoundaryTests(unittest.TestCase):
    def test_model_folder_registered_without_reference_plugin(self):
        import ntpath
        import os
        import posixpath

        # The native case follows the host OS. Explicit POSIX/Windows cases
        # also catch separator regressions when the suite runs on Linux only.
        cases = [
            ("native", os.path, os.path.join(os.path.sep, "comfy", "models"),
             os.path.join(os.path.sep, "comfy", "models", "latent_upscale_models")),
            ("posix", posixpath, "/comfy/models", "/comfy/models/latent_upscale_models"),
            ("windows_report", ntpath, "/comfy/models", r"/comfy/models\latent_upscale_models"),
            ("windows_drive", ntpath, r"G:\AIGC\ComfyUI\models",
             r"G:\AIGC\ComfyUI\models\latent_upscale_models"),
            ("windows_unicode", ntpath, r"C:\工作流\Comfy UI\models",
             r"C:\工作流\Comfy UI\models\latent_upscale_models"),
            ("windows_unc", ntpath, r"\\server\share\ComfyUI\models",
             r"\\server\share\ComfyUI\models\latent_upscale_models"),
        ]
        for name, path_module, models_dir, expected in cases:
            with self.subTest(path_case=name):
                folders = types.ModuleType("folder_paths")
                folders.folder_names_and_paths = {}
                folders.models_dir = models_dir

                def register(folder, path):
                    folders.folder_names_and_paths[folder] = path

                folders.add_model_folder_path = Mock(side_effect=register)
                folders.get_filename_list = lambda folder: ["b.safetensors", "a.safetensors", "b.safetensors"]
                # Replace only this module's os reference, not process-global
                # os.path or os.name; no real filesystem or plugin is needed.
                with patch.dict(sys.modules, {"folder_paths": folders}), \
                        patch.object(up, "os", types.SimpleNamespace(path=path_module)):
                    self.assertEqual(up.list_models(), ["a.safetensors", "b.safetensors"])
                    self.assertEqual(up.list_models(), ["a.safetensors", "b.safetensors"])
                folders.add_model_folder_path.assert_called_once_with("latent_upscale_models", expected)
                self.assertEqual(folders.folder_names_and_paths, {"latent_upscale_models": expected})

    def test_owned_upscaler_unload_does_not_touch_other_models(self):
        owned, other = object(), object()
        first = types.SimpleNamespace(model=owned, model_unload=Mock())
        second = types.SimpleNamespace(model=other, model_unload=Mock())
        mm = types.ModuleType("comfy.model_management")
        mm.current_loaded_models = [second, None, first]
        comfy = types.ModuleType("comfy"); comfy.model_management = mm
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": mm}):
            up._offload_owned(owned)
        first.model_unload.assert_called_once(); second.model_unload.assert_not_called()
        self.assertEqual(mm.current_loaded_models, [second, None])
        pending = Mock()
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": mm}):
            up._offload_owned(pending)
        pending.detach.assert_called_once()
        second.model_unload.assert_not_called()

    def test_internal_schema_and_call(self):
        def input_type(name, **kwargs): return types.SimpleNamespace(name=name, **kwargs)
        def output_type(*args, **kwargs): return types.SimpleNamespace(**kwargs)
        io = types.SimpleNamespace(ComfyNode=object, Schema=lambda **kw: types.SimpleNamespace(**kw),
                                   NodeOutput=lambda *args: args)
        for name in ("Model", "Conditioning", "Vae", "Latent", "Sampler", "Sigmas", "Int", "Float", "String", "Boolean", "Combo"):
            setattr(io, name, types.SimpleNamespace(Input=input_type, Output=output_type))
        latest = types.ModuleType("comfy_api.latest"); latest.io = io
        api = types.ModuleType("comfy_api"); api.latest = latest
        with patch.dict(sys.modules, {"comfy_api": api, "comfy_api.latest": latest}):
            module = importlib.import_module(PKG + ".director_selflift_node")
            schema = module.TerryDirectorSelfLiftSampler.define_schema()
            self.assertTrue(schema.is_dev_only)
            self.assertEqual(schema.node_id, "TerryDirectorSelfLiftSampler")
            names = [x.name for x in schema.inputs]
            signature = inspect.signature(module.TerryDirectorSelfLiftSampler.execute)
            self.assertEqual(set(names), set(signature.parameters))
            required = {name: object() for name, param in signature.parameters.items() if param.default is inspect.Parameter.empty}
            with patch.object(module, "sample_selflift", return_value={"samples": "ok"}) as sampling:
                result = module.TerryDirectorSelfLiftSampler.execute(**required)
                self.assertEqual(result, ({"samples": "ok"},))
                self.assertEqual(sampling.call_count, 1)
                self.assertTrue(set(required).issubset(sampling.call_args.kwargs))

    def test_mask_cannot_expand_latent_batch(self):
        with self.assertRaises(ValueError):
            maths.normalize_masks(torch.ones(2, 8, 12), [torch.zeros(1, 2, 3, 8, 12), torch.zeros(1, 2, 1, 9)])


if __name__ == "__main__":
    torch.set_num_threads(2)
    unittest.main()
