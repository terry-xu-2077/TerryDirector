import unittest

import torch

from TerryDirector.director_internal import (
    TerryDirectorAssembleMedia,
    TerryDirectorPackOutput,
    TerryDirectorResampleReferenceVideo,
)
from TerryDirector.director_node import TerryDirector, TerryDirectorOutput


class DirectorInternalTests(unittest.TestCase):
    def test_assemble_trims_overlap_and_inserts_gap(self):
        images = torch.arange(5, dtype=torch.float32).reshape(5, 1, 1, 1).repeat(1, 2, 2, 3)
        audio = {
            "waveform": torch.arange(20, dtype=torch.float32).reshape(1, 1, 20),
            "sample_rate": 8,
        }

        out = TerryDirectorAssembleMedia.execute(
            images=images,
            audio=audio,
            gap_frames=2,
            gap_after_frames=0,
            trim_head_frames=1,
            fps=2,
        ).result
        merged_images, merged_audio = out

        self.assertEqual(merged_images.shape[0], 6)
        self.assertTrue(torch.equal(merged_images[:2], torch.zeros_like(merged_images[:2])))
        self.assertTrue(torch.equal(merged_images[2:], images[1:]))
        self.assertEqual(merged_audio["waveform"].shape[-1], 24)
        self.assertTrue(torch.equal(
            merged_audio["waveform"][..., :8],
            torch.zeros_like(merged_audio["waveform"][..., :8]),
        ))
        self.assertTrue(torch.equal(
            merged_audio["waveform"][..., 8:],
            audio["waveform"][..., 4:],
        ))

    def test_assemble_appends_to_existing_media(self):
        images = torch.ones((2, 2, 2, 3), dtype=torch.float32)
        audio = {"waveform": torch.ones((1, 2, 8)), "sample_rate": 8}
        accumulated_images = torch.zeros((3, 2, 2, 3), dtype=torch.float32)
        accumulated_audio = {"waveform": torch.zeros((1, 2, 12)), "sample_rate": 8}

        merged_images, merged_audio = TerryDirectorAssembleMedia.execute(
            images=images,
            audio=audio,
            gap_frames=0,
            gap_after_frames=0,
            trim_head_frames=0,
            fps=2,
            accumulated_images=accumulated_images,
            accumulated_audio=accumulated_audio,
        ).result

        self.assertEqual(merged_images.shape[0], 5)
        self.assertEqual(merged_audio["waveform"].shape[-1], 20)

    def test_pack_output_preserves_segment_items_and_media(self):
        first = {"samples": "a"}
        second = {"samples": "b"}
        images = torch.zeros((2, 2, 2, 3), dtype=torch.float32)
        audio = {"waveform": torch.zeros((1, 2, 4000)), "sample_rate": 48000}
        packet = TerryDirectorPackOutput.execute(
            {"latent_0": first, "latent_1": second},
            images,
            audio,
            24,
        ).result[0]

        self.assertEqual(packet["fps"], 24)
        self.assertEqual(packet["segment_latents"], [first, second])
        self.assertIs(packet["images"], images)
        self.assertIs(packet["audio"], audio)

    def test_main_node_exposes_only_director_output(self):
        schema = TerryDirector.define_schema()
        self.assertEqual(len(schema.outputs), 1)
        self.assertEqual(schema.outputs[0].display_name, "导演输出")
        self.assertEqual(schema.outputs[0].get_io_type(), "TERRYDIRECTOR_OUTPUT")

    def test_director_output_builds_native_video_and_exposes_all_results(self):
        first = {"samples": "a"}
        images = torch.zeros((4, 2, 2, 3), dtype=torch.float32)
        audio = {"waveform": torch.zeros((1, 2, 8000)), "sample_rate": 48000}
        packet = {
            "fps": 24,
            "segment_latents": [first],
            "images": images,
            "audio": audio,
        }

        video, latents, out_images, out_audio = TerryDirectorOutput.execute(packet).result
        components = video.get_components()

        self.assertEqual(float(components.frame_rate), 24.0)
        self.assertIs(components.images, images)
        self.assertIs(components.audio, audio)
        self.assertEqual(latents, [first])
        self.assertIs(out_images, images)
        self.assertIs(out_audio, audio)

    def test_assemble_appends_trailing_blank(self):
        images = torch.ones((2, 2, 2, 3), dtype=torch.float32)
        audio = {"waveform": torch.ones((1, 2, 8)), "sample_rate": 8}
        merged_images, merged_audio = TerryDirectorAssembleMedia.execute(
            images=images,
            audio=audio,
            gap_frames=0,
            gap_after_frames=2,
            trim_head_frames=0,
            fps=2,
        ).result
        self.assertEqual(merged_images.shape[0], 4)
        self.assertTrue(torch.equal(merged_images[-2:], torch.zeros_like(merged_images[-2:])))
        self.assertEqual(merged_audio["waveform"].shape[-1], 16)
        self.assertTrue(torch.equal(
            merged_audio["waveform"][..., -8:],
            torch.zeros_like(merged_audio["waveform"][..., -8:]),
        ))

    def test_reference_video_resamples_to_24_fps(self):
        images = torch.arange(30, dtype=torch.float32).reshape(30, 1, 1, 1)
        resampled = TerryDirectorResampleReferenceVideo.execute(
            images=images,
            source_fps=30.0,
            target_fps=24.0,
        ).result[0]

        self.assertEqual(resampled.shape[0], 24)
        self.assertEqual(float(resampled[0, 0, 0, 0]), 0.0)
        self.assertEqual(float(resampled[-1, 0, 0, 0]), 29.0)


if __name__ == "__main__":
    unittest.main()
