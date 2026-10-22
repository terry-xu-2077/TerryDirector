"""CPU-only regression for deterministic MOV checkpoint discovery and safety."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PKG = "_td_resume_unit"


class TestResume(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        self.pkg = types.ModuleType(PKG)
        self.pkg.__path__ = [str(ROOT)]
        mocks = {
            PKG: self.pkg,
            "folder_paths": types.SimpleNamespace(
                get_output_directory=lambda: str(self.output),
            ),
        }
        self.patcher = patch.dict(sys.modules, mocks)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        spec = importlib.util.spec_from_file_location(
            PKG + ".director_loop_resume", ROOT / "director_loop_resume.py"
        )
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)

        self.profile = {
            "filename_prefix": "video/test/timeline",
            "resolved_prefix": "video/test/timeline",
            "subfolder": "video/test",
            "filename": "timeline",
            "save_node_id": "9",
            "save_settings": {"format": "auto"},
            "schema": 1,
        }

    def _run(self, number, fp, statuses):
        directory = self.output / "video" / "test"
        directory.mkdir(parents=True, exist_ok=True)
        stem = f"timeline_segments_{number:05d}"
        clips = []
        for index, status in enumerate(statuses):
            if not status:
                break
            media = directory / f"{stem}_{index + 1:03d}_clip.mov"
            media.write_bytes(b"movie packet")
            clips.append({
                "segment_id": "clip-" + str(index),
                "index": index, "frames": 48, "fps": 24,
                "segment_format": "MOV · ProRes 422 HQ",
                "path": str(media),
                "plan_fingerprint": fp,
            })
        manifest = directory / f"{stem}.json"
        manifest.write_text(json.dumps({
            "status": "in_progress", "plan_fingerprint": fp,
            "run_signature": f"run-{number}",
            "output_profile": self.profile,
            "clips": clips,
        }), "utf-8")
        return manifest

    def test_contiguous_exact_signature(self):
        segments = [{"id": "clip-"+str(i), "output_frames": 48,
                     "kind": "generated"} for i in range(3)]
        self._run(1, "stable", [1, 1, 0])
        found = self.mod.find_resume_checkpoint(
            self.profile, "stable", segments, "MOV · ProRes 422 HQ"
        )
        self.assertEqual(found["run_signature"], "run-1")
        self.assertEqual(len(found["completed"]), 2)
        self.assertIsNone(self.mod.find_resume_checkpoint(
            self.profile, "changed", segments, "MOV · ProRes 422 HQ"
        ))
        self.assertIsNone(self.mod.find_resume_checkpoint(
            self.profile, "stable", segments, "MP4 · H.264"
        ))

    def test_does_not_accept_source_outside_owned_tree(self):
        segments = [{"id": "clip-"+str(i), "output_frames": 48,
                     "kind": "generated"} for i in range(2)]
        statepath = self._run(2, "fp", [1, 0])
        state = json.loads(statepath.read_text("utf-8"))
        outside = self.output / "out.mov"
        outside.write_bytes(b"outside")
        state["clips"][0]["path"] = str(outside)
        statepath.write_text(json.dumps(state), "utf-8")
        self.assertIsNone(self.mod.find_resume_checkpoint(
            self.profile, "fp", segments, "MOV · ProRes 422 HQ"
        ))

    def test_all_clips_saved_can_resume_final_assembly(self):
        segments = [{"id": "clip-" + str(i), "output_frames": 48,
                     "kind": "generated"} for i in range(2)]
        self._run(4, "ready-to-merge", [1, 1])
        found = self.mod.find_resume_checkpoint(
            self.profile, "ready-to-merge", segments, "MOV · ProRes 422 HQ",
        )
        self.assertEqual(len(found["completed"]), 2)

    def test_graph_and_plan_changes_invalidate(self):
        node_map = {
            "1": {"class_type": "TerryDirectorLooper", "inputs": {}},
            "2": {"class_type": "VAELoader", "inputs": {"vae_name": "h3.vae"}},
            "3": {"class_type": "Sampler", "inputs": {"vae": ["2", 0], "steps": 6}},
        }
        graph = types.SimpleNamespace(get_node=lambda node: node_map[str(node)])
        link = lambda value: isinstance(value, list) and len(value) == 2
        a = self.mod.workflow_fingerprint(graph, ["3"], link)
        node_map["2"]["inputs"]["vae_name"] = "different.vae"
        b = self.mod.workflow_fingerprint(graph, ["3"], link)
        self.assertNotEqual(a, b)
        plan = {"segments": [{
            "id": "a", "output_frames": 48, "continuity": {"kind": "independent"},
            "assembly": {"trim_head_frames": 0}, "seed": 1,
        }]}
        doc = {"clips": [{"id": "a", "seed": "1", "prompt": "Scene"}]}
        p1 = self.mod.plan_fingerprint(doc, 1, plan, a, "MOV · ProRes 422 HQ")
        doc["clips"][0]["prompt"] = "Different scene"
        p2 = self.mod.plan_fingerprint(doc, 1, plan, a, "MOV · ProRes 422 HQ")
        self.assertNotEqual(p1, p2)
        doc["selected"] = "clip-one"
        p3 = self.mod.plan_fingerprint(doc, 1, plan, a, "MOV · ProRes 422 HQ")
        doc["selected"] = "clip-two"
        p4 = self.mod.plan_fingerprint(doc, 1, plan, a, "MOV · ProRes 422 HQ")
        self.assertEqual(p3, p4, "switching focused clip cannot break resume")

        p5 = self.mod.plan_fingerprint(
            doc, 1, plan, a, "MOV · ProRes 422 HQ", self.profile,
        )
        moved = dict(self.profile, subfolder="video/elsewhere")
        p6 = self.mod.plan_fingerprint(
            doc, 1, plan, a, "MOV · ProRes 422 HQ", moved,
        )
        self.assertNotEqual(p5, p6, "changing the save path must start a new task")


if __name__ == "__main__":
    unittest.main()
