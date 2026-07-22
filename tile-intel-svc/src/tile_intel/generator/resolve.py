"""Phase 8G-2 - Skeleton → metatile-grid resolver.

The "from intent to bytes" half of the two-stage map-generation
pipeline. Reads a `MapSkeleton` DSL document (produced by 8G-1)
and emits a `ResolvedMap` carrying:

  * a `width × height` grid of `(tileset_slug, metatile_index)`
    placements (`None` for cells the resolver couldn't fill),
  * a `tags_grid` recording which tags each cell inherited from
    region layering / paths / templates,
  * a `border_block` (2 × 2 metatile IDs) to use as the map's bezel,
  * a structured `report` with diagnostics (unassigned-cell count,
    rule-respect rate, template anchor failures, etc.).

The resolver is the place where biome + adjacency knowledge from
8C / 8D / 8F crystallise into concrete metatile choices.  We
intentionally STOP at the metatile grid; the TS side
(`propose_resolve_map_skeleton`) composes the actual
`propose_create_map` + `propose_paint_map_blocks` tool calls.

Algorithm (v1 - greedy, no AC-3 / WFC fallback):

  1. Layer regions by priority. Each cell collects a tag set drawn
     from the region's `tags.terrain` (or `terrain.unknown` if the
     region didn't specify one).
  2. Solve paths via 4-direction A* over a walkability mask
     (anything tagged `traversal.walkable` or with a terrain we
     consider walkable). Overlay `terrain.path` on solved cells.
  3. Instantiate templates: for each `TemplateRef`, look up the
     template's `cells` (a `height × width` grid of
     `{ tilesetSlug, metatileIndex }`), and paint the literal
     metatile IDs at `(anchor.x + tx, anchor.y + ty)`. Templates
     win over any earlier placement.
  4. Greedy metatile fill for un-assigned cells: pick a metatile
     that
       a) is tagged with the cell's terrain (via `metatile_tags`
          joined on `tag_taxonomy.slug`),
       b) is a legal neighbour of any already-placed neighbours
          per the `adjacency_rules` table (best-effort - we don't
          backtrack),
       c) prefers the skeleton's `primary_tileset` /
          `secondary_tileset`.
  5. Border block: 2 × 2 metatile IDs derived from the skeleton's
     dominant background terrain.
  6. Validation: count cells the resolver failed to fill, count
     adjacency-rule violations.

Determinism: the resolver uses an internal `random.Random(seed)`
seeded from the skeleton's `seed` field (carried via the report
when supplied). Two calls with the same skeleton + DB state
produce identical output.
"""

from __future__ import annotations

import random
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Iterable

from sqlalchemy import select

from tile_intel.domain.models import (
    AdjacencyRule,
    Metatile,
    MetatileTag,
    TagTaxonomy,
    Template,
    Tileset,
)
from tile_intel.grammar.dsl import (
    MapSkeleton,
    PathEndpointPoint,
    PathEndpointRef,
    PointShape,
    PolygonShape,
    RectShape,
)
from tile_intel.storage.base import SqlAlchemyStorageFactory


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


# A placed metatile: (tileset_slug, metatile_index_in_tileset).
MetatilePlacement = tuple[str, int]


@dataclass(frozen=True)
class ResolvedMapReport:
    """Diagnostic summary the TS side surfaces to the user."""

    seed: int
    width: int
    height: int
    assigned_cells: int
    unassigned_cells: int
    template_anchors_placed: int
    template_anchors_skipped: int
    rule_violations: int
    rules_consulted: int
    paths_solved: int
    paths_failed: int
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ResolvedPOI:
    """Per-POI metadata carried into the resolved output so the
    Phase 8G-3 validator can find POI cells without re-reading the
    original skeleton."""

    id: str
    kind: str
    x: int | None
    y: int | None
    # Optional rect for shape-bearing POIs (encounter zones).
    rect: tuple[int, int, int, int] | None  # (x, y, w, h)


@dataclass(frozen=True)
class ResolvedMap:
    """Output of `resolve_skeleton`. `grid[y][x]` is `None` when
    the resolver couldn't pick a metatile for that cell."""

    width: int
    height: int
    grid: list[list[MetatilePlacement | None]]
    tag_grid: list[list[list[str]]]  # per-cell sorted tag list
    primary_tileset_slug: str
    secondary_tileset_slug: str
    border_blocks: list[list[MetatilePlacement | None]]  # 2x2
    report: ResolvedMapReport
    pois: list[ResolvedPOI]


