"""No ComfyUI, CUDA, network or model files required."""
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("lab_isolation", Path(__file__).resolve().parents[1] / "check_isolation.py")
lab = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lab)


def node(kind):
    return {"class_type": kind, "inputs": {}}


class PromptBoundaryTests(unittest.TestCase):
    def test_read_only_sampler_allowed(self):
        self.assertEqual(lab.prompt_errors({"1": node("TerryDirectorSelfLiftSampler")}), [])

    def test_lab_chain_allowed(self):
        payload = {"prompt": {"1": node("TerryAccelLabSelfLift"), "2": node("SaveVideo")}, "client_id": "local"}
        self.assertEqual(lab.prompt_errors(payload), [])

    def test_director_family_forbidden(self):
        for kind in ("TerryDirector", "TerryDirectorAdvanced", "TerryDirectorConfig", "TerryDirectorSecondPassConfig", "TerryDirectorOutput"):
            with self.subTest(kind=kind):
                self.assertTrue(lab.prompt_errors({"1": node(kind)}))

    def test_external_sampler_forbidden(self):
        self.assertTrue(lab.prompt_errors({"1": node("SelfLiftAvatarH3Sampler")}))

    def test_decode_rejects_sampling(self):
        for kind in ("TerryAccelLabSelfLift", "TerryDirectorSelfLiftSampler", "KSampler", "SamplerCustomAdvanced", "UNETLoader", "MiniMaxH3ReferenceToVideo"):
            with self.subTest(kind=kind):
                self.assertTrue(lab.prompt_errors({"1": node(kind)}, "decode"))

    def test_decode_chain_allowed(self):
        self.assertEqual(lab.prompt_errors({"1": node("TerryAccelLabLoadAVLatent"), "2": node("VAEDecode")}, "decode"), [])

    def test_ui_workflow_and_empty_inputs_rejected(self):
        for payload in ([], {}, {"prompt": {}}, {"nodes": [{"type": "LoadImage"}]}):
            with self.subTest(payload=payload):
                self.assertTrue(lab.prompt_errors(payload))

    def test_changes_do_not_mutate_api(self):
        payload = {"1": node("TerryDirector")}
        before = repr(payload)
        lab.prompt_errors(payload)
        self.assertEqual(repr(payload), before)


@unittest.skipUnless(shutil.which("git"), "Git is required for real repository boundary checks")
class RepoBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Lab test")
        self.git("config", "user.email", "lab-test@example.invalid")
        (self.root / "director_node.py").write_text("original\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True).stdout

    def test_clean_repo(self):
        self.assertEqual(lab.changed_paths(self.root, self.base), [])

    def test_new_lab_files_allowed(self):
        target = self.root / "experiments/acceleration_lab/example.py"
        target.parent.mkdir(parents=True)
        target.write_text("# lab only\n", encoding="utf-8")
        self.assertTrue(all(lab.allowed_path(p) for p in lab.changed_paths(self.root, self.base)))

    def test_unstaged_production_edit_detected(self):
        (self.root / "director_node.py").write_text("modified\n", encoding="utf-8")
        self.assertIn("director_node.py", lab.changed_paths(self.root, self.base))
        self.assertFalse(lab.allowed_path("director_node.py"))

    def test_committed_production_edit_detected(self):
        (self.root / "director_node.py").write_text("modified\n", encoding="utf-8")
        self.git("commit", "-qam", "bad edit")
        self.assertIn("director_node.py", lab.changed_paths(self.root, self.base))

    def test_production_rename_not_hidden(self):
        target = self.root / "experiments/acceleration_lab"
        target.mkdir(parents=True)
        self.git("mv", "director_node.py", "experiments/acceleration_lab/moved.py")
        self.assertIn("director_node.py", lab.changed_paths(self.root, self.base))

    def test_cli_failure_is_nonzero_without_reverting(self):
        (self.root / "director_node.py").write_text("modified\n", encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            code = lab.main(["--repo", str(self.root), "--baseline", self.base])
        self.assertEqual(code, 2)
        self.assertEqual((self.root / "director_node.py").read_text(encoding="utf-8"), "modified\n")


if __name__ == "__main__":
    unittest.main()
