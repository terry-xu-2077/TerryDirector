"""True per-clip ProRes/PCM encoder test with simulated Float32 tensors.

CPU-only, no ComfyUI/PyTorch/model weights. Uses real FFmpeg + FFprobe and
NumPy mock tensor wrappers. Tests 32kHz to 48kHz and exact 24fps samples.
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

try:
    import numpy as np
except ImportError:
    np = None


ROOT = Path(__file__).resolve().parents[1]


class DummyTensor:
    def __init__(self, data):
        self.array = np.asarray(data)

    @property
    def shape(self):
        return self.array.shape

    @property
    def ndim(self):
        return self.array.ndim

    def __getitem__(self, key):
        return DummyTensor(self.array[key])

    def __iter__(self):
        for frame in self.array:
            yield DummyTensor(frame)

    def detach(self):
        return self

    def float(self):
        return DummyTensor(self.array.astype(np.float32, copy=False))

    def cpu(self):
        return self

    def transpose(self, i, j):
        return DummyTensor(self.array.swapaxes(i, j))

    def contiguous(self):
        return self

    def numpy(self):
        return self.array


@unittest.skipUnless(
    np is not None and shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "NumPy, FFmpeg and FFprobe required for ProRes clip encode test",
)
class TestProResClipWriter(unittest.TestCase):
    def test_encode_float32_frames_with_32khz_audio(self):
        ffprobe = shutil.which("ffprobe")

        def probe(file, selector):
            cmd = [ffprobe, "-v", "error", "-select_streams", selector,
                   "-show_entries",
                   "stream=codec_name,profile,pix_fmt,nb_frames,duration_ts,time_base,sample_rate",
                   "-of", "json", str(file)]
            data = subprocess.run(cmd, check=True, capture_output=True, text=True)
            return json.loads(data.stdout)["streams"][0]

        def validate(path, *, expected_frames, require_audio=True):
            video = probe(path, "v:0")
            audio = probe(path, "a:0")
            if int(video["nb_frames"]) != expected_frames:
                raise AssertionError("Wrong ProRes output frame count")
            if video["codec_name"] != "prores" or video["profile"] != "HQ":
                raise AssertionError("Wrong ProRes codec/profile")
            if video["pix_fmt"] != "yuv422p10le":
                raise AssertionError("Wrong 10-bit 4:2:2 output format")
            if audio["codec_name"] != "pcm_s24le" or int(audio["sample_rate"]) != 48000:
                raise AssertionError("Wrong PCM audio encoding")
            if int(audio["duration_ts"]) != expected_frames * 2000:
                raise AssertionError("PCM samples not aligned to 24fps")
            return {"frames": expected_frames, "width": 320, "height": 180, "channels": 2}

        with tempfile.TemporaryDirectory() as folder:
            workdir = Path(folder)
            stubs = {
                "folder_paths": types.SimpleNamespace(
                    get_output_directory=lambda: str(workdir)
                ),
                "torch": types.SimpleNamespace(Tensor=DummyTensor),
            }
            with mock.patch.dict(sys.modules, stubs):
                spec = importlib.util.spec_from_file_location(
                    "_td_prores_writer_test", ROOT / "director_loop_mov.py"
                )
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)

            images = np.zeros((24, 180, 320, 3), dtype=np.float32)
            images[:, :, :, 0] = np.arange(24)[:, None, None] / 24
            images[:, :, :, 1] = 0.5
            images[:, :, :, 2] = 0.8
            seconds = np.arange(32000, dtype=np.float32) / 32000.0
            tone = (np.sin(seconds * (440 * 2 * np.pi)) * 0.2).astype(np.float32)
            waveform = np.stack((tone, tone * 0.75))[None, :, :]

            target = workdir / "001_镜头.mov"
            with mock.patch.object(module, "_inspect_mov", side_effect=validate):
                technical = module._write_prores_clip(
                    DummyTensor(images),
                    {"sample_rate": 32000, "waveform": DummyTensor(waveform)},
                    target, 24,
                )

            self.assertTrue(target.is_file())
            self.assertEqual(technical["audio_sample_rate"], 48000)
            self.assertEqual(technical["frames"], 24)
            validate(target, expected_frames=24)
            self.assertFalse(any(path.suffix == ".f32le" for path in workdir.iterdir()))


if __name__ == "__main__":
    unittest.main()
