"""Static integration regressions that don't import ComfyUI or GPU modules."""
import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LoopIntegrationContractTest(unittest.TestCase):
    def test_main_selflift_registration_remains(self):
        text = (ROOT / "__init__.py").read_text(encoding="utf-8")
        root = ast.parse(text)
        self.assertIn("TerryDirectorSelfLiftSampler", text)
        self.assertIn("install(__package__, node_classes)", text)
        self.assertIn("TerryDirectorAdvanced", text)
        self.assertIn("TerryDirector", text)
        self.assertIn("TerryDirectorSecondPassConfig", text)
        self.assertIn("from .director_trace import install", text)
        names = [
            "TerryDirectorLooper", "TerryDirectorLoopInfo",
            "TerryDirectorLoopCondition", "TerryDirectorLoopFrame",
            "TerryDirectorLoopCache", "TerryDirectorLoopEnd",
        ]
        for name in names:
            with self.subTest(node=name):
                self.assertIn(name, text)
                self.assertEqual(text.count("            " + name + ",\n"), 1)

    def test_loop_uses_native_boundaries_and_existing_cache(self):
        text = (ROOT / "director_loop.py").read_text(encoding="utf-8")
        root = ast.parse(text)
        klasses = {n.name: n for n in root.body if isinstance(n, ast.ClassDef)}
        self.assertEqual(klasses["TerryDirectorLooper"].bases[0].id, "StartLoop")
        self.assertEqual(klasses["TerryDirectorLoopEnd"].bases[0].attr, "ComfyNode")
        self.assertNotIn("TerryDirectorLoopMerge", klasses)
        self.assertNotIn("TerryDirectorLoopMedia", klasses)
        self.assertNotIn("TerryDirectorLoopGuide", klasses)
        self.assertIn("adapter.cache_segment(", text)
        self.assertIn("adapter.compile_plan(", text)
        self.assertIn("adapter.reference_images(", text)
        self.assertIn("adapter.apply_continuity(", text)
        self.assertIn("adapter.sampling_frames(segment)", text)
        self.assertIn('"adapter_id": adapter.info.adapter_id', text)
        adapter = (ROOT / "director_loop_adapters.py").read_text(encoding="utf-8")
        ast.parse(adapter)
        self.assertIn("class MiniMaxH3LoopAdapter(", adapter)
        self.assertIn("class LTX25ReservedAdapter(", adapter)
        self.assertIn("cache_node.execute(", adapter)
        self.assertIn("guide_node.execute(", adapter)
        self.assertIn('DEFAULT_LOOP_ADAPTER = "minimax_h3"', adapter)
        self.assertIn('LTX25_LOOP_ADAPTER = "ltx_2_5"', adapter)
        self.assertIn("LoopAdapterNotReadyError", adapter)
        self.assertIn("TerryDirectorStreamVideo(", text)
        self.assertIn("from .director_loop_video import TerryDirectorStreamVideo", text)
        self.assertIn('CATEGORY = "TerryDirector/循环"', text)
        self.assertEqual(text.count('category="TerryDirector/循环/内部"'), 2)
        self.assertIn('io.Int.Output(display_name="采样帧数")', text)
        self.assertEqual(text.count('display_name="采样结果"'), 2)
        self.assertNotIn('display_name="H3帧数"', text)
        self.assertNotIn('display_name="H3采样结果"', text)
        # Truthful capability scope: changing UI labels does not remove H3 adapters.
        self.assertIn('from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide', text)
        self.assertIn('segment["h3_frames"]', adapter)
        self.assertIn("guide_node.execute(", adapter)
        self.assertIn('io.Video.Output(display_name="视频")', text)
        self.assertIn('io.Latent.Output(display_name="分段潜变量", is_output_list=True)', text)
        self.assertNotIn('io.Image.Output(display_name="合并画面")', text)
        self.assertNotIn('io.Audio.Output(display_name="合并音频")', text)
        self.assertIn('io.Combo.Input(', text)
        self.assertIn('"bit_depth"', text)
        self.assertIn('"color_space"', text)
        self.assertNotIn('"output_mode"', text)
        self.assertIn("store_latents=store_latents", text)
        self.assertIn("_wants_segment_latents(dynprompt, close_id)", text)
        self.assertIn("_save_segment_latent(samples, descriptor)", text)
        self.assertNotIn('"merge_output"', text)
        self.assertIn('loop_boundary="start"', text)
        self.assertIn('loop_boundary="end"', text)
        self.assertIn("TerryDirectorLoopFrame", text)
        self.assertIn('LoopContextData = io.Custom("TERRYDIRECTOR_LOOP_CONTEXT")', text)
        self.assertIn('SegmentData = io.Custom("TERRYDIRECTOR_SEGMENT_DATA")', text)
        self.assertIn('LoopContextData.Output("loop_context", display_name="循环上下文")', text)
        self.assertIn('LoopContextData.Input("loop_context", display_name="循环上下文")', text)
        self.assertIn('SegmentData.Output(display_name="片段数据")', text)
        self.assertIn('SegmentData.Input("segment_data", display_name="片段数据")', text)
        # End's body links are intentionally optional in its schema because
        # LoopStart removes them when installing the native external block.
        end_section = text.split("class TerryDirectorLoopEnd(io.ComfyNode):", 1)[1]
        for name in ("samples", "vae", "audio_vae", "segment_data"):
            with self.subTest(end_optional=name):
                self.assertIn('Input("' + name + '"', end_section)
        self.assertGreaterEqual(end_section.count("optional=True"), 4)
        self.assertIn("prepare_base_run_cache(", text)
        self.assertNotIn("from .director_selflift", text)
        stream = (ROOT / "director_loop_video.py").read_text(encoding="utf-8")
        self.assertIn("class TerryDirectorStreamVideo(VideoInput):", stream)
        self.assertIn("def save_to(", stream)
        self.assertIn("video_output_config(path, format, codec)", stream)
        self.assertIn("torch.load(", stream)
        self.assertNotIn("torch.cat(", stream)
        self.assertIn("def _clear_lossless_cache(", stream)

    def test_workflow_editor_keeps_only_current_node_readonly(self):
        text = (ROOT / "web" / "terry_director.js").read_text(encoding="utf-8")
        self.assertIn('const LOOP_NODE_CLASS = "TerryDirectorLooper"', text)
        self.assertIn('const LOOP_END_NODE_CLASS = "TerryDirectorLoopEnd"', text)
        self.assertIn("loopExecutionTarget(node)", text)
        self.assertIn('current.comfyClass === "SaveVideo"', text)
        self.assertIn("saves.size === 1", text)
        self.assertIn("bindLoopSegmentActivity()", text)
        self.assertIn('collectLoopSamplerProgress(detail, app.graph)', text)
        self.assertIn('applyLoopSamplerProgress(event.detail)', text)
        self.assertIn('activeLoopClip(readConfig(node).document.clips, sample.iteration)', text)
        self.assertIn('Math.min(0.99, sample.fraction)', text)
        self.assertIn('samplingSteps', text)
        self.assertIn("isDirector(node)", text)
        self.assertIn('findLoopMemorySources(node, linkedNodeForInput)', text)
        self.assertIn('readH3Resolution(h3)', text)
        self.assertIn('const isLoopEnd = node.comfyClass === LOOP_END_NODE_CLASS', text)
        self.assertIn('node?.comfyClass === LOOP_END_NODE_CLASS', text)
        self.assertIn('bindLoopMemorySource(node)', text)
        self.assertIn('function linkedOutputForInput(node, inputName)', text)
        self.assertIn('readH3Resolution(h3, linkedOutputForInput)', text)
        self.assertIn('node.comfyClass === "ResolutionSelector"', text)
        self.assertIn('const activeClips = (documentData.clips || []).filter(clip => !clip.suspended).length', text)
        self.assertIn("createLoopOutputCheckCard(estimate, tdTempDisk)", text)
        self.assertIn('api.fetchApi("/terrydirector/api/temp-space")', text)
        self.assertIn("function syncLoopSocketLabels(node)", text)
        self.assertIn('slot.name = "采样帧数"', text)
        self.assertIn('slot.localized_name = "采样结果"', text)
        self.assertIn("refreshTempDiskSpace()", text)
        self.assertIn('td-output-check-row', (ROOT / "web" / "terry_director.css").read_text(encoding="utf-8"))
        page = (ROOT / "server_routes.py").read_text(encoding="utf-8")
        self.assertIn('"/terrydirector/api/temp-space"', page)
        self.assertIn("TerryDirectorAdvanced", text)

    def test_old_sample_execution_not_replaced(self):
        init = (ROOT / "__init__.py").read_text(encoding="utf-8")
        src = (ROOT / "director_h3.py").read_text(encoding="utf-8")
        self.assertIn("TerryDirectorSelfLiftSampler", init)
        self.assertIn("TerryDirectorSelfLiftSampler", src)
        self.assertIn("SamplerCustomAdvanced", src)
        self.assertIn("def build_timeline_graph(", src)


if __name__ == "__main__":
    unittest.main()
