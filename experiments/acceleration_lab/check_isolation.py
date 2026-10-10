"""Read-only repository/API boundary check. Never starts ComfyUI or queues a job.

This checks isolation, not node registration, output quality, or graph validity.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess

FROZEN_BASE = "0c82cd7bfb2de963304479eda86e02513e106da0"
LAB_ROOT = "experiments/acceleration_lab/"
TASK_PATH = "docs/47_ACCELERATION_LAB_TEST.md"


def allowed_path(path: str) -> bool:
    return path.startswith(LAB_ROOT) or path == TASK_PATH


def _git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def changed_paths(repo: Path, baseline: str = FROZEN_BASE) -> list[str]:
    _git(repo, "rev-parse", "--verify", f"{baseline}^{{commit}}")
    # Includes committed, staged, unstaged and non-ignored untracked changes.
    # --no-renames makes a production-file rename visible as a deletion too.
    raw = _git(repo, "diff", "--no-renames", "--name-only", "-z", baseline, "--")
    raw += _git(repo, "ls-files", "--others", "--exclude-standard", "-z")
    return sorted({value.decode("utf-8", errors="surrogateescape") for value in raw.split(b"\0") if value})


def prompt_errors(payload: object, mode: str = "sample") -> list[str]:
    if not isinstance(payload, dict):
        return ["API payload must be an object"]
    graph = payload.get("prompt", payload)
    if not isinstance(graph, dict) or not graph:
        return ["API prompt must contain nodes"]
    errors = []
    for node_id, node in graph.items():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
            errors.append(f"{node_id}: expected an API node, not UI workflow metadata")
            continue
        kind = node["class_type"]
        # The existing sampler may be reused read-only; director orchestration may not.
        if kind.startswith("TerryDirector") and kind != "TerryDirectorSelfLiftSampler":
            errors.append(f"{node_id}: production director node forbidden: {kind}")
        if kind == "SelfLiftAvatarH3Sampler":
            errors.append(f"{node_id}: external SelfLift sampler forbidden")
        if mode == "decode" and (
            "sampler" in kind.lower() or "selflift" in kind.lower()
            or kind in {"MiniMaxH3ReferenceToVideo", "UNETLoader", "CLIPLoader", "BasicScheduler"}
        ):
            errors.append(f"{node_id}: decode-only graph must not run generation: {kind}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--baseline", default=FROZEN_BASE)
    parser.add_argument("--api", type=Path, help="Optional local API prompt JSON; not a UI workflow")
    parser.add_argument("--mode", choices=("sample", "decode"), default="sample")
    args = parser.parse_args(argv)
    try:
        changed = changed_paths(args.repo, args.baseline)
        forbidden = [path for path in changed if not allowed_path(path)]
        errors = prompt_errors(json.loads(args.api.read_text(encoding="utf-8-sig")), args.mode) if args.api else []
        result = dict(
            baseline=args.baseline, changed_paths=changed,
            forbidden_changed_paths=forbidden,
            production_files_unchanged=not forbidden,
            api_checked=args.api is not None, api_errors=errors,
            isolation_ok=not forbidden and not errors,
            note="Read-only boundary check; not proof of ComfyUI registration, transitive helper behavior, performance, or quality.",
        )
    except (OSError, RuntimeError, ValueError) as exc:
        result = dict(isolation_ok=False, error=str(exc))
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result["isolation_ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
