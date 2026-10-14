"""No-GPU tests for clip signatures, partial recovery and stale dependencies."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("_td_loop_state_test", ROOT / "director_loop_state.py")
state = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(state)


def clip(identifier, start, end, kind="generated"):
    continuity = (
        {"kind": "independent"} if start == 0 else
        {"kind": "overlap", "frames": 12}
        if start < 48 else {"kind": "tail_reference"}
    )
    return {
        "id": identifier, "name": identifier,
        "kind": kind, "seed": None, "prompt": identifier,
        "start_frame": start, "end_frame": end,
        "h3_frames": 56, "output_frames": end-start,
        "transition_mode": "tail_reference", "continuity": continuity,
        "assembly": {"trim_head_frames": 12 if continuity["kind"] == "overlap" else 0},
        "assets": {"images": [], "videos": [], "audios": []},
        "source_asset": None,
    }


class Fingerprints(unittest.TestCase):
    def test_authoring_and_graph_invalidate_old_result(self):
        a = clip("A", 0, 48)
        sig = state.clip_fingerprint(a, 1, "graph-A")
        self.assertEqual(sig, state.clip_fingerprint(a, 1, "graph-A"))
        self.assertNotEqual(sig, state.clip_fingerprint(a, 2, "graph-A"))
        self.assertNotEqual(sig, state.clip_fingerprint(a, 1, "graph-B"))
        self.assertNotEqual(sig, state.clip_fingerprint(dict(a, prompt="updated"), 1, "graph-A"))

    def test_file_stats_invalidate_referenced_asset(self):
        with tempfile.TemporaryDirectory() as dirname:
            media = Path(dirname) / "asset.png"
            media.write_bytes(b"1")
            part = clip("B", 48, 96)
            part["assets"]["images"] = [{
                "id": "x", "kind": "image",
                "source": {"type": "comfy-input", "path": "asset.png"},
            }]
            old = state.clip_fingerprint(part, 1, "g",
                                         lambda rel: str(Path(dirname) / rel))
            media.write_bytes(b"1234567")
            changed = state.clip_fingerprint(part, 1, "g",
                                             lambda rel: str(Path(dirname) / rel))
            self.assertNotEqual(old, changed)

    def test_graph_hash_includes_upstream_sampler_input(self):
        nodes = {
            "21": {"class_type": "SamplerCustomAdvanced", "inputs": {"model": ["9", 0]}},
            "9": {"class_type": "UNETLoader", "inputs": {"unet_name": "model-a"}},
        }

        class Prompt:
            def get_node(self, idx):
                return nodes[str(idx)]

        fn = lambda value: isinstance(value, list) and len(value) == 2
        old = state.graph_fingerprint(Prompt(), ["21"], "1", "3", fn)
        nodes["9"]["inputs"]["unet_name"] = "model-b"
        self.assertNotEqual(old, state.graph_fingerprint(Prompt(), ["21"], "1", "3", fn))


class ResumeAndMerge(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="td_loop_state_")
        self.addCleanup(self.temp.cleanup)
        self.root = state.loop_folder(self.temp.name, "42")
        self.root.mkdir(parents=True)

    def write(self, run, rows, *, plan_hash="full", status="in_progress", stamped=True):
        folder = self.root / run
        (folder / "clips").mkdir(parents=True, exist_ok=True)
        descriptors = []
        for index, (part, size) in enumerate(rows):
            path = folder / "clips" / f"{part['id']}.mov"
            path.write_bytes(b"x" * size)
            descriptors.append({
                "index": index, "segment_id": part["id"], "frames": part["output_frames"],
                "segment_format": "MOV", "fps": 24,
                "path": str(path), "run_signature": run,
                "recipe_fingerprint": f"recipe-{part['id']}" if stamped else None,
                "file_size": size,
                "continuity": part["continuity"],
                "upstream_source": str((folder / "clips" / "A.mov"))
                                   if part["id"] != "A" else None,
            })
        (folder / "timeline.json").write_text(json.dumps({
            "status": status, "segment_format": "MOV",
            "plan_fingerprint": plan_hash, "clips": descriptors,
        }), "utf-8")
        return descriptors

    def test_resume_complete_prefix_only(self):
        a, b, c = [clip(x, i*48, (i+1)*48) for i, x in enumerate("ABC")]
        self.write("broken", [(a, 40), (b, 40)])
        resume = state.incomplete_run(
            self.root, [a, b, c],
            ["recipe-A", "recipe-B", "recipe-C"], "full", "MOV",
        )
        self.assertEqual(resume["completed"], 2)
        self.assertEqual(resume["run_signature"], "broken")
        self.assertEqual(len(resume["prefix"]), 2)

    def test_resume_rejects_changed_graph_and_missing_file(self):
        a, b, c = [clip(x, i*48, (i+1)*48) for i, x in enumerate("ABC")]
        self.write("broken", [(a, 40), (b, 40)])
        self.assertIsNone(state.incomplete_run(
            self.root, [a, b, c],
            ["recipe-A", "recipe-B", "recipe-C"], "new-plan", "MOV",
        ))
        (self.root / "broken" / "clips" / "A.mov").unlink()
        self.assertIsNone(state.incomplete_run(
            self.root, [a, b, c],
            ["recipe-A", "recipe-B", "recipe-C"], "full", "MOV",
        ))

    def test_resume_rejects_mismatched_file_size(self):
        a = clip("A", 0, 48)
        self.write("broken", [(a, 40)])
        (self.root / "broken" / "clips" / "A.mov").write_bytes(b"corrupt")
        self.assertIsNone(state.incomplete_run(
            self.root, [a], ["recipe-A"], "full", "MOV",
        ))

    def test_merge_selects_latest_and_flags_stale_successor(self):
        a, b, c = [clip(x, i*48, (i+1)*48) for i, x in enumerate("ABC")]
        original = self.write("baseline", [(a, 40), (b, 40), (c, 40)], status="completed")
        new_b = self.write("rerun", [(b, 100)], status="completed")[0]
        manifest = self.root / "rerun" / "timeline.json"
        state_json = json.loads(manifest.read_text("utf-8"))
        state_json["clips"][0]["upstream_source"] = original[0]["path"]
        manifest.write_text(json.dumps(state_json), "utf-8")
        future = time.time_ns() + 8_000_000_000
        os.utime(manifest, ns=(future, future))
        selected = state.select_current_takes(
            self.root, [a, b, c],
            ["recipe-A", "recipe-B", "recipe-C"], "MOV",
        )
        self.assertEqual([Path(x["path"]).parent.parent.name
                          for x in selected["clips"]], ["baseline", "rerun", "baseline"])
        self.assertEqual([x["index"] for x in selected["clips"]], [0, 1, 2])
        self.assertEqual([x["segment_id"] for x in selected["stale"]], ["C"])

    def test_skips_entity_but_resets_generated_head_trim(self):
        physical = clip("P", 0, 48, kind="entity")
        physical["source_asset"] = {"source": {"path": "anchor.mov"}}
        b = clip("B", 36, 84)
        self.write("baseline", [(b, 40)], status="completed")
        picked = state.select_current_takes(
            self.root, [physical, b], ["unused", "recipe-B"], "MOV",
        )
        self.assertEqual(picked["clips"][0]["trim_head_frames"], 0)


if __name__ == "__main__":
    unittest.main()