# ---------------------------------------------------------------------------
# Tag-table lookups
# ---------------------------------------------------------------------------


@dataclass
class TagIndex:
    """In-memory cache of `tag_slug → [(tileset_slug, metatile_index, metatile_id, behavior_id)]`.

    Built once per resolve call to avoid N+1 queries against
    `metatile_tags`.
    """

    by_tag: dict[str, list[tuple[str, int, int, int]]]

    @classmethod
    def from_db(cls, session) -> TagIndex:
        rows = session.execute(
            select(
                TagTaxonomy.slug,
                Tileset.slug,
                Metatile.metatile_index,
                Metatile.id,
                Metatile.behavior_id,
            )
            .join(MetatileTag, MetatileTag.tag_id == TagTaxonomy.id)
            .join(Metatile, Metatile.id == MetatileTag.metatile_id)
            .join(Tileset, Tileset.id == Metatile.tileset_id)
        ).all()
        by_tag: dict[str, list[tuple[str, int, int, int]]] = defaultdict(list)
        for tag_slug, ts_slug, mt_idx, mt_id, beh in rows:
            by_tag[str(tag_slug)].append(
                (str(ts_slug), int(mt_idx), int(mt_id), int(beh))
            )
        return cls(by_tag=dict(by_tag))

    def candidates_for_tag(self, tag_slug: str) -> list[tuple[str, int, int, int]]:
        return self.by_tag.get(tag_slug, [])

    def candidates_for_tags(
        self, tag_slugs: Iterable[str]
    ) -> list[tuple[str, int, int, int]]:
        """Union of candidates across multiple tags; preserves DB order
        + deduplicates by (tileset_slug, metatile_index)."""

        seen: set[tuple[str, int]] = set()
        out: list[tuple[str, int, int, int]] = []
        for tag in tag_slugs:
            for cand in self.by_tag.get(tag, []):
                key = (cand[0], cand[1])
                if key in seen:
                    continue
                seen.add(key)
                out.append(cand)
        return out


# ---------------------------------------------------------------------------
# Region layering
# ---------------------------------------------------------------------------


def _cells_in_shape(shape, width: int, height: int) -> Iterable[tuple[int, int]]:
    """Yield (x, y) cells covered by a Region/POI shape, clipped to
    the map's bounds. Polygon support is intentionally crude - a
    bounding-box approximation, since template anchors don't tend
    to need pixel-perfect polygon fill."""

    if isinstance(shape, RectShape):
        for x in range(shape.x, min(width, shape.x + shape.w)):
            for y in range(shape.y, min(height, shape.y + shape.h)):
                yield (x, y)
    elif isinstance(shape, PointShape):
        if 0 <= shape.x < width and 0 <= shape.y < height:
            yield (shape.x, shape.y)
    elif isinstance(shape, PolygonShape):
        # Bounding-box approximation.
        xs = [p[0] for p in shape.points]
        ys = [p[1] for p in shape.points]
        x0, x1 = max(0, min(xs)), min(width, max(xs) + 1)
        y0, y1 = max(0, min(ys)), min(height, max(ys) + 1)
        for x in range(x0, x1):
            for y in range(y0, y1):
                yield (x, y)


def _layer_regions(
    skeleton: MapSkeleton,
) -> list[list[set[str]]]:
    """Build a `height × width` grid of cell tag sets by layering
    regions in priority order."""

    w = skeleton.map.size.w
    h = skeleton.map.size.h
    grid: list[list[set[str]]] = [[set() for _ in range(w)] for _ in range(h)]

    for region in sorted(skeleton.regions, key=lambda r: r.priority):
        terrain = region.tags.terrain or "terrain.unknown"
        for (x, y) in _cells_in_shape(region.shape, w, h):
            grid[y][x] = {terrain}  # higher priority replaces.
    return grid


# ---------------------------------------------------------------------------
# Walkability + A*
# ---------------------------------------------------------------------------


