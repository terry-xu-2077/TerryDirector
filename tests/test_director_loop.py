"""CPU-only adapter tests. Execute without starting the ComfyUI server.

python -m unittest discover -s tests -p "test_director_loop.py" -v
"""
import ast
import json
from pathlib import Path
import types
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[1] / "director_loop.py"


class FakeNodeOutput:
    def __init__(self, *args):
        self.args = args

    def __getitem__(self, index):
        return self.args[index]


def load_functions(*names, context=None):
    parsed = ast.parse(SOURCE.read_text(encoding="utf-8"))
    wanted = [item for item in parsed.body if getattr(item, "name", None) in names]
    if len(wanted) != len(names):
        raise AssertionError(f"Missing declarations: {names}")
    io = types.SimpleNamespace(ComfyNode=object, NodeOutput=FakeNodeOutput)
    env = {"io": io, "uuid": uuid, **(context or {})}
    code = compile(ast.fix_missing_locations(ast.Module(body=wanted, type_ignores=[])), str(SOURCE), "exec")
    exec(code, env)
    return env


class DirectorLoopTests(unittest.TestCase):
    def test_registration_declarations_and_python_syntax(self):
        text = SOURCE.read_text(encoding="utf-8")
        module = ast.parse(text)
        classes = {decl.name: decl for decl in module.body if isinstance(decl, ast.ClassDef)}
        self.assertEqual(classes["TerryDirectorLooper"].bases[0].id, "StartLoop")
        self.assertEqual(classes["TerryDirectorLoopEnd"].bases[0].id, "EndLoop")
        self.assertIn('"initial_iteration_value"', text)
        self.assertIn('TerryDirectorDecodeSegmentToCache.execute(', text)

    def test_compiled_items_keep_next_overlap_only(self):
        calls = []
        items = [
            {"id": "one", "h3_frames": 107, "continuity": {"kind": "independent"}},
            {"id": "two", "h3_frames": 73, "continuity": {"kind": "overlap", "frames": 12}},
            {"id": "three", "h3_frames": 124, "continuity": {"kind": "tail_reference"}},
        ]
        fn = load_functions("_plan_items", context={
            "normalize_config": lambda value: {"document": json.loads(value)},
            "compile_timeline": lambda document, tail_reference_prompt: {"segments": items},
            "prepare_base_run_cache": lambda *args: calls.append(args),
        })["_plan_items"]
        compiled = fn('{"fps":24}', 9, "template", 22)
        self.assertEqual([x["_loop"]["context_frames"] for x in compiled], [12, 1, 1])
        self.assertEqual([x["_loop"]["seed"] for x in compiled], [9, 9, 9])
        self.assertEqual(calls[0][0], "loop-22")
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            compiled[0]["_loop"]["run_signature"],
            compiled[2]["_loop"]["run_signature"],
        )

    def test_media_reference_position_and_tail(self):
        import torch

        seen = []
        def load_image(item):
            seen.append(item["id"])
            return torch.zeros((1, 4, 4, 3))
        ns = load_functions("TerryDirectorLoopMedia", context={
            "_load_image": load_image, "_notify": lambda *args: None,
            "IMAGE_SLOTS": 9,
        })
        segment = {
            "prompt": "picture prompt", "h3_frames": 107,
            "assets": {"images": [{"id": "four"}, {"id": "one"}], "videos": [], "audios": []},
            "continuity": {"kind": "tail_reference", "picture_number": 3},
            "_loop": {"seed": 9, "loop_id": "22"},
        }
        tail = torch.ones((1, 4, 4, 3))
        out = ns["TerryDirectorLoopMedia"].execute(segment, {"images": tail}).args
        self.assertEqual(seen, ["four", "one"])
        self.assertEqual(out[:3], ("picture prompt", 107, 9))
        self.assertEqual(len(out), 13)
        self.assertTrue(torch.equal(out[6], tail))
        self.assertTrue(all(img is None for img in out[7:]))

    def test_guide_independent_or_tail(self):
        import torch

        calls = []
        class Guide:
            @classmethod
            def execute(cls, **kwargs):
                calls.append(kwargs)
                return FakeNodeOutput(["guided"])
        ns = load_functions("TerryDirectorLoopGuide", context={"MiniMaxH3AddGuide": Guide})
        cls = ns["TerryDirectorLoopGuide"]
        independent = cls.execute("original", "latent", "vae", "audio_vae",
                                  {"continuity": {"kind": "independent"}}, "{}")
        self.assertEqual(independent[0], "original")
        self.assertEqual(len(calls), 0)
        ctx = {"images": torch.ones((1, 4, 4, 3)), "audio": {"waveform": None}}
        guided = cls.execute("original", "latent", "vae", "audio_vae",
                             {"continuity": {"kind": "tail_frame"}}, ctx)
        self.assertEqual(guided[0], ["guided"])
        self.assertEqual(calls[-1]["frame_idx"], 0)

    def test_cache_delegates_to_existing_lossless_path(self):
        calls = []
        class BaseCache:
            @classmethod
            def execute(cls, **kwargs):
                calls.append(kwargs)
                return FakeNodeOutput("descriptor", "tail", "audio")
        ns = load_functions("TerryDirectorLoopCache", context={
            "TerryDirectorDecodeSegmentToCache": BaseCache,
            "_notify": lambda *args: None,
        })
        segment = {
            "id": "one", "output_frames": 96,
            "assembly": {"trim_head_frames": 0, "gap_before_frames": 0, "gap_after_frames": 0},
            "_loop": {
                "cache_key": "loop-22", "run_signature": "abcd",
                "signature": "test", "context_frames": 12, "loop_id": "22",
            },
        }
        out = ns["TerryDirectorLoopCache"].execute("samples", "vae", "audio", segment)
        self.assertEqual(out[0], "descriptor")
        self.assertEqual(out[1], {"images": "tail", "audio": "audio"})
        self.assertEqual(calls[0]["output_frames"], 96)
        self.assertEqual(calls[0]["context_frames"], 12)


if __name__ == "__main__":
    unittest.main()
