"""CPU-only checks for LoopEnd's temporary-cache drive capacity endpoint."""
import ast
from pathlib import Path
import shutil
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "server_routes.py"


class LoopTempSpaceTest(unittest.TestCase):
    def test_storage_helper_reads_only_disk_metadata(self):
        contents = SOURCE.read_text(encoding="utf-8")
        parsed = ast.parse(contents)
        func = next(n for n in parsed.body
                    if isinstance(n, ast.FunctionDef)
                    and n.name == "_temp_disk_space")
        namespace = {"Path": Path, "shutil": shutil}
        exec(compile(ast.Module(body=[func], type_ignores=[]),
                     str(SOURCE), "exec"), namespace)
        with tempfile.TemporaryDirectory() as folder:
            result = namespace["_temp_disk_space"](folder)
        self.assertIs(result["available"], True)
        self.assertIsInstance(result["free_bytes"], int)
        self.assertGreaterEqual(result["free_bytes"], 0)
        self.assertNotIn("path", result)
        self.assertNotIn("directory", result)
        self.assertNotIn("total_bytes", result)

    def test_route_uses_current_comfy_temp_not_cwd_or_output(self):
        contents = SOURCE.read_text(encoding="utf-8")
        self.assertIn('"/terrydirector/api/temp-space"', contents)
        self.assertIn("shutil.disk_usage(path)", contents)
        self.assertIn("_temp_disk_space(folder_paths.get_temp_directory())", contents)
        self.assertIn('"Cache-Control": "no-store"', contents)
        self.assertIn('"available": False', contents)


if __name__ == "__main__":
    unittest.main()
