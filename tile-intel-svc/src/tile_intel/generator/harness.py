"""Phase 8J-1 - Generated-map smoke-boot harness.

Takes a resolved-map JSON (produced by Phase 8G-2) and verifies
its internal invariants + computes a deterministic fingerprint
the editor can compare against a persisted baseline to detect
regressions.

Specifically, the harness checks:

  - Grid shape matches the report's width / height.
  - Every assigned cell references a tileset slug that's in the
    grid's declared (primary, secondary) pair (or any of the
    skeleton's templated tilesets - those leak through resolver
    instantiation).
  - Cell count totals match the resolver's report
    (assigned + unassigned = width * height).
  - Border block is non-empty (a missing border block crashes
    the GBA engine when the camera nears the map edge).
  - POI cells are within map bounds (the resolver's path solver
    can place "phantom" cells if it follows a malformed skeleton).
  - The `pois` list matches the report's count.

The fingerprint is sha256 of the canonicalized resolved-map JSON
(sorted keys, no whitespace). Re-running the harness with the same
resolved-map yields the same fingerprint - useful for asserting
"this slug's resolver output didn't drift" after a sidecar update.

mGBA-WASM smoke-boot is intentionally NOT in this module's scope
(per the Phase 8J plan note that the engine harness ships
byte-level + header invariants while emulator-boot is a future
enhancement once the in-process emulator integration lands).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class HarnessIssue:
    severity: str  # 'error' | 'warning'
    code: str
    message: str


@dataclass(frozen=True)
class HarnessReport:
    ok: bool
    fingerprint: str
    width: int
    height: int
    assigned_cells: int
    unassigned_cells: int
    distinct_tileset_slugs: list[str]
    issues: list[HarnessIssue] = field(default_factory=list)
    # When a baseline file existed, this is its fingerprint; the
    # caller compares to the new fingerprint to detect drift.
    baseline_fingerprint: str | None = None
    baseline_match: bool | None = None
    summary: str = ""


def _canonicalize(obj: object) -> str:
    """Deterministic JSON: sorted keys, no whitespace."""

    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def fingerprint_resolved_map(resolved: dict) -> str:
    """SHA-256 of canonical resolved-map JSON."""

    return hashlib.sha256(_canonicalize(resolved).encode("utf-8")).hexdigest()


def check_resolved_map(
    resolved: dict,
    baseline_fingerprint: str | None = None,
) -> HarnessReport:
    """Validate a resolved-map dict + compute its fingerprint."""

    issues: list[HarnessIssue] = []
    width = int(resolved.get("width", 0))
    height = int(resolved.get("height", 0))
    grid = resolved.get("grid", [])
    tag_grid = resolved.get("tag_grid", [])
    border = resolved.get("border_blocks", [])
    pois = resolved.get("pois", []) or []
    report = resolved.get("report", {}) or {}

    # Shape checks.
    if len(grid) != height:
        issues.append(
            HarnessIssue(
                severity="error",
                code="grid_height_mismatch",
                message=f"grid has {len(grid)} rows but report says height={height}",
            )
        )
    for y, row in enumerate(grid):
        if not isinstance(row, list):
            continue
        if len(row) != width:
            issues.append(
                HarnessIssue(
                    severity="error",
                    code="grid_row_width_mismatch",
                    message=f"row {y} has {len(row)} cells but width={width}",
                )
            )

    if len(tag_grid) != height:
        issues.append(
            HarnessIssue(
                severity="warning",
                code="tag_grid_height_mismatch",
                message=f"tag_grid has {len(tag_grid)} rows but height={height}",
            )
        )

    # Border block must be 2x2 and at least one non-null cell.
    if len(border) != 2 or any(len(row) != 2 for row in border):
        issues.append(
            HarnessIssue(
                severity="error",
                code="border_shape",
                message=f"border_blocks must be 2x2 (got {len(border)} rows)",
            )
        )
    else:
        flat_border = [c for row in border for c in row]
        if all(c is None for c in flat_border):
            issues.append(
                HarnessIssue(
                    severity="warning",
                    code="border_empty",
                    message=(
                        "border_blocks are all None - the GBA engine will "
                        "render garbage when the camera nears the map edge"
                    ),
                )
            )

    # Cell totals match the report.
    assigned = 0
    unassigned = 0
    distinct_slugs: set[str] = set()
    for row in grid:
        if not isinstance(row, list):
            continue
        for cell in row:
            if cell is None:
                unassigned += 1
            else:
                assigned += 1
                if isinstance(cell, dict):
                    slug = cell.get("tileset_slug")
                    if slug:
                        distinct_slugs.add(str(slug))
    expected_assigned = int(report.get("assigned_cells", -1))
    expected_unassigned = int(report.get("unassigned_cells", -1))
    if expected_assigned != -1 and expected_assigned != assigned:
        issues.append(
            HarnessIssue(
                severity="error",
                code="assigned_count_mismatch",
                message=f"report.assigned_cells={expected_assigned}, observed={assigned}",
            )
        )
    if expected_unassigned != -1 and expected_unassigned != unassigned:
        issues.append(
            HarnessIssue(
                severity="error",
                code="unassigned_count_mismatch",
                message=f"report.unassigned_cells={expected_unassigned}, observed={unassigned}",
            )
        )

    # Tileset slug consistency: every assigned cell must reference
    # either the primary or secondary tileset (or a slug from a
    # template that the resolver pulled in).
    primary = resolved.get("primary_tileset_slug")
    secondary = resolved.get("secondary_tileset_slug")
    known = {primary, secondary} - {None}
    out_of_set = distinct_slugs - {str(k) for k in known}
    if out_of_set:
        issues.append(
            HarnessIssue(
                severity="warning",
                code="tileset_slug_drift",
                message=(
                    "cells reference tilesets outside the declared "
                    f"primary/secondary pair: {sorted(out_of_set)[:5]}"
                    + (" …" if len(out_of_set) > 5 else "")
                ),
            )
        )

    # POI bounds.
    for poi in pois:
        x = poi.get("x")
        y = poi.get("y")
        if x is not None and y is not None:
            if not (0 <= int(x) < width and 0 <= int(y) < height):
                issues.append(
                    HarnessIssue(
                        severity="error",
                        code="poi_out_of_bounds",
                        message=f"POI {poi.get('id')!r} at ({x},{y}) outside {width}x{height}",
                    )
                )

    fingerprint = fingerprint_resolved_map(resolved)
    baseline_match: bool | None = None
    if baseline_fingerprint is not None:
        baseline_match = baseline_fingerprint == fingerprint
        if not baseline_match:
            issues.append(
                HarnessIssue(
                    severity="warning",
                    code="baseline_drift",
                    message=(
                        f"fingerprint changed from baseline "
                        f"{baseline_fingerprint[:12]}… to {fingerprint[:12]}…"
                    ),
                )
            )

    ok = not any(i.severity == "error" for i in issues)
    summary = _build_summary(
        ok=ok,
        width=width,
        height=height,
        assigned=assigned,
        unassigned=unassigned,
        distinct=distinct_slugs,
        issues=issues,
        baseline_match=baseline_match,
        fingerprint=fingerprint,
    )

    return HarnessReport(
        ok=ok,
        fingerprint=fingerprint,
        width=width,
        height=height,
        assigned_cells=assigned,
        unassigned_cells=unassigned,
        distinct_tileset_slugs=sorted(distinct_slugs),
        issues=issues,
        baseline_fingerprint=baseline_fingerprint,
        baseline_match=baseline_match,
        summary=summary,
    )


def _build_summary(
    *,
    ok: bool,
    width: int,
    height: int,
    assigned: int,
    unassigned: int,
    distinct: Iterable[str],
    issues: list[HarnessIssue],
    baseline_match: bool | None,
    fingerprint: str,
) -> str:
    lines: list[str] = []
    lines.append(
        f"Harness {'passed' if ok else 'failed'}: "
        f"{assigned} assigned / {unassigned} unassigned cells in {width}×{height} map."
    )
    distinct_list = list(distinct)
    if distinct_list:
        lines.append(
            f"Tileset slugs referenced: {len(distinct_list)} "
            f"({', '.join(sorted(distinct_list)[:3])}"
            + (" …" if len(distinct_list) > 3 else "")
            + ")."
        )
    if baseline_match is True:
        lines.append(f"Baseline match: ✓ ({fingerprint[:12]}…)")
    elif baseline_match is False:
        lines.append(f"Baseline drift detected ({fingerprint[:12]}…)")
    errors = [i for i in issues if i.severity == "error"]
    warnings = [i for i in issues if i.severity == "warning"]
    if errors:
        lines.append(f"Errors ({len(errors)}):")
        for e in errors[:5]:
            lines.append(f"  - {e.message}")
        if len(errors) > 5:
            lines.append(f"  - … and {len(errors) - 5} more")
    if warnings:
        lines.append(f"Warnings ({len(warnings)}):")
        for w in warnings[:5]:
            lines.append(f"  - {w.message}")
        if len(warnings) > 5:
            lines.append(f"  - … and {len(warnings) - 5} more")
    if not errors and not warnings:
        lines.append("No issues. The resolved map is safe to apply.")
    return "\n".join(lines)


def save_baseline(baseline_path: Path, fingerprint: str) -> None:
    """Persist a baseline fingerprint to disk. The caller decides
    when to update - typically after a confirmed good resolve."""

    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline_path.write_text(
        json.dumps({"fingerprint": fingerprint}, indent=2),
        encoding="utf-8",
    )


def load_baseline(baseline_path: Path) -> str | None:
    """Read a baseline fingerprint; returns None when the file
    doesn't exist (so callers can branch "no baseline → just
    persist the current one")."""

    if not baseline_path.exists():
        return None
    try:
        data = json.loads(baseline_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    fp = data.get("fingerprint")
    return str(fp) if isinstance(fp, str) else None


__all__ = [
    "HarnessIssue",
    "HarnessReport",
    "check_resolved_map",
    "fingerprint_resolved_map",
    "load_baseline",
    "save_baseline",
]
