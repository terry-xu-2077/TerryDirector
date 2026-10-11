"""Validate website-only H3 Skill sample text without importing ComfyUI.

Never modify the canonical three-clip GPU acceptance workflow's empty AI fields.
The preview is illustrative and is intentionally NOT recorded as Qwen inference.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
WORKFLOW = BASE / "TerryDirector_AI_3clips_0.2MP.json"
DRAFTS = BASE / "TerryDirector_AI_3clips_demo_prompts.json"
SKILL = ROOT / "ai_skills" / "h3-prompt-writing" / "SKILL.md"

SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)
EXPECTED_DURATION = (4, 3, 5)
RETAINED_LINES = {
    "clip-1": ("yellow industrial", "insulation tape", "teal", "35 mm"),
    "clip-2": ('"剩余电量"', "<d>[Chinese] 再撑一段。</d>", "two", "LCD"),
    "clip-3": ('"ORC"', '"蚂蚱"', "25 mm", "pink-purple"),
}


def validate() -> dict:
    wf = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    director = next(n for n in wf["nodes"] if n["type"] == "TerryDirector")
    doc = json.loads(director["widgets_values_named"]["config_json"])["document"]
    demo = json.loads(DRAFTS.read_text(encoding="utf-8"))
    skill = SKILL.read_text(encoding="utf-8")

    assert demo["format"] == "terrydirector-site-ai-preview"
    assert demo["version"] == 1
    assert demo["skill"] == "h3-prompt-writing" and demo["mode"] == "Ref2VA"
    assert "not an actual Qwen model output" in demo["provenance"]
    assert demo["workflow"] == "examples/" + WORKFLOW.name
    assert demo["globalMode"] == "global-constraints-only"
    global_ai = demo["globalAiPrompt"]
    assert all(key in global_ai for key in (
        "[Global direction]", "[Visual language]", "[Lighting and palette]",
        "[Shared reference definitions]", "Sony Venice 2", "2.39:1",
    ))
    assert re.findall(r"<Picture\s+(\d+)>", global_ai) == [
        str(i) for i in range(1, 8)
    ]
    assert "<Picture 8>" not in global_ai
    assert "tail_reference" not in global_ai
    assert all(field + ":" not in global_ai for field in SECTIONS)
    assert "[\"skill\"]" not in doc  # Not a real AI engine output
    assert len(doc["clips"]) == len(demo["clips"]) == 3
    assert [c["id"] for c in doc["clips"]] == [c["id"] for c in demo["clips"]]
    assert all(c["aiPrompt"] == "" and c["promptMode"] == "user"
               and not c["aiMetadata"] for c in doc["clips"])
    assert all(c["transitionMode"] == "tail_reference" for c in doc["clips"])
    assert all(name in skill for name in SECTIONS)

    source_tags = {m.group(0) for m in re.finditer(
        r"<Picture\s+\d+>", doc["globalPrompt"]
        + "\n" + "\n".join(c["prompt"] for c in doc["clips"])
    )}
    assert source_tags == {f"<Picture {i}>" for i in range(1, 8)}
    prompts = {}
    for original, draft, length in zip(doc["clips"], demo["clips"], EXPECTED_DURATION):
        ai = draft["aiPrompt"]
        assert (original["end"] - original["start"]) == length * 24
        assert len(ai) > 1800, f"Enhanced example too short: {original['id']}"
        headings = re.findall(r"(?m)^([a-z_]+):\s*$", ai)
        assert headings == list(SECTIONS), (
            f"{original['id']}: Ref2VA must contain the six official sections in order; got {headings}"
        )
        positions = [ai.index(name + ":") for name in SECTIONS]
        assert all(a < b for a, b in zip(positions, positions[1:]))
        for begin, end in zip(positions, positions[1:] + [len(ai)]):
            assert ai[begin:end].strip(), "Empty Skill section"

        tags = set(re.findall(r"<Picture\s+\d+>", ai))
        assert tags and tags.issubset(source_tags), (
            f"{original['id']}: unauthorized image tag(s): {tags - source_tags}"
        )
        assert "<Picture 8>" not in ai, "Dynamic tail frame is H3 runtime's responsibility"
        assert "tail_reference" not in ai, "Do not encode timeline continuity into AI text"
        assert "<Video " not in ai and "<Audio " not in ai
        assert re.search(r"(?m)^summary:\n\[reference generation\]", ai)
        assert re.search(r"(?m)^detailed_description:\n", ai)
        assert re.search(r"(?m)^non_diegetic_music:\nN/A\s*$", ai)
        for text in RETAINED_LINES[original["id"]]:
            assert text in ai, f"{original['id']}: missing required original detail: {text}"

        # Check a realistic 1-shot Ref2VA sample without artificial cuts.
        assert "[Shot 1]" in ai and "[Shot 2]" not in ai
        assert f"{length}.00 seconds" in ai
        assert "fully_preserved" in ai
        prompts[original["id"]] = {
            "characters": len(ai),
            "source_references": sorted(tags),
            "duration_seconds": length,
            "section_count": len(headings),
        }

    return {
        "status": "SITE_DEMO_H3_SKILL_STRUCTURE_VALIDATED",
        "preview_only": True,
        "real_ai_results_in_workflow": False,
        "source_clips": len(doc["clips"]),
        "source_images": len(doc["assets"]),
        "global_ai_demo": True,
        "details": prompts,
    }


if __name__ == "__main__":
    print(json.dumps(validate(), ensure_ascii=False, indent=2))
