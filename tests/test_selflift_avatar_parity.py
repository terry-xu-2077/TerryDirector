"""Optional differential tests against a local selflift-Avatar checkout.

Run in ComfyUI's Python environment; the sibling checkout is a test reference,
never a TerryDirector runtime dependency. Real native Euler, AV scaling and
mask wrappers are used with a deterministic state-dependent denoiser.
"""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT.parent / "selflift-Avatar/tests/test_avatar.py"


class AvatarParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("TD_SELFLIFT_AVATAR_PARITY") != "1":
            raise unittest.SkipTest("run this file directly to enable the external reference check")
        if not REFERENCE.is_file():
            raise unittest.SkipTest("optional local selflift-Avatar reference absent")
        spec = importlib.util.spec_from_file_location("td_avatar_reference", REFERENCE)
        cls.ref = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.ref)
        global torch
        import torch
        package = types.ModuleType("td_avatar_parity")
        package.__path__ = [str(ROOT / "nodes")]
        sys.modules[package.__name__] = package
        from importlib import import_module
        cls.stages = import_module(package.__name__ + ".director_selflift_stages")
        cls.upscaler = import_module(package.__name__ + ".director_selflift_upscaler")
        cls.cache = import_module(package.__name__ + ".director_latent_checkpoint")
        cls.math = import_module(package.__name__ + ".director_selflift_math")
        cls.tiling = import_module(package.__name__ + ".director_selflift_tiling")
        torch.set_num_threads(2)

    def sample(self, model, noise, positive, negative, cfg, device, sampler, sigmas,
               options, latent_image, callback, disable_pbar, seed):
        r = self.ref
        self.inputs.append(([x.clone() for x in latent_image.unbind()], sigmas.clone()))
        raw, shapes = r.comfy.utils.pack_latents(latent_image.unbind())
        eps, _ = r.comfy.utils.pack_latents(noise.unbind())
        owner = self
        class Denoiser:
            def __init__(self):
                self.inner_model = model.model
                self.model_patcher = model
                self.cfg = cfg
            def __call__(self, x, sigma, **kwargs):
                # A constant x0 would hide transition errors at final sigma zero.
                return x * .23 + torch.sin(x) * .07 + .125
        def outer(noise, latent_image, stage_sampler, schedule, denoise_mask=None,
                  callback=None, disable_pbar=False, seed=None, latent_shapes=None):
            inner = model.model
            inner.latent_shapes = latent_shapes
            def report(i, x0, x, total):
                owner.states.append((x0.clone(), x.clone()))
                callback(i, r.NestedTensor(r.comfy.utils.unpack_latents(x0, latent_shapes)),
                         r.NestedTensor(r.comfy.utils.unpack_latents(x, latent_shapes)), total)
            result = stage_sampler.sample(Denoiser(), schedule,
                {'model_options': options, 'seed': seed}, report, noise,
                latent_image=inner.process_latent_in(latent_image),
                denoise_mask=denoise_mask, disable_pbar=True)
            return inner.process_latent_out(result)
        ext = r.comfy.patcher_extension
        wrappers = ext.get_all_wrappers(ext.WrappersMP.OUTER_SAMPLE, options, is_model_options=True)
        result = ext.WrapperExecutor.new_class_executor(
            outer, types.SimpleNamespace(model_patcher=model), wrappers).execute(
                eps, raw, sampler, sigmas, None, callback, True, seed, latent_shapes=shapes)
        return r.NestedTensor(r.comfy.utils.unpack_latents(result, shapes))

    def test_native_euler_intermediates_and_final_av_match_including_disk_resume(self):
        r = self.ref
        torch.manual_seed(17)
        source = {'samples': r.NestedTensor([torch.randint(-8,9,(2,24,3,1,1)).float().expand(2,24,3,8,12).clone(), torch.randn(2,32,2,7)]),
                  'batch_index': [3,7], 'tag': 'preserved'}
        schedules = [torch.tensor([1., .88, .61, .34, .12, 0.]),
                     torch.tensor([1., .72, .31, 0.])]
        def lift(x, target, name):
            return torch.nn.functional.interpolate(x, size=(x.shape[2], *target), mode='trilinear', align_corners=False)
        def paired(x, vae, size, mode, lifter, need_lat, need_pix):
            return lift(x,size,None), None
        for sigmas in schedules:
            for k in (1, len(sigmas)-2):
                for mask_kind in ('none', 'soft', 'keep_audio'):
                    with self.subTest(schedule=len(sigmas), low=k, mask=mask_kind):
                        latent = dict(source)
                        if mask_kind != 'none':
                            v,a = source['samples'].unbind()
                            mv = (torch.randint(0,5,v[:,:,:,:1,:1].shape).float()/4).expand_as(v).clone() if mask_kind == 'soft' else torch.ones_like(v)
                            mv[:,:,:1] = 0
                            ma = torch.rand_like(a) if mask_kind == 'soft' else torch.zeros_like(a)
                            latent['noise_mask'] = r.NestedTensor([mv,ma])
                        # Different high-model audio shift exercises cached LOW scaling.
                        low, high = r.Patcher(), r.Patcher()
                        low.model.model_sampling.noise_scale = 1.17
                        high.model.model_sampling.set_parameters(shift=2., audio_shift=1.3)
                        self.inputs, self.states = [], []
                        sampler = r.comfy.samplers.sampler_object('euler')
                        with patch.object(r.comfy.samplers, 'sample', side_effect=self.sample), \
                             patch.object(r.nodes.latent_preview, 'prepare_callback', return_value=lambda *a: None), \
                             patch.object(r.nodes, 'log_memory'), \
                             patch.object(r.nodes.selflift, 'paired_lifts', side_effect=paired):
                            expected = r.nodes.progressive_sample(low, [], [], None, latent, sampler,
                                sigmas, 42, 1., k, .5, 0., 1., 1., 'nearest', high_res_model=high)
                            expected_inputs, expected_states = self.inputs, self.states
                            for disk in (False, True):
                                self.inputs, self.states = [], []
                                low_latent = {**latent, 'samples':r.NestedTensor([
                                    self.math.spatial_resize(latent['samples'].unbind()[0], (4,6)), source['samples'].unbind()[1]])}
                                if 'noise_mask' in latent:
                                    low_latent['noise_mask'] = r.NestedTensor([
                                        self.math.spatial_resize(latent['noise_mask'].unbind()[0],(4,6),framewise=True),
                                        latent['noise_mask'].unbind()[1]])
                                result = self.stages.sample_lowres(model=low,positive=[],negative=[],latent_image=low_latent,
                                    sampler=sampler,sigmas=sigmas,low_steps=k,seed=42,cfg=1.)
                                if disk:
                                    with tempfile.TemporaryDirectory() as directory, \
                                         patch.object(sys.modules['folder_paths'],'get_output_directory',return_value=directory):
                                        cid = self.cache.save_checkpoint(result, 'parity')
                                        result = self.cache.load_checkpoint(cid)['latent']
                                result = self.stages.sample_highres(latent=result,model=high,positive=[],negative=[],
                                    sampler=sampler,high_steps=len(sigmas)-1-k,seed=42,cfg=1.,
                                    width=192,height=128,upscaler_model='test.safetensors',_lifter=lift)
                                self.assertEqual(len(self.inputs), len(expected_inputs))
                                self.assertEqual(len(self.states), len(expected_states))
                                for actual_stage, wanted_stage in zip(self.inputs, expected_inputs):
                                    torch.testing.assert_close(actual_stage[1],wanted_stage[1],rtol=0,atol=0)
                                    for a,b in zip(actual_stage[0],wanted_stage[0]):
                                        torch.testing.assert_close(a,b,rtol=0,atol=0)
                                for actual_state, wanted_state in zip(self.states,expected_states):
                                    for a,b in zip(actual_state,wanted_state):
                                        torch.testing.assert_close(a,b,rtol=0,atol=0)
                                for a,b in zip(result['samples'].unbind(),expected['samples'].unbind()):
                                    torch.testing.assert_close(a,b,rtol=0,atol=0)
                                self.assertEqual(result['tag'],'preserved')

    def test_upscaler_same_weights_short_long_and_batch(self):
        torch.manual_seed(24)
        for attention in (False, True):
            reference = self.ref.h3_upscaler.LatentResizer3D(in_channels=24,in_blocks=1,out_blocks=1,
                channels=32,dropout=0.,attn=attention,temporal_every=1,temporal_kernel=5).eval()
            own = self.upscaler.H3LatentUpscaler(reference.state_dict()).eval()
            own.load_state_dict(reference.state_dict(),strict=True)
            for frames in (1,32,33,67):
                for batch in (1,2):
                    with self.subTest(attention=attention,frames=frames,batch=batch), torch.no_grad():
                        x = torch.randn(batch,24,frames,2,2)
                        expected = reference(x,scale=2.,target_size=(frames,4,4))
                        actual = own(x,(4,4))
                        torch.testing.assert_close(actual,expected,rtol=0,atol=0)

    def test_guides_and_legacy_spatial_payload_match_with_references(self):
        torch.manual_seed(31)
        video, audio = torch.randn(1,24,3,8,12), torch.randn(1,32,2,7)
        guides = [{"resolved_frame_index": 0, "latent": torch.randn(1,24,2,8,12)}]
        refs = [{"kind":"image", "latent_h":6, "latent_w":10, "latent":torch.randn(1,24,1,6,10)}]
        cond = [[torch.zeros(1,2,4), {"minimax_keyframes":guides, "minimax_refs":refs}]]
        expected = self.ref.nodes._resize_keyframes(cond,4,6)
        actual = self.math.resize_guides(cond,(4,6))
        torch.testing.assert_close(actual[0][1]['minimax_keyframes'][0]['latent'],
                                   expected[0][1]['minimax_keyframes'][0]['latent'],rtol=0,atol=0)
        payload = {'keyframes':guides,'refs':refs,'cond_video_latents':[g['latent'] for g in guides+refs]}
        context = torch.zeros(1,2,4)
        expected = self.ref.h3_tiling._tile_payload(payload,context,video,audio,4,0,8)
        actual = self.tiling.crop_payload(payload,context,video,audio,4,0,8)
        for x,y in zip(actual['cond_video_latents'],expected['cond_video_latents']):
            torch.testing.assert_close(x,y,rtol=0,atol=0)
        torch.testing.assert_close(actual['layout'].position_ids,expected['layout'].position_ids,rtol=0,atol=0)
        for length in (12,33,104):
            for count in (2,4,6,8):
                self.assertEqual(self.tiling.tile_regions(length,count),self.ref.h3_tiling._regions(length,count))

    def test_current_avatar_spatial_anchor_and_content_cuts_match(self):
        torch.manual_seed(37)
        v = torch.randn(1,24,3,12,36)
        scores = self.tiling.spatial_scores(v)
        expected_scores = self.ref.h3_tiling.content_scores(v)
        for axis,name in ((3,'H'),(4,'W')):
            torch.testing.assert_close(scores[axis],expected_scores[name],rtol=0,atol=0)
            for count in (2,4,6,8):
                self.assertEqual(self.tiling.tile_regions(v.shape[axis],count,overlap=6,scores=scores[axis]),
                    self.ref.h3_tiling._content_aware_regions(v.shape[axis],count,overlap=6,scores=expected_scores[name]))
                # Normal scale=.5 has shorter content curves: preserve upstream fallback.
                self.assertEqual(self.tiling.tile_regions(v.shape[axis]*2,count,overlap=6,scores=scores[axis]),
                    self.ref.h3_tiling._content_aware_regions(v.shape[axis]*2,count,overlap=6,scores=expected_scores[name]))
        original = [[torch.zeros(1,2,4), {'minimax_refs':[]}]]
        actual = self.tiling.append_spatial_reference(original,v)
        expected = self.ref.nodes.spatial_anchor_utils.append_global_video_reference(original,v)
        self.assertEqual(actual[0][1]['minimax_refs'][0],expected[0][1]['minimax_refs'][0])
        self.assertEqual(original[0][1]['minimax_refs'],[])

    def test_spatial_stitch_matches_avatar_on_cpu_and_cuda(self):
        for device in ('cpu','cuda') if torch.cuda.is_available() else ('cpu',):
            with self.subTest(device=device):
                v = torch.randn(1,24,3,18,32,device=device)
                a = torch.randn(1,32,2,7,device=device)
                context = torch.zeros(1,2,4,device=device)
                def predict(streams,*args,**kwargs):
                    return [torch.sin(streams[0]) + streams[0] * .37, streams[1] * .61]
                expected = self.ref.h3_tiling._tiled_forward(predict,[v,a],torch.ones(1,device=device),
                    context,{},plan={'axis':4,'tiles':4,'overlap':6})
                regions = self.tiling.tile_regions(32,4,overlap=6)
                actual = self.tiling._forward(predict,[v,a],torch.ones(1,device=device),
                    context,{},plan={'axis':4,'regions':regions})
                for x,y in zip(actual,expected):
                    torch.testing.assert_close(x,y,rtol=0,atol=0)

    def test_euler_ratio_precision_matches_avatar_bfloat16(self):
        x = torch.randn(2,24,3,4,4).bfloat16()
        z = torch.randn_like(x)
        a,b = torch.tensor(.731),torch.tensor(.429)
        torch.testing.assert_close(self.math.advance_euler(x,z,a,b),self.ref.nodes._euler_step(x,z,a,b),rtol=0,atol=0)


if __name__ == '__main__':
    os.environ['TD_SELFLIFT_AVATAR_PARITY'] = '1'
    unittest.main()

