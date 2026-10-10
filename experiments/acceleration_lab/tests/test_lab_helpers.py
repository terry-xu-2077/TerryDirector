"""CPU-only checks for lab graph construction and lossless AV handling."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

import torch


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AvStoreTests(unittest.TestCase):
    def test_roundtrip_both_streams_mask_and_metadata_without_rng(self):
        store = load("av_store")
        class Packed:
            is_nested = True
            def __init__(self, streams): self.streams = streams
            def unbind(self): return tuple(self.streams)
        video = torch.arange(48, dtype=torch.float32).reshape(1, 2, 2, 3, 4)
        audio = torch.arange(12, dtype=torch.float32).reshape(1, 2, 2, 3)
        latent = {"samples": Packed([video, audio]), "noise_mask": Packed([video * 0, audio * 0]),
                  "downscale_ratio_spacial": 16, "downscale_ratio_temporal": 4,
                  "batch_index": [0]}
        rng = torch.random.get_rng_state().clone()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "B0_AV.pt"
            store.save(path, latent, Packed)
            restored = store.load(path, Packed)
        self.assertEqual(set(restored), set(latent))
        self.assertTrue(torch.equal(restored["samples"].unbind()[0], video))
        self.assertTrue(torch.equal(restored["samples"].unbind()[1], audio))
        self.assertTrue(torch.equal(restored["noise_mask"].unbind()[0], video * 0))
        self.assertEqual(restored["downscale_ratio_spacial"], 16)
        self.assertTrue(torch.equal(torch.random.get_rng_state(), rng))

    def test_rejects_missing_audio_without_write(self):
        store = load("av_store")
        class Packed:
            is_nested = True
            def __init__(self, streams): self.streams = streams
            def unbind(self): return tuple(self.streams)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bad.pt"
            with self.assertRaises(ValueError):
                store.save(path, {"samples": Packed([torch.zeros(1, 2, 2, 3, 4)])}, Packed)
            self.assertFalse(path.exists())


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.builder = load("build_workflows")
        self.source = {"prompt": {
            "333": {"inputs": {"unet_name": "model", "weight_dtype": "default"}},
            "332": {"inputs": {"lora_name": "lora", "strength_model": 1}},
            "331": {"inputs": {"clip_name": "clip", "type": "minimax", "device": "default"}},
            "330": {"inputs": {"vae_name": "current_int8"}},
            "329": {"inputs": {"vae_name": "audio"}},
            "304": {"inputs": {"ref_image_size": "match"}},
            "930010": {"inputs": {"transition_step": 5, "lowres_scale": .5, "rho": 0,
                                  "highres_tiling": False, "upscaler_model": "h3.safetensors"}},
            "9700451": {"inputs": {"seed": 1000}},
        }}
        self.segment = {"id": "clip-1", "continuity": {"kind": "independent"},
                        "h3_frames": 107, "output_frames": 96, "prompt": "<Picture 1>",
                        "assets": {"images": [{"source": {"path": f"image{i}.png"}} for i in range(7)],
                                   "videos": [], "audios": []}}

    def test_b1_only_adds_sparse_to_b0_inputs(self):
        b0 = self.builder.build_sample(self.source, self.segment, "B0")
        b1 = self.builder.build_sample(self.source, self.segment, "B1")
        sparse = [node for node in b1.values() if node["class_type"] == "BlockSparseAttention"]
        self.assertEqual(len(sparse), 1)
        self.assertEqual(sparse[0]["inputs"]["selection"], "sol-attn")
        self.assertEqual(sparse[0]["inputs"]["selection.tau"], 1.0)
        for graph in (b0, b1):
            self.assertEqual(sum(n["class_type"] == "TerryAccelLabSaveVideo" for n in graph.values()), 1)
            self.assertFalse(any(n["class_type"].startswith("TerryDirector") for n in graph.values()))
            self.assertEqual(sum(n["class_type"] == "LoadImage" for n in graph.values()), 7)
            self.assertEqual(next(n for n in graph.values() if n["class_type"] == "TerryAccelLabCondition")["inputs"]["prompt"], "<Picture 1>")

    def test_decode_variants_use_same_vae_and_latent(self):
        v0 = self.builder.build_decode(self.source, "V0")
        v1 = self.builder.build_decode(self.source, "V1")
        for graph in (v0, v1):
            self.assertFalse(any("sampler" in n["class_type"].lower() for n in graph.values()))
            self.assertEqual(next(n for n in graph.values() if n["class_type"] == "VAELoader")["inputs"]["vae_name"], "current_int8")
            self.assertEqual(next(n for n in graph.values() if n["class_type"] == "TerryAccelLabLoadAV")["inputs"]["filename"], "B0_AV.pt")

    def test_input_is_unchanged_and_ui_edges_resolve(self):
        original = copy.deepcopy(self.source)
        graph = self.builder.build_sample(self.source, self.segment, "B0")
        ui = self.builder.build_ui(graph)
        self.assertEqual(self.source, original)
        self.assertEqual(ui["last_node_id"], len(graph))
        self.assertTrue(all(str(edge[1]) in graph and str(edge[3]) in graph for edge in ui["links"]))


if __name__ == "__main__":
    unittest.main()
