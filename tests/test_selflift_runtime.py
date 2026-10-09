"""CPU checks for the internal SelfLift engine, without ComfyUI or external plugins.

Real tensor math and the local upscaler evaluator are exercised. Native H3
sampling/model loading are synthetic substitutes, not GPU or quality validation.
"""
from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import torch
import torch.nn as nn
import torch.nn.functional as F

 torch.set_num_threads(1)
ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "_terry_selflift_test"
package = ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = package


def module(name):
    full = f"{PACKAGE}.{name}"
    spec = importlib.util.spec_from_file_location(full, ROOT / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    sys.modules[full] = result
    spec.loader.exec_module(result)
    return result


engine = module("director_selflift")
lift = module("director_lift_model")
til ing = module("director_selflift_tiling")


class Nested:
    is_nested = True
    def __init__(self, streams):
        self.streams = list(streams)
    def unbind(self):
        return tuple(self.streams)
    def to(self, *args, **kwargs):
        return Nested([s.to(*args, **kwargs) for s in self.streams])


class Flow:
    def noise_scaling(self, sigma, noise, latent):
        return (1 - sigma) * latent + sigma * noise
    def inverse_noise_scaling(self, sigma, latent):
        return latent / (1 - sigma)


class Format:
    def process_in(self, value):
        return (value - 0.2) * 1.5
    def process_out(self, value):
        return value / 1.5 + 0.2


class Model:
    def __init__(self, device="cpu"):
        self.load_device = device
        self.model_options = {}
        self.format = Format()
        self.flow = Flow()
        self.model = self
        self.wrappers = {}
    def get_model_object(self, name):
        return {"model_sampling": self.flow, "latent_format": self.format}[name]
    def process_latent_out(self, values):
        parts = engine.unpack(values)
        return Nested([self.format.process_out(parts[0]), *parts[1:]])
    def process_latent_in(self, values):
        parts = engine.unpack(values)
        return Nested([self.format.process_in(parts[0]), *parts[1:]])
    def clone(self):
        other = Model(self.load_device)
        other.model_options = dict(self.model_options)
        other.wrappers = dict(self.wrappers)
        return other
    def add_wrapper_with_key(self, kind, key, callback):
        self.wrappers[(kind, key)] = callback


def euler_marker(*args, **kwargs):
    return None


class Sampler:
    def __init__(self, fn=euler_marker, options=None, inpaint=None):
        self.sampler_function = fn
        self.extra_options = options or {}
        self.inpaint_options = inpaint or {}


class NativeHarness:
    def __init__(self):
        self.calls = []
        self.noise_seeds = []
        self.previews = []
        self.drop_callback = False
        self.mm = SimpleNamespace(intermediate_device=lambda: "cpu", intermediate_dtype=lambda: torch.float32)
        self.const, self.euler, self.nested = Flow, euler_marker, Nested
        self.wrappers = SimpleNamespace(OUTER_SAMPLE="outer")
        self.sample = SimpleNamespace(fix_empty_latent_channels=lambda model, samples, *args: samples,
                                      prepare_noise=self.noise)
        self.sampling = SimpleNamespace(sample=self.sample_native, KSAMPLER=Sampler)
        self.utils = SimpleNamespace(PROGRESS_BAR_ENABLED=True,
            pack_latents=lambda values: (torch.cat([v.reshape(v.shape[0], 1, -1) for v in values], -1), None))
        self.preview = SimpleNamespace(prepare_callback=lambda model, total: self.preview_call)
    def noise(self, latent, seed, batch_index=None):
        self.noise_seeds.append(seed)
        rng = torch.Generator().manual_seed(seed)
        parts = [torch.randn(v.shape, generator=rng, dtype=v.dtype) for v in engine.unpack(latent)]
        return Nested(parts) if getattr(latent, "is_nested", False) else parts[0]
    def preview_call(self, index, clean, state, total):
        self.previews.append((index, tuple(engine.unpack(clean)[0].shape), total))
    def sample_native(self, model, noise, positive, negative, cfg, device, sampler, sigmas,
                      model_options, *, latent_image, callback, disable_pbar, seed):
        values = engine.unpack(model.process_latent_in(latent_image))
        states = [model.flow.noise_scaling(sigmas[0], e, z)
                  for e, z in zip(engine.unpack(noise), values)]
        record = {"model": model, "device": device, "sigmas": sigmas.clone(), "positive": positive,
                  "initial": [s.clone() for s in states], "boundaries": [], "noise": engine.unpack(noise)}
        self.calls.append(record)
        for index, (sigma, next_sigma) in enumerate(zip(sigmas[:-1], sigmas[1:])):
            clean = [torch.full_like(s, 0.3 + stream * 0.4 + index * 0.02) for stream, s in enumerate(states)]
            record["boundaries"].append(([s.clone() for s in states], [c.clone() for c in clean]))
            if not self.drop_callback:
                callback(index, Nested(clean), Nested(states), sigmas.numel() - 1)
            # In-place update intentionally tests ownership of the captured boundary.
            for state, target in zip(states, clean):
                state.copy_(engine.euler_advance(state, target, sigma, next_sigma))
        return model.process_latent_out(Nested(states))


class MathTests(unittest.TestCase):
    def test_resize_does_not_mix_time_or_batch(self):
        data = torch.arange(6.).view(2, 1, 3, 1, 1).expand(2, 4, 3, 4, 6)
        result = engine.spatial_resize(data, (8, 12))
        torch.testing.assert_close(result[..., 0, 0], data[..., 0, 0])
    def test_euler_matches_rectified_flow_interpolation(self):
        z, noise = torch.randn(2, 3), torch.randn(2, 3)
        first, second = 0.7, 0.2
        result = engine.euler_advance((1 - first) * z + first * noise, z, first, second)
        torch.testing.assert_close(result, (1 - second) * z + second * noise)
    def test_correction_zero_skips_anchor(self):
        direct = torch.ones(1, 4, 2, 2, 2)
        self.assertIs(engine.correct_lift(direct, None, 0, 0.5, 1), direct)
    def test_pure_anchor_skips_direct(self):
        anchor = torch.ones(1, 4, 2, 2, 2)
        self.assertIs(engine.correct_lift(None, anchor, 1, 1, 1), anchor)
    def test_correction_selects_highest_disagreement(self):
        direct = torch.zeros(1, 1, 1, 1, 4)
        anchor = torch.tensor([1., 2., 3., 4.]).reshape_as(direct)
        result = engine.correct_lift(direct, anchor, 0.5, 0.5, 1)
        torch.testing.assert_close(result.flatten(), torch.tensor([0., 0., 1.5, 4.]))
    def test_correction_batch_and_mask_are_independent(self):
        direct = torch.zeros(2, 2, 1, 1, 4)
        anchor = torch.arange(1., 5.).view(1, 1, 1, 1, 4).expand_as(direct)
        mask = torch.ones(2, 1, 1, 1, 4)
        mask[0] = 0
        result = engine.correct_lift(direct, anchor, 0.5, 0.5, 1, mask)
        self.assertTrue(bool(torch.isfinite(result).all()))
        self.assertEqual(float(result[0].sum()), 0)
        self.assertGreater(float(result[1].sum()), 0)
    def test_schedule_rejects_invalid_values(self):
        for values, split in (([1., .5, 0.], 2), ([1., 0., 0.], 1), ([1., 1., 0.], 1),
                              ([1., .2, .4, 0.], 1), ([1., float("nan"), 0.], 1)):
            with self.subTest(values=values), self.assertRaises(ValueError):
                engine.validate_schedule(torch.tensor(values), split)
    def test_valid_schedule(self):
        engine.validate_schedule(torch.tensor([1., .8, .4, .2, 0.]), 3)
    def test_keyframes_keep_metadata_and_mean(self):
        latent = torch.randn(1, 4, 3, 8, 10)
        refs = [{"kind": "image", "latent": latent}]
        source = [[torch.ones(1), {"minimax_keyframes": [{"latent": latent, "frame_idx": 0}], "minimax_refs": refs}]]
        before = latent.clone()
        result = engine.condition_at_resolution(source, (4, 6))
        changed = result[0][1]["minimax_keyframes"][0]["latent"]
        torch.testing.assert_close(changed.mean((-2, -1)), before.mean((-2, -1)), atol=1e-6, rtol=1e-6)
        torch.testing.assert_close(latent, before)
        self.assertIs(result[0][1]["minimax_refs"], refs)
        self.assertEqual(source[0][1]["minimax_keyframes"][0]["latent"].shape, before.shape)
    def test_audio_only_keyframe(self):
        source = [[None, {"minimax_keyframes": [{"audio_latent": torch.ones(1, 2, 2, 10)}]}]]
        self.assertNotIn("latent", engine.condition_at_resolution(source, (4, 4))[0][1]["minimax_keyframes"][0])


class SamplingTests(unittest.TestCase):
    def setUp(self):
        self.native = NativeHarness()
        self.native_patch = patch.object(engine, "_native", return_value=self.native)
        self.native_patch.start()
        self.addCleanup(self.native_patch.stop)
        self.model = Model()
        self.video = torch.randn(1, 4, 3, 8, 12)
        self.audio = torch.randn(1, 2, 2, 17)
        self.args = dict(model=self.model, positive=[[None, {}]], negative=[[None, {}]],
                         vae=Mock(), latent_image={"samples": Nested([self.video, self.audio]), "tag": "keep"},
                         sampler=Sampler(), sigmas=torch.tensor([1., .85, .65, .4, .2, 0.]), seed=1000,
                         cfg=1., transition_step=3, lowres_scale=.5, rho=0., w_min=.5, w_max=1.,
                         upscaler_model="synthetic.safetensors")
        self.lifter_patch = patch.object(lift, "lift_video", side_effect=lambda x, size, _: engine.spatial_resize(x, size))
        self.lifter = self.lifter_patch.start()
        self.addCleanup(self.lifter_patch.stop)
    def run_sample(self, **changes):
        return engine.sample_h3(**{**self.args, **changes})
    def test_two_stages_use_exact_nfe_and_original_target(self):
        result = self.run_sample()
        self.assertEqual([len(c["boundaries"]) for c in self.native.calls], [3, 2])
        self.assertEqual(engine.unpack(result["samples"])[0].shape, self.video.shape)
        self.assertEqual(engine.unpack(result["samples"])[1].shape, self.audio.shape)
        self.assertEqual(result["tag"], "keep")
        self.assertEqual(self.native.calls[0]["initial"][0].shape[-2:], (4, 6))
    def test_audio_continues_boundary_without_new_noise(self):
        self.run_sample()
        first, second = self.native.calls
        state, clean = first["boundaries"][-1]
        expected = engine.euler_advance(state[1], clean[1], self.args["sigmas"][2], self.args["sigmas"][3])
        torch.testing.assert_close(second["initial"][1], expected)
        self.assertEqual(float(second["noise"][1].abs().sum()), 0.)
        self.assertEqual(self.native.noise_seeds, [1000, 1001])
    def test_video_resume_matches_clean_lift_and_transition_sigma(self):
        self.run_sample()
        low, high = self.native.calls
        clean = low["boundaries"][-1][1][0]
        target = engine.spatial_resize(clean, self.video.shape[-2:])
        rng = torch.Generator().manual_seed(1001)
        noise = torch.randn(target.shape, generator=rng)
        sigma = self.args["sigmas"][3]
        torch.testing.assert_close(high["initial"][0], (1 - sigma) * target + sigma * noise)
    def test_default_path_never_decodes_pixel_anchor(self):
        self.run_sample()
        self.args["vae"].decode.assert_not_called()
        self.args["vae"].encode.assert_not_called()
        self.lifter.assert_called_once()
    def test_progress_is_monotonic_and_target_sized(self):
        self.run_sample()
        self.assertEqual([x[0] for x in self.native.previews], list(range(5)))
        self.assertTrue(all(x[1] == tuple(self.video.shape) for x in self.native.previews))
    def test_optional_high_model_and_load_device(self):
        high = Model("synthetic-device")
        self.run_sample(high_res_model=high)
        self.assertIs(self.native.calls[1]["model"], high)
        self.assertEqual(self.native.calls[1]["device"], "synthetic-device")
        self.assertEqual(self.model.wrappers, {})
    def test_seed_wraps_without_overflow(self):
        self.run_sample(seed=(1 << 64) - 1)
        self.assertEqual(self.native.noise_seeds, [(1 << 64) - 1, 0])
    def test_reference_keyframes_resize_only_for_low_stage(self):
        positive = [[None, {"minimax_keyframes": [{"latent": self.video}]}]]
        self.run_sample(positive=positive)
        self.assertEqual(self.native.calls[0]["positive"][0][1]["minimax_keyframes"][0]["latent"].shape[-2:], (4, 6))
        self.assertIs(self.native.calls[1]["positive"], positive)
    def test_non_euler_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Euler"):
            self.run_sample(sampler=Sampler(lambda: None))
    def test_missing_callbacks_are_rejected(self):
        self.native.drop_callback = True
        with self.assertRaisesRegex(RuntimeError, "回调"):
            self.run_sample()
    def test_input_latent_is_not_mutated(self):
        original_video, original_audio = self.video.clone(), self.audio.clone()
        self.run_sample()
        torch.testing.assert_close(self.video, original_video)
        torch.testing.assert_close(self.audio, original_audio)
    def test_original_kept_audio_restored_exactly(self):
        inputs = {**self.args["latent_image"], "noise_mask": Nested([torch.ones(1,1,1,1,1), torch.zeros(17)])}
        result = self.run_sample(latent_image=inputs)
        torch.testing.assert_close(engine.unpack(result["samples"])[1], self.audio, rtol=0, atol=0)
    def test_unsupported_tiling_masks_rejected_before_sampling(self):
        inputs = {**self.args["latent_image"], "noise_mask": torch.zeros(1, 8, 12)}
        with self.assertRaisesRegex(ValueError, "高清分块"):
            self.run_sample(latent_image=inputs, highres_tiling=True)
        self.assertEqual(self.native.calls, [])


class MaskTests(unittest.TestCase):
    def setUp(self):
        self.streams = [torch.zeros(1, 4, 3, 8, 12), torch.zeros(1, 2, 2, 17)]
    def test_video_mask_does_not_mask_audio(self):
        masks = engine.normalize_masks(torch.zeros(1, 8, 12), self.streams)
        self.assertEqual(float(masks[0].sum()), 0)
        self.assertTrue(bool((masks[1] == 1).all()))
    def test_nested_and_packed_masks_match(self):
        nested = Nested([torch.zeros_like(self.streams[0]), torch.ones_like(self.streams[1])])
        packed = torch.cat([x.flatten(1).unsqueeze(1) for x in nested.unbind()], -1)
        a, b = engine.normalize_masks(nested, self.streams), engine.normalize_masks(packed, self.streams)
        for left, right in zip(a, b):
            torch.testing.assert_close(left, right)
    def test_nonuniform_audio_image_mask_is_rejected(self):
        masks = Nested([torch.ones(1,1,1,1,1), torch.rand(1, 1, 8, 12)])
        with self.assertRaisesRegex(ValueError, "音频遮罩"):
            engine.normalize_masks(masks, self.streams)
    def test_constant_audio_image_mask_broadcasts(self):
        masks = Nested([torch.ones(1,1,1,1,1), torch.zeros(1,1,8,12)])
        actual = engine.normalize_masks(masks, self.streams)
        self.assertEqual(actual[1].shape, (1,1,1,1))
    def test_nan_masks_rejected(self):
        with self.assertRaises(ValueError):
            engine.normalize_masks(torch.full((1,8,12), float("nan")), self.streams)
    def test_anchor_wrapper_uses_clean_anchor_not_resume(self):
        harness = NativeHarness()
        model = Model()
        masks = [torch.ones(1,1,1,1,1), torch.zeros(1,1,1,1)]
        patched = engine._with_static_masks(harness, model, self.streams, masks, True)
        self.assertIsNot(patched, model)
        callback = patched.wrappers[("outer", "terry_selflift_mask")]
        captured = {}
        def executor(noise, latent, sampler, sigmas, **kwargs):
            captured.update(sampler=sampler, **kwargs)
        callback(executor, None, None, Sampler(), torch.tensor([.4,0.]))
        self.assertEqual(captured["denoise_mask"].shape[-1], sum(s[0].numel() for s in self.streams))
        identity = SimpleNamespace(process_latent_in=lambda value: value + 3)
        k = SimpleNamespace(inner_model=SimpleNamespace(inner_model=identity))
        x = captured["denoise_mask"]
        captured["sampler"].sampler_function(k, x, torch.tensor([.4,0.]))
        torch.testing.assert_close(k.latent_image, torch.full_like(x, 3))
        self.assertEqual(model.wrappers, {})


class TinyResidual(nn.Module):
    def __init__(self):
        super().__init__()
        self.in_layers = nn.Sequential(nn.GroupNorm(32,32), nn.SiLU(), nn.Conv3d(32,32,3,padding=1))
        self.emb_layers = nn.Sequential(nn.SiLU(), nn.Linear(8,64))
        self.out_norm = nn.GroupNorm(32,32)
        self.out_layers = nn.Sequential(nn.SiLU(), nn.Dropout(.1), nn.Conv3d(32,32,3,padding=1))
    def forward(self, value, embedding):
        h = self.in_layers(value)
        scale, shift = self.emb_layers(embedding).chunk(2,1)
        h = self.out_norm(h) * (1 + scale[...,None,None,None]) + shift[...,None,None,None]
        return value + self.out_layers(h)


class TinyNetwork(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_in = nn.Conv3d(4,32,3,padding=1)
        self.embed = nn.Sequential(nn.Linear(1,8),nn.SiLU(),nn.Linear(8,8))
        self.in_blocks = nn.ModuleList([TinyResidual()])
        self.out_blocks = nn.ModuleList([TinyResidual()])
        self.norm_out = nn.GroupNorm(32,32)
        self.conv_out = nn.Conv3d(32,4,3,padding=1)
    def forward(self, value, size):
        scale = sum(a / b for a,b in zip(size,value.shape[-2:])) / 2
        emb = self.embed(value.new_full((value.shape[0],1),scale-1))
        h = self.in_blocks[0](self.conv_in(value),emb)
        h = F.interpolate(h,size=(value.shape[2],*size),mode="trilinear",align_corners=False)
        h = self.out_blocks[0](h,emb)
        return self.conv_out(F.silu(self.norm_out(h)))


class LiftModelTests(unittest.TestCase):
    def test_checkpoint_functional_evaluator_matches_module_equations(self):
        torch.manual_seed(10)
        network = TinyNetwork().eval()
        local = lift.H3LiftWeights(network.state_dict()).eval()
        value = torch.randn(2,4,3,4,6)
        with torch.no_grad():
            expected, actual = network(value,(8,12)), local(value,(8,12))
        torch.testing.assert_close(actual,expected,rtol=1e-5,atol=1e-5)
    def test_identity_skips_network(self):
        network = lift.H3LiftWeights(TinyNetwork().state_dict()).eval()
        value = torch.randn(1,4,3,4,6)
        self.assertIs(network(value,(4,6)), value)
    def test_long_clip_preserves_temporal_length(self):
        network = lift.H3LiftWeights(TinyNetwork().state_dict()).eval()
        result = network(torch.randn(1,4,35,2,2),(4,4))
        self.assertEqual(result.shape,(1,4,35,4,4))
        self.assertTrue(bool(torch.isfinite(result).all()))
    def test_unknown_checkpoint_keys_fail_closed(self):
        state = TinyNetwork().state_dict()
        state["unrecognized.weight"] = torch.ones(1)
        with self.assertRaisesRegex(ValueError,"未使用"):
            lift.H3LiftWeights(state)
    def test_missing_layer_weights_are_rejected(self):
        state = TinyNetwork().state_dict()
        del state["in_blocks.0.out_norm.bias"]
        with self.assertRaises(ValueError):
            lift.H3LiftWeights(state)


class TilingTests(unittest.TestCase):
    def test_all_pixels_covered_and_blending_preserves_constants(self):
        for length in (1,3,8,16,25,64):
            for count in range(1,9):
                with self.subTest(length=length,count=count):
                    regions = tiling.strips(length,count)
                    weights = torch.zeros(length)
                    value = torch.zeros(length)
                    for index,(a,b) in enumerate(regions):
                        self.assertEqual(a % 2,0)
                        window = tiling.blend_window(regions,index)
                        weights[a:b] += window
                        value[a:b] += 7 * window
                    self.assertTrue(bool((weights > 0).all()))
                    torch.testing.assert_close(value / weights, torch.full((length,),7.))
    def test_small_target_limits_tile_count(self):
        self.assertEqual(tiling.strips(4,8), [(0,4)])



class GraphAndConfigTests(unittest.TestCase):
    def helper(self, filename, names, scope=None):
        source = ast.parse((ROOT / filename).read_text(encoding="utf-8"))
        nodes = [ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)]
        for item in source.body:
            if isinstance(item, ast.Import):
                allowed = [name for name in item.names if name.name in {"torch", "math", "json", "hashlib"}]
                if allowed:
                    nodes.append(ast.Import(names=allowed))
            if isinstance(item, ast.FunctionDef) and item.name in names:
                nodes.append(item)
        namespace = dict(scope or {})
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])), filename, "exec"),namespace)
        return namespace
    def graph(self):
        calls = []
        def node(kind, name, **inputs):
            calls.append((kind,name,inputs))
            return SimpleNamespace(out=lambda index: [name,index])
        return SimpleNamespace(node=node), calls
    def test_enabled_graph_uses_internal_node(self):
        fn = self.helper("director_h3.py", {"_sample_segment"})["_sample_segment"]
        graph,calls = self.graph()
        settings = {"method":"selflift","high_res_model":None}
        runtime = {"model":object(),"vae":object(),"params":{"second_pass":settings}}
        positive,latent = ["guide",0],["conditioning",1]
        fn(graph,runtime,positive,latent,"seg",1000)
        self.assertEqual([c[0] for c in calls],["ConditioningZeroOut","TerryDirectorSelfLiftSampler"])
        self.assertIs(calls[-1][2]["settings"],settings)
        self.assertIs(calls[-1][2]["positive"],positive)
        self.assertIs(calls[-1][2]["latent_image"],latent)
    def test_preview_model_link_remains_top_level(self):
        fn = self.helper("director_h3.py", {"_sample_segment"})["_sample_segment"]
        graph,calls = self.graph()
        model_link = ["preview_override",0]
        runtime = {"model":model_link,"vae":object(),"params":{"second_pass":{"method":"selflift"}}}
        fn(graph,runtime,None,None,"seg",1000)
        self.assertIs(calls[-1][2]["model"],model_link)
        self.assertNotIn("runtime",calls[-1][2])
    def test_disconnected_graph_is_native_baseline(self):
        fn = self.helper("director_h3.py", {"_sample_segment"})["_sample_segment"]
        graph,calls = self.graph()
        runtime = {"model":object(),"sampler":object(),"sigmas":object(),"params":{"second_pass":{"method":"none"}}}
        fn(graph,runtime,None,None,"seg",1000)
        self.assertEqual([c[0] for c in calls],["RandomNoise","BasicGuider","SamplerCustomAdvanced"])
        self.assertIs(calls[-1][2]["sampler"],runtime["sampler"])
    def test_external_lookup_and_aliases_are_gone(self):
        for file in ("director_node.py","director_h3.py","director_selflift_node.py"):
            source = (ROOT/file).read_text(encoding="utf-8")
            self.assertNotIn("SelfLiftAvatarH3Sampler",source)
            self.assertNotIn("sampler_model_inputs",source)
        self.assertIn("TerryDirectorSelfLiftSampler",(ROOT/"__init__.py").read_text())
    def test_config_topology_still_uses_second_pass_input(self):
        source = (ROOT/"director_node.py").read_text(encoding="utf-8")
        self.assertIn('SecondPassConfigData.Input(',source)
        self.assertIn('"second_pass_config"',source)
        self.assertIn('DirectorConfigData.Input("director_config"',source)
        config_class = next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=="TerryDirectorSecondPassConfig")
        self.assertFalse(any(isinstance(n,(ast.Import,ast.ImportFrom)) for n in ast.walk(config_class)))
    def test_refinement_and_engine_cache_signature(self):
        ns = self.helper("director_node.py", {"_refine_sigmas","_second_pass_signature"},
                         {"ENGINE_VERSION":engine.ENGINE_VERSION})
        source = torch.tensor([1.,.95,.82,.65,.45,.25,0.])
        for spacing in ("cosine","linear","exponential"):
            refined = ns["_refine_sigmas"](source,extra_steps=1,start_at_sigma=.7,end_at_sigma=0.,spacing=spacing)
            self.assertEqual(refined.numel()-1,7)
            engine.validate_schedule(refined,5)
        self.assertIs(ns["_refine_sigmas"](source,extra_steps=0,start_at_sigma=.7,end_at_sigma=0.,spacing="cosine"),source)
        runtime={"params":{"second_pass":{"method":"selflift","sigmas":source}}}
        self.assertEqual(ns["_second_pass_signature"](runtime)["engine"],engine.ENGINE_VERSION)
    def test_model_folder_registration_is_self_contained(self):
        folder=ModuleType("folder_paths")
        folder.models_dir="/models"
        folder.folder_names_and_paths={}
        def add(name,path):
            folder.folder_names_and_paths[name]=([path],set())
        folder.add_model_folder_path=add
        folder.get_filename_list=lambda name:["test.safetensors"]
        with patch.dict(sys.modules,{"folder_paths":folder}):
            self.assertEqual(lift.model_names(),["none","test.safetensors"])
            self.assertIn(".safetensors",folder.folder_names_and_paths[lift.FOLDER][1])
            folder.folder_names_and_paths[lift.FOLDER][0].append("/custom")
            lift.register_model_folder()
            self.assertIn("/custom",folder.folder_names_and_paths[lift.FOLDER][0])


