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


def plan_fingerprint(document, seed, compiled, workflow_hash, video_format,
                     output_profile=None):
    """Hash the *effective* authored content, not a random per-run UUID."""
    # Cursor focus and the selected card do not alter generated content.
    # Do not accidentally invalidate a resumable run when the user switches
    # which clip is selected in the editor.
    authored = dict(document)
    authored.pop("selected", None)
    asset_versions = []
    for asset in authored.get("assets", []):
        source = asset.get("source") if isinstance(asset, dict) else None
        if not isinstance(source, dict) or source.get("type") != "comfy-input":
            continue
        label = str(source.get("path") or "")
        try:
            if not folder_paths.exists_annotated_filepath(label):
                asset_versions.append((label, "missing"))
                continue
            p = Path(folder_paths.get_annotated_filepath(label))
            stat = p.stat()
            asset_versions.append((label, stat.st_size, stat.st_mtime_ns))
        except (OSError, ValueError):
            asset_versions.append((label, "unavailable"))
    relevant = {
        "document": authored,
        "input_asset_versions": sorted(asset_versions),
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
        # The user's final SaveVideo path is part of task identity. Moving or
        # renaming the destination intentionally starts a new task.
        "output_profile": output_profile or {},
        "schema": 2,
    }
    return canonical_hash(relevant)


def _within(file: Path, root: Path) -> bool:
    try:
        file.relative_to(root)
        return True
    except ValueError:
        return False


def verified_clip(entry, root: Path, segment, video_format, fingerprint=None,
                  run_stem=None):
    """Never trust descriptor paths, format or durations without checks."""
    if not isinstance(entry, dict):
        return False
    try:
        media = Path(entry["path"]).resolve()
        return (
            _within(media, root)
            and media.parent == root
            and (not run_stem or media.name.startswith(str(run_stem) + "_"))
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


def find_resume_checkpoint(output_profile, fingerprint, segments, video_format):
    """Return newest *incomplete* exact-match run and its completed prefix.

    The prefix is ordered and contiguous. Never reuse a partial segment or a
    saved movie from a different creative/workflow fingerprint.
    """
    from .director_loop_storage import manifest_glob, profile_directory, storage_from_manifest

    root = profile_directory(output_profile)
    if not root.is_dir():
        return None
    candidates = sorted(root.glob(manifest_glob(output_profile)),
                        key=lambda file: file.stat().st_mtime_ns, reverse=True)
    for manifest in candidates:
        try:
            state = json.loads(manifest.read_text("utf-8"))
            if state.get("status") != "in_progress":
                continue
            if state.get("plan_fingerprint") != fingerprint:
                continue
            if state.get("output_profile") != output_profile:
                continue
            run_id = str(state.get("run_signature") or "")
            if not run_id:
                continue
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
                if not verified_clip(
                    entry, root, segment, video_format, fingerprint, manifest.stem,
                ):
                    break
                completed.append(entry)
            if (0 < len(completed) <= len(segments)
                    and any(part is not None for part in completed)):
                return {
                    **storage_from_manifest(manifest, state),
                    "completed": completed,
                }
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            continue
    return None
