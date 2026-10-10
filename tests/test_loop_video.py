"""CPU-only VIDEO wrapper tests: metadata, disk safety, no full IMAGE allocation."""
import ast
from fractions import Fraction
import json
import os
from pathlib import Path
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
VIDEO_SOURCE = ROOT / "director_loop_video.py"


def load_video_class(temp_root):
    tree = ast.parse(VIDEO_SOURCE.read_text(encoding="utf-8"))
    klasses = [item for item in tree.body if isinstance(item, ast.ClassDef)
               and item.name == "TerryDirectorStreamVideo"]
    assert len(klasses) == 1
    env = {
        "VideoInput": object,
        "Fraction": Fraction,
        "json": json,
        "os": os,
        "shutil": __import__("shutil"),
        "folder_paths": types.SimpleNamespace(get_temp_directory=lambda: temp_root),
    }
    compiled = compile(ast.fix_missing_locations(
        ast.Module(body=klasses, type_ignores=[])
    ), str(VIDEO_SOURCE), "exec")
    exec(compiled, env)
    return env["TerryDirectorStreamVideo"]


def descriptor(path, frames=96, width=608, height=352):
    return {
        "path": str(path),
        "width": width,
        "height": height,
        "channels": 3,
        "frames": frames,
        "sample_rate": 32000,
        "audio_shape": [1, 2, round(frames / 24 * 32000)],
    }


class StreamVideoContract(unittest.TestCase):
    def test_wrapper_is_a_video_input_with_file_streaming(self):
        text = VIDEO_SOURCE.read_text(encoding="utf-8")
        tree = ast.parse(text)
        klass = next(node for node in tree.body
                     if isinstance(node, ast.ClassDef)
                     and node.name == "TerryDirectorStreamVideo")
        self.assertEqual(klass.bases[0].id, "VideoInput")
        self.assertIn("video_output_config(path, format, codec)", text)
        self.assertIn("for index, descriptor in enumerate(self._descriptors):", text)
        self.assertIn("torch.load(", text)
        self.assertNotIn("torch.cat(", text)
        self.assertIn("self._saved_path = os.fspath(path)", text)
        self.assertIn("self._clear_lossless_cache()", text)

    def test_metadata_and_no_pre_save_components(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "terrydirector_base" / "loop-1" / "run-a"
            folder.mkdir(parents=True)
            a, b = folder / "a.pt", folder / "b.pt"
            a.write_bytes(b"mock")
            b.write_bytes(b"mock")
            cls = load_video_class(root)
            video = cls([json.dumps(descriptor(a)), descriptor(b, frames=72)])
            self.assertEqual(video.get_dimensions(), (608, 352))
            self.assertEqual(video.get_frame_count(), 168)
            self.assertEqual(video.get_frame_rate(), Fraction(24, 1))
            self.assertEqual(video.get_duration(), 7.0)
            self.assertEqual(video.get_bit_depth(), 8)
            self.assertEqual(video.get_color_space(), "sRGB")
            with self.assertRaisesRegex(RuntimeError, "SaveVideo"):
                video.get_components()
            with self.assertRaisesRegex(RuntimeError, "SaveVideo"):
                video.get_stream_source()
            self.assertTrue(a.exists())
            self.assertTrue(b.exists())

    def test_depth_color_and_invalid_shapes(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "terrydirector_base" / "loop-2" / "run-b"
            folder.mkdir(parents=True)
            a = folder / "a.pt"
            a.write_bytes(b"mock")
            cls = load_video_class(root)
            self.assertEqual(cls([descriptor(a)], bit_depth="auto", color_space="HDR").get_bit_depth(), 10)
            self.assertEqual(cls([descriptor(a)], bit_depth=8, color_space="HDR PQ").get_bit_depth(), 8)
            with self.assertRaisesRegex(ValueError, "色彩空间"):
                cls([descriptor(a)], color_space="invalid")
            with self.assertRaisesRegex(ValueError, "位深"):
                cls([descriptor(a)], bit_depth=12)
            with self.assertRaisesRegex(ValueError, "偶数"):
                cls([descriptor(a, width=607)])
            with self.assertRaisesRegex(ValueError, "不一致"):
                cls([descriptor(a), descriptor(a, width=640)])

    def test_cleanup_only_removes_private_run_directory(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "terrydirector_base" / "loop-2" / "run-c"
            folder.mkdir(parents=True)
            a = folder / "a.pt"
            a.write_bytes(b"mock")
            cls = load_video_class(root)
            video = cls([descriptor(a)])
            video._clear_lossless_cache()
            self.assertFalse(folder.exists())
            self.assertTrue(folder.parent.exists())

            outside = Path(root) / "private-unrelated"
            outside.mkdir()
            b = outside / "b.pt"
            b.write_bytes(b"mock")
            external = cls([descriptor(b)])
            external._clear_lossless_cache()
            self.assertTrue(b.exists())

    def test_failed_validations_leave_lossless_files_intact(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "terrydirector_base" / "loop-3" / "run-d"
            folder.mkdir(parents=True)
            a = folder / "a.pt"
            a.write_bytes(b"mock")
            cls = load_video_class(root)
            with self.assertRaises(ValueError):
                cls([descriptor(a), descriptor(a, frames=0)])
            self.assertTrue(a.exists())


if __name__ == "__main__":
    unittest.main()
