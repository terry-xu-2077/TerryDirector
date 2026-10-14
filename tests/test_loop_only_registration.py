"""The current node registry must remain loop-only after retirement.

Structural smoke test: runs without ComfyUI, CUDA or Torch.
"""
from pathlib import Path
import ast
import unittest

ROOT = Path(__file__).resolve().parents[1]
RETIRED_IDS = {
    "TerryDirector", "TerryDirectorAdvanced", "TerryDirectorConfig",
    "TerryDirectorSecondPassConfig", "TerryDirectorOutput",
}
SHARED_IDS = {
    "TerryDirectorLooper", "TerryDirectorLoopInfo",
    "TerryDirectorLoopCondition", "TerryDirectorLoopEnd",
    "TerryDirectorLoopCache", "TerryDirectorLoopReuse",
    "TerryDirectorSelfLiftSampler", "TerryDirectorH3X2LowRAMDecode",
    "TerryDirectorLlamaConfig", "TerryDirectorPromptEnhancer",
}

class RetiredDirectors(unittest.TestCase):
    def test_public_registry_keeps_loop_and_shared_nodes_only(self):
        source = (ROOT / "__init__.py").read_text("utf-8")
        tree = ast.parse(source)
        declared = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                declared.update(alias.name for alias in node.names)
        self.assertFalse(declared.intersection(RETIRED_IDS))
        self.assertTrue(SHARED_IDS.issubset(declared))

    def test_old_modules_are_not_accidentally_reintroduced(self):
        for filename in ("director_node.py", "director_h3.py",
                         "director_internal.py", "director_loop_video.py"):
            self.assertFalse((ROOT / filename).exists(), filename)
        self.assertTrue((ROOT / "director_selflift_node.py").exists())
        self.assertTrue((ROOT / "director_loop_resume.py").exists())

    def test_legacy_ui_and_routes_not_registered(self):
        ui = (ROOT / "web/terry_director.js").read_text("utf-8")
        server = (ROOT / "server_routes.py").read_text("utf-8")
        self.assertNotIn("ADVANCED_NODE_CLASS", ui)
        self.assertNotIn("renderAdvancedNode(", ui)
        self.assertNotIn("bindSecondPassTakeover(", ui)
        self.assertNotIn("/terrydirector/api/advanced-state", server)
        self.assertNotIn("/terrydirector/api/capabilities", server)
        self.assertIn("TerryDirectorLoopEnd", ui)

if __name__ == "__main__":
    unittest.main()
