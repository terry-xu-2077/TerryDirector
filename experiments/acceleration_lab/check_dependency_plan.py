"""Read-only pip dry-run guard; never installs, imports GPU code or calls a server.

Run under the ACTUAL target Python. Checks core pins, an explicit replacement
allowlist and the projected base requirements of ALL installed distributions.
Optional extras and runtime/binary compatibility still require local validation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from importlib import metadata
import json
from pathlib import Path
import re
import sys

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name
from packaging.version import Version

LAB = Path(__file__).resolve().parent


def read_pins(path):
    pins = {}
    for number, line in enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s;*]+)", line)
        if not match:
            raise ValueError(f"Pin file line {number} must be a single exact name==version")
        name, version = canonicalize_name(match[1]), match[2]
        Version(version)
        if name in pins:
            raise ValueError(f"Duplicate pin: {name}")
        pins[name] = version
    if not pins:
        raise ValueError("Empty pin set")
    return pins


def installed_rows():
    rows = []
    for dist in metadata.distributions():
        name = dist.metadata.get("Name")
        if not name:
            raise ValueError("Installed distribution is missing Name metadata")
        rows.append({"name": name, "version": dist.version,
                     "requires_dist": list(dist.requires or []),
                     "requires_python": dist.metadata.get("Requires-Python")})
    return rows


def indexed(rows):
    result = {}
    for row in rows:
        name = canonicalize_name(row["name"])
        if name in result:
            raise ValueError(f"Duplicate normalized distribution metadata: {name}")
        Version(row["version"])
        result[name] = row
    return result


def validate(installed, changes, core, approved, environment=None):
    """Evaluate an explicit future state without modifying the current one."""
    environment = dict(environment or default_environment())
    environment["extra"] = ""
    current = indexed(installed)
    replacements = indexed(changes)
    projected = {**current, **replacements}
    errors = []
    if set(core) & set(approved):
        errors.append("Repair allowlist must not include protected core packages")
    for name, expected in core.items():
        row = current.get(name)
        if row is None or Version(row["version"]) != Version(expected):
            errors.append(f"Protected core mismatch: {name}, expected {expected}")
        if name in replacements:
            errors.append(f"Protected package appears in installation plan: {name}")
    for name, row in replacements.items():
        if name not in approved:
            errors.append(f"Unapproved package in installation plan: {name}=={row['version']}")
        elif Version(row["version"]) != Version(approved[name]):
            errors.append(f"Unapproved version for {name}: {row['version']}, expected {approved[name]}")
    for name, expected in approved.items():
        row = projected.get(name)
        if row is None or Version(row["version"]) != Version(expected):
            errors.append(f"Target not satisfied: {name}=={expected}")
    checked = 0
    direct_urls = set()
    for name, row in projected.items():
        python_rule = row.get("requires_python")
        if python_rule and not SpecifierSet(python_rule).contains(environment["python_full_version"], prereleases=True):
            errors.append(f"Python requirement not satisfied: {name} requires {python_rule}")
        for raw in row.get("requires_dist") or []:
            try:
                req = Requirement(raw)
                if req.marker is not None and not req.marker.evaluate(environment):
                    continue
            except Exception as exc:
                errors.append(f"Unparseable requirement in {name}: {type(exc).__name__}")
                continue
            checked += 1
            target_name = canonicalize_name(req.name)
            target = projected.get(target_name)
            if target is None:
                errors.append(f"Missing dependency: {name} requires {target_name}")
            elif req.specifier and not req.specifier.contains(Version(target["version"]), prereleases=True):
                errors.append(f"Reverse dependency conflict: {name} requires {target_name}{req.specifier}; projected {target['version']}")
            if req.url:
                direct_urls.add(f"{name} -> {target_name}")
    return {"ok": not errors, "errors": errors,
            "base_requirements_checked": checked,
            "installed_distribution_count": len(current),
            "approved_targets": approved, "protected_core": core,
            "proposed_changes": {n: r["version"] for n, r in replacements.items()},
            "direct_url_dependencies_requiring_manual_source_check": sorted(direct_urls),
            "limitations": ["Optional extras are not inferred from installed metadata.",
                            "Direct URL source identity requires a separate manual hash/origin check.",
                            "No ABI, import, CUDA gate, plugin or generation test is performed."],
            "installation_executed": False, "generation_submissions": 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--report", type=Path, help="pip install --dry-run --report JSON")
    mode.add_argument("--check-installed", action="store_true")
    parser.add_argument("--core", type=Path, default=LAB / "environment/cu130-core.constraints.txt")
    parser.add_argument("--approved", type=Path, default=LAB / "environment/repair-candidates.requirements.txt")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.output.exists():
        parser.error("Output already exists; preserve prior evidence and choose a new path")
    try:
        env = default_environment()
        report = None
        changes = []
        if args.report:
            report = json.loads(args.report.read_text(encoding="utf-8-sig"))
            if str(report.get("version")) != "1" or not isinstance(report.get("install"), list):
                raise ValueError("Expected pip installation-report version 1 with an install list")
            recorded = report.get("environment", {})
            for key in ("python_full_version", "sys_platform", "platform_machine", "implementation_name"):
                if recorded.get(key) != env.get(key):
                    raise ValueError(f"Plan was produced for a different/missing environment field: {key}")
            for item in report["install"]:
                info = item["metadata"]
                # Missing Requires-Dist means no declared dependencies, as in pip's report.
                changes.append({"name": info["name"], "version": info["version"],
                                "requires_dist": info.get("requires_dist", []),
                                "requires_python": info.get("requires_python")})
        result = validate(installed_rows(), changes, read_pins(args.core), read_pins(args.approved), env)
        result["status"] = (("INSTALLED_METADATA_OK" if args.check_installed else "PLAN_METADATA_OK")
                            if result["ok"] else "BLOCKED")
        result["runtime"] = {"python": env["python_full_version"], "platform": env["sys_platform"]}
    except Exception as exc:
        result = {"ok": False, "status": "ERROR", "error_type": type(exc).__name__,
                  "message": str(exc), "installation_executed": False, "generation_submissions": 0}
    result["checked_at_utc"] = datetime.now(timezone.utc).isoformat()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
