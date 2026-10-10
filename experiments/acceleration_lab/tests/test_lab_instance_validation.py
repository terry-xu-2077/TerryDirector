"""Standard-library checks for read-only validation of the isolated lab instance.

HTTP and registry data are synthetic. No server, GPU, model or queue is used.
"""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch
from urllib.error import URLError

LAB = Path(__file__).resolve().parents[1]


def load_validator():
    spec = importlib.util.spec_from_file_location("lab_instance_validator", LAB / "validate_workflows.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LabInstanceValidationTests(unittest.TestCase):
    def setUp(self):
        self.validator = load_validator()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.graph = {
            "1": {"class_type": "TerryAccelLabCondition", "inputs": {}},
            "2": {"class_type": "SyntheticConsumer", "inputs": {"conditioning": ["1", 0]}},
            "3": {"class_type": "TerryAccelLabSaveVideo", "inputs": {"video": ["2", 0]}},
        }
        self.registry = {
            "TerryAccelLabCondition": {"input": {"required": {}}, "output": ["CONDITIONING"]},
            "SyntheticConsumer": {"input": {"required": {"conditioning": ["CONDITIONING", {}]}},
                                  "output": ["VIDEO"]},
            "TerryAccelLabSaveVideo": {"input": {"required": {"video": ["VIDEO", {}]}},
                                      "output": ["VIDEO"], "output_node": True},
        }
        self.api, self.ui = self.write_pair(self.root / "api_dir" / "B0.api.json",
                                           self.root / "ui_dir" / "B0.json")

    def write_pair(self, api, ui):
        api.parent.mkdir(parents=True, exist_ok=True)
        ui.parent.mkdir(parents=True, exist_ok=True)
        api.write_text(json.dumps({"prompt": self.graph}), encoding="utf-8")
        workflow = {"nodes": [{"id": int(k), "type": n["class_type"]} for k, n in self.graph.items()],
                    "links": [], "extra": {"acceleration_lab_api": copy.deepcopy(self.graph)}}
        ui.write_text(json.dumps(workflow), encoding="utf-8")
        return api, ui

    def cli(self, extra=()):
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = self.validator.main(["--api", str(self.api), "--ui", str(self.ui), *extra])
        return code, json.loads(stream.getvalue())

    def test_accepts_only_loopback_lab_url(self):
        for url in ("http://127.0.0.1:8190", "http://localhost:8190/", "http://[::1]:8190"):
            with self.subTest(url=url):
                self.assertEqual(self.validator.lab_server_url(url), url.rstrip("/"))

    def test_refuses_production_remote_and_ambiguous_urls(self):
        for url in ("http://127.0.0.1:8188", "http://localhost:8188", "http://example.org:8190",
                    "http://127.0.0.1", "https://127.0.0.1:8190", "http://127.0.0.1:8190/path",
                    "http://a@127.0.0.1:8190", "http://127.0.0.1:8190/?x=1",
                    "http://127.0.0.1:8190/#x", "http://127.0.0.1:notaport"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.validator.lab_server_url(url)

    def test_missing_upstream_registration_is_reported_not_keyerror(self):
        del self.registry["TerryAccelLabCondition"]
        errors = self.validator.validate(self.api, self.ui, self.registry)
        self.assertTrue(any("1: unregistered TerryAccelLabCondition" in e for e in errors))
        self.assertTrue(any("2.conditioning: source 1 is unregistered" in e for e in errors))

    def test_valid_graph_and_registry_are_unchanged(self):
        before = copy.deepcopy(self.registry)
        api_before, ui_before = self.api.read_bytes(), self.ui.read_bytes()
        self.assertEqual(self.validator.validate(self.api, self.ui, self.registry), [])
        self.assertEqual(self.registry, before)
        self.assertEqual((self.api.read_bytes(), self.ui.read_bytes()), (api_before, ui_before))

    def test_invalid_output_slot_still_rejected(self):
        self.graph["2"]["inputs"]["conditioning"][1] = 9
        self.write_pair(self.api, self.ui)
        self.assertTrue(any("invalid source slot" in e for e in
                            self.validator.validate(self.api, self.ui, self.registry)))

    def test_dynamic_combo_rules_still_apply(self):
        declared = {"required": {"selection": ["COMFY_DYNAMICCOMBO_V3", {"options": [
            {"key": "sol-attn", "inputs": {"required": {"tau": ["FLOAT", {}]}}}]}]}}
        errors = []
        expanded = self.validator.expand_dynamic_definitions(
            declared, {"selection": "sol-attn", "selection.tau": 1.0}, errors)
        self.assertEqual(errors, [])
        self.assertIn("selection.tau", expanded["required"])
        errors = []
        self.validator.expand_dynamic_definitions(
            declared, {"selection": {"selection": "sol-attn", "tau": 1.0}}, errors)
        self.assertTrue(any("requires a string" in e for e in errors))

    def test_registry_read_is_one_get_and_preserves_scope(self):
        opener = Mock()
        opener.open.return_value = io.StringIO(json.dumps(self.registry))
        with patch.object(self.validator, "build_opener", return_value=opener):
            result = self.validator.read_lab_registry("http://127.0.0.1:8190", {"TerryAccelLabCondition"})
        self.assertEqual(result, self.registry)
        opener.open.assert_called_once_with("http://127.0.0.1:8190/object_info", timeout=20)

    def test_missing_lab_nodes_refused_at_registry_boundary(self):
        opener = Mock()
        opener.open.return_value = io.StringIO("{}")
        with patch.object(self.validator, "build_opener", return_value=opener):
            with self.assertRaisesRegex(ValueError, "not loaded.*TerryAccelLabCondition"):
                self.validator.read_lab_registry("http://127.0.0.1:8190", {"TerryAccelLabCondition"})

    def test_nondict_registry_rejected(self):
        opener = Mock()
        opener.open.return_value = io.StringIO("[]")
        with patch.object(self.validator, "build_opener", return_value=opener):
            with self.assertRaisesRegex(ValueError, "not a node registry"):
                self.validator.read_lab_registry("http://127.0.0.1:8190", set())

    def test_redirect_to_other_instance_refused(self):
        with self.assertRaisesRegex(URLError, "redirects are refused"):
            self.validator._NoRedirect().redirect_request(None, None, 302, "", {},
                                                          "http://127.0.0.1:8188/object_info")

    def test_cli_production_url_refused_before_http(self):
        with patch.object(self.validator, "read_lab_registry") as read:
            code, result = self.cli(["--server", "http://127.0.0.1:8188"])
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "WRONG_INSTANCE")
        read.assert_not_called()

    def test_cli_connection_failure_never_falls_back(self):
        with patch.object(self.validator, "read_lab_registry", side_effect=URLError("refused")) as read:
            code, result = self.cli()
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "LAB_UNREACHABLE_OR_NOT_READY")
        self.assertIn("start_lab.ps1", result["next_action"])
        self.assertEqual(read.call_count, 1)
        self.assertEqual(read.call_args.args[0], "http://127.0.0.1:8190")
        self.assertEqual(result["generation_submissions"], 0)

    def test_cli_single_pair_across_directories(self):
        with patch.object(self.validator, "read_lab_registry", return_value=self.registry):
            code, result = self.cli()
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "SCHEMA_VALIDATED")
        self.assertEqual(list(result["workflows"]), [str(self.api)])
        self.assertFalse(result["runtime_identity_verified"])
        self.assertEqual(result["generation_submissions"], 0)

    def test_cli_original_directory_mode_kept(self):
        names = ("Lab_B0_Dense_Clip1", "Lab_B1_SolAttn_Clip1",
                 "Lab_V0_CurrentVAE_Decode", "Lab_V1_INT8VAE_Decode")
        for name in names:
            self.write_pair(self.root / (name + ".api.json"), self.root / (name + ".json"))
        output = io.StringIO()
        with patch.object(self.validator, "read_lab_registry", return_value=self.registry), redirect_stdout(output):
            code = self.validator.main(["--directory", str(self.root)])
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads(output.getvalue())["workflows"]), 4)

    def test_cli_missing_private_file_does_not_query_server(self):
        self.ui.unlink()
        with patch.object(self.validator, "read_lab_registry") as read:
            code, result = self.cli()
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "PRECHECK_BLOCKED")
        read.assert_not_called()

    def test_cli_schema_error_not_overridden(self):
        self.registry["SyntheticConsumer"]["input"]["required"]["must_have"] = ["FLOAT", {}]
        with patch.object(self.validator, "read_lab_registry", return_value=self.registry):
            code, result = self.cli()
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "VALIDATION_FAILED")
        self.assertTrue(any("must_have" in e for e in result["workflows"][str(self.api)]))


if __name__ == "__main__":
    unittest.main()
