import unittest

import torch

from TerryDirector.director_internal import (
    TerryDirectorAssembleMedia,
    TerryDirectorLatentList,
    TerryDirectorResampleReferenceVideo,
)


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
            trim_head_frames=0,
            fps=2,
            accumulated_images=accumulated_images,
            accumulated_audio=accumulated_audio,
        ).result

        self.assertEqual(merged_images.shape[0], 5)
        self.assertEqual(merged_audio["waveform"].shape[-1], 20)

    def test_latent_list_preserves_segment_items(self):
        first = {"samples": "a"}
        second = {"samples": "b"}
        result = TerryDirectorLatentList.execute({
            "latent_0": first,
            "latent_1": second,
        }).result[0]
        self.assertEqual(result, [first, second])

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
