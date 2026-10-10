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
    # The two production packet validators are used by several target classes.
    targets = set(names) | {"_require_loop_context", "_require_segment_data"}
    wanted = [item for item in parsed.body if getattr(item, "name", None) in targets]
    found = {getattr(item, "name", None) for item in wanted}
    if not set(names).issubset(found):
        raise AssertionError(f"Missing declarations: {set(names) - found}")
    io = types.SimpleNamespace(ComfyNode=object, NodeOutput=FakeNodeOutput)
    env = {
        "io": io, "uuid": uuid,
        "LOOP_CONTEXT_KIND": "terrydirector.loop_context",
        "SEGMENT_DATA_KIND": "terrydirector.segment_data",
        **(context or {}),
    }
    code = compile(ast.fix_missing_locations(ast.Module(body=wanted, type_ignores=[])), str(SOURCE), "exec")
    exec(code, env)
    return env


class DirectorLoopTests(unittest.TestCase):
    def test_registration_declarations_and_python_syntax(self):
        text = SOURCE.read_text(encoding="utf-8")
        module = ast.parse(text)
        classes = {decl.name: decl for decl in module.body if isinstance(decl, ast.ClassDef)}
        self.assertEqual(classes["TerryDirectorLooper"].bases[0].id, "StartLoop")
        self.assertEqual(classes["TerryDirectorLoopEnd"].bases[0].attr, "ComfyNode")
        self.assertIn("TerryDirectorLoopFrame", classes)
        self.assertIn("TerryDirectorLoopInfo", classes)
        self.assertIn("TerryDirectorLoopCondition", classes)
        self.assertNotIn("TerryDirectorLoopMerge", classes)
        self.assertNotIn("TerryDirectorLoopMedia", classes)
        self.assertNotIn("TerryDirectorLoopGuide", classes)
        self.assertIn('TerryDirectorLoopFrame', text)
        self.assertIn('loop_boundary="start"', text)
        self.assertIn('loop_boundary="end"', text)
        self.assertIn('TerryDirectorDecodeSegmentToCache.execute(', text)
        self.assertIn('io.Custom("TERRYDIRECTOR_LOOP_CONTEXT")', text)
        self.assertIn('io.Custom("TERRYDIRECTOR_SEGMENT_DATA")', text)
        self.assertIn('LoopContextData.Input("loop_context"', text)
        self.assertIn('SegmentData.Output(display_name="片段数据")', text)

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
        ns = load_functions("TerryDirectorLoopInfo", context={
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
        context = {
            "_type": "terrydirector.loop_context",
            "current_segment": segment,
            "previous_context": {"images": tail},
        }
        out = ns["TerryDirectorLoopInfo"].execute(context).args
        self.assertEqual(seen, ["four", "one"])
        self.assertEqual(out[:3], ("picture prompt", 107, 9))
        self.assertEqual(len(out), 13)
        self.assertEqual(out[3]["_type"], "terrydirector.segment_data")
        self.assertEqual(out[3]["h3_frames"], 107)
        self.assertIs(out[3]["previous_context"]["images"], tail)
        self.assertNotIn("current_segment", out[3])
        self.assertTrue(torch.equal(out[6], tail))
        self.assertTrue(all(img is None for img in out[7:]))


    def test_one_port_frame_keeps_current_segment_and_carried_context(self):
        ns = load_functions("TerryDirectorLoopFrame")
        cls = ns["TerryDirectorLoopFrame"]
        segment = {"id": "clip-1", "_loop": {"seed": 1}}
        first = cls.execute(segment, "{}")[0]
        self.assertEqual(first["current_segment"], segment)
        self.assertEqual(first["_type"], "terrydirector.loop_context")
        self.assertEqual(first["previous_context"], {})
        last = {"images": "tail"}
        later = cls.execute(segment, last)[0]
        self.assertIs(later["previous_context"], last)

    def test_distinct_packet_types_reject_cross_connection(self):
        validators = load_functions("_require_loop_context", "_require_segment_data")
        context = {
            "_type": "terrydirector.loop_context",
            "current_segment": {"_loop": {"seed": 9}},
            "previous_context": {},
        }
        segment_data = {
            "_type": "terrydirector.segment_data",
            "h3_frames": 96,
            "previous_context": {},
        }
        self.assertEqual(validators["_require_loop_context"](context)[0]["_loop"]["seed"], 9)
        self.assertIs(validators["_require_segment_data"](segment_data), segment_data)
        with self.assertRaisesRegex(ValueError, "片段数据"):
            validators["_require_segment_data"](context)
        with self.assertRaisesRegex(ValueError, "循环上下文"):
            validators["_require_loop_context"](segment_data)

    def test_native_graph_repeats_hidden_cache_and_carries_context(self):
        class Node:
            def __init__(self, cls, name, inputs):
                self.cls = cls
                self.id = name
                self.inputs = inputs
            def out(self, index):
                return [self.id, index]
            def set_override_display_id(self, _value):
                pass
            def set_input(self, name, value):
                self.inputs[name] = value

        class Builder:
            def __init__(self):
                self.nodes = {}
            def node(self, cls, name, **kwargs):
                assert name not in self.nodes, name
                node = Node(cls, name, kwargs)
                self.nodes[name] = node
                return node
            def finalize(self):
                return {
                    key: {"class_type": node.cls, "inputs": dict(node.inputs)}
                    for key, node in self.nodes.items()
                }

        class DynPrompt:
            def __init__(self):
                self.nodes = {
                    "start": {"class_type": "TerryDirectorLooper", "inputs": {}},
                    "info": {"class_type": "TerryDirectorLoopInfo",
                             "inputs": {"loop_context": ["start", 0]}},
                    "sampler": {"class_type": "FakeSampler",
                                "inputs": {"segment_data": ["info", 3]}},
                    "end": {"class_type": "TerryDirectorLoopEnd",
                            "inputs": {
                                "samples": ["sampler", 0],
                                "vae": ["external_video_vae", 0],
                                "audio_vae": ["external_audio_vae", 0],
                                "segment_data": ["info", 3],
                                "merge_output": True,
                            }},
                }
            def get_node(self, key):
                return self.nodes[key]

        ns = load_functions("_expand_director_loop", context={
            "GraphBuilder": Builder,
            "is_link": lambda v: isinstance(v, list) and len(v) == 2,
        })
        graph = ns["_expand_director_loop"](
            DynPrompt(), "start", {"info", "sampler"}, "end",
            [{"id": "a"}, {"id": "b"}], "{}",
        )
        self.assertEqual(graph["0_info"]["inputs"]["loop_context"], ["frame_0", 0])
        self.assertEqual(graph["1_info"]["inputs"]["loop_context"], ["frame_1", 0])
        self.assertEqual(graph["0_sampler"]["inputs"]["segment_data"], ["0_info", 3])
        self.assertEqual(graph["cache_0"]["inputs"]["samples"], ["0_sampler", 0])
        self.assertEqual(graph["cache_1"]["inputs"]["samples"], ["1_sampler", 0])
        self.assertEqual(graph["iteration_1"]["inputs"]["current_iteration_value"], ["cache_0", 1])
        self.assertEqual(graph["result"]["inputs"]["output0"], ["cache_0", 0])
        self.assertEqual(graph["result"]["inputs"]["output1"], ["cache_1", 0])

    def test_fused_end_materializes_once_or_retains_cache(self):
        descriptions = [
            json.dumps({"frames": 96, "path": "/virtual/1"}),
            json.dumps({"frames": 72, "path": "/virtual/2"}),
        ]
        class Block:
            def get_external_block_result(self, node_id):
                assert node_id == "end"
                return [[descriptions[0]], [descriptions[1]]]
        class Materialize:
            calls = []
            @classmethod
            def execute(cls, **kwargs):
                cls.calls.append(kwargs)
                return FakeNodeOutput("IMAGE", "AUDIO")
        ns = load_functions("TerryDirectorLoopEnd", context={
            "_one": lambda v: v[0] if isinstance(v, list) else v,
            "json": json,
            "TerryDirectorMaterializeTimeline": Materialize,
        })
        cls = ns["TerryDirectorLoopEnd"]
        cls.hidden = types.SimpleNamespace(
            unique_id=["end"], execution_list=Block()
        )
        out = cls.execute(merge_output=[True])
        self.assertEqual(out.args, ("IMAGE", "AUDIO"))
        self.assertEqual(Materialize.calls[0]["expected_frames"], 168)
        self.assertEqual(len(Materialize.calls[0]["segments"]), 2)
        out = cls.execute(merge_output=[False])
        self.assertEqual(out.args, (None, None))
        self.assertEqual(len(Materialize.calls), 1)

    def test_guide_independent_or_tail(self):
        import torch

        calls = []
        class Guide:
            @classmethod
            def execute(cls, **kwargs):
                calls.append(kwargs)
                return FakeNodeOutput(["guided"])
        ns = load_functions("TerryDirectorLoopCondition", context={"MiniMaxH3AddGuide": Guide})
        cls = ns["TerryDirectorLoopCondition"]
        independent = cls.execute("original", "latent", "vae", "audio_vae",
                                  {"_type": "terrydirector.segment_data",
                                   "continuity": {"kind": "independent"}, "previous_context": {}})
        self.assertEqual(independent[0], "original")
        self.assertEqual(len(calls), 0)
        ctx = {"images": torch.ones((1, 4, 4, 3)), "audio": {"waveform": None}}
        guided = cls.execute("original", "latent", "vae", "audio_vae",
                             {"_type": "terrydirector.segment_data",
                              "continuity": {"kind": "tail_frame"}, "previous_context": ctx})
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
        out = ns["TerryDirectorLoopCache"].execute(
            "samples", "vae", "audio",
            {**segment, "_type": "terrydirector.segment_data", "previous_context": {}},
        )
        self.assertEqual(out[0], "descriptor")
        self.assertEqual(out[1], {"images": "tail", "audio": "audio"})
        self.assertEqual(calls[0]["output_frames"], 96)
        self.assertEqual(calls[0]["context_frames"], 12)


if __name__ == "__main__":
    unittest.main()
