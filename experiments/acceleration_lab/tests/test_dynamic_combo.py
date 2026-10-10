"""Synthetic registry tests; real installed V3 binding is a separate preflight."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

LAB = Path(__file__).resolve().parents[1]


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DynamicComboTests(unittest.TestCase):
    def setUp(self):
        self.validator = load(LAB / "validate_workflows.py")
        # Reuse the synthetic private-data-free graph fixture, not a real request.
        fixture = load(LAB / "tests" / "test_lab_helpers.py").BuilderTests()
        fixture.setUp()
        self.builder = fixture.builder
        self.graph = self.builder.build_sample(fixture.source, fixture.segment, "B1")
        self.ui = self.builder.build_ui(self.graph)
        self.registry = {}
        for node in self.ui["nodes"]:
            definitions = {}
            for inp in node["inputs"]:
                name = inp["name"]
                value = self.graph[str(node["id"])]["inputs"][name]
                kind = inp["type"] if inp["link"] is not None else (
                    "BOOLEAN" if isinstance(value, bool) else
                    "INT" if isinstance(value, int) else
                    "FLOAT" if isinstance(value, float) else "STRING")
                definitions[name] = [kind, {}]
            self.registry[node["type"]] = {
                "input": {"required": definitions},
                "output": [out["type"] for out in node["outputs"]],
                "output_node": node["type"] == "TerryAccelLabSaveVideo",
            }
        definitions = self.registry["BlockSparseAttention"]["input"]["required"]
        definitions.pop("selection.tau")
        definitions["selection"] = ["COMFY_DYNAMICCOMBO_V3", {"options": [
            {"key": "sol-attn", "inputs": {"required": {"tau": ["FLOAT", {"min": 0, "max": 10}]}}},
            {"key": "sla", "inputs": {"required": {"keep_percent": ["FLOAT", {}]}}},
        ]}]
        self.inputs = self.graph["6"]["inputs"]

    def check(self, refresh_ui=True):
        if refresh_ui:
            self.ui = self.builder.build_ui(self.graph)
        with tempfile.TemporaryDirectory() as directory:
            api, ui = Path(directory) / "api.json", Path(directory) / "ui.json"
            api.write_text(json.dumps({"prompt": self.graph}), encoding="utf-8")
            ui.write_text(json.dumps(self.ui), encoding="utf-8")
            return self.validator.validate(api, ui, self.registry)

    def test_flat_form_and_generated_ui_pass(self):
        self.assertEqual(self.inputs["selection"], "sol-attn")
        self.assertEqual(self.inputs["selection.tau"], 1.0)
        self.assertEqual(self.check(), [])

    def test_old_execute_dict_is_rejected(self):
        self.inputs.pop("selection.tau")
        self.inputs["selection"] = {"selection": "sol-attn", "tau": 1.0}
        self.assertTrue(any("DynamicCombo requires a string" in e for e in self.check()))

    def test_missing_selected_child_is_rejected(self):
        self.inputs.pop("selection.tau")
        self.assertTrue(any("missing" in e and "selection.tau" in e for e in self.check()))

    def test_unprefixed_child_is_rejected(self):
        self.inputs["tau"] = self.inputs.pop("selection.tau")
        self.assertTrue(any("unknown input tau" in e for e in self.check()))

    def test_missing_selector_is_rejected(self):
        self.inputs.pop("selection")
        self.assertTrue(any("missing" in e and "selection" in e for e in self.check()))

    def test_unknown_selection_is_rejected(self):
        self.inputs["selection"] = "unknown"
        self.assertTrue(any("DynamicCombo requires a string" in e for e in self.check()))

    def test_inactive_branch_child_is_rejected(self):
        self.inputs["selection.keep_percent"] = 25.0
        self.assertTrue(any("unknown input selection.keep_percent" in e for e in self.check()))

    def test_wrong_tau_preserves_fixed_experiment_preset(self):
        self.inputs["selection.tau"] = 1.3
        self.assertTrue(any("expected lab Sol preset" in e for e in self.check()))

    def test_stale_ui_named_selection_is_rejected(self):
        node = next(n for n in self.ui["nodes"] if n["id"] == 6)
        node["widgets_values_named"]["selection"] = {"selection": "sol-attn", "tau": 1.0}
        self.assertTrue(any("UI/API dynamic widget differs" in e for e in self.check(False)))

    def test_stale_embedded_api_is_rejected(self):
        self.ui["extra"]["acceleration_lab_api"] = {}
        self.assertTrue(any("UI embedded API differs" in e for e in self.check(False)))

    def test_selected_schema_only_and_no_mutation(self):
        declared = self.registry["BlockSparseAttention"]["input"]
        before, input_before = copy.deepcopy(declared), copy.deepcopy(self.inputs)
        errors = []
        expanded = self.validator.expand_dynamic_definitions(declared, self.inputs, errors)
        self.assertIn("selection.tau", expanded["required"])
        self.assertNotIn("selection.keep_percent", expanded["required"])
        self.assertEqual(errors, [])
        self.assertEqual(declared, before)
        self.assertEqual(self.inputs, input_before)

    def test_nested_dynamic_schema_uses_dotted_prefixes(self):
        declared = {"required": {"outer": ["COMFY_DYNAMICCOMBO_V3", {"options": [
            {"key": "on", "inputs": {"required": {
                "inner": ["COMFY_DYNAMICCOMBO_V3", {"options": [
                    {"key": "x", "inputs": {"required": {"weight": ["FLOAT", {}]}}}
                ]}]
            }}}
        ]}]}}
        errors = []
        expanded = self.validator.expand_dynamic_definitions(
            declared, {"outer": "on", "outer.inner": "x", "outer.inner.weight": 1.0}, errors)
        self.assertEqual(set(expanded["required"]), {"outer", "outer.inner", "outer.inner.weight"})
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
