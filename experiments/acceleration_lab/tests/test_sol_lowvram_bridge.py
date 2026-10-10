"""Portable routing/isolation tests. No ComfyUI install or model weights required."""
import copy
import importlib.util
import inspect
from pathlib import Path
import random
from types import MethodType, SimpleNamespace
import unittest

LAB = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, LAB / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("sol_lowvram_bridge")
workflow = load("build_sol_bridge_workflow")


class FakeBlock:
    def __init__(self):
        self.calls = []

    def minimax_block_lowmem_forward(self, x, t_emb, mod_segments, rope_freqs, transformer_options={}):
        self.calls.append((x, t_emb, mod_segments, rope_freqs, transformer_options))
        return x


def native_forward(self, x, t_emb, mod_segments, rope_freqs, transformer_options={}, attention=None):
    self.calls.append(("native", x, transformer_options))
    return attention(x, rope_freqs=rope_freqs, transformer_options=transformer_options)


class Model:
    def __init__(self, count=2):
        self.diffusion = SimpleNamespace(blocks=[FakeBlock() for _ in range(count)])
        self.object_patches = {}
        for i, block in enumerate(self.diffusion.blocks):
            base = f"diffusion_model.blocks.{i}"
            self.object_patches[base + ".forward"] = block.minimax_block_lowmem_forward
            self.object_patches[base + ".attn.forward"] = object()
            self.object_patches[base + ".mlp.forward"] = object()
        self.model_options = {"transformer_options": {"minimax_head_chunks": 4, "optimized_attention_override": "Kitchen"}}
        self.clones = 0

    def get_model_object(self, name):
        assert name == "diffusion_model"
        return self.diffusion

    def clone(self):
        self.clones += 1
        result = copy.copy(self)
        result.object_patches = self.object_patches.copy()
        result.model_options = copy.deepcopy(self.model_options)
        return result

    def add_object_patch(self, key, value):
        self.object_patches[key] = value


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.block = FakeBlock()
        self.old = self.block.minimax_block_lowmem_forward
        self.forward = bridge.bridge_forward(self.old, native_forward)
        self.values = [object() for _ in range(4)]
        self.options = {"sigmas": object(), "minimax_head_chunks": 4}

    def test_old_explicit_none_reproduces_error(self):
        with self.assertRaisesRegex(TypeError, "attention"):
            self.old(*self.values, transformer_options=self.options, attention=None)

    def test_dense_none_calls_existing_forward_once(self):
        result = self.forward(*self.values, transformer_options=self.options, attention=None)
        self.assertIs(result, self.values[0])
        self.assertEqual(len(self.block.calls), 1)
        self.assertEqual(self.block.calls[0][:4], tuple(self.values))
        self.assertIs(self.block.calls[0][4], self.options)

    def test_missing_attention_stays_dense(self):
        self.assertIs(self.forward(*self.values), self.values[0])
        self.assertEqual(len(self.block.calls), 1)

    def test_supplied_attention_is_called_once_with_original_objects(self):
        seen, result = [], object()
        def attention(x, **kw):
            seen.append((x, kw))
            return result
        actual = self.forward(*self.values, transformer_options=self.options, attention=attention)
        self.assertIs(actual, result)
        self.assertEqual(len(seen), 1)
        self.assertIs(seen[0][0], self.values[0])
        self.assertIs(seen[0][1]["rope_freqs"], self.values[3])
        self.assertIs(seen[0][1]["transformer_options"], self.options)
        self.assertEqual(self.block.calls[0][0], "native")
        self.assertEqual(len(self.block.calls), 1)

    def test_sparse_error_is_not_hidden_or_retried_dense(self):
        error = MemoryError("original OOM")
        def fail(*args, **kwargs):
            raise error
        with self.assertRaises(MemoryError) as caught:
            self.forward(*self.values, attention=fail)
        self.assertIs(caught.exception, error)
        self.assertEqual(len(self.block.calls), 1)
        self.assertEqual(self.block.calls[0][0], "native")

    def test_noncallable_rejected_before_forward(self):
        with self.assertRaises(TypeError):
            self.forward(*self.values, attention="bad")
        self.assertEqual(self.block.calls, [])

    def test_rng_unchanged(self):
        before = random.getstate()
        self.forward(*self.values, attention=lambda x, **kw: x)
        self.assertEqual(random.getstate(), before)

    def test_signature_accepts_native_keyword(self):
        inspect.signature(self.forward).bind(*self.values, attention=None)

    def test_unknown_patch_rejected(self):
        def other(self, *args, **kw):
            return None
        with self.assertRaises(ValueError):
            bridge.bridge_forward(MethodType(other, self.block), native_forward)

    def test_already_fixed_version_is_not_silently_wrapped(self):
        def minimax_block_lowmem_forward(self, x, attention=None):
            return x
        with self.assertRaisesRegex(ValueError, "already"):
            bridge.bridge_forward(MethodType(minimax_block_lowmem_forward, self.block), native_forward)

    def test_clone_changes_only_block_forward_keys(self):
        model = Model()
        before = model.object_patches.copy()
        options = copy.deepcopy(model.model_options)
        cloned = bridge.bridge_model(model, native_forward, FakeBlock)
        self.assertIsNot(cloned, model)
        self.assertEqual(model.object_patches, before)
        self.assertEqual(model.model_options, options)
        self.assertEqual(cloned.model_options, options)
        for key, original in before.items():
            if key.endswith(".attn.forward") or key.endswith(".mlp.forward"):
                self.assertIs(cloned.object_patches[key], original)
            else:
                self.assertIsNot(cloned.object_patches[key], original)
                self.assertIs(cloned.object_patches[key].__self__, original.__self__)
        # Installing the mapping never changes the live module itself.
        self.assertEqual(model.diffusion.blocks[0].minimax_block_lowmem_forward.__func__, FakeBlock.minimax_block_lowmem_forward)

    def test_all_blocks_validated_before_clone(self):
        model = Model()
        del model.object_patches["diffusion_model.blocks.1.forward"]
        with self.assertRaises(ValueError):
            bridge.bridge_model(model, native_forward)
        self.assertEqual(model.clones, 0)

    def test_wrong_block_type_rejected(self):
        with self.assertRaises(TypeError):
            bridge.bridge_model(Model(), native_forward, str)

    def test_each_block_keeps_its_own_bound_forward(self):
        model = Model()
        cloned = bridge.bridge_model(model, native_forward)
        for i in range(2):
            cloned.object_patches[f"diffusion_model.blocks.{i}.forward"](*self.values)
        self.assertEqual([len(b.calls) for b in model.diffusion.blocks], [1, 1])


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        graph = {
            "5": {"class_type": "MiniMaxChunkFeedForward", "inputs": {"chunks": 2}},
            "6": {"class_type": "BlockSparseAttention", "inputs": {"model": ["5", 0], "selection": "sol-attn", "selection.tau": 1.0}},
            "7": {"class_type": "TerryAccelLabSelfLift", "inputs": {"model": ["6", 0], "seed": 1000}},
        }
        self.api = {"prompt": graph}
        self.ui = {"nodes": [
            {"id": 5, "type": "MiniMaxChunkFeedForward", "outputs": [{"links": [1]}]},
            {"id": 6, "type": "BlockSparseAttention", "inputs": [{"name": "model", "link": 1}], "outputs": [{"links": [2]}], "pos": [400, 100]},
            {"id": 7, "type": "TerryAccelLabSelfLift", "inputs": [{"name": "model", "link": 2}]},
        ], "links": [[1, 5, 0, 6, 0, "MODEL"], [2, 6, 0, 7, 0, "MODEL"]],
            "last_node_id": 7, "last_link_id": 2, "extra": {"acceleration_lab_api": copy.deepcopy(graph)}}

    def test_changes_only_added_node_and_sparse_model_edge(self):
        before = copy.deepcopy((self.api, self.ui))
        api, ui, diff = workflow.add_bridge(self.api, self.ui)
        self.assertEqual((self.api, self.ui), before)
        self.assertEqual(api["prompt"]["5"], self.api["prompt"]["5"])
        self.assertEqual(api["prompt"]["7"], self.api["prompt"]["7"])
        self.assertEqual(api["prompt"]["6"]["inputs"]["selection.tau"], 1.0)
        self.assertEqual(api["prompt"]["6"]["inputs"]["model"], ["8", 0])
        self.assertEqual(api["prompt"]["8"], {"class_type": workflow.BRIDGE, "inputs": {"model": ["5", 0]}})
        self.assertEqual(ui["extra"]["acceleration_lab_api"], api["prompt"])
        self.assertEqual(ui["links"], [[1, 8, 0, 6, 0, "MODEL"], [2, 6, 0, 7, 0, "MODEL"], [3, 5, 0, 8, 0, "MODEL"]])
        self.assertEqual(ui["nodes"][0]["outputs"][0]["links"], [3])
        self.assertEqual(diff["added_node"], "8")

    def test_duplicate_bridge_rejected(self):
        api, ui, _ = workflow.add_bridge(self.api, self.ui)
        with self.assertRaises(ValueError):
            workflow.add_bridge(api, ui)

    def test_inconsistent_ui_rejected(self):
        self.ui["links"][0][1] = 7
        with self.assertRaises(ValueError):
            workflow.add_bridge(self.api, self.ui)

    def test_embedded_api_mismatch_rejected(self):
        self.ui["extra"]["acceleration_lab_api"]["7"]["inputs"]["seed"] = 42
        with self.assertRaises(ValueError):
            workflow.add_bridge(self.api, self.ui)


if __name__ == "__main__":
    unittest.main()
