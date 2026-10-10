"""Portable audit tests: no torch, CUDA, server, model or kernel required."""
import builtins
import copy
import importlib.util
import json
import os
from pathlib import Path
import random
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

PATH = Path(__file__).resolve().parents[1] / "sol_runtime_audit.py"
spec = importlib.util.spec_from_file_location("sol_runtime_audit_tested", PATH)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def fixture(*, disabled=False, extension=True, symbol=True, rules=True, capability=(8, 6), cuda=True):
    states = {"cuda": {"available": True, "disabled": disabled, "unavailable_reason": None,
                        "capabilities": ["sol_attn"]}}
    constraints = types.SimpleNamespace(min_compute_capability=(8, 0)) if rules else None
    registry = types.SimpleNamespace(
        is_available=lambda name: states[name]["available"] and not states[name]["disabled"],
        get_constraints=lambda *args: constraints,
        enable=Mock(side_effect=AssertionError("must not enable")),
        disable=Mock(side_effect=AssertionError("must not disable")))
    ext = types.SimpleNamespace(sol_attn=lambda: None) if symbol else types.SimpleNamespace()
    torch = types.SimpleNamespace(__version__="2.11.0+cu128", version=types.SimpleNamespace(cuda="12.8"),
        device=lambda name: types.SimpleNamespace(type="cuda", index=0),
        cuda=types.SimpleNamespace(is_available=lambda: cuda, current_device=lambda: 0,
            get_device_capability=lambda device: capability, get_device_name=lambda device: "test GPU"))
    ck = types.SimpleNamespace(registry=registry, _cuda_backend=types.SimpleNamespace(_C=ext, _EXT_AVAILABLE=extension),
        list_backends=lambda: copy.deepcopy(states), sol_attn_chunked=Mock(side_effect=AssertionError("no kernels")))
    ck.sol_attn_is_available = lambda device: cuda and registry.is_available("cuda") and extension and symbol and rules and capability >= (8, 0)
    return torch, ck, states


