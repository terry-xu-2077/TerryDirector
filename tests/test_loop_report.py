"""CPU-only regression tests for TerryDirector external-loop Markdown reports.

Run: python -m unittest discover -s tests -p test_loop_report.py
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SOURCE = pathlib.Path(__file__).resolve().parents[1] / "director_loop_report.py"
SPEC = importlib.util.spec_from_file_location("td_loop_report_test", SOURCE)
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)


def segment(index, name="测试片段"):
    return {
        "id": "clip-" + str(index),
        "name": name,
        "output_frames": 240,
        "_loop": {"index": index, "run_signature": "fixture123456"},
    }


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def add(self, seconds):
        self.now += seconds


class LoopReportTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.run = R.RunReport(
            "251", [segment(0, "采摘烟叶"), segment(1, "夜晚的战壕")],
            clock=self.clock
        )

    def test_per_clip_elapsed_and_observed_steps(self):
        self.run.clip_event(0, "start")
        self.clock.add(10)
        self.run.sampler_event(0, "251.call.graph.0_263", "SelfLiftAvatarH3Sampler", "start")
        self.clock.add(20)
        self.run.sampler_event(0, "251.call.graph.0_263", "SelfLiftAvatarH3Sampler", "progress", 1, 5)
        self.clock.add(40)
        self.run.sampler_event(0, "251.call.graph.0_263", "SelfLiftAvatarH3Sampler", "progress", 3, 5)
        self.clock.add(10)
        self.run.sampler_event(0, "251.call.graph.0_263", "SelfLiftAvatarH3Sampler", "end")
        self.clock.add(20)
        self.run.clip_event(0, "end")
        self.run.close("已完成")
        content = self.run.markdown()
        self.assertIn("00:01:40", content)
        self.assertIn("采摘烟叶", content)
        self.assertIn("夜晚的战壕", content)
        self.assertIn("3 | 20.00 s/步", content)

    def test_memory_peaks_are_real_observed_values(self):
        self.run.clip_event(0, "start")
        snapshots = [
            {"gpu_used": 12, "ram_used": 33, "process_rss": 22,
             "torch_allocated": 8, "gpu_total": 24},
            {"gpu_used": 23, "ram_used": 49, "process_rss": 37,
             "torch_allocated": 17, "gpu_total": 24},
        ]
        with patch.object(R, "resource_snapshot", side_effect=snapshots):
            self.run.sample()
            self.run.sample()
        self.run.clip_event(0, "end")
        self.run.close("已完成")
        self.assertEqual(self.run.clips[0]["peak"]["gpu_used"], 23)
        self.assertEqual(self.run.global_peak["ram_used"], 49)
        self.assertIn("23.00 GiB", self.run.markdown())

    def test_multiphase_progress_resets_are_not_negative_steps(self):
        self.run.sampler_event(0, "sampler", "SelfLiftAvatarH3Sampler", "start")
        self.clock.add(6)
        self.run.sampler_event(0, "sampler", "SelfLiftAvatarH3Sampler", "progress", 3, 5)
        self.clock.add(1)
        self.run.sampler_event(0, "sampler", "SelfLiftAvatarH3Sampler", "progress", 0, 1)
        self.clock.add(3)
        self.run.sampler_event(0, "sampler", "SelfLiftAvatarH3Sampler", "progress", 1, 1)
        self.assertEqual(self.run.clips[0]["samplers"]["sampler"]["steps"], 4)

    def test_sampler_selector_never_counts_as_sampling(self):
        self.assertTrue(R.is_sampler("SelfLiftAvatarH3Sampler"))
        self.assertFalse(R.is_sampler("KSamplerSelect"))
        self.assertFalse(R.is_sampler("BasicScheduler"))

    def test_missing_native_progress_does_not_invent_step_speed(self):
        self.run.clip_event(0, "start")
        self.clock.add(180)
        self.run.clip_event(0, "end")
        self.run.close("已完成")
        self.assertIn("未收到采样器原生进度事件", self.run.markdown())
        self.assertIn("未采集", self.run.markdown())

    def test_native_handler_uses_correct_loop_owner(self):
        events = []
        fake_progress = types.ModuleType("comfy_execution.progress")

        class BaseHandler:
            def __init__(self, name):
                self.name = name

        fake_progress.ProgressHandler = BaseHandler
        fake_progress.add_progress_handler = events.append
        fake_package = types.ModuleType("comfy_execution")
        with patch.dict(sys.modules, {
            "comfy_execution": fake_package,
            "comfy_execution.progress": fake_progress,
        }):
            R._attach_native_handler(self.run)
        self.assertEqual(len(events), 1)

        class DynamicPrompt:
            def get_real_node_id(self, key):
                return "251" if str(key).startswith("251.") else "999"

            def get_node(self, key):
                return {"class_type": "SelfLiftAvatarH3Sampler"}

        handler = events[0]
        handler.set_registry(types.SimpleNamespace(dynprompt=DynamicPrompt()))
        handler.start_handler("251.call.graph.0_263", {}, "prompt")
        self.clock.add(2)
        handler.update_handler("251.call.graph.0_263", 1, 6, {}, "prompt")
        handler.update_handler("999.call.graph.0_263", 5, 6, {}, "prompt")
        self.assertEqual(self.run.clips[0]["samplers"]["251.call.graph.0_263"]["steps"], 1)

    def test_report_auto_saves_in_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            fake_paths = types.ModuleType("folder_paths")
            fake_paths.get_output_directory = lambda: directory
            self.run.close("已完成")
            with patch.dict(sys.modules, {"folder_paths": fake_paths}):
                content = R._save(self.run)
            path = pathlib.Path(directory) / "TerryDirector" / "reports"
            files = list(path.glob("loop_*.md"))
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].read_text(encoding="utf-8"), content)


    def test_raw_trace_contains_samples_and_no_prompt_text(self):
        self.run.clip_event(0, "start")
        self.clock.add(10)
        with patch.object(R, "resource_snapshot", return_value={
            "gpu_used": 22.4, "gpu_total": 24.0,
            "ram_used": 45.0, "ram_total": 63.7,
            "process_rss": 25.0, "swap_used": 6.0,
            "gpu_util": 97.0, "proc_cpu_seconds": 44.0,
        }):
            self.run.sample()
        self.run.sampler_event(0, "251.call.graph.0_263", "SelfLiftAvatarH3Sampler",
                               "progress", 1, 5)
        self.run.add_cache_result(0, elapsed=11.5, size_mb=6888, frames=288)
        with patch.object(R, "_save"):
            self.run.clip_event(0, "end")
        raw = self.run.raw()
        self.assertEqual(raw["format"], "terrydirector-loop-diagnostics")
        self.assertTrue(raw["samples"])
        self.assertEqual(raw["clips"][0]["cache"]["time_s"], 11.5)
        self.assertTrue(raw["clips"][0]["samplers"]["251.call.graph.0_263"]["progress_timeline"])
        self.assertNotIn("subject_definitions", str(raw))
        self.assertIn("GPU 显存采样峰值", self.run.markdown())

    def test_diagnostics_sidecar_json_written_with_markdown(self):
        with tempfile.TemporaryDirectory() as directory:
            fake_paths = types.ModuleType("folder_paths")
            fake_paths.get_output_directory = lambda: directory
            with patch.dict(sys.modules, {"folder_paths": fake_paths}):
                self.run.close("已完成")
                R._save(self.run)
            outputs = pathlib.Path(directory) / "TerryDirector" / "reports"
            markdown = next(outputs.glob("loop_*.md"))
            diagnostic = markdown.with_suffix(".json")
            self.assertTrue(diagnostic.is_file())
            import json
            parsed = json.loads(diagnostic.read_text(encoding="utf-8"))
            self.assertEqual(parsed["version"], 2)
            self.assertEqual(parsed["loop_id"], "251")
            self.assertIn("samples", parsed)
            self.assertIn(str(diagnostic), markdown.read_text(encoding="utf-8"))

    def test_native_node_timing_and_cache_are_visible(self):
        with patch.object(R, "_save"):
            self.run.clip_event(0, "start")
            self.run.stage_event(0, "251.call.graph.0_122", "VAEDecode", "start")
            self.clock.add(125)
            self.run.stage_event(0, "251.call.graph.0_122", "VAEDecode", "end")
            self.run.add_cache_result(0, elapsed=9.2, size_mb=5000, frames=240)
            self.run.clip_event(0, "end")
        report = self.run.markdown()
        self.assertIn("VAEDecode：125.00 s", report)
        self.assertIn("缓存写入：9.20 s", report)

    def test_external_selflift_log_parser_uses_real_clip_time(self):
        # These are representative lines from the submitted 4h work session,
        # not hardcoded performance figures in the report.
        import importlib.util
        root = SOURCE.parent / "director_loop_logmetrics.py"
        spec = importlib.util.spec_from_file_location("td_loop_log_test", root)
        metrics = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(metrics)
        from datetime import datetime
        start = datetime(2026, 10, 13, 0, 18, 0).timestamp()
        end = datetime(2026, 10, 13, 0, 53, 0).timestamp()
        sample = (
            "[2026-10-13 00:29:00.918] [selflift-Avatar timing] low_resolution step 1/5 (includes setup): 73.988s\n"
            "[2026-10-13 00:33:25.343] [selflift-Avatar timing] transition start (wall time; no forced CUDA sync)\n"
            "[2026-10-13 00:46:16.108] [selflift-Avatar timing] transition paired_lifts: 770.747s\n"
            "[2026-10-13 00:52:52.937] [selflift-Avatar timing] high_resolution step 1/1 (includes setup): 396.507s\n"
            "[2026-10-13 00:52:52.937] Secret prompt: should never be included\n"
        )
        events = metrics.extract_lines(sample, [{"wall_start":start, "wall_end":end}])
        self.assertEqual(len(events[0]), 3)
        phases = metrics.phase_summary(events[0])
        self.assertEqual(phases["upscale"], 770.747)
        self.assertEqual(phases["low_steps"], [73.988])
        self.assertEqual(phases["high_steps"], [396.507])
        self.assertNotIn("Secret prompt", str(events))

    def test_log_integration_reports_precise_highres_and_upscale_spikes(self):
        self.run.source_log = {
            "status": "已关联日志", "files": ["comfyui.log"],
            "by_clip": [[{"kind":"upscale", "seconds":770.747},
                         {"kind":"high_total", "seconds":398.5},
                         {"kind":"low_step", "seconds":32.0},
                         {"kind":"low_step", "seconds":31.9},
                         {"kind":"low_step", "seconds":32.1}],
                        []],
        }
        content = self.run.markdown()
        self.assertIn("770.75 s", content)
        self.assertIn("398.50 s", content)
        self.assertIn("31.95", content)
        self.assertIn("Latent 升采样耗费", content)



if __name__ == "__main__":
    unittest.main()
