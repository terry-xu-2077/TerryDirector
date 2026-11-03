"""CPU numerical orchestration checks for separately counted SelfLift stages."""
import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from torch.nn import functional as F

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "td_selflift_stages_testpkg"
pkg = types.ModuleType(PACKAGE)
pkg.__path__ = [str(ROOT / "nodes")]
sys.modules[PACKAGE] = pkg


class Nested:
    is_nested = True
    def __init__(self, values): self.values = values
    def unbind(self): return self.values


class Format:
    scale_factor = 1.0
    def process_in(self, value): return value
    def process_out(self, value): return value


class Flow:
    def noise_scaling(self, sigma, noise, clean): return sigma * noise + (1 - sigma) * clean
    def inverse_noise_scaling(self, sigma, value): return value / (1 - sigma)


class Model:
    def __init__(self): self.model, self.format, self.flow = self, Format(), Flow()
    def get_model_object(self, name): return self.format if name == "latent_format" else self.flow
    def process_latent_out(self, value): return value


class Backend:
    device, dtype = torch.device("cpu"), torch.float32
    def __init__(self): self.calls, self.progress = [], []
    def split(self, value): return list(value.unbind())
    def pack(self, streams): return Nested(list(streams))
    def fix(self, model, latent): return latent["samples"]
    def validate(self, *args): pass
    def interrupt(self): pass
    def mask_model(self, model, *args): return model
    def tiled_model(self, model, *args): return model
    def noise(self, latent, *args):
        return self.pack([torch.zeros_like(x) for x in latent.unbind()]) if getattr(latent,"is_nested",False) else torch.zeros_like(latent)
    def preview(self, model, steps):
        return lambda step, clean, state, total: self.progress.append((step,total))
    def sample(self, model, noise, positive, negative, cfg, sampler, sigmas, latent, callback, seed):
        self.calls.append(sigmas.clone())
        for step in range(sigmas.numel()-1): callback(step, latent, latent, sigmas.numel()-1)
        return latent


class SelfLiftStagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stages = importlib.import_module(PACKAGE + ".director_selflift_stages")
        cls.cache = importlib.import_module(PACKAGE + ".director_latent_checkpoint")

    def setUp(self):
        self.backend, self.model = Backend(), Model()
        self.source = {"samples": Nested([torch.ones(1,4,3,8,8), torch.ones(1,2,4,3)*7]), "batch_index":[0]}
        self.sigmas = torch.tensor([1., .8, .6, .4, .2, 0.])

    def low(self, steps=3):
        return self.stages.sample_lowres(
            model=self.model, positive=[], negative=[], latent_image=self.source,
            sampler=None, sigmas=self.sigmas, low_steps=steps, seed=8, cfg=1.,
            _backend=self.backend)

    def high(self, latent, steps):
        return self.stages.sample_highres(
            latent=latent, model=self.model, positive=[], negative=[], sampler=None,
            high_steps=steps, seed=8, cfg=1., width=128, height=128, upscaler_model="test.safetensors",
            _backend=self.backend, _lifter=lambda value,size,_: F.interpolate(
                value,size=(value.shape[2],*size),mode="trilinear",align_corners=False))

    def test_split_uses_exact_prefix_and_suffix_without_sigma_interpolation(self):
        latent = self.low(3)
        self.assertEqual(tuple(latent["samples"].unbind()[0].shape), (1,4,3,8,8))
        self.assertEqual(len(self.backend.calls),1)
        self.assertTrue(torch.equal(self.backend.calls[0],self.sigmas[:4]))
        self.assertEqual(self.backend.progress,[(0,3),(1,3),(2,3)])
        for steps in (1,5):
            with self.assertRaisesRegex(ValueError, "完整 SIGMAS 剩余"):
                self.high(latent, steps)
        self.backend.calls.clear(); self.backend.progress.clear()
        result = self.high(latent, 2)
        self.assertEqual(len(self.backend.calls), 1)
        self.assertTrue(torch.equal(self.backend.calls[0], self.sigmas[3:]))
        self.assertEqual(self.backend.progress, [(0,2),(1,2)])
        self.assertEqual(tuple(result["samples"].unbind()[0].shape), (1,4,3,8,8))
        self.assertNotIn(self.stages.CONTEXT_KEY, result)
        self.assertEqual(result["batch_index"], [0])

    def test_generic_cache_preserves_stage_payload_without_owning_any_sampling_settings(self):
        latent=self.low()
        old_paths=sys.modules.get("folder_paths")
        old_nested=sys.modules.get("comfy.nested_tensor")
        try:
            with tempfile.TemporaryDirectory() as directory:
                sys.modules["folder_paths"]=types.SimpleNamespace(get_output_directory=lambda: directory)
                sys.modules["comfy.nested_tensor"]=types.SimpleNamespace(NestedTensor=Nested)
                cid=self.cache.save_checkpoint(latent,"可暂停的低清")
                restored=self.cache.load_checkpoint(cid)["latent"]
                # Restored tensors must not keep the disk file locked on Windows.
                (Path(directory)/"TerryDirector/checkpoints"/cid/"state.safetensors").unlink()
                self.assertNotIn("seed",self.cache.read_manifest(cid))
                self.assertNotIn("seed",restored[self.stages.CONTEXT_KEY])
                self.assertEqual(restored[self.stages.CONTEXT_KEY]["transition_step"],3)
                result=self.high(restored,2)
                self.assertEqual(tuple(result["samples"].unbind()[0].shape),(1,4,3,8,8))
        finally:
            for name,old in (("folder_paths",old_paths),("comfy.nested_tensor",old_nested)):
                if old is None: sys.modules.pop(name,None)
                else: sys.modules[name]=old

    def test_high_target_dimensions_change_only_video_and_never_repeat_low(self):
        latent = self.low()
        before = len(self.backend.calls)
        def run(width,height):
            return self.stages.sample_highres(latent=latent,model=self.model,positive=[],negative=[],sampler=None,
                high_steps=2,seed=8,cfg=1.,width=width,height=height,upscaler_model="test.safetensors",
                _backend=self.backend,_lifter=lambda x,size,_:F.interpolate(x,size=(x.shape[2],*size),mode="trilinear",align_corners=False))
        result = run(256,192)
        self.assertEqual(tuple(result['samples'].unbind()[0].shape),(1,4,3,12,16))
        self.assertEqual(tuple(result['samples'].unbind()[1].shape),(1,2,4,3))
        self.assertEqual(len(self.backend.calls),before+1)
        for width,height in ((127,128),(64,128),(0,128)):
            with self.assertRaises(ValueError): run(width,height)
        self.assertEqual(len(self.backend.calls),before+1)

    def test_invalid_payload_format_and_step_counts_fail_before_sampling(self):
        with self.assertRaises(ValueError): self.low(5)
        latent=self.low()
        before=len(self.backend.calls)
        with self.assertRaises(ValueError): self.high({"samples":latent["samples"]},2)
        with self.assertRaises(ValueError): self.high(latent,0)
        self.model.format.scale_factor=2.0
        with self.assertRaisesRegex(ValueError,"格式不匹配"): self.high(latent,2)
        self.assertEqual(len(self.backend.calls),before)

    def test_public_nodes_expose_and_forward_their_own_step_controls(self):
        names=("comfy_api.latest",PACKAGE+".director_selflift_stage_nodes",PACKAGE+".director_selflift_upscaler")
        before={name:sys.modules.get(name) for name in names}
        try:
            field=lambda *args,**kwargs:types.SimpleNamespace(id=args[0],options=kwargs)
            io=types.SimpleNamespace(ComfyNode=object,NodeOutput=lambda *args:args,
                                     Schema=lambda **kwargs:types.SimpleNamespace(**kwargs))
            for name in ("Model","Conditioning","Latent","Sampler","Sigmas","Int","Float","Combo","Boolean"):
                setattr(io,name,types.SimpleNamespace(Input=field,Output=field))
            sys.modules["comfy_api.latest"]=types.SimpleNamespace(io=io)
            sys.modules[PACKAGE+".director_selflift_upscaler"]=types.SimpleNamespace(list_models=lambda:["test.safetensors"])
            module=importlib.import_module(PACKAGE+".director_selflift_stage_nodes")
            low=module.TerryDirectorSelfLiftLowres
            high=module.TerryDirectorSelfLiftHighresSampler
            self.assertIn("low_steps",[item.id for item in low.define_schema().inputs])
            self.assertNotIn("high_steps",[item.id for item in low.define_schema().inputs])
            self.assertNotIn("lowres_scale",[item.id for item in low.define_schema().inputs])
            self.assertTrue({"width","height"}.issubset({item.id for item in high.define_schema().inputs}))
            self.assertIn("high_steps",[item.id for item in high.define_schema().inputs])
            self.assertNotIn("low_steps",[item.id for item in high.define_schema().inputs])
            with patch.object(module,"sample_lowres",return_value={}) as sample:
                low.execute(None,[],[],{},None,self.sigmas,3,8,1.)
                self.assertEqual(sample.call_args.kwargs["low_steps"],3)
            with patch.object(module,"sample_highres",return_value={}) as sample:
                high.execute({},None,[],[],None,7,8,1.,128,128,"test.safetensors")
                self.assertEqual(sample.call_args.kwargs["high_steps"],7)
        finally:
            for name,value in before.items():
                if value is None:sys.modules.pop(name,None)
                else:sys.modules[name]=value


if __name__=="__main__": unittest.main()
