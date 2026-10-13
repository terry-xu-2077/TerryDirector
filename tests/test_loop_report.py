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


if __name__ == "__main__":
    unittest.main()
