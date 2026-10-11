"""CPU-only adapter contract tests; do not import or start ComfyUI."""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "director_loop_adapters.py"


def load_module():
    key = "_td_loop_adapters_contract_test"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, SOURCE)
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        spec.loader.exec_module(module)
    return sys.modules[key]


class LoopAdapterFoundationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adapters = load_module()

    def test_registry_exposes_one_working_adapter_and_ltx_placeholder(self):
        a = self.adapters
        catalog = {info.adapter_id: info for info in a.loop_adapter_catalog()}
        self.assertEqual(set(catalog), {"minimax_h3", "ltx_2_5"})
        self.assertTrue(catalog["minimax_h3"].ready)
        self.assertFalse(catalog["ltx_2_5"].ready)
        self.assertIn("8n+1", catalog["ltx_2_5"].description)
        self.assertIsInstance(a.get_loop_adapter(), a.MiniMaxH3LoopAdapter)
        self.assertIsInstance(
            a.get_loop_adapter("ltx_2_5", require_ready=False),
            a.LTX25ReservedAdapter,
        )

    def test_ltx_fails_closed_and_unknown_model_never_falls_back_to_h3(self):
        a = self.adapters
        with self.assertRaisesRegex(a.LoopAdapterNotReadyError, "LTX 2.5"):
            a.get_loop_adapter("ltx_2_5")
        with self.assertRaisesRegex(ValueError, "未知"):
            a.get_loop_adapter("some-other-model")
        with self.assertRaisesRegex(ValueError, "未知"):
            a.get_loop_adapter("")
        with self.assertRaisesRegex(a.LoopAdapterNotReadyError, "LTX 2.5"):
            a.adapter_from_segment({"_loop": {"adapter_id": "ltx_2_5"}})

    def test_segment_dispatch_defaults_to_h3_and_tracks_own_adapter(self):
        a = self.adapters
        self.assertIsInstance(a.adapter_from_segment({}), a.MiniMaxH3LoopAdapter)
        self.assertIsInstance(
            a.adapter_from_segment({"_loop": {"adapter_id": "minimax_h3"}}),
            a.MiniMaxH3LoopAdapter,
        )
        with self.assertRaisesRegex(ValueError, "片段数据无效"):
            a.adapter_from_segment(None)
        with self.assertRaisesRegex(ValueError, "适配信息"):
            a.adapter_from_segment({"_loop": "not-a-dict"})
        with self.assertRaisesRegex(ValueError, "适配信息"):
            a.adapter_from_segment({"_loop": []})

    def test_h3_compiles_using_existing_compiler_and_keeps_frame_grid(self):
        calls = []
        def compiler(document, *, tail_reference_prompt):
            calls.append((document, tail_reference_prompt))
            return {"fps": 24, "segments": [{"h3_frames": 107}]}
        a = self.adapters.get_loop_adapter()
        document = {"clips": [{"id": "one"}]}
        result = a.compile_plan(document, "tail-template", compiler=compiler)
        self.assertEqual(calls, [(document, "tail-template")])
        self.assertEqual(a.sampling_frames(result["segments"][0]), 107)
        with self.assertRaises(KeyError):
            a.sampling_frames({"ltx_frames": 97})

    def test_h3_image_order_and_tail_reference_validation(self):
        a = self.adapters.get_loop_adapter()
        seen = []
        def loader(asset):
            seen.append(asset["id"])
            return TinyFrames(1)
        first = {
            "assets": {"images": [{"id": "alpha"}, {"id": "beta"}],
                       "videos": [], "audios": []},
            "continuity": {"kind": "independent"},
        }
        result = a.reference_images(first, {}, load_image=loader)
        self.assertEqual(seen, ["alpha", "beta"])
        self.assertEqual(len(result), 2)

        second = {**first, "continuity": {
            "kind": "tail_reference", "picture_number": 3,
        }}
        result = a.reference_images(
            second, {"images": TinyFrames(3)}, load_image=loader,
        )
        self.assertEqual(len(result), 3)
        self.assertEqual(result[-1].shape[0], 1)
        with self.assertRaisesRegex(ValueError, "参考序号"):
            a.reference_images(
                {**second, "continuity": {"kind":"tail_reference",
                                          "picture_number":2}},
                {"images": TinyFrames(3)}, load_image=loader,
            )
        with self.assertRaisesRegex(ValueError, "真实尾帧"):
            a.reference_images(second, {}, load_image=loader)
        with self.assertRaisesRegex(ValueError, "图片参考"):
            a.reference_images(
                {**first, "assets": {**first["assets"], "videos": ["video"]}},
                {}, load_image=loader,
            )
        with self.assertRaisesRegex(ValueError, "9"):
            a.reference_images(
                {**first, "assets": {**first["assets"],
                                    "images": [{"id": str(i)} for i in range(10)]}},
                {}, load_image=loader,
            )

    def test_h3_continuity_preserves_guide_calls(self):
        a = self.adapters.get_loop_adapter()
        class Guide:
            calls = []
            @classmethod
            def execute(cls, **kwargs):
                cls.calls.append(kwargs)
                return ("guided",)
        no_guide = a.apply_continuity(
            {"continuity": {"kind": "independent"}, "previous_context": {}},
            "original", "latent", "video_vae", "audio_vae",
            guide_node=Guide,
        )
        self.assertEqual(no_guide, "original")
        self.assertEqual(Guide.calls, [])

        context = {
            "images": TinyFrames(6),
            "audio": {"waveform": TinyWaveform(9000), "sample_rate": 24000},
        }
        continuation = a.apply_continuity(
            {"continuity": {"kind": "tail_frame"},
             "previous_context": context},
            "original", "latent", "video_vae", "audio_vae",
            guide_node=Guide,
        )
        self.assertEqual(continuation, "guided")
        self.assertEqual(Guide.calls[-1]["frame_idx"], 0)

        result = a.apply_continuity(
            {"continuity": {"kind": "overlap", "frames": 2,
                            "video_guide_frames": 1,
                            "boundary_target_frame": 1},
             "previous_context": context},
            "original", "latent", "video_vae", "audio_vae",
            guide_node=Guide,
        )
        self.assertEqual(result, "guided")
        self.assertEqual(Guide.calls[-2]["audio"]["sample_rate"], 24000)
        self.assertEqual(Guide.calls[-2]["audio"]["waveform"].shape[-1], 2000)
        self.assertEqual(Guide.calls[-1]["frame_idx"], 1)

    def test_h3_cache_passes_exact_original_base_parameters(self):
        a = self.adapters.get_loop_adapter()
        class Cache:
            recorded = []
            @classmethod
            def execute(cls, **kwargs):
                cls.recorded.append(kwargs)
                return ("descriptor", "tail_images", "tail_audio")
        segment = {
            "id": "clip-1", "output_frames": 96,
            "assembly": {
                "trim_head_frames": 0, "gap_before_frames": 0,
                "gap_after_frames": 0,
            },
            "_loop": {
                "cache_key": "loop-55", "run_signature": "sig",
                "signature": "segment-sig", "context_frames": 12,
            },
        }
        result = a.cache_segment(segment, "samples", "vae", "audio",
                                 cache_node=Cache)
        self.assertEqual(result, ("descriptor", "tail_images", "tail_audio"))
        self.assertEqual(Cache.recorded, [{
            "samples": "samples", "vae": "vae", "audio_vae": "audio",
            "cache_key": "loop-55", "run_signature": "sig",
            "segment_id": "clip-1", "signature": "segment-sig",
            "output_frames": 96, "trim_head_frames": 0,
            "gap_frames": 0, "gap_after_frames": 0,
            "context_frames": 12, "fps": 24,
        }])


class TinyFrames:
    def __init__(self, frames):
        self.shape = (frames, 4, 4, 3)

    def __getitem__(self, index):
        if isinstance(index, slice):
            frames = len(range(*index.indices(self.shape[0])))
            return TinyFrames(frames)
        raise TypeError("Unexpected frame index")

    def clone(self):
        return TinyFrames(self.shape[0])


class TinyWaveform:
    def __init__(self, samples):
        self.shape = (1, 2, samples)

    def __getitem__(self, index):
        end = index[-1]
        if isinstance(end, slice):
            return TinyWaveform(len(range(*end.indices(self.shape[-1]))))
        raise TypeError("Unexpected audio slice")

    def clone(self):
        return TinyWaveform(self.shape[-1])


if __name__ == "__main__":
    unittest.main()