class AuditTests(unittest.TestCase):
    def setUp(self):
        version = patch.object(audit, "_version", return_value="0.2.37")
        version.start(); self.addCleanup(version.stop)

    def snap(self, **kwargs):
        torch, ck, states = fixture(**kwargs)
        before, rng = copy.deepcopy(states), random.getstate()
        out = audit.snapshot(torch, ck, "test", modules={})
        self.assertEqual(states, before)
        self.assertEqual(random.getstate(), rng)
        ck.registry.enable.assert_not_called()
        ck.registry.disable.assert_not_called()
        ck.sol_attn_chunked.assert_not_called()
        self.assertFalse(out["generation_allowed"])
        return out

    def test_available_is_not_smoke_or_generation_permission(self):
        result = self.snap()
        self.assertTrue(result["sol_available"])
        self.assertEqual(result["failed_gate_fields"], [])
        self.assertFalse(result["kernel_smoke_executed"])

    def test_disabled_with_present_extension_is_not_missing_binary(self):
        result = self.snap(disabled=True)
        self.assertEqual(result["status"], "CUDA_REGISTRY_DISABLED")
        self.assertEqual(result["failed_gate_fields"], ["registry_cuda_available_and_enabled"])
        self.assertTrue(result["gate_fields"]["extension_has_sol_attn"])

    def test_missing_extension_flag_recorded(self):
        result = self.snap(extension=False)
        self.assertIn("extension_loaded", result["failed_gate_fields"])
        self.assertNotEqual(result["status"], "CUDA_REGISTRY_DISABLED")

    def test_missing_symbol_recorded(self):
        self.assertIn("extension_has_sol_attn", self.snap(symbol=False)["failed_gate_fields"])

    def test_missing_rules_not_mislabeled_device_failure(self):
        result = self.snap(rules=False)
        self.assertIn("sol_constraints_present", result["failed_gate_fields"])
        self.assertIsNone(result["gate_fields"]["device_meets_minimum"])

    def test_insufficient_arch_recorded(self):
        self.assertIn("device_meets_minimum", self.snap(capability=(7, 5))["failed_gate_fields"])

    def test_cpu_only_does_not_query_device(self):
        torch, ck, _ = fixture(cuda=False)
        torch.cuda.current_device = Mock(side_effect=AssertionError("no device queries"))
        result = audit.snapshot(torch, ck, "cpu", modules={})
        self.assertFalse(result["sol_available"])
        self.assertIsNone(result["device"])
        torch.cuda.current_device.assert_not_called()

    def test_missing_api_is_unknown_not_false_success(self):
        torch, ck, _ = fixture()
        del ck.sol_attn_is_available
        result = audit.snapshot(torch, ck, "missing", modules={})
        self.assertIsNone(result["sol_available"])
        self.assertEqual(result["status"], "AUDIT_INCOMPLETE")
        self.assertTrue(result["errors"])

    def test_query_error_is_preserved(self):
        torch, ck, _ = fixture()
        ck.sol_attn_is_available = Mock(side_effect=RuntimeError("test check failed"))
        result = audit.snapshot(torch, ck, "bad", modules={})
        self.assertEqual(result["errors"][0]["error"], "RuntimeError: test check failed")

    def test_write_preserves_existing_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "sample.json"
            audit.write_new(path, {"value": 1})
            with self.assertRaises(FileExistsError):
                audit.write_new(path, {"value": 2})
            self.assertEqual(json.loads(path.read_text())["value"], 1)

    def test_default_startup_no_work(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(audit, "snapshot") as snapshot:
            self.assertIsNone(audit.startup_audit_if_enabled())
        snapshot.assert_not_called()

    def test_live_startup_reads_loaded_objects_only(self):
        torch, ck, _ = fixture(disabled=True)
        with tempfile.TemporaryDirectory() as temp:
            modules = {"torch": torch, "comfy_kitchen": ck, "comfy.quant_ops": types.SimpleNamespace(),
                       "folder_paths": types.SimpleNamespace(get_output_directory=lambda: temp)}
            with patch.dict(os.environ, {"TERRY_ACCEL_LAB_SOL_AUDIT": "1"}), patch.dict(sys.modules, modules), patch.object(builtins, "print"):
                result = audit.startup_audit_if_enabled()
            self.assertEqual(result["snapshots"][0]["status"], "CUDA_REGISTRY_DISABLED")
            self.assertTrue(result["snapshots"][0]["quant_ops_loaded"])
            self.assertEqual(len(list(Path(temp).rglob("*.json"))), 1)
            ck.registry.enable.assert_not_called()

    def test_live_startup_missing_loaded_dependencies_fails_without_importing(self):
        with patch.dict(os.environ, {"TERRY_ACCEL_LAB_SOL_AUDIT": "1"}), patch.dict(sys.modules, {"torch": None}), patch.object(audit.importlib, "import_module") as load:
            with self.assertRaisesRegex(RuntimeError, "already-loaded"):
                audit.startup_audit_if_enabled()
        load.assert_not_called()

    def test_cli_before_after_and_argv_restoration(self):
        torch, ck, states = fixture()
        old_argv, old_path = sys.argv[:], sys.path[:]
        def load(name):
            if name == "torch": return torch
            if name == "comfy_kitchen": return ck
            if name == "comfy.quant_ops":
                states["cuda"]["disabled"] = True
                sys.modules[name] = types.SimpleNamespace()
                return sys.modules[name]
            raise AssertionError(name)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "comfy").mkdir()
            (root / "comfy/quant_ops.py").write_text("# simulated fixture\n")
            out = root / "audit.json"
            with patch.dict(sys.modules, {"comfy.quant_ops": None}), patch.object(audit.importlib, "import_module", side_effect=load), patch.object(builtins, "print"):
                result = audit.main(["--comfy-root", temp, "--output", str(out)])
            data = json.loads(out.read_text())
        self.assertEqual(result, 0)
        self.assertTrue(data["availability_changed"])
        self.assertTrue(data["cuda_disabled_changed"])
        self.assertFalse(data["generation_allowed"])
        self.assertEqual(sys.argv, old_argv)
        self.assertEqual(sys.path, old_path)

    def test_cli_import_error_saves_stop_record(self):
        torch, ck, _ = fixture()
        def load(name):
            if name == "torch": return torch
            if name == "comfy_kitchen": return ck
            raise ImportError("synthetic quant import error")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "comfy").mkdir()
            (root / "comfy/quant_ops.py").write_text("# simulated fixture\n")
            out = root / "audit.json"
            with patch.dict(sys.modules, {"comfy.quant_ops": None}), patch.object(audit.importlib, "import_module", side_effect=load), patch.object(builtins, "print"):
                code = audit.main(["--comfy-root", temp, "--output", str(out)])
            data = json.loads(out.read_text())
        self.assertEqual(code, 2)
        self.assertEqual(len(data["snapshots"]), 1)
        self.assertIn("synthetic quant import error", data["traceback"])
        self.assertFalse(data["generation_allowed"])


if __name__ == "__main__":
    unittest.main()
