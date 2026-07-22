"""Phase 8G-3 - Map traversal validator.

Given a resolved metatile grid (from Phase 8G-2's `resolve_skeleton`),
the validator answers two questions:

  1. Are POIs reachable from each other?  Every (warp, fly_destination,
     trainer_spawn) POI must sit on a walkable cell AND be reachable
     from at least one other navigation POI.

  2. Are there isolated walkable pockets?  Flood-fill the walkable
     region from each POI and report any connected component that
     contains no POI - the player would get stuck.

Plus two cheaper checks:

  3. Invalid water transitions: a `terrain.water.*` cell directly
     adjacent (4-way) to a non-walkable, non-water cell - flagged
     because surf-water tiles in Pokémon's gen-3 engine expect the
     shoreline to be water-adjacent.

  4. Cells whose tag set is empty (the resolver left them with no
     terrain assignment) - almost always a bug in the skeleton
     authoring stage.

The output is a `TraversalReport` carrying:

  - A list of `TraversalIssue` objects with `(severity, location,
    message)` triples.
  - Per-POI reachability bitmap (a tiny adjacency-graph).
  - A `walkable_mask_summary` block showing connected-component
    counts + the largest component's size.

The validator does NOT mutate the resolved grid; it's a read-only
analysis pass.  Used by `propose_validate_map_traversal` (Phase
8G-3 tool) and by `propose_check_story_coherence` (Phase 2C - when
that tool is later extended to validate map traversal as part of
its overall coherence sweep).
"""

from __future__ import annotations

import heapq
from collections import deque
from dataclasses import dataclass, field
from typing import Iterable, Literal

# Reuse the walkability allow-set from the resolver.
from tile_intel.generator.resolve import WALKABLE_TERRAINS, ResolvedMap, ResolvedPOI


Severity = Literal["error", "warning", "info"]


@dataclass(frozen=True)
class TraversalIssue:
    severity: Severity
    code: str
    message: str
    # When the issue maps to a coord, populate one (or a list of them);
    # otherwise leave None.
    x: int | None = None
    y: int | None = None
    poi_id: str | None = None


@dataclass(frozen=True)
class PoiReachabilityEntry:
    poi_id: str
    walkable: bool
    component_size: int
    reachable_pois: list[str]


@dataclass(frozen=True)
class WalkableMaskSummary:
    walkable_cells: int
    component_count: int
    largest_component_size: int
    largest_component_share: float  # fraction of walkable cells in the largest component


@dataclass(frozen=True)
class TraversalReport:
    width: int
    height: int
    walkable_mask: list[list[bool]]
    issues: list[TraversalIssue]
    poi_reachability: list[PoiReachabilityEntry]
    walkable_summary: WalkableMaskSummary
    ok: bool  # True when no `error`-severity issues fired
    summary: str = ""  # Plain-English summary the TS tool surfaces


# ---------------------------------------------------------------------------
# Mask
# ---------------------------------------------------------------------------


def _is_walkable_tags(tags: list[str] | set[str]) -> bool:
    if "traversal.walkable" in tags:
        return True
    return any(t in WALKABLE_TERRAINS for t in tags)


def _build_walkable_mask(tag_grid: list[list[list[str]]]) -> list[list[bool]]:
    return [[_is_walkable_tags(cell) for cell in row] for row in tag_grid]


# ---------------------------------------------------------------------------
# Connected components on walkable cells (BFS)
# ---------------------------------------------------------------------------


def _connected_components(mask: list[list[bool]]) -> tuple[list[list[int]], int]:
    """Label every walkable cell with its component id (1-indexed) +
    return the total component count. Non-walkable cells get 0."""

    h = len(mask)
    w = len(mask[0]) if h else 0
    labels: list[list[int]] = [[0] * w for _ in range(h)]
    next_label = 1

    for y in range(h):
        for x in range(w):
            if not mask[y][x] or labels[y][x]:
                continue
            queue: deque[tuple[int, int]] = deque()
            queue.append((x, y))
            labels[y][x] = next_label
            while queue:
                cx, cy = queue.popleft()
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not labels[ny][nx]:
                        labels[ny][nx] = next_label
                        queue.append((nx, ny))
            next_label += 1
    return labels, next_label - 1


# ---------------------------------------------------------------------------
# A* (within walkable cells, with POI-edge override identical to resolver)
# ---------------------------------------------------------------------------


