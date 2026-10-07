import unittest

from TerryDirector.director_compile import (
    compile_timeline,
    h3_align_frames,
    h3_guide_frames,
)


def asset(asset_id, kind, number, path):
    return {
        "id": asset_id,
        "name": asset_id,
        "kind": kind,
        "number": number,
        "source": {"type": "comfy-input", "path": path},
    }


def clip(clip_id, start, end, prompt="", suspended=False):
    return {
        "id": clip_id,
        "name": clip_id,
        "start": start,
        "end": end,
        "prompt": prompt,
        "refs": [],
        "suspended": suspended,
    }


class DirectorCompileTests(unittest.TestCase):
    def test_h3_frame_alignment(self):
        self.assertEqual(h3_align_frames(1), 5)
        self.assertEqual(h3_align_frames(5), 5)
        self.assertEqual(h3_align_frames(6), 22)
        self.assertEqual(h3_align_frames(22), 22)
        self.assertEqual(h3_align_frames(60), 73)

    def test_h3_guide_alignment_floors_inside_overlap(self):
        self.assertEqual(h3_guide_frames(4), 0)
        self.assertEqual(h3_guide_frames(5), 5)
        self.assertEqual(h3_guide_frames(21), 5)
        self.assertEqual(h3_guide_frames(22), 22)
        self.assertEqual(h3_guide_frames(48), 39)

    def test_compiles_overlap_touch_and_gap(self):
        document = {
            "fps": 24,
            "clips": [
                clip("a", 0, 240),
                clip("b", 192, 432),
                clip("c", 432, 552),
                clip("d", 600, 720),
            ],
            "assets": [],
        }

        plan = compile_timeline(document)
        a, b, c, d = plan["segments"]

        self.assertEqual(plan["total_frames"], 720)
        self.assertEqual(a["h3_frames"], 243)
        self.assertEqual(a["assembly"]["trim_tail_frames"], 3)

        self.assertEqual(b["continuity"]["kind"], "overlap")
        self.assertEqual(b["continuity"]["frames"], 48)
        self.assertEqual(b["continuity"]["source_start_frame"], 192)
        self.assertEqual(b["continuity"]["video_guide_frames"], 39)
        self.assertEqual(b["continuity"]["boundary_target_frame"], 47)
        self.assertEqual(b["continuity"]["audio_guide_frames"], 48)
        self.assertEqual(b["assembly"]["trim_head_frames"], 48)

        self.assertEqual(c["continuity"]["kind"], "tail_frame")
        self.assertEqual(c["continuity"]["source_frame"], 239)
        self.assertEqual(c["continuity"]["target_frame"], 0)

        self.assertEqual(d["continuity"], {"kind": "gap", "frames": 48})
        self.assertEqual(d["assembly"]["gap_before_frames"], 48)

    def test_initial_gap_is_preserved_in_final_timeline(self):
        document = {
            "fps": 24,
            "clips": [clip("a", 48, 168)],
            "assets": [],
        }
        plan = compile_timeline(document)
        segment = plan["segments"][0]
        self.assertEqual(plan["total_frames"], 168)
        self.assertEqual(segment["continuity"], {"kind": "independent"})
        self.assertEqual(segment["assembly"]["gap_before_frames"], 48)

    def test_remaps_global_asset_tags_to_segment_local_tags(self):
        document = {
            "fps": 24,
            "clips": [
                clip(
                    "a",
                    0,
                    120,
                    "<Picture 9> hero, <Audio 4> voice, then <Picture 3> detail and <Picture 9> again.",
                )
            ],
            "assets": [
                asset("image-3", "image", 3, "refs/detail.png"),
                asset("image-9", "image", 9, "refs/hero.png"),
                asset("audio-4", "audio", 4, "refs/voice.wav"),
            ],
        }

        segment = compile_timeline(document)["segments"][0]
        self.assertEqual(
            segment["prompt"],
            "<Picture 1> hero, <Audio 1> voice, then <Picture 2> detail and <Picture 1> again.",
        )
        self.assertEqual(
            [item["id"] for item in segment["assets"]["images"]],
            ["image-9", "image-3"],
        )
        self.assertEqual(
            [item["local_tag"] for item in segment["assets"]["images"]],
            ["<Picture 1>", "<Picture 2>"],
        )
        self.assertEqual(segment["assets"]["audios"][0]["local_tag"], "<Audio 1>")

    def test_reference_count_uses_native_h3_limits(self):
        assets = [asset(f"image-{i}", "image", i, f"refs/{i}.png") for i in range(1, 11)]
        prompt = " ".join(f"<Picture {i}>" for i in range(1, 11))
        document = {
            "fps": 24,
            "clips": [clip("a", 0, 120, prompt)],
            "assets": assets,
        }
        with self.assertRaisesRegex(ValueError, "images limit"):
            compile_timeline(document)

    def test_rejects_segment_longer_than_native_h3_limit(self):
        document = {
            "fps": 24,
            "clips": [clip("a", 0, 3593)],
            "assets": [],
        }
        with self.assertRaisesRegex(ValueError, "maximum length"):
            compile_timeline(document)

    def test_suspended_segment_is_blank_and_continuity_skips_left(self):
        document = {
            "fps": 24,
            "clips": [
                clip("a", 0, 144),
                clip("b", 96, 240, suspended=True),
                clip("c", 144, 288),
            ],
            "assets": [],
        }
        plan = compile_timeline(document)
        self.assertEqual([segment["id"] for segment in plan["segments"]], ["a", "c"])
        self.assertEqual(plan["suspended_segment_ids"], ["b"])
        self.assertEqual(plan["segments"][1]["continuity"]["kind"], "tail_frame")
        self.assertEqual(plan["segments"][1]["continuity"]["source_segment_id"], "a")

    def test_suspended_tail_extends_as_blank_output(self):
        document = {
            "fps": 24,
            "clips": [
                clip("a", 0, 120),
                clip("b", 120, 240, suspended=True),
            ],
            "assets": [],
        }
        plan = compile_timeline(document)
        self.assertEqual(plan["total_frames"], 240)
        self.assertEqual(plan["segments"][0]["assembly"]["gap_after_frames"], 120)

    def test_unreferenced_pool_assets_do_not_enter_text_only_task(self):
        document = {
            "fps": 24,
            "clips": [clip("a", 0, 120, "A text-only H3 prompt with no media tags.")],
            "assets": [
                asset("image-1", "image", 1, "refs/unused.png"),
                asset("audio-1", "audio", 1, "refs/unused.wav"),
            ],
        }
        segment = compile_timeline(document)["segments"][0]
        self.assertEqual(segment["assets"], {
            "images": [],
            "videos": [],
            "audios": [],
        })
        self.assertEqual(segment["prompt"], "A text-only H3 prompt with no media tags.")

    def test_missing_prompt_asset_is_an_error(self):
        document = {
            "fps": 24,
            "clips": [clip("a", 0, 120, "Use <Picture 7>.")],
            "assets": [],
        }
        with self.assertRaisesRegex(ValueError, "missing asset"):
            compile_timeline(document)

    def test_rejects_non_advancing_timeline(self):
        document = {
            "fps": 24,
            "clips": [
                clip("a", 0, 240),
                clip("b", 120, 200),
            ],
            "assets": [],
        }
        with self.assertRaisesRegex(ValueError, "advance forward"):
            compile_timeline(document)


if __name__ == "__main__":
    unittest.main()