class PixelAnchorTests(unittest.TestCase):
    def test_pixel_anchor_keeps_batch_and_time_separate(self):
        class VAE:
            def decode(self,value):
                return value[0,:3].permute(1,2,3,0)
            def encode(self,frames):
                return frames.permute(3,0,1,2)[None]
        value=torch.stack([torch.ones(3,10,4,6),torch.full((3,10,4,6),2.)])
        result=engine.pixel_anchor(value,VAE(),(8,12))
        self.assertEqual(result.shape,(2,3,10,8,12))
        torch.testing.assert_close(result[0],torch.ones_like(result[0]))
        torch.testing.assert_close(result[1],torch.full_like(result[1],2.))
    def test_pixel_anchor_rejects_temporal_mismatch(self):
        vae=Mock()
        vae.decode.return_value=torch.ones(3,4,6,3)
        vae.encode.return_value=torch.ones(1,3,2,8,12)
        with self.assertRaisesRegex(ValueError,"时间/空间"):
            engine.pixel_anchor(torch.ones(1,3,3,4,6),vae,(8,12))


class TinyTemporal(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm=nn.GroupNorm(32,32)
        self.dwconv=nn.Conv3d(32,32,(5,1,1),padding=(2,0,0),groups=32)
        self.pwconv=nn.Conv3d(32,32,1)
    def forward(self,value):
        return value+self.pwconv(self.dwconv(F.silu(self.norm(value))))


class TinyAttention(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm=nn.GroupNorm(32,32)
        self.q,self.k,self.v,self.proj_out=[nn.Conv3d(32,32,1) for _ in range(4)]
    def forward(self,value):
        hidden=self.norm(value)
        q,k,v=[layer(hidden).flatten(2).transpose(1,2).unsqueeze(1) for layer in (self.q,self.k,self.v)]
        attended=F.scaled_dot_product_attention(q,k,v).squeeze(1).transpose(1,2).reshape_as(value)
        return value+self.proj_out(attended)


class ExtraLiftTests(unittest.TestCase):
    def test_temporal_and_attention_block_equations(self):
        fixture=TinyNetwork().eval()
        fixture.in_blocks.extend([TinyTemporal().eval(),TinyAttention().eval()])
        local=lift.H3LiftWeights(fixture.state_dict()).eval()
        value=torch.randn(1,4,3,2,2)
        with torch.no_grad():
            embedding=fixture.embed(torch.ones(1,1))
            hidden=fixture.in_blocks[0](fixture.conv_in(value),embedding)
            for block in fixture.in_blocks[1:]:
                hidden=block(hidden)
            hidden=F.interpolate(hidden,size=(3,4,4),mode="trilinear",align_corners=False)
            hidden=fixture.out_blocks[0](hidden,embedding)
            expected=fixture.conv_out(F.silu(fixture.norm_out(hidden)))
            actual=local(value,(4,4))
        torch.testing.assert_close(actual,expected,atol=1e-5,rtol=1e-5)
    def test_temporal_windows_blend_without_missing_frames(self):
        fixture=TinyNetwork().eval()
        fixture.in_blocks.append(TinyTemporal().eval())
        local=lift.H3LiftWeights(fixture.state_dict()).eval()
        self.assertEqual(local.halo,5)
        local.evaluate_window=lambda value,size,scale: F.interpolate(value,size=(value.shape[2],*size),mode="nearest")
        value=torch.arange(67.).view(1,1,67,1,1).expand(1,4,67,2,2)
        result=local(value,(4,4))
        torch.testing.assert_close(result[...,0,0],value[...,0,0])



class FakeLayout:
    def __init__(self,text_len,latent_t,latent_h,latent_w,audio_t,keyframes=None,refs=None):
        self.signature=(text_len,latent_t,latent_h,latent_w,audio_t)
        pieces=[("text",torch.zeros(text_len,3))]
        def grid(frames):
            axes=torch.meshgrid(torch.arange(frames),torch.arange(latent_h//2),torch.arange(latent_w//2),indexing="ij")
            return torch.stack(axes,-1).reshape(-1,3).float()/torch.tensor([1,latent_h,latent_w])
        for frame in keyframes or ():
            if frame.get("latent") is not None:
                pieces.append(("cond",grid(frame["latent"].shape[2])))
            if frame.get("audio_latent") is not None:
                pieces.append(("cond_audio",torch.full((frame["audio_latent"].shape[-1]*2,3),5.)))
        for ref in refs or ():
            pieces.append(("ref_img",torch.full((4,3),99.)))
        pieces.extend([("audio",torch.full((audio_t*2,3),11.)),("video",grid(latent_t))])
        self.segments=[]
        offset=0
        for name,positions in pieces:
            self.segments.append((offset,offset+len(positions),name))
            offset+=len(positions)
        self.position_ids=torch.cat([positions for _,positions in pieces])


def comfy_stubs():
    names=("comfy","comfy.ldm","comfy.ldm.minimax","comfy.ldm.minimax.model","comfy.ldm.common_dit",
           "comfy.model_base","comfy.patcher_extension","comfy.sampler_helpers","comfy.model_management")
    modules={name:ModuleType(name) for name in names}
    for name,entry in modules.items():
        entry.__path__=[]
        if "." in name:
            parent,child=name.rsplit(".",1)
            setattr(modules[parent],child,entry)
    modules["comfy.ldm.minimax.model"].PackedLayout=FakeLayout
    modules["comfy.ldm.common_dit"].pad_to_patch_size=lambda x,size: F.pad(x,(0,x.shape[-1]%2,0,x.shape[-2]%2))
    modules["comfy.model_base"].MiniMaxH3=Model
    modules["comfy.patcher_extension"].WrappersMP=SimpleNamespace(PREPARE_SAMPLING="prepare",DIFFUSION_MODEL="forward")
    modules["comfy.sampler_helpers"].estimate_memory=lambda model,shape,conds:(100.,50.)
    return modules


class TilingIntegrationTests(unittest.TestCase):
    def test_crop_keeps_global_positions_refs_and_audio_only_guide(self):
        modules=comfy_stubs()
        video,audio=torch.ones(1,4,3,8,16),torch.ones(1,2,2,17)
        context=torch.ones(1,5,4)
        refs=[{"latent":torch.ones(1,4,1,2,2)}]
        payload={"keyframes":[{"latent":video[:,:,:1]},{"audio_latent":audio}],"refs":refs}
        full=FakeLayout(5,3,8,16,17,keyframes=payload["keyframes"],refs=refs)
        payload["layout"]=full
        before=full.position_ids.clone()
        with patch.dict(sys.modules,modules):
            result=tiling.crop_payload(payload,context,video,audio,4,4,12)
        self.assertIs(result["refs"],refs)
        self.assertIs(result["keyframes"][1]["audio_latent"],audio)
        self.assertEqual(result["keyframes"][0]["latent"].shape[-1],8)
        start,end,_=full.segments[-1]
        wanted=full.position_ids[start:end].reshape(3,4,8,3)[:,:,2:6].reshape(-1,3)
        start,end,_=result["layout"].segments[-1]
        torch.testing.assert_close(result["layout"].position_ids[start:end],wanted)
        torch.testing.assert_close(full.position_ids,before)
    def tile_model(self):
        modules=comfy_stubs()
        model=Model()
        model.memory_required=lambda shape:float(shape[-1])
        shapes=[(1,4,3,8,16),(1,2,2,17)]
        patched=tiling.patch_tiling(model,shapes,"manual",4,"width")
        prepare=patched.wrappers[("prepare","terry_selflift_tiles")]
        shape=(1,1,4*3*8*16+2*2*17)
        with patch.object(tiling,"available_workspace",return_value=1000):
            prepare(lambda *args,**kwargs:None,model,shape,{"positive":[]})
        return patched,shapes
    def test_forward_sends_full_audio_to_all_tiles(self):
        modules=comfy_stubs()
        with patch.dict(sys.modules,modules):
            patched,shapes=self.tile_model()
            video,audio=torch.randn(shapes[0]),torch.randn(shapes[1])
            calls=[]
            def executor(streams,*args,**kwargs):
                calls.append(streams[1])
                return [streams[0]*2,torch.full_like(streams[1],len(calls))]
            forward=patched.wrappers[("forward","terry_selflift_tiles")]
            with patch.object(tiling,"crop_payload",return_value={}):
                result=forward(executor,[video,audio],torch.tensor([.2]),None,{})
            self.assertEqual(len(calls),4)
            self.assertTrue(all(item is audio for item in calls))
            torch.testing.assert_close(result[0],video*2)
            torch.testing.assert_close(result[1],torch.ones_like(audio))
    def test_controlnet_rejected_for_actual_split(self):
        modules=comfy_stubs()
        with patch.dict(sys.modules,modules):
            patched,shapes=self.tile_model()
            forward=patched.wrappers[("forward","terry_selflift_tiles")]
            with self.assertRaisesRegex(ValueError,"ControlNet"):
                forward(Mock(),[torch.zeros(shapes[0]),torch.zeros(shapes[1])],None,None,{},control=object())
    def test_expired_loaded_models_do_not_crash_workspace_estimate(self):
        modules=comfy_stubs()
        mm=modules["comfy.model_management"]
        mm.get_free_memory=lambda device:100
        mm.get_total_memory=lambda device:1000
        mm.minimum_inference_memory=lambda:10
        mm.MIN_WEIGHT_MEMORY_RATIO=.4
        live=SimpleNamespace(model=object(),load_device="cpu",loaded_size=lambda:200)
        mm.loaded_models=lambda:[None,SimpleNamespace(model=None),live,live]
        model=Model()
        model.model_size=lambda:50
        with patch.dict(sys.modules,modules):
            self.assertEqual(tiling.available_workspace(model),240)


if __name__ == "__main__":
    unittest.main()
