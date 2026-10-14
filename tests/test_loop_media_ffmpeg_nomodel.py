"""FFmpeg media regression on the real loop media implementation.

Unlike tests/test_loop_media.py, this test needs no PyTorch, NumPy, H3 weights,
ComfyUI runtime, or GPU. Real FFmpeg encodes three short source MOV clips and
the TerryDirector merge implementation cuts overlap, preserves source frames
and concatenates 24-bit PCM with sample-exact 24fps synchronization.
"""

from __future__ import annotations

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
                     "FFmpeg and FFprobe are required for the real MOV merge test")
class TestLoopMediaFFmpegWithoutTorch(unittest.TestCase):
    def test_prores_mov_packet_copy_overlap_gap_and_pcm(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")

        def run(*args):
            subprocess.run(
                [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", *args],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                timeout=120,
            )

        def stream(path, selector):
            reply = subprocess.run([
                ffprobe, "-v", "error", "-select_streams", selector,
                "-show_entries",
                "stream=codec_name,profile,pix_fmt,nb_frames,duration_ts,sample_rate",
                "-of", "json", str(path),
            ], capture_output=True, check=True, text=True, timeout=120)
            return json.loads(reply.stdout)["streams"][0]

        with tempfile.TemporaryDirectory(prefix="td_real_mov_") as temp:
            root = Path(temp)
            clipdir = root / "clips"
            clipdir.mkdir()
            sources = [clipdir / f"{i:03d}_source.mov" for i in (1, 2, 3)]
            for i, path in enumerate(sources):
                run(
                    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
                    "-f", "lavfi", "-i",
                    f"sine=frequency={440 + 120*i}:sample_rate=48000:duration=1",
                    "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
                    "-c:a", "pcm_s24le", "-ar", "48000", "-shortest",
                    "-f", "mov", "-y", str(path),
                )

            stubs = {
                "folder_paths": types.SimpleNamespace(get_output_directory=lambda: str(root)),
                "numpy": types.ModuleType("numpy"),
                "torch": types.ModuleType("torch"),
            }
            with mock.patch.dict(sys.modules, stubs):
                spec = importlib.util.spec_from_file_location(
                    "_td_media_no_torch_test", ROOT / "director_loop_media.py",
                )
                media = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(media)

            clips = [
                {"index": 0, "path": str(sources[0]), "frames": 24,
                 "trim_head_frames": 0, "gap_before_frames": 0,
                 "width": 320, "height": 180, "channels": 1,
                 "fps": 24, "run_signature": "media-ci",
                 "segment_format": media.MOV_HQ},
                {"index": 1, "path": str(sources[1]), "frames": 24,
                 "trim_head_frames": 7, "gap_before_frames": 0,
                 "width": 320, "height": 180, "channels": 1,
                 "fps": 24, "run_signature": "media-ci",
                 "segment_format": media.MOV_HQ},
                {"index": 2, "path": str(sources[2]), "frames": 24,
                 "trim_head_frames": 0, "gap_before_frames": 6,
                 "width": 320, "height": 180, "channels": 1,
                 "fps": 24, "run_signature": "media-ci",
                 "segment_format": media.MOV_HQ},
            ]

            final = media.merge_loop_clips(clips, merge_final=True)
            self.assertTrue(final.endswith("Final.mov"))
            video = stream(final, "v:0")
            audio = stream(final, "a:0")
            expected_frames = 24 + (24 - 7) + 6 + 24
            self.assertEqual(int(video["nb_frames"]), expected_frames)
            self.assertEqual(video["codec_name"], "prores")
            self.assertEqual(video["profile"], "HQ")
            self.assertEqual(audio["codec_name"], "pcm_s24le")
            self.assertEqual(int(audio["sample_rate"]), 48000)
            self.assertEqual(int(audio["duration_ts"]), expected_frames * 2000)
            self.assertTrue(all(
                int(stream(path, "v:0")["nb_frames"]) == 24 for path in sources
            ))
            self.assertFalse(list(root.rglob("*.pt")))
            # Rebuild across independently saved takes: the second clip may
            # have come from a later single-clip rerun. No source MOV or
            # original Final is overwritten.
            mixed = [dict(part) for part in clips]
            mixed[1]["run_signature"] = "newer-take"
            assembled = media.merge_loop_clips(
                mixed, merge_final=True,
                output_root=root / "assemblies" / "rebuild-mix",
                source_root=root,
            )
            self.assertEqual(int(stream(assembled, "v:0")["nb_frames"]), expected_frames)
            self.assertEqual(int(stream(assembled, "a:0")["duration_ts"]),
                             expected_frames * 2000)
            self.assertTrue(Path(final).is_file())
            self.assertTrue(all(path.is_file() for path in sources))
            self.assertTrue((Path(assembled).parent / "timeline.json").is_file())
            with self.assertRaises(ValueError):
                media.merge_loop_clips(
                    mixed, merge_final=True,
                    output_root=root / "outside-rebuild", source_root=root,
                )
            self.assertEqual(
                media.merge_loop_clips(clips, merge_final=False), None
            )
            invalid = [dict(clip) for clip in clips]
            invalid[2]["path"] = str(clipdir / "missing.mov")
            with self.assertRaises(ValueError):
                media.merge_loop_clips(invalid, merge_final=True)
            self.assertTrue(all(path.is_file() for path in sources))


    def test_mp4_frame_exact_overlap_and_nonoverlap(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")

        def frame_count(path):
            result = subprocess.run([
                ffprobe, "-v", "error", "-count_frames",
                "-select_streams", "v:0", "-show_entries",
                "stream=nb_read_frames", "-of", "csv=p=0", str(path),
            ], capture_output=True, check=True, text=True, timeout=120)
            return int(result.stdout.strip())

        with tempfile.TemporaryDirectory(prefix="td_real_mp4_") as temp:
            root = Path(temp)
            folder = root / "clips"
            folder.mkdir()
            originals = [folder / f"{i:03d}.mp4" for i in (1, 2)]
            for i, path in enumerate(originals):
                subprocess.run([
                    ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
                    "-f", "lavfi", "-i",
                    f"sine=frequency={440+120*i}:sample_rate=48000:duration=1",
                    "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p",
                    "-g", "48", "-c:a", "aac", "-b:a", "192k",
                    "-f", "mp4", str(path),
                ], check=True, capture_output=True, timeout=120)

            stubs = {
                "folder_paths": types.SimpleNamespace(get_output_directory=lambda: str(root)),
                "numpy": types.ModuleType("numpy"),
                "torch": types.ModuleType("torch"),
            }
            with mock.patch.dict(sys.modules, stubs):
                spec = importlib.util.spec_from_file_location(
                    "_td_media_mp4_no_torch_test", ROOT / "director_loop_media.py",
                )
                media = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(media)

            template = {
                "frames": 24, "width": 320, "height": 180, "channels": 1,
                "fps": 24, "run_signature": "media-mp4",
                "segment_format": media.MP4_H264,
            }
            clips = [
                dict(template, index=i, path=str(path),
                     trim_head_frames=0, gap_before_frames=0)
                for i, path in enumerate(originals)
            ]
            copied = media.merge_loop_clips(clips, merge_final=True)
            self.assertEqual(frame_count(copied), 48)
            Path(copied).unlink()
            clips[1]["trim_head_frames"] = 7
            clips[1]["gap_before_frames"] = 6
            recoded = media.merge_loop_clips(clips, merge_final=True)
            self.assertEqual(frame_count(recoded), 24 + 6 + 24 - 7)
            self.assertTrue(all(path.is_file() for path in originals))


if __name__ == "__main__":
    unittest.main()
