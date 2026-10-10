"""Read a trace, verify required events, and separate nested host-wall timings.

No ComfyUI/PyTorch imports and no generation. Exit 2 on an incomplete trace.
"""
from __future__ import annotations
import argparse
from collections import Counter
import json
from pathlib import Path


def union_ns(intervals):
    total, right = 0, None
    for start, end in sorted(intervals):
        if end < start: raise ValueError("negative interval")
        total += max(0, end - max(start, right if right is not None else start))
        right = max(end, right if right is not None else end)
    return total


def summarize(records, prompt_id, expected_segments=3):
    selected = [r for r in records if r.get("prompt_id") == prompt_id]
    errors, begins, ends, plans = [], {}, {}, []
    if not selected: errors.append("no records for requested prompt_id")
    sessions = {r.get("session") for r in selected}
    if len(sessions) > 1: errors.append("prompt appears in multiple trace sessions; do not mix clocks")
    for record in selected:
        kind = record.get("event")
        if kind == "plan": plans.append(record)
        if kind in ("begin", "end"):
            target = begins if kind == "begin" else ends
            key = record.get("span_id")
            if not key or key in target: errors.append(f"invalid or duplicate {kind}: {key}")
            target[key] = record
    for key in begins.keys() - ends.keys(): errors.append(f"missing end: {key}")
    for key in ends.keys() - begins.keys(): errors.append(f"missing begin: {key}")
    rows = []
    for key in begins.keys() & ends.keys():
        begin, end = begins[key], ends[key]
        if (begin.get("name"), begin.get("parent_id"), begin.get("node_id")) != (end.get("name"), end.get("parent_id"), end.get("node_id")):
            errors.append(f"span identity mismatch: {key}")
        start, stop = end.get("start_ns"), end.get("end_ns")
        if not isinstance(start, int) or not isinstance(stop, int) or stop < start:
            errors.append(f"invalid duration: {key}"); continue
        parent = begin.get("parent_id")
        if parent is not None and parent not in begins: errors.append(f"missing parent: {key}")
        if end.get("status") != "ok": errors.append(f"failed span: {begin.get('name')} {key}")
        children = []
        for child in ends.values():
            if child.get("parent_id") == key and isinstance(child.get("start_ns"), int) and isinstance(child.get("end_ns"), int):
                a, b = max(start, child["start_ns"]), min(stop, child["end_ns"])
                if b >= a: children.append((a, b))
        rows.append(dict(span_id=key, parent_id=parent, node_id=begin.get("node_id"),
                         director_id=begin.get("director_id"), segment_id=begin.get("segment_id"),
                         name=begin.get("name"), start_ns=start, end_ns=stop,
                         implementation=begin.get("implementation"),
                         memory_before=begin.get("memory"), memory_after=end.get("memory"),
                         models_before=begin.get("models_before"),
                         inclusive_s=(stop-start)/1e9,
                         outside_children_s=(stop-start-union_ns(children))/1e9))
    rows.sort(key=lambda r: r["start_ns"])
    if len(plans) != 1:
        errors.append(f"expected one fresh director plan, found {len(plans)}")
    else:
        planned = plans[0].get("segments", [])
        if len(planned) != expected_segments: errors.append(f"expected {expected_segments} segments, found {len(planned)}")
        required = ("conditioning", "selflift", "low_sampling", "resolution_transition", "latent_upscale", "high_sampling", "latent_checkpoint", "decode_cache")
        for segment in planned:
            counts = Counter(r["name"] for r in rows if r["segment_id"] == segment["id"])
            for name in required:
                if counts[name] != 1: errors.append(f"{segment['id']}: expected one {name}, found {counts[name]}")
        if sum(r["name"] == "final_output" for r in rows) != 1: errors.append("missing or duplicate final_output")
    for row in rows:
        if row["name"] in ("low_sampling", "high_sampling"):
            begin = begins[row["span_id"]]
            callbacks = [r for r in selected if r.get("event") == "step_callback" and r.get("span_id") == row["span_id"]]
            expected = begin.get("sigma_count", 0) - 1
            if [c.get("callback_index") for c in callbacks] != list(range(1, expected+1)):
                errors.append(f"missing/duplicate step callbacks: {row['span_id']}")
            returns = [r for r in selected if r.get("event") == "sampler_return" and r.get("span_id") == row["span_id"]]
            if len(returns) != 1 or returns[0].get("callbacks") != expected:
                errors.append(f"invalid sampler return: {row['span_id']}")
    root_union = union_ns([(r["start_ns"], r["end_ns"]) for r in rows if r["parent_id"] is None]) / 1e9
    return dict(prompt_id=prompt_id, integrity_ok=not errors, integrity_errors=errors,
                measured_root_union_s=root_union, spans=rows,
                step_callbacks=[r for r in selected if r.get("event") == "step_callback"],
                model_events=[r for r in selected if r.get("event") == "model_return"],
                note="Host wall time without forced CUDA sync. Nested inclusive times must not be added. Root union is not whole-task history duration; uncovered work remains unknown.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--prompt-id", required=True)
    parser.add_argument("--expected-segments", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    records = []
    for line_no, line in enumerate(args.trace.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            try: record = json.loads(line)
            except json.JSONDecodeError as exc: parser.error(f"line {line_no}: {exc}")
            if not isinstance(record, dict): parser.error(f"line {line_no}: expected an object")
            records.append(record)
    result = summarize(records, args.prompt_id, args.expected_segments)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with args.output.open("x", encoding="utf-8") as file: file.write(text + "\n")
    print(text)
    return 0 if result["integrity_ok"] else 2


if __name__ == "__main__": raise SystemExit(main())