WALKABLE_TERRAINS = {
    "terrain.grass",
    "terrain.grass.short",
    "terrain.grass.tall",
    "terrain.grass.long",
    "terrain.dirt",
    "terrain.sand",
    "terrain.path",
    "terrain.cave.floor",
    "terrain.bridge",
    "terrain.snow",
    "terrain.unknown",
    "terrain.flowerbed",
}


def _is_walkable(tags: set[str]) -> bool:
    """A cell is walkable when its terrain is in the allow-set OR
    it carries the `traversal.walkable` tag."""

    if "traversal.walkable" in tags:
        return True
    return any(t in WALKABLE_TERRAINS for t in tags)


def _astar(
    start: tuple[int, int],
    goal: tuple[int, int],
    walkable: list[list[bool]],
) -> list[tuple[int, int]] | None:
    """4-direction A* with Manhattan heuristic. Returns the path
    (inclusive of start + goal) or None if no walkable path exists."""

    import heapq

    h = len(walkable)
    w = len(walkable[0]) if h else 0
    if not (0 <= start[0] < w and 0 <= start[1] < h):
        return None
    if not (0 <= goal[0] < w and 0 <= goal[1] < h):
        return None

    def heuristic(p: tuple[int, int]) -> int:
        return abs(p[0] - goal[0]) + abs(p[1] - goal[1])

    open_set: list[tuple[int, int, tuple[int, int]]] = [(heuristic(start), 0, start)]
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    gscore: dict[tuple[int, int], int] = {start: 0}
    closed: set[tuple[int, int]] = set()

    while open_set:
        _, cur_g, cur = heapq.heappop(open_set)
        if cur == goal:
            # Reconstruct.
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
            # The path can pass THROUGH start + goal even if the
            # cells aren't otherwise walkable (entrance / exit
            # warps tend to sit on map edges that the bg region
            # painted as non-walkable).
            if (nx, ny) != goal and not walkable[ny][nx]:
                continue
            tentative = cur_g + 1
            if tentative < gscore.get((nx, ny), 1 << 30):
                gscore[(nx, ny)] = tentative
                came_from[(nx, ny)] = cur
                heapq.heappush(open_set, (tentative + heuristic((nx, ny)), tentative, (nx, ny)))
    return None


def _endpoint_to_xy(
    endpoint, pois_by_id: dict[str, tuple[int, int]]
) -> tuple[int, int] | None:
    """Resolve a path endpoint (POI ref or literal coord) to a cell."""

    if isinstance(endpoint, PathEndpointPoint):
        return (endpoint.x, endpoint.y)
    if isinstance(endpoint, PathEndpointRef):
        if not endpoint.ref.startswith("poi:"):
            return None
        return pois_by_id.get(endpoint.ref.removeprefix("poi:"))
    return None


