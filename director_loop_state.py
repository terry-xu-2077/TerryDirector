"""Pure planning for MOV-backed loop recovery and result selection.

This module intentionally imports neither ComfyUI nor Torch so that interrupted
runs, stale dependencies and multi-take Final rebuilds can be checked offline.
No .pt or model-state persistence is required.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

FPS = 24
CONTEXT_KINDS = {"tail_frame", "tail_reference", "overlap"}


def _digest(payload) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _asset_tag(asset, resolver=None):
    if not isinstance(asset, dict):
        return None
    source = asset.get("source") or {}
    data = {
        "id": str(asset.get("id") or ""),
        "kind": asset.get("kind"),
        "source": source,
    }
    if source.get("type") == "comfy-input" and resolver is not None:
        # File size + mtime invalidate changed input assets without hashing
        # multi-gigabyte videos. User-editable filesystem timestamps cannot
        # constitute a cryptographic content guarantee.
        path = Path(resolver(str(source.get("path") or ""))).resolve()
        st = path.stat()
        data["file"] = (st.st_size, st.st_mtime_ns)
    return data


def graph_fingerprint(dynprompt, body_ids, opener_id, end_id, is_link):
    """Hash actual user sampler/VAE graph and its static upstream ancestors."""
    visited = {}
    pending = sorted(str(n) for n in body_ids)
    while pending:
        identifier = str(pending.pop())
        if identifier in visited or identifier in {str(opener_id), str(end_id)}:
            continue
        node = dynprompt.get_node(identifier)
        if not isinstance(node, dict):
            raise ValueError(f"工作流中缺少节点 {identifier}")
        inputs = node.get("inputs", {})
        # Do not capture execution-only Loop metadata or generated identifiers.
        visited[identifier] = {
            "class_type": str(node.get("class_type") or ""),
            "inputs": inputs,
        }
        for value in inputs.values():
            if is_link(value):
                source = str(value[0])
                if source not in visited and source != str(opener_id):
                    pending.append(source)
    return _digest([{"node": key, **visited[key]} for key in sorted(visited)])


def clip_fingerprint(segment, global_seed, graph_hash, resolver=None):
    """A clip recipe fingerprint independent of run UUID and neighboring take."""
    seed = segment.get("seed")
    effective_seed = int(global_seed) if seed is None else int(seed)
    assets = segment.get("assets") or {}
    asset_tags = {
        kind: [_asset_tag(asset, resolver) for asset in assets.get(kind, [])]
        for kind in ("images", "videos", "audios")
    }
    source_asset = _asset_tag(segment.get("source_asset"), resolver)
    return _digest({
        "recipe_version": 1,
        "id": segment["id"],
        "kind": segment.get("kind", "generated"),
        "seed": effective_seed,
        "prompt": segment.get("prompt"),
        "start_frame": int(segment["start_frame"]),
        "end_frame": int(segment["end_frame"]),
        "output_frames": int(segment["output_frames"]),
        "h3_frames": int(segment["h3_frames"]),
        "transition_mode": segment.get("transition_mode"),
        "continuity": segment.get("continuity"),
        # The physical context anchor does not enter Final; the runtime
        # therefore zeroes the guided head trim. Authored continuity and
        # frame ranges above still capture the complete edit geometry.
        "assets": asset_tags,
        "source_asset": source_asset,
        "body": graph_hash,
    })


def plan_fingerprint(segments, recipe_hashes, segment_format):
    if len(segments) != len(recipe_hashes):
        raise ValueError("片段数量与生成签名不一致")
    return _digest({
        "plan_version": 1,
        "format": segment_format,
        "clips": [
            {"id": part["id"], "recipe": recipe_hashes[i],
             "kind": part.get("kind", "generated")}
            for i, part in enumerate(segments)
        ],
    })


def loop_folder(output_directory, loop_id):
    loop = str(loop_id)
    if not loop.isdigit():
        raise ValueError("无效的循环节点 ID")
    return (Path(output_directory).resolve() / "TerryDirector" /
            "renders" / f"loop-{loop}")


def _within(path, directory):
    try:
        Path(path).resolve().relative_to(Path(directory).resolve())
        return True
    except ValueError:
        return False


def _manifests(loop_root):
    root = Path(loop_root).resolve()
    if not root.is_dir():
        return []
    paths = root.glob("*/timeline.json")
    return sorted(paths, key=lambda p: p.stat().st_mtime_ns, reverse=True)


def _descriptor_valid(part, root, expected_frames=None, expected_recipe=None,
                      required_format=None):
    if not isinstance(part, dict):
        return False
    try:
        if expected_frames is not None and int(part.get("frames", -1)) != int(expected_frames):
            return False
        if expected_recipe is not None and part.get("recipe_fingerprint") != expected_recipe:
            return False
        if required_format is not None and part.get("segment_format") != required_format:
            return False
        if int(part.get("fps", 0)) != FPS:
            return False
        movie = Path(str(part.get("path") or "")).resolve()
        if not _within(movie, root) or movie.suffix.lower() not in (".mov", ".mp4"):
            return False
        st = movie.stat()
        if st.st_size <= 0:
            return False
        expected_size = part.get("file_size")
        if expected_size is not None and int(expected_size) != st.st_size:
            return False
        return True
    except (OSError, TypeError, ValueError):
        return False


def _manifest(path):
    try:
        result = json.loads(Path(path).read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else None
    except (OSError, UnicodeError, ValueError):
        return None


def incomplete_run(
    loop_root, segments, recipe_hashes, plan_hash, segment_format,
    *, verify_media=None,
):
    """Latest resumable *prefix*. Reuse only exact matching contiguous results.

    If a previous run has a corrupt/missing middle clip, we reuse its valid
    prefix and regenerate the rest; we never silently skip a missing clip.
    """
    for path in _manifests(loop_root):
        state = _manifest(path)
        if not state or state.get("status") == "completed" or state.get("rerun_target"):
            continue
        if state.get("plan_fingerprint") != plan_hash:
            continue
        if state.get("segment_format") != segment_format:
            continue
        parts = {
            str(part.get("segment_id")): part
            for part in state.get("clips", []) if isinstance(part, dict)
        }
        prefix = []
        for part, recipe in zip(segments, recipe_hashes):
            if part.get("kind") == "entity":
                # Physical clips never write a MOV output but must replay as
                # context source in the loop.
                prefix.append(None)
                continue
            candidate = parts.get(str(part["id"]))
            if candidate is None or not _descriptor_valid(
                    candidate, loop_root,
                    expected_frames=part["output_frames"],
                    expected_recipe=recipe, required_format=segment_format):
                break
            # For resume all generated clips need to be in the same run
            # folder. This prevents accidentally reusing an unrelated take.
            if Path(candidate["path"]).resolve().parent.parent != path.parent.resolve():
                break
            if verify_media is not None and not verify_media(candidate):
                break
            prefix.append(dict(candidate))
        completed = sum(part is not None for part in prefix)
        if completed:
            return {
                "run_signature": path.parent.name,
                "manifest_path": str(path),
                "prefix": prefix,
                "completed": completed,
                "total_generated": sum(p.get("kind") != "entity" for p in segments),
            }
    return None


def _take_rows(loop_root):
    for path in _manifests(loop_root):
        state = _manifest(path)
        if not state:
            continue
        for item in state.get("clips") or ():
            if isinstance(item, dict):
                yield item


def select_current_takes(
    loop_root, segments, recipe_hashes, segment_format,
    *, seed=None, resolver=None,
):
    """Select the newest recipe-compatible MOV for each generated clip.

    Report downstream clips that were rendered from an older predecessor;
    never silently assert that such a sequence is seamless.
    """
    histories = list(_take_rows(loop_root))
    chosen = []
    problems = []
    stale = []
    prev = None
    for part, recipe in zip(segments, recipe_hashes):
        if part.get("kind") == "entity":
            rel = str(part["source_asset"]["source"]["path"])
            source = str(Path(resolver(rel)).resolve()) if resolver else rel
            prev = {"kind": "entity", "source": source}
            continue
        # In a rebuild request we have the current authored document and seed,
        # but cannot safely query a live Comfy graph from a separate HTTP
        # handler. Verify each take against *its recorded* sampler graph hash,
        # then warn separately when chosen takes used different graph versions.
        def recipe_for(row):
            if seed is None:
                return recipe
            original_graph = row.get("body_fingerprint")
            if not original_graph:
                return ""
            return clip_fingerprint(part, seed, original_graph, resolver)

        entry = next((
            row for row in histories
            if str(row.get("segment_id")) == str(part["id"])
            and _descriptor_valid(row, loop_root,
                    expected_frames=part["output_frames"],
                    expected_recipe=recipe_for(row),
                    required_format=segment_format)
        ), None)
        if entry is None:
            problems.append(f"片段「{part['name']}」没有匹配当前参数的已保存视频")
            prev = {"kind": "missing"}
            continue

        entry = dict(entry)
        entry["index"] = len(chosen)
        assembly = part["assembly"]
        entry["trim_head_frames"] = int(assembly["trim_head_frames"])
        entry["gap_before_frames"] = int(assembly["gap_before_frames"])
        entry["continuity"] = dict(part["continuity"])

        needs_context = part["continuity"]["kind"] in CONTEXT_KINDS
        if prev and prev.get("kind") == "entity":
            # Entity video supplies generation context but is not a visible
            # clip in Final, so don't delete the guided head.
            entry["trim_head_frames"] = 0
            entry["gap_before_frames"] = 0
        if needs_context and prev:
            previous_source = (
                prev.get("path") if prev.get("kind") == "generated"
                else prev.get("source") if prev.get("kind") == "entity"
                else None
            )
            actual_source = entry.get("upstream_source")
            # Unknown metadata is treated as stale, not silently compatible.
            recorded_stat = entry.get("upstream_stat") or {}
            replaced_source = False
            if prev.get("kind") == "entity" and previous_source:
                try:
                    current_stat = Path(previous_source).stat()
                    replaced_source = (
                        int(recorded_stat.get("size", -1)) != current_stat.st_size
                        or int(recorded_stat.get("mtime_ns", -1)) != current_stat.st_mtime_ns
                    )
                except (OSError, TypeError, ValueError):
                    replaced_source = True
            if (not previous_source or not actual_source or replaced_source
                or Path(actual_source).resolve() != Path(previous_source).resolve()):
                stale.append({
                    "segment_id": part["id"],
                    "name": part["name"],
                    "reason": "承接来源与当前选用的上一镜头版本不一致",
                })
        chosen.append(entry)
        prev = {"kind": "generated", "path": entry["path"]}
    # The current model graph may have changed since old takes were created.
    # Mixing samples from different recorded versions requires confirmation.
    graphs = {str(row.get("body_fingerprint") or "") for row in chosen}
    if len(graphs) > 1:
        stale.append({
            "segment_id": "__pipeline__",
            "name": "工作流版本",
            "reason": "选中的镜头由不同版本的采样或解码工作流生成",
        })
    if problems:
        raise ValueError("不能重建整片：" + "；".join(problems))
    return {"clips": chosen, "stale": stale, "total": len(chosen)}
