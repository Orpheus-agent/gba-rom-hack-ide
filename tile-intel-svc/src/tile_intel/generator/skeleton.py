"""Phase 8G-1 - Skeleton generator.

Composes a `MapSkeleton` DSL document from high-level intent
(theme, biome, size, density, seed). The output is meant for the
8G-2 resolver to turn into concrete metatile placements, OR for a
human to inspect and tweak before resolving.

Design choices:

  - **Pure Python, no DB writes.** The generator reads from
    the templates / biome library when a factory is supplied, but
    it never persists. Skeletons live as JSON files on disk
    (managed by the TS side) and as in-flight Pydantic objects
    here.

  - **Deterministic.** Every random choice goes through a single
    `random.Random(seed)` instance. Two calls with the same input
    produce byte-identical output.

  - **Biome-shape-aware.** Route biomes get tall/narrow defaults;
    towns get square; caves stay roughly square; forests slightly
    wider. Anything the caller passes via `size` always wins.

  - **Graceful when the library is empty.** When no templates
    exist for the requested biome (the user just spun up the
    sidecar for the first time), the generator still produces a
    valid skeleton - it just skips the template-anchors stage and
    surfaces a warning in the report.

The output's `tags` carry hints the 8G-2 resolver uses but doesn't
ENFORCE (e.g. `tags.density='medium'`). The resolver may decide
to drop or interpret them differently.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Literal

from tile_intel.grammar.biomes import templates_by_biome
from tile_intel.grammar.dsl import (
    MapHeader,
    MapSize,
    MapSkeleton,
    NoOverlapConstraint,
    POI,
    Path,
    PathConstraints,
    PathEndpointPoint,
    PathEndpointRef,
    PointShape,
    RectShape,
    Region,
    RegionTags,
    TemplateAnchor,
    TemplateRef,
    ConnectivityConstraint,
)
from tile_intel.storage.base import SqlAlchemyStorageFactory


# ---------------------------------------------------------------------------
# Inputs / outputs
# ---------------------------------------------------------------------------


Density = Literal["low", "medium", "high"]
Theme = Literal[
    "route",
    "forest",
    "cave",
    "town",
    "beach",
    "mountain",
    "dungeon",
    "arctic",
    "tropical",
    "urban",
    "indoor",
    "plains",
]


@dataclass(frozen=True)
class SkeletonGenerationInput:
    """All knobs for `generate_skeleton`. Defaults match the docs."""

    theme: Theme
    biome: str  # 'biome.forest', 'biome.route', etc. - uses TERRAIN_TO_BIOMES vocab.
    size: tuple[int, int] | None = None  # (w, h); biome default if None.
    density: Density = "medium"
    elevation_layers: int = 1
    seed: int = 0
    name: str | None = None  # Display name; auto-derived from theme if None.
    primary_tileset: str | None = None  # Slug; auto-picked from DB if None.
    secondary_tileset: str | None = None
    # When True, generator skips the template-anchors stage even if the
    # library has templates for the biome. Useful for tests that want
    # only the region + path layout.
    skip_templates: bool = False


@dataclass(frozen=True)
class SkeletonGenerationReport:
    """Diagnostics about a generate_skeleton() run. The skeleton
    itself is returned alongside; this report carries everything
    else (template choices, fallbacks taken, warnings)."""

    seed: int
    chosen_templates: list[str] = field(default_factory=list)
    chosen_primary_tileset: str = ""
    chosen_secondary_tileset: str = ""
    warnings: list[str] = field(default_factory=list)
    region_count: int = 0
    poi_count: int = 0
    path_count: int = 0
    template_anchor_count: int = 0
    constraint_count: int = 0


# ---------------------------------------------------------------------------
# Biome-shape and density tuning
# ---------------------------------------------------------------------------

# Per-theme default (w, h). Routes are tall corridors, towns are
# squarish, caves slightly wide, indoor compact.
_DEFAULT_SIZE: dict[str, tuple[int, int]] = {
    "route": (24, 40),
    "forest": (28, 32),
    "cave": (32, 28),
    "town": (24, 24),
    "beach": (32, 24),
    "mountain": (36, 28),
    "dungeon": (32, 32),
    "arctic": (28, 32),
    "tropical": (28, 28),
    "urban": (28, 24),
    "indoor": (16, 16),
    "plains": (40, 32),
}

# Per-density POI counts (entrance + exit always present; this is
# the EXTRA count layered on top).
_DENSITY_TUNING: dict[str, dict[str, int]] = {
    "low": {"trainer_spawns": 1, "encounter_zones": 1, "template_anchors": 2},
    "medium": {"trainer_spawns": 3, "encounter_zones": 2, "template_anchors": 4},
    "high": {"trainer_spawns": 6, "encounter_zones": 3, "template_anchors": 7},
}

# Per-theme default terrain hint for the background region.
_DEFAULT_BG_TERRAIN: dict[str, str] = {
    "route": "terrain.grass",
    "forest": "terrain.grass.tall",
    "cave": "terrain.cave.floor",
    "town": "terrain.path",
    "beach": "terrain.sand",
    "mountain": "terrain.rock",
    "dungeon": "terrain.cave.floor",
    "arctic": "terrain.snow",
    "tropical": "terrain.grass",
    "urban": "terrain.path",
    "indoor": "terrain.path",
    "plains": "terrain.grass",
}

# Default tileset slugs when DB lookup yields nothing. These match the
# pret-firered slugs the 8B miner emits. The 8G-2 resolver maps these
# to actual project tilesets at apply time.
_DEFAULT_TILESETS: dict[str, tuple[str, str]] = {
    "route": ("pret-frlg-general", "pret-frlg-route1"),
    "forest": ("pret-frlg-general", "pret-frlg-viridian-forest"),
    "cave": ("pret-frlg-rock", "pret-frlg-mt-moon-1f"),
    "town": ("pret-frlg-general", "pret-frlg-pallet-town"),
    "beach": ("pret-frlg-general", "pret-frlg-route-19"),
    "mountain": ("pret-frlg-rock", "pret-frlg-rock-tunnel-1f"),
    "dungeon": ("pret-frlg-rock", "pret-frlg-victory-road-1f"),
    "arctic": ("pret-frlg-general", "pret-frlg-icefall-cave-1f"),
    "tropical": ("pret-frlg-general", "pret-frlg-pinkan-island"),
    "urban": ("pret-frlg-general", "pret-frlg-celadon-city"),
    "indoor": ("pret-frlg-building", "pret-frlg-pokemon-center-1f"),
    "plains": ("pret-frlg-general", "pret-frlg-route1"),
}


# ---------------------------------------------------------------------------
# Tileset lookup helpers
# ---------------------------------------------------------------------------


def _resolve_tilesets(
    factory: SqlAlchemyStorageFactory | None,
    theme: str,
    biome: str,
    explicit_primary: str | None,
    explicit_secondary: str | None,
) -> tuple[str, str, list[str]]:
    """Pick the (primary, secondary) tileset slugs to bind into the
    skeleton header.

    Priority order:
      1. Explicit user inputs (any non-None value).
      2. Tilesets that originate templates the biome cares about
         (queried via `templates_by_biome`).
      3. Per-theme defaults at `_DEFAULT_TILESETS`.

    Returns `(primary_slug, secondary_slug, warnings)`. Warnings
    carry messages like "no template-derived tileset for biome.X,
    falling back to theme default".
    """

    warnings: list[str] = []
    primary = explicit_primary
    secondary = explicit_secondary

    # If both are explicit, we trust the caller.
    if primary and secondary:
        return primary, secondary, warnings

    # Try to derive from biome templates.
    template_tileset_slugs: list[str] = []
    if factory is not None:
        try:
            from sqlalchemy import select
            from tile_intel.domain.models import Template, Tileset

            with factory.session() as session:
                entries = templates_by_biome(factory, biome, limit=30)
                if not entries:
                    warnings.append(
                        f"no templates in DB for biome={biome!r}; "
                        f"falling back to theme defaults"
                    )
                else:
                    # Look up each template's origin tileset slug.
                    seen: set[str] = set()
                    for entry in entries:
                        # We have the slug already; need to follow it to its
                        # tileset.
                        row = session.execute(
                            select(Tileset.slug, Tileset.is_secondary)
                            .join(Template, Template.origin_tileset_id == Tileset.id)
                            .where(Template.slug == entry.template_slug)
                        ).first()
                        if row is None:
                            continue
                        ts_slug, is_secondary = row
                        if ts_slug in seen:
                            continue
                        seen.add(ts_slug)
                        template_tileset_slugs.append(str(ts_slug))
        except Exception as e:  # noqa: BLE001
            warnings.append(f"tileset resolution failed ({e!s}); using theme defaults")

    # Pick from candidates.
    fallback_primary, fallback_secondary = _DEFAULT_TILESETS.get(
        theme, ("pret-frlg-general", "pret-frlg-route1")
    )
    if not primary:
        primary = (
            template_tileset_slugs[0] if template_tileset_slugs else fallback_primary
        )
    if not secondary:
        # Prefer a different slug than primary.
        for slug in template_tileset_slugs:
            if slug != primary:
                secondary = slug
                break
        if not secondary:
            secondary = fallback_secondary
            if secondary == primary:
                secondary = fallback_primary

    return primary, secondary, warnings


# ---------------------------------------------------------------------------
# Region layout
# ---------------------------------------------------------------------------


def _build_regions(
    rng: random.Random,
    theme: str,
    biome: str,
    width: int,
    height: int,
    density: str,
) -> list[Region]:
    """Lay out the background + feature regions for the map.

    Layout rules:
      - Always: one background region covering the entire map
        (priority=0, biome=skel.biome, terrain=theme-default).
      - For route/forest/plains: 1-3 grass patches as priority=10
        sub-regions, biased toward the middle third of the map.
      - For cave/dungeon/mountain: 2 wall rectangles along the
        long edge (priority=20) carving out the playable area.
      - For beach/tropical: 1 water region along the southern edge
        (priority=10).
      - For town: 2 building-zone rectangles (priority=10).
    """

    regions: list[Region] = []
    bg_terrain = _DEFAULT_BG_TERRAIN.get(theme, "terrain.grass")
    regions.append(
        Region(
            id="bg",
            shape=RectShape(kind="rect", x=0, y=0, w=width, h=height),
            biome=biome,
            tags=RegionTags(terrain=bg_terrain, density=density),  # type: ignore[arg-type]
            elevation=0,
            priority=0,
        )
    )

    feature_count = {"low": 1, "medium": 2, "high": 3}.get(density, 2)

    if theme in ("route", "forest", "plains"):
        for i in range(feature_count):
            patch_w = rng.randint(3, 6)
            patch_h = rng.randint(3, 6)
            patch_x = rng.randint(2, max(2, width - patch_w - 2))
            patch_y = rng.randint(3, max(3, height - patch_h - 3))
            regions.append(
                Region(
                    id=f"grass_patch_{i + 1}",
                    shape=RectShape(
                        kind="rect", x=patch_x, y=patch_y, w=patch_w, h=patch_h
                    ),
                    biome=biome,
                    tags=RegionTags(terrain="terrain.grass.tall", density="high"),  # type: ignore[arg-type]
                    elevation=0,
                    priority=10,
                )
            )

    elif theme in ("cave", "dungeon", "mountain"):
        wall_terrain = "terrain.cave.wall" if theme != "mountain" else "terrain.rock"
        # West wall.
        regions.append(
            Region(
                id="wall_west",
                shape=RectShape(kind="rect", x=0, y=0, w=2, h=height),
                biome=biome,
                tags=RegionTags(terrain=wall_terrain, density="high"),  # type: ignore[arg-type]
                elevation=1,
                priority=20,
            )
        )
        # East wall.
        regions.append(
            Region(
                id="wall_east",
                shape=RectShape(kind="rect", x=width - 2, y=0, w=2, h=height),
                biome=biome,
                tags=RegionTags(terrain=wall_terrain, density="high"),  # type: ignore[arg-type]
                elevation=1,
                priority=20,
            )
        )

    elif theme in ("beach", "tropical"):
        water_h = max(3, height // 5)
        regions.append(
            Region(
                id="water",
                shape=RectShape(
                    kind="rect", x=0, y=height - water_h, w=width, h=water_h
                ),
                biome=biome,
                tags=RegionTags(terrain="terrain.water.shallow", density="medium"),  # type: ignore[arg-type]
                elevation=0,
                priority=10,
            )
        )

    elif theme == "town":
        # Two house-sized rectangles flanking the centre.
        bldg_w = 5
        bldg_h = 4
        regions.append(
            Region(
                id="building_a",
                shape=RectShape(
                    kind="rect", x=width // 4, y=height // 3, w=bldg_w, h=bldg_h
                ),
                biome=biome,
                tags=RegionTags(terrain="terrain.path", density="high"),  # type: ignore[arg-type]
                elevation=1,
                priority=20,
            )
        )
        regions.append(
            Region(
                id="building_b",
                shape=RectShape(
                    kind="rect",
                    x=(width * 5) // 8,
                    y=(height * 2) // 3,
                    w=bldg_w,
                    h=bldg_h,
                ),
                biome=biome,
                tags=RegionTags(terrain="terrain.path", density="high"),  # type: ignore[arg-type]
                elevation=1,
                priority=20,
            )
        )

    return regions


# ---------------------------------------------------------------------------
# POI placement
# ---------------------------------------------------------------------------


def _build_pois(
    rng: random.Random,
    theme: str,
    width: int,
    height: int,
    density: str,
    regions: list[Region],
) -> list[POI]:
    """Place entrance + exit + density-driven trainer / encounter POIs.

    Entrance is always at the top edge (y=0 or y=1), exit at the
    bottom edge for corridor themes; for towns we use west/east
    edges so warps land where the player walks in/out.

    Trainer spawns and encounter zones land in the interior, biased
    toward the map's middle third to avoid overlapping regions
    with priority ≥ 20 (walls / buildings).
    """

    pois: list[POI] = []

    # Entrance + exit positions per theme.
    if theme in ("route", "forest", "plains", "beach"):
        entrance_x = width // 2
        entrance_y = 1
        exit_x = width // 2
        exit_y = height - 2
    elif theme in ("cave", "dungeon", "mountain", "arctic", "tropical"):
        # Two warps on the long axis.
        entrance_x = 2
        entrance_y = height // 2
        exit_x = width - 3
        exit_y = height // 2
    elif theme == "town":
        entrance_x = 1
        entrance_y = height // 2
        exit_x = width - 2
        exit_y = height // 2
    else:  # urban, indoor, plains
        entrance_x = width // 2
        entrance_y = 1
        exit_x = width // 2
        exit_y = height - 2

    pois.append(
        POI(
            id="entrance",
            kind="warp",
            x=entrance_x,
            y=entrance_y,
            metadata={"role": "entrance"},
        )
    )
    pois.append(
        POI(
            id="exit",
            kind="warp",
            x=exit_x,
            y=exit_y,
            metadata={"role": "exit"},
        )
    )

    tune = _DENSITY_TUNING.get(density, _DENSITY_TUNING["medium"])

    # Build a list of "interior" cells we'll allow POIs to land on:
    # exclude the 2-cell border and any rect-region with priority ≥ 20.
    forbidden = _forbidden_cells(regions, width, height)
    interior_candidates = [
        (x, y)
        for x in range(3, width - 3)
        for y in range(3, height - 3)
        if (x, y) not in forbidden
    ]
    rng.shuffle(interior_candidates)
    candidates_iter = iter(interior_candidates)

    def _next_cell() -> tuple[int, int] | None:
        try:
            return next(candidates_iter)
        except StopIteration:
            return None

    for i in range(tune["trainer_spawns"]):
        cell = _next_cell()
        if cell is None:
            break
        pois.append(
            POI(
                id=f"trainer_spawn_{i + 1}",
                kind="trainer_spawn",
                x=cell[0],
                y=cell[1],
                metadata={"role": "patrol"},
            )
        )

    for i in range(tune["encounter_zones"]):
        cell = _next_cell()
        if cell is None:
            break
        # Encounter zones are areas, not points; give them a small rect.
        ez_w = rng.randint(3, 5)
        ez_h = rng.randint(3, 5)
        # Re-anchor to keep it on map.
        cx = max(2, min(width - ez_w - 2, cell[0]))
        cy = max(2, min(height - ez_h - 2, cell[1]))
        pois.append(
            POI(
                id=f"encounter_zone_{i + 1}",
                kind="encounter_zone",
                shape=RectShape(kind="rect", x=cx, y=cy, w=ez_w, h=ez_h),
                metadata={"role": "wild_grass"},
            )
        )

    return pois


def _forbidden_cells(
    regions: list[Region], width: int, height: int
) -> set[tuple[int, int]]:
    """Set of cells that POIs shouldn't land on (high-priority rect
    regions like walls + buildings)."""

    forbidden: set[tuple[int, int]] = set()
    for r in regions:
        if r.priority < 20:
            continue
        if r.shape.kind != "rect":
            continue
        shape = r.shape
        for x in range(shape.x, min(width, shape.x + shape.w)):
            for y in range(shape.y, min(height, shape.y + shape.h)):
                forbidden.add((x, y))
    return forbidden


# ---------------------------------------------------------------------------
# Path generation
# ---------------------------------------------------------------------------


def _build_paths(
    rng: random.Random,
    theme: str,
    pois: list[POI],
    width: int,
    height: int,
) -> list[Path]:
    """Construct entrance→exit connector(s).

    Default: one path from entrance to exit with width 2 (caves and
    dungeons get width 1 to imply narrower corridors). Routes get a
    second branch path through one encounter zone to make the
    encounter feel intentional.
    """

    entrance = next((p for p in pois if p.id == "entrance"), None)
    exit_ = next((p for p in pois if p.id == "exit"), None)
    if entrance is None or exit_ is None:
        return []

    width_metatiles = 1 if theme in ("cave", "dungeon", "indoor") else 2
    paths: list[Path] = [
        Path(
            id="main_corridor",
            endpoints=[
                PathEndpointRef(ref="poi:entrance"),
                PathEndpointRef(ref="poi:exit"),
            ],
            width_metatiles=width_metatiles,
            tags={"role": "primary"},
            constraints=PathConstraints(min_turns=0, max_turns=6),
        )
    ]

    # Detour through one encounter zone for routes / forests.
    if theme in ("route", "forest"):
        encounter_pois = [p for p in pois if p.kind == "encounter_zone"]
        if encounter_pois:
            target = rng.choice(encounter_pois)
            paths.append(
                Path(
                    id="encounter_detour",
                    endpoints=[
                        PathEndpointRef(ref="poi:entrance"),
                        PathEndpointRef(ref=f"poi:{target.id}"),
                    ],
                    width_metatiles=1,
                    tags={"role": "detour"},
                    constraints=PathConstraints(min_turns=1, max_turns=8),
                )
            )

    return paths


# ---------------------------------------------------------------------------
# Template anchors
# ---------------------------------------------------------------------------


def _build_template_anchors(
    rng: random.Random,
    factory: SqlAlchemyStorageFactory | None,
    biome: str,
    width: int,
    height: int,
    density: str,
    regions: list[Region],
    skip: bool,
) -> tuple[list[TemplateRef], list[str], list[str]]:
    """Pick a few biome-appropriate templates from the DB and anchor
    them at random walkable positions.

    Returns `(template_refs, chosen_template_slugs, warnings)`.
    """

    if skip:
        return [], [], []
    if factory is None:
        return [], [], ["no factory provided, skipping template anchors"]

    tune = _DENSITY_TUNING.get(density, _DENSITY_TUNING["medium"])
    target_count = tune["template_anchors"]

    try:
        entries = templates_by_biome(factory, biome, limit=20)
    except Exception as e:  # noqa: BLE001
        return [], [], [f"templates_by_biome failed: {e!s}"]

    if not entries:
        return (
            [],
            [],
            [
                f"no templates in DB for biome={biome!r}; skipping anchors "
                f"(re-run /v1/grammar/templates/build after ingest)"
            ],
        )

    # Weight by total_usage (heavier templates get picked more often).
    # Re-implemented from random.choices so it's deterministic against
    # rng (which it would be since random.choices uses the supplied rng).
    weights = [max(1, e.total_usage) for e in entries]
    chosen_refs: list[TemplateRef] = []
    chosen_slugs: list[str] = []

    forbidden = _forbidden_cells(regions, width, height)

    for _ in range(target_count):
        entry = rng.choices(entries, weights=weights, k=1)[0]
        # Pick an anchor cell not in the forbidden set and away from edges.
        for _attempt in range(20):
            ax = rng.randint(2, max(2, width - 5))
            ay = rng.randint(2, max(2, height - 5))
            if (ax, ay) in forbidden:
                continue
            break
        chosen_refs.append(
            TemplateRef(
                ref=entry.template_slug,
                anchor=TemplateAnchor(x=ax, y=ay),
                tag_bindings={},
            )
        )
        chosen_slugs.append(entry.template_slug)

    return chosen_refs, chosen_slugs, []


# ---------------------------------------------------------------------------
# Top-level entry
# ---------------------------------------------------------------------------


def generate_skeleton(
    inputs: SkeletonGenerationInput,
    factory: SqlAlchemyStorageFactory | None = None,
) -> tuple[MapSkeleton, SkeletonGenerationReport]:
    """Compose a MapSkeleton from the high-level inputs.

    Returns a (skeleton, report) pair. The skeleton validates clean
    against `MapSkeleton.model_validate` and `validate_skeleton`
    (the latter shouldn't surface error-severity issues - only
    warnings if the library is empty).
    """

    rng = random.Random(inputs.seed)
    width, height = inputs.size or _DEFAULT_SIZE.get(inputs.theme, (24, 24))

    warnings: list[str] = []

    # Pick tilesets.
    primary, secondary, tileset_warnings = _resolve_tilesets(
        factory=factory,
        theme=inputs.theme,
        biome=inputs.biome,
        explicit_primary=inputs.primary_tileset,
        explicit_secondary=inputs.secondary_tileset,
    )
    warnings.extend(tileset_warnings)

    regions = _build_regions(
        rng=rng,
        theme=inputs.theme,
        biome=inputs.biome,
        width=width,
        height=height,
        density=inputs.density,
    )
    pois = _build_pois(
        rng=rng,
        theme=inputs.theme,
        width=width,
        height=height,
        density=inputs.density,
        regions=regions,
    )
    paths = _build_paths(
        rng=rng, theme=inputs.theme, pois=pois, width=width, height=height
    )
    template_refs, chosen_template_slugs, template_warnings = _build_template_anchors(
        rng=rng,
        factory=factory,
        biome=inputs.biome,
        width=width,
        height=height,
        density=inputs.density,
        regions=regions,
        skip=inputs.skip_templates,
    )
    warnings.extend(template_warnings)

    constraints = [
        ConnectivityConstraint(
            kind="connectivity",
            from_="poi:entrance",
            to="poi:exit",
            via_tag="traversal.walkable",
        )
    ]

    skeleton = MapSkeleton(
        version="1.0",
        map=MapHeader(
            name=inputs.name or _default_name(inputs.theme, inputs.biome),
            size=MapSize(w=width, h=height),
            primary_tileset=primary,
            secondary_tileset=secondary,
            default_biome=inputs.biome,
        ),
        regions=regions,
        paths=paths,
        templates=template_refs,
        pois=pois,
        constraints=constraints,
    )
    report = SkeletonGenerationReport(
        seed=inputs.seed,
        chosen_templates=chosen_template_slugs,
        chosen_primary_tileset=primary,
        chosen_secondary_tileset=secondary,
        warnings=warnings,
        region_count=len(regions),
        poi_count=len(pois),
        path_count=len(paths),
        template_anchor_count=len(template_refs),
        constraint_count=len(constraints),
    )
    return skeleton, report


def _default_name(theme: str, biome: str) -> str:
    """Friendly fallback name like "Forest route - biome.forest"."""

    pretty_theme = theme.replace("_", " ").capitalize()
    return f"{pretty_theme} (auto-generated)"


__all__ = [
    "SkeletonGenerationInput",
    "SkeletonGenerationReport",
    "generate_skeleton",
]


# ---------------------------------------------------------------------------
# Re-exports used by external callers that don't want to dig into dsl.py.
# ---------------------------------------------------------------------------


_REEXPORT = (PathEndpointPoint, PointShape, NoOverlapConstraint)  # noqa: F841