def _solve_paths(
    skeleton: MapSkeleton,
    tag_grid: list[list[set[str]]],
) -> tuple[list[list[tuple[int, int]]], int]:
    """Solve every Path endpoint pair in order, mutating `tag_grid`
    along the way (every path cell gains `terrain.path` +
    `traversal.walkable`). Returns the per-path cell lists +
    the count of paths the solver couldn't satisfy."""

    w = skeleton.map.size.w
    h = skeleton.map.size.h
    pois_by_id: dict[str, tuple[int, int]] = {}
    for poi in skeleton.pois:
        if poi.x is not None and poi.y is not None:
            pois_by_id[poi.id] = (poi.x, poi.y)

    solved: list[list[tuple[int, int]]] = []
    failed = 0

    for path in skeleton.paths:
        if len(path.endpoints) < 2:
            failed += 1
            continue
        # Refresh walkability since previous paths may have widened it.
        walkable = [[_is_walkable(tag_grid[y][x]) for x in range(w)] for y in range(h)]
        path_cells: list[tuple[int, int]] = []
        prev = _endpoint_to_xy(path.endpoints[0], pois_by_id)
        if prev is None:
            failed += 1
            continue
        leg_failed = False
        for nxt in path.endpoints[1:]:
            target = _endpoint_to_xy(nxt, pois_by_id)
            if target is None:
                leg_failed = True
                break
            leg = _astar(prev, target, walkable)
            if leg is None:
                leg_failed = True
                break
            for cell in leg:
                if not path_cells or path_cells[-1] != cell:
                    path_cells.append(cell)
            prev = target
        if leg_failed:
            failed += 1
            continue

        # Width-N corridor: dilate each cell by Chebyshev radius
        # floor((width-1) / 2). Width=1 leaves cells untouched.
        dilation = max(0, (path.width_metatiles - 1) // 2)
        expanded: set[tuple[int, int]] = set(path_cells)
        if dilation > 0:
            for x, y in list(path_cells):
                for dx in range(-dilation, dilation + 1):
                    for dy in range(-dilation, dilation + 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            expanded.add((nx, ny))

        # Re-walk in path order and apply path tags.
        for x, y in expanded:
            tag_grid[y][x] = {"terrain.path", "traversal.walkable"}

        solved.append(sorted(expanded))

    return solved, failed


# ---------------------------------------------------------------------------
# Template instantiation
# ---------------------------------------------------------------------------


def _instantiate_templates(
    session,
    skeleton: MapSkeleton,
    grid: list[list[MetatilePlacement | None]],
) -> tuple[int, int]:
    """Read template rows for each TemplateRef + paint metatile IDs
    into `grid`. Returns `(placed, skipped)` counts."""

    placed = 0
    skipped = 0
    w = skeleton.map.size.w
    h = skeleton.map.size.h

    for ref in skeleton.templates:
        template = (
            session.execute(
                select(Template).where(Template.slug == ref.ref).limit(1)
            )
            .scalars()
            .first()
        )
        if template is None:
            skipped += 1
            continue
        # `cells` is height × width grid of { tilesetSlug, metatileIndex }.
        cells = template.cells
        height_cells = template.height
        width_cells = template.width
        any_painted = False
        for ty in range(height_cells):
            for tx in range(width_cells):
                gx, gy = ref.anchor.x + tx, ref.anchor.y + ty
                if not (0 <= gx < w and 0 <= gy < h):
                    continue
                row = cells[ty] if ty < len(cells) else []
                cell = row[tx] if tx < len(row) else {}
                ts_slug = cell.get("tilesetSlug")
                idx = cell.get("metatileIndex")
                if ts_slug is None or idx is None:
                    continue
                grid[gy][gx] = (str(ts_slug), int(idx))
                any_painted = True
        if any_painted:
            placed += 1
        else:
            skipped += 1

    return placed, skipped


# ---------------------------------------------------------------------------
# Cell fill (greedy)
# ---------------------------------------------------------------------------


def _adjacency_lookup(session) -> dict[int, dict[int, set[int]]]:
    """Build `{ metatile_a_id: { direction: set(legal_metatile_b_ids) } }`
    from `adjacency_rules` (scope='global'). Returns an empty dict if
    no rules exist yet (e.g. the user hasn't run /v1/rules/rebuild)."""

    out: dict[int, dict[int, set[int]]] = defaultdict(lambda: defaultdict(set))
    rows = session.execute(
        select(
            AdjacencyRule.metatile_a,
            AdjacencyRule.direction,
            AdjacencyRule.hard_legal_set,
        ).where(AdjacencyRule.scope == "global")
    ).all()
    for mid_a, direction, hard_set in rows:
        out[int(mid_a)][int(direction)] = {int(x) for x in hard_set}
    return dict(out)


# Direction codes used by the adjacency miner:
#   0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW
# We only consult 4-direction neighbours when filling.
_NEIGHBORS_4 = ((0, -1, 0), (1, 0, 2), (0, 1, 4), (-1, 0, 6))


def _fill_unassigned(
    session,
    skeleton: MapSkeleton,
    grid: list[list[MetatilePlacement | None]],
    tag_grid: list[list[set[str]]],
    tag_index: TagIndex,
    primary_slug: str,
    secondary_slug: str,
    rng: random.Random,
) -> tuple[int, int]:
    """Greedy single-pass fill. Returns `(rule_violations, rules_consulted)`."""

    w = skeleton.map.size.w
    h = skeleton.map.size.h
    adj = _adjacency_lookup(session)

    rule_violations = 0
    rules_consulted = 0

    for y in range(h):
        for x in range(w):
            if grid[y][x] is not None:
                continue
            tags = tag_grid[y][x]
            if not tags:
                # Empty cell - fall back to terrain.unknown.
                tags = {"terrain.unknown"}
            candidates = tag_index.candidates_for_tags(tags)
            if not candidates:
                continue

            # Sort by tileset preference: primary first, then secondary,
            # then everything else. Within a bucket, deterministic by
            # (metatile_index).
            def sort_key(c: tuple[str, int, int, int]) -> tuple[int, int]:
                ts_slug = c[0]
                bucket = 0 if ts_slug == primary_slug else (1 if ts_slug == secondary_slug else 2)
                return (bucket, c[1])

            ordered = sorted(candidates, key=sort_key)

            # Score each candidate by adjacency-rule compliance.
            best: tuple[int, int, tuple[str, int, int, int]] | None = None
            for cand in ordered:
                _, mt_idx, mt_id, _ = cand
                compliance = 0
                consulted = 0
                for dx, dy, direction in _NEIGHBORS_4:
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < w and 0 <= ny < h):
                        continue
                    neighbour = grid[ny][nx]
                    if neighbour is None:
                        continue
                    # Find the neighbour's metatile_id via the tag index
                    # (the cheapest way without re-querying).
                    n_id = _find_metatile_id(tag_index, neighbour)
                    if n_id is None:
                        continue
                    legal = adj.get(n_id, {}).get(_opposite_dir(direction), set())
                    if legal:
                        consulted += 1
                        if mt_id in legal:
                            compliance += 1
                # Higher compliance + earlier in ordered list wins.
                # Use a tiebreaker that prefers DB-order among
                # equally-compliant candidates.
                key = (-compliance, ordered.index(cand))
                if best is None or key < (
                    -best[0],
                    ordered.index(best[2]),
                ):
                    best = (compliance, consulted, cand)
                if compliance > 0 and consulted > 0 and compliance == consulted:
                    # Perfect candidate; stop searching.
                    break

            if best is None:
                # No candidates survived; pick the first one anyway.
                best = (0, 0, ordered[0])
            compliance, consulted, chosen = best
            rules_consulted += consulted
            rule_violations += max(0, consulted - compliance)
            grid[y][x] = (chosen[0], chosen[1])
            # Add some non-deterministic stir via rng so future
            # picking lines up with the seed.
            if len(ordered) > 1:
                rng.random()

    return rule_violations, rules_consulted


def _opposite_dir(direction: int) -> int:
    """Direction code seen FROM the neighbour. (0↔4, 2↔6.)"""

    return {0: 4, 4: 0, 2: 6, 6: 2}.get(direction, direction)


def _find_metatile_id(
    tag_index: TagIndex, placement: MetatilePlacement
) -> int | None:
    """Best-effort reverse lookup: given a (tileset_slug, metatile_index),
    find the metatile_id from the tag index's flat candidate lists.
    Returns None when the metatile isn't tagged at all."""

    target = placement
    for cands in tag_index.by_tag.values():
        for ts_slug, mt_idx, mt_id, _ in cands:
            if (ts_slug, mt_idx) == target:
                return mt_id
    return None


# ---------------------------------------------------------------------------
# Border
# ---------------------------------------------------------------------------


def _pick_border_blocks(
    skeleton: MapSkeleton,
    tag_index: TagIndex,
    primary_slug: str,
    secondary_slug: str,
) -> list[list[MetatilePlacement | None]]:
    """Pick a 2 × 2 metatile block to use as the map's border (the
    bezel painted around the playable area when the camera nears
    the edge). v1: use the first candidate metatile for the default-
    biome terrain tag, replicated across the 4 cells."""

    # The skeleton's default_biome is e.g. "biome.forest" - not a
    # terrain. Pick the bg region's terrain instead.
    bg_terrain = None
    for region in skeleton.regions:
        if region.id == "bg" or region.priority == 0:
            bg_terrain = region.tags.terrain
            break
    if not bg_terrain:
        bg_terrain = "terrain.unknown"

    candidates = tag_index.candidates_for_tag(bg_terrain)
    chosen: MetatilePlacement | None = None
    if candidates:
        # Same preference order as the cell filler.
        candidates.sort(
            key=lambda c: (0 if c[0] == primary_slug else (1 if c[0] == secondary_slug else 2), c[1])
        )
        chosen = (candidates[0][0], candidates[0][1])

    return [[chosen, chosen], [chosen, chosen]]


# ---------------------------------------------------------------------------
# Top-level entry
# ---------------------------------------------------------------------------


def resolve_skeleton(
    skeleton: MapSkeleton,
    factory: SqlAlchemyStorageFactory,
    seed: int = 0,
) -> ResolvedMap:
    """Resolve a MapSkeleton to a metatile grid + diagnostics."""

    w = skeleton.map.size.w
    h = skeleton.map.size.h
    primary = skeleton.map.primary_tileset
    secondary = skeleton.map.secondary_tileset
    rng = random.Random(seed)

    grid: list[list[MetatilePlacement | None]] = [[None] * w for _ in range(h)]
    tag_grid = _layer_regions(skeleton)

    paths_solved: list[list[tuple[int, int]]]
    paths_failed: int

    with factory.session() as session:
        # 2. Solve paths (mutates tag_grid).
        paths_solved, paths_failed = _solve_paths(skeleton, tag_grid)

        # 3. Templates.
        placed, skipped = _instantiate_templates(session, skeleton, grid)

        # 4. Greedy fill (queries adjacency_rules + tag_index).
        tag_index = TagIndex.from_db(session)
        rule_violations, rules_consulted = _fill_unassigned(
            session=session,
            skeleton=skeleton,
            grid=grid,
            tag_grid=tag_grid,
            tag_index=tag_index,
            primary_slug=primary,
            secondary_slug=secondary,
            rng=rng,
        )

        # 5. Border.
        border = _pick_border_blocks(skeleton, tag_index, primary, secondary)

    # 6. Counts.
    assigned = sum(1 for row in grid for cell in row if cell is not None)
    unassigned = (w * h) - assigned
    warnings: list[str] = []
    if unassigned:
        warnings.append(
            f"{unassigned} cells unassigned (no tagged metatile candidate) - "
            f"re-run ingestion or extend ontology coverage"
        )
    if skipped:
        warnings.append(f"{skipped} template anchor(s) skipped (template not in DB)")
    if paths_failed:
        warnings.append(f"{paths_failed} path(s) failed to solve")
    if rules_consulted and rule_violations / max(1, rules_consulted) > 0.4:
        warnings.append(
            f"adjacency-rule respect rate low ({rule_violations}/{rules_consulted} violations)"
        )

    report = ResolvedMapReport(
        seed=seed,
        width=w,
        height=h,
        assigned_cells=assigned,
        unassigned_cells=unassigned,
        template_anchors_placed=placed,
        template_anchors_skipped=skipped,
        rule_violations=rule_violations,
        rules_consulted=rules_consulted,
        paths_solved=len(paths_solved),
        paths_failed=paths_failed,
        warnings=warnings,
    )

    # Serialise tag_grid into sorted lists (sets aren't JSON-safe).
    tag_grid_sorted: list[list[list[str]]] = [
        [sorted(tag_grid[y][x]) for x in range(w)] for y in range(h)
    ]

    # Carry POIs into the resolved output so the 8G-3 validator can
    # check reachability without re-reading the skeleton.
    resolved_pois: list[ResolvedPOI] = []
    for poi in skeleton.pois:
        rect: tuple[int, int, int, int] | None = None
        if poi.shape is not None and isinstance(poi.shape, RectShape):
            rect = (poi.shape.x, poi.shape.y, poi.shape.w, poi.shape.h)
        resolved_pois.append(
            ResolvedPOI(id=poi.id, kind=poi.kind, x=poi.x, y=poi.y, rect=rect)
        )

    return ResolvedMap(
        width=w,
        height=h,
        grid=grid,
        tag_grid=tag_grid_sorted,
        primary_tileset_slug=primary,
        secondary_tileset_slug=secondary,
        border_blocks=border,
        report=report,
        pois=resolved_pois,
    )


__all__ = [
    "MetatilePlacement",
    "ResolvedMap",
    "ResolvedMapReport",
    "resolve_skeleton",
]


# Suppress import-unused warnings for symbols we re-export at the
# module level for users that want them.
_REEXPORT = (deque,)  # noqa: F841
