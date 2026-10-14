"""Actual FFmpeg regression: ProRes video stream-copy + PCM frame trimming.

Runs with synthetic 320x180 one-second MOVs (no H3, ComfyUI or torch).
Requires ffmpeg and ffprobe on PATH; skips if either binary is unavailable.
"""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                     "FFmpeg and FFprobe are required for MOV codec tests")
class TestProResFFmpeg(unittest.TestCase):
    def test_overlap_frame_copy_with_gap_and_pcm_samples(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        assert ffmpeg and ffprobe

        def run(*args):
            subprocess.run(
                [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", *args],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                timeout=60,
            )

        def stream(path, selector):
            result = subprocess.run([
                ffprobe, "-v", "error", "-select_streams", selector,
                "-show_entries",
                "stream=codec_name,profile,pix_fmt,nb_frames,duration_ts,time_base,sample_rate",
                "-of", "json", str(path),
            ], check=True, capture_output=True, text=True)
            return json.loads(result.stdout)["streams"][0]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [root / f"clip_{index}.mov" for index in range(3)]
            for i, path in enumerate(paths):
                run(
                    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
                    "-f", "lavfi", "-i",
                    f"sine=frequency={440 + i*100}:sample_rate=48000:duration=1",
                    "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
                    "-c:a", "pcm_s24le", "-ar", "48000", "-shortest",
                    "-f", "mov", "-y", str(path),
                )

            stubs = {
                "folder_paths": types.SimpleNamespace(
                    get_output_directory=lambda: str(root)
                ),
                "numpy": types.ModuleType("numpy"),
                "torch": types.ModuleType("torch"),
            }
            with mock.patch.dict(sys.modules, stubs):
                spec = importlib.util.spec_from_file_location(
                    "_td_prores_ffmpeg_integration", ROOT / "director_loop_mov.py"
                )
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)

            # module PyAV probe is replaced by FFprobe for this tool-independent test.
            def inspect(path, *, expected_frames, require_audio=True):
                video = stream(path, "v:0")
                audio = stream(path, "a:0")
                frames = int(video["nb_frames"])
                samples = int(audio["duration_ts"])
                assert frames == expected_frames, (frames, expected_frames)
                assert samples == frames * 2000, (samples, frames * 2000)
                assert video["codec_name"] == "prores"
                assert audio["codec_name"] == "pcm_s24le"
                return {"frames": frames, "width": 320, "height": 180, "channels": 1}

            clips = [
                {"index": 0, "path": str(paths[0]), "frames": 24,
                 "trim_head_frames": 0, "gap_before_frames": 0,
                 "width": 320, "height": 180, "channels": 1},
                {"index": 1, "path": str(paths[1]), "frames": 24,
                 "trim_head_frames": 7, "gap_before_frames": 0,
                 "width": 320, "height": 180, "channels": 1},
                {"index": 2, "path": str(paths[2]), "frames": 24,
                 "trim_head_frames": 0, "gap_before_frames": 6,
                 "width": 320, "height": 180, "channels": 1},
            ]
            with mock.patch.object(module, "_inspect_mov", side_effect=inspect):
                final = module.merge_loop_mov_clips(clips)

            self.assertTrue(Path(final).exists())
            probe = inspect(final, expected_frames=24 + (24-7) + 6 + 24)
            self.assertEqual(probe["frames"], 71)
            self.assertEqual(stream(final, "v:0")["profile"], "HQ")
            self.assertTrue(all(
                int(stream(path, "v:0")["nb_frames"]) == 24 for path in paths
            ))
            manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["final_frames"], 71)
            self.assertEqual(manifest["status"], "completed")


if __name__ == "__main__":
    unittest.main()
