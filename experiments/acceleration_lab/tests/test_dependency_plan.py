"""Synthetic metadata tests; no packages are installed and no CUDA is imported."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

path = Path(__file__).resolve().parents[1] / "check_dependency_plan.py"
spec = importlib.util.spec_from_file_location("dep_guard", path)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


def row(name, version, *requirements, python=None):
    return {"name": name, "version": version, "requires_dist": list(requirements), "requires_python": python}


class DependencyPlanTests(unittest.TestCase):
    def setUp(self):
        self.core = {"torch": "2.11.0+cu130"}
        self.targets = {"numpy": "2.3.2", "pydantic": "2.11.10", "pydantic-core": "2.33.2", "kornia": "0.8.2"}
        self.current = [row("torch", "2.11.0+cu130"), row("numpy", "2.5.3"),
                        row("pydantic", "2.13.5", "pydantic-core==2.40.0"), row("pydantic-core", "2.40.0"),
                        row("kornia", "0.8.3", "torch>=2"), row("numba", "0.1", "numpy<2.5"),
                        row("llama-cpp-python", "0.1", "numpy<=2.3.2"), row("example-consumer", "1", "pydantic<2.12")]
        self.changes = [row("numpy", "2.3.2", python=">=3.11"),
                        row("pydantic", "2.11.10", "pydantic-core==2.33.2"),
                        row("pydantic-core", "2.33.2"), row("kornia", "0.8.2", "torch>=2")]
        self.env = {"python_full_version": "3.12.13", "python_version": "3.12", "sys_platform": "win32",
                    "platform_system": "Windows", "platform_machine": "AMD64", "implementation_name": "cpython"}

    def check(self):
        return g.validate(self.current, self.changes, self.core, self.targets, self.env)

    def test_targeted_repair_passes_without_input_mutation(self):
        before = copy.deepcopy((self.current, self.changes, self.env))
        self.assertTrue(self.check()["ok"])
        self.assertEqual(before, (self.current, self.changes, self.env))

    def test_cu128_current_rejected(self):
        self.current[0]["version"] = "2.11.0+cu128"
        self.assertFalse(self.check()["ok"])

    def test_even_same_version_core_reinstall_is_rejected(self):
        self.changes.append(row("torch", "2.11.0+cu130"))
        self.assertTrue(any("Protected package" in e for e in self.check()["errors"]))

    def test_unknown_dependency_plan_change_rejected(self):
        self.changes.append(row("unrelated", "1"))
        self.assertFalse(self.check()["ok"])

    def test_different_target_version_rejected(self):
        self.changes[0]["version"] = "2.3.1"
        self.assertFalse(self.check()["ok"])

    def test_reverse_requirement_outside_install_request_is_checked(self):
        self.current.append(row("other-installed-plugin", "1", "numpy>=2.4"))
        self.assertTrue(any("other-installed-plugin" in e for e in self.check()["errors"]))

    def test_pydantic_settings_conflict_is_not_ignored(self):
        self.current.append(row("pydantic-settings", "9", "pydantic>=2.12"))
        self.assertFalse(self.check()["ok"])

    def test_pydantic_core_must_match(self):
        self.changes = [r for r in self.changes if r["name"] != "pydantic-core"]
        self.assertFalse(self.check()["ok"])

    def test_optional_extras_are_labelled_not_assumed(self):
        self.current.append(row("optional", "1", 'missing-extra; extra == "dev"'))
        self.assertTrue(self.check()["ok"])
        self.assertTrue(self.check()["limitations"])

    def test_windows_marker_is_checked(self):
        self.current.append(row("platform-test", "1", 'missing-wheel; sys_platform == "win32"'))
        self.assertFalse(self.check()["ok"])

    def test_inactive_platform_marker_is_skipped(self):
        self.current.append(row("platform-test", "1", 'missing-linux; sys_platform == "linux"'))
        self.assertTrue(self.check()["ok"])

    def test_python_requirement_rejected(self):
        self.changes[0]["requires_python"] = ">=3.13"
        self.assertFalse(self.check()["ok"])

    def test_duplicate_metadata_rejected(self):
        self.current.append(row("Pydantic_Core", "2.40.0"))
        with self.assertRaises(ValueError):
            self.check()

    def test_protected_allowlist_overlap_rejected(self):
        self.targets["torch"] = "2.11.0+cu130"
        self.assertFalse(self.check()["ok"])

    def test_final_installed_state_passes(self):
        final = {r["name"]: r for r in self.current}
        final.update({r["name"]: r for r in self.changes})
        self.assertTrue(g.validate(list(final.values()), [], self.core, self.targets, self.env)["ok"])

    def test_direct_url_requires_manual_source_check(self):
        self.current.append(row("url-consumer", "1", "numpy @ https://example.invalid/numpy.whl"))
        result = self.check()
        self.assertTrue(result["ok"])
        self.assertEqual(result["direct_url_dependencies_requiring_manual_source_check"], ["url-consumer -> numpy"])

    def test_pin_parser(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "pins.txt"
            p.write_text("# note\nPydantic_Core==2.33.2\n", encoding="utf-8")
            self.assertEqual(g.read_pins(p), {"pydantic-core": "2.33.2"})
            for bad in ("numpy>=2", "numpy==2.*", "--index-url https://example.invalid", "numpy==2\nnumpy==3", ""):
                p.write_text(bad, encoding="utf-8")
                with self.assertRaises(ValueError):
                    g.read_pins(p)


if __name__ == "__main__":
    unittest.main()