def _astar(
    start: tuple[int, int],
    goal: tuple[int, int],
    mask: list[list[bool]],
) -> list[tuple[int, int]] | None:
    h = len(mask)
    w = len(mask[0]) if h else 0

    def heuristic(p: tuple[int, int]) -> int:
        return abs(p[0] - goal[0]) + abs(p[1] - goal[1])

    open_set: list[tuple[int, int, tuple[int, int]]] = [(heuristic(start), 0, start)]
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    gscore: dict[tuple[int, int], int] = {start: 0}
    closed: set[tuple[int, int]] = set()
    while open_set:
        _, cur_g, cur = heapq.heappop(open_set)
        if cur == goal:
            path = [cur]
            while cur in came_from:
                cur = came_from[cur]
                path.append(cur)
            path.reverse()
            return path
        if cur in closed:
            continue
        closed.add(cur)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cur[0] + dx, cur[1] + dy
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            # Allow stepping into start or goal even if not walkable.
            if (nx, ny) != goal and not mask[ny][nx]:
                continue
            tentative = cur_g + 1
            if tentative < gscore.get((nx, ny), 1 << 30):
                gscore[(nx, ny)] = tentative
                came_from[(nx, ny)] = cur
                heapq.heappush(
                    open_set, (tentative + heuristic((nx, ny)), tentative, (nx, ny))
                )
    return None


# ---------------------------------------------------------------------------
# Top-level validator
# ---------------------------------------------------------------------------


_NAV_POI_KINDS = {"warp", "fly_destination", "trainer_spawn", "encounter_zone"}


