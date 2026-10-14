"""Durable, conservative MOV-based continuation of TerryDirector loop renders.

No .pt cache is required. A failed run is eligible for resume only when the
whole authored plan and the loop's actual ComfyUI body/upstream inputs match
the original recorded fingerprint. Unverified/legacy runs are not resumed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import folder_paths


def canonical_hash(value) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def workflow_fingerprint(dynprompt, body_ids, is_link) -> str:
    """Hash loop body *and linked upstream nodes* (models, LoRAs, schedules).

    Loop control node inputs are separately covered by plan_fingerprint.
    Include stable node IDs: renaming/rewiring a workflow invalidates resume
    rather than risking reuse from an unrelated workflow.
    """
    seen = set()
    pending = list(body_ids)
    nodes = []
    while pending:
        node_id = str(pending.pop())
        if node_id in seen:
            continue
        seen.add(node_id)
        node = dynprompt.get_node(node_id)
        if not isinstance(node, dict):
            raise ValueError("工作流中存在无法校验的输入节点")
        # Loop start and end have special control state; their format and
        # creative document are checked separately by plan_fingerprint.
        if node.get("class_type") in ("TerryDirectorLooper", "TerryDirectorLoopEnd"):
            continue
        inputs = dict(node.get("inputs") or {})
        nodes.append({"id": node_id, "type": node.get("class_type"), "inputs": inputs})
        for value in inputs.values():
            if is_link(value):
                pending.append(str(value[0]))
    return canonical_hash(sorted(nodes, key=lambda row: row["id"]))


def plan_fingerprint(document, seed, compiled, workflow_hash, video_format):
    """Hash the *effective* authored content, not a random per-run UUID."""
    relevant = {
        "document": document,
        "seed": str(seed),
        "segments": [{
            "id": segment["id"],
            "output_frames": segment["output_frames"],
            "continuity": segment["continuity"],
            "assembly": segment["assembly"],
            "seed": segment.get("seed"),
            "kind": segment.get("kind", "generated"),
        } for segment in compiled["segments"]],
        "workflow": workflow_hash,
        "format": video_format,
        "schema": 1,
    }
    return canonical_hash(relevant)


def _loop_root(loop_id) -> Path:
    from .director_loop_media import _safe
    return (Path(folder_paths.get_output_directory()) / "TerryDirector"
            / "renders" / _safe(f"loop-{loop_id}")).resolve()


def _within(file: Path, root: Path) -> bool:
    try:
        file.relative_to(root)
        return True
    except ValueError:
        return False


def verified_clip(entry, root: Path, segment, video_format, fingerprint=None):
    """Never trust descriptor paths, format or durations without checks."""
    if not isinstance(entry, dict):
        return False
    try:
        media = Path(entry["path"]).resolve()
        return (
            _within(media, root)
            and media.is_file()
            and media.stat().st_size > 0
            and media.suffix.lower() in (".mov", ".mp4")
            and str(entry.get("segment_id")) == str(segment["id"])
            and int(entry.get("frames")) == int(segment["output_frames"])
            and int(entry.get("fps")) == 24
            and str(entry.get("segment_format")) == str(video_format)
            and (fingerprint is None or entry.get("plan_fingerprint") == fingerprint)
        )
    except (KeyError, TypeError, ValueError, OSError):
        return False


def find_resume_checkpoint(loop_id, fingerprint, segments, video_format):
    """Return newest *incomplete* exact-match run and its completed prefix.

    The prefix is ordered and contiguous. Never reuse a partial segment or a
    saved movie from a different creative/workflow fingerprint.
    """
    root = _loop_root(loop_id)
    if not root.is_dir():
        return None
    candidates = sorted(root.glob("*/timeline.json"),
                        key=lambda file: file.stat().st_mtime_ns, reverse=True)
    for manifest in candidates:
        try:
            state = json.loads(manifest.read_text("utf-8"))
            if state.get("status") != "in_progress":
                continue
            if state.get("plan_fingerprint") != fingerprint:
                continue
            run_id = manifest.parent.name
            indexed = {int(entry["index"]): entry
                       for entry in state.get("clips", [])}
            completed = []
            for i, segment in enumerate(segments):
                if segment.get("kind") == "entity":
                    # Imported footage needs to remain available; validation
                    # is performed again at execution time.
                    completed.append(None)
                    continue
                entry = indexed.get(i)
                if not verified_clip(entry, root, segment, video_format, fingerprint):
                    break
                completed.append(entry)
            if (0 < len(completed) < len(segments)
                    and any(part is not None for part in completed)):
                return {
                    "run_signature": run_id,
                    "root": str(manifest.parent),
                    "completed": completed,
                    "manifest": str(manifest),
                }
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            continue
    return None
