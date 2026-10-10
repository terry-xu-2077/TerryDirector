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
        self.assertIn("TerryDirectorDecodeSegmentToCache.execute", text)
        self.assertIn("TerryDirectorMaterializeTimeline.execute", text)
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