def _poi_cell(poi: ResolvedPOI) -> tuple[int, int] | None:
    """Pick a representative cell for a POI. Shape-bearing POIs use
    the rect centre; coord-bearing POIs use (x, y)."""

    if poi.x is not None and poi.y is not None:
        return (poi.x, poi.y)
    if poi.rect is not None:
        rx, ry, rw, rh = poi.rect
        return (rx + rw // 2, ry + rh // 2)
    return None


def validate_traversal(resolved: ResolvedMap) -> TraversalReport:
    """Validate a resolved map's reachability + walkability."""

    width = resolved.width
    height = resolved.height
    tag_grid = resolved.tag_grid
    mask = _build_walkable_mask(tag_grid)

    issues: list[TraversalIssue] = []

    # 1. Empty-tag cells.
    for y in range(height):
        for x in range(width):
            if not tag_grid[y][x]:
                issues.append(
                    TraversalIssue(
                        severity="warning",
                        code="empty_tag_cell",
                        message=f"cell at ({x}, {y}) has no terrain tag",
                        x=x,
                        y=y,
                    )
                )

    # 2. Invalid water transitions: water cell adjacent to a non-water,
    #    non-walkable cell. (Water → walkable shore is fine; water →
    #    wall is the suspect case.)
    for y in range(height):
        for x in range(width):
            cell_tags = tag_grid[y][x]
            if not any(t.startswith("terrain.water") for t in cell_tags):
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if not (0 <= nx < width and 0 <= ny < height):
                    continue
                ntags = tag_grid[ny][nx]
                if not ntags:
                    continue
                if mask[ny][nx]:
                    continue
                if any(t.startswith("terrain.water") for t in ntags):
                    continue
                issues.append(
                    TraversalIssue(
                        severity="warning",
                        code="invalid_water_transition",
                        message=(
                            f"water cell at ({x}, {y}) borders non-walkable "
                            f"non-water terrain at ({nx}, {ny})"
                        ),
                        x=x,
                        y=y,
                    )
                )
                # One issue per water cell is enough.
                break

    # 3. Connected-component analysis.
    labels, comp_count = _connected_components(mask)
    component_sizes: dict[int, int] = {}
    for row in labels:
        for label in row:
            if label == 0:
                continue
            component_sizes[label] = component_sizes.get(label, 0) + 1
    largest_component = max(component_sizes.values(), default=0)
    walkable_cells = sum(component_sizes.values())
    walkable_summary = WalkableMaskSummary(
        walkable_cells=walkable_cells,
        component_count=comp_count,
        largest_component_size=largest_component,
        largest_component_share=(
            largest_component / walkable_cells if walkable_cells else 0.0
        ),
    )

    # 4. POI reachability + isolated-walkable-pocket check.
    nav_pois: list[tuple[ResolvedPOI, tuple[int, int]]] = []
    for poi in resolved.pois:
        if poi.kind not in _NAV_POI_KINDS:
            continue
        cell = _poi_cell(poi)
        if cell is None:
            issues.append(
                TraversalIssue(
                    severity="warning",
                    code="poi_no_coord",
                    message=f"POI {poi.id!r} has no coordinate or shape",
                    poi_id=poi.id,
                )
            )
            continue
        x, y = cell
        if not (0 <= x < width and 0 <= y < height):
            issues.append(
                TraversalIssue(
                    severity="error",
                    code="poi_out_of_bounds",
                    message=f"POI {poi.id!r} at ({x}, {y}) lies outside map bounds",
                    poi_id=poi.id,
                    x=x,
                    y=y,
                )
            )
            continue
        if not mask[y][x]:
            issues.append(
                TraversalIssue(
                    severity="error",
                    code="poi_on_unwalkable_cell",
                    message=(
                        f"POI {poi.id!r} at ({x}, {y}) is on an unwalkable cell - "
                        f"the player can't reach it"
                    ),
                    poi_id=poi.id,
                    x=x,
                    y=y,
                )
            )
            continue
        nav_pois.append((poi, (x, y)))

    # Pairwise reachability between nav POIs (only within same component).
    poi_reachability: list[PoiReachabilityEntry] = []
    poi_components_with_poi: set[int] = set()
    for poi, (px, py) in nav_pois:
        cid = labels[py][px]
        poi_components_with_poi.add(cid)
        reachable = []
        for other, (ox, oy) in nav_pois:
            if other.id == poi.id:
                continue
            if labels[oy][ox] == cid:
                reachable.append(other.id)
        poi_reachability.append(
            PoiReachabilityEntry(
                poi_id=poi.id,
                walkable=True,
                component_size=component_sizes.get(cid, 0),
                reachable_pois=reachable,
            )
        )

    # 4b. Errors for navigation POIs that should but can't reach each other.
    # Convention: 'entrance' and 'exit' MUST be in the same component if
    # both exist.
    nav_ids = {p[0].id for p in nav_pois}
    if "entrance" in nav_ids and "exit" in nav_ids:
        entrance_entry = next(
            (e for e in poi_reachability if e.poi_id == "entrance"), None
        )
        if entrance_entry and "exit" not in entrance_entry.reachable_pois:
            issues.append(
                TraversalIssue(
                    severity="error",
                    code="entrance_exit_unreachable",
                    message=(
                        "entrance and exit are in different walkable components - "
                        "the player can't traverse the map end-to-end"
                    ),
                )
            )

    # 4c. Isolated walkable pockets (no POI in a component).
    isolated_components = comp_count - len(poi_components_with_poi)
    if isolated_components > 0:
        # Surface up to 3 cells, one per isolated component.
        seen_components: set[int] = set()
        for y in range(height):
            for x in range(width):
                cid = labels[y][x]
                if cid == 0 or cid in poi_components_with_poi:
                    continue
                if cid in seen_components:
                    continue
                seen_components.add(cid)
                if len(seen_components) > 3:
                    break
                issues.append(
                    TraversalIssue(
                        severity="warning",
                        code="isolated_walkable_pocket",
                        message=(
                            f"walkable cell at ({x}, {y}) is in an isolated "
                            f"component of {component_sizes[cid]} cells - no POI "
                            f"reaches this region"
                        ),
                        x=x,
                        y=y,
                    )
                )
            if len(seen_components) >= 3:
                break

    ok = not any(i.severity == "error" for i in issues)
    summary = _build_summary(
        width=width,
        height=height,
        issues=issues,
        walkable_summary=walkable_summary,
        nav_pois=nav_pois,
        poi_reachability=poi_reachability,
        ok=ok,
    )

    return TraversalReport(
        width=width,
        height=height,
        walkable_mask=mask,
        issues=issues,
        poi_reachability=poi_reachability,
        walkable_summary=walkable_summary,
        ok=ok,
        summary=summary,
    )


def _build_summary(
    *,
    width: int,
    height: int,
    issues: list[TraversalIssue],
    walkable_summary: WalkableMaskSummary,
    nav_pois: list[tuple[ResolvedPOI, tuple[int, int]]],
    poi_reachability: list[PoiReachabilityEntry],
    ok: bool,
) -> str:
    """Plain-English summary for the propose tool to surface."""

    lines: list[str] = []
    total_cells = width * height
    walkable_pct = (
        round(walkable_summary.walkable_cells / total_cells * 100, 1)
        if total_cells
        else 0
    )
    lines.append(
        f"Traversal check {'passed' if ok else 'failed'}: "
        f"{walkable_summary.walkable_cells} of {total_cells} cells walkable "
        f"({walkable_pct}%), split across "
        f"{walkable_summary.component_count} connected region"
        f"{'s' if walkable_summary.component_count != 1 else ''}."
    )
    if walkable_summary.component_count > 1:
        lines.append(
            f"Largest region has {walkable_summary.largest_component_size} cells "
            f"({round(walkable_summary.largest_component_share * 100, 1)}% of all walkable cells)."
        )
    lines.append(
        f"Navigation POIs found: {len(nav_pois)} "
        f"({', '.join(p[0].id for p in nav_pois) if nav_pois else 'none'})."
    )
    errors = [i for i in issues if i.severity == "error"]
    warnings = [i for i in issues if i.severity == "warning"]
    if errors:
        lines.append(f"Errors ({len(errors)}):")
        for e in errors[:6]:
            lines.append(f"  - {e.message}")
        if len(errors) > 6:
            lines.append(f"  - ... and {len(errors) - 6} more.")
    if warnings:
        lines.append(f"Warnings ({len(warnings)}):")
        for w in warnings[:6]:
            lines.append(f"  - {w.message}")
        if len(warnings) > 6:
            lines.append(f"  - ... and {len(warnings) - 6} more.")
    if ok and not warnings:
        lines.append("No issues detected. The map is safe to apply.")
    return "\n".join(lines)


__all__ = [
    "TraversalIssue",
    "TraversalReport",
    "PoiReachabilityEntry",
    "WalkableMaskSummary",
    "validate_traversal",
]


# Re-export astar for callers that want to use it directly (e.g.
# Phase 8H-2 `propose_complete_region`).
_REEXPORT = (_astar, Iterable)  # noqa: F841
