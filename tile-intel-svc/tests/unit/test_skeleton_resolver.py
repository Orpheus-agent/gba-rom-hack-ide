"""Phase 8G-2 - Resolver tests.

Exercises the resolve_skeleton() pipeline against a hand-built
SQLite-backed factory with a few tilesets / metatiles / tags /
templates set up to mirror what the full pret ingest gives us.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.models import (
    AdjacencyRule,
    MetatileTag,
    Metatile,
    TagTaxonomy,
    Template,
    Tileset,
)
from tile_intel.generator import resolve_skeleton
from tile_intel.generator.skeleton import (
    SkeletonGenerationInput,
    generate_skeleton,
)
from tile_intel.grammar.dsl import MapSkeleton
from tile_intel.storage.base import make_inmemory_factory


@pytest.fixture
def factory():
    f = make_inmemory_factory()
    f.create_all()
    yield f
    f.drop_all()


@pytest.fixture
def client(factory):
    return TestClient(create_app(storage_factory=factory))


def _seed_minimal_db(factory) -> dict[str, int]:
    """Seed enough for the resolver to fill a small map:

    * Two tilesets (primary `tset-pri`, secondary `tset-sec`).
    * Six metatiles with assorted tags + behavior_ids.
    * Tag taxonomy entries for the terrains the seed uses.

    Returns a dict mapping tag slug → tag taxonomy ID so tests can
    look up by name.
    """

    tag_ids: dict[str, int] = {}
    with factory.session() as session:
        # Tag taxonomy.
        for slug in (
            "terrain.grass",
            "terrain.grass.tall",
            "terrain.path",
            "terrain.cave.floor",
            "terrain.cave.wall",
            "terrain.water.shallow",
            "terrain.unknown",
            "traversal.walkable",
        ):
            tt = TagTaxonomy(
                slug=slug,
                parent_id=None,
                axis="terrain" if slug.startswith("terrain.") else "traversal",
                display_name=slug,
                is_leaf=True,
            )
            session.add(tt)
            session.flush()
            tag_ids[slug] = tt.id

        # Tilesets.
        primary = Tileset(
            slug="tset-pri",
            display_name="Primary",
            family="frlg",
            is_secondary=False,
            is_compressed=True,
            scope="global",
            project_id=None,
            source="pret",
            content_hash=b"p" * 32,
            raw_bytes_size=0,
        )
        secondary = Tileset(
            slug="tset-sec",
            display_name="Secondary",
            family="frlg",
            is_secondary=True,
            is_compressed=True,
            scope="global",
            project_id=None,
            source="pret",
            content_hash=b"s" * 32,
            raw_bytes_size=0,
        )
        session.add(primary)
        session.add(secondary)
        session.flush()

        # Metatiles: index → (tileset, tags it carries).
        seed_specs = [
            # (tileset, index, behavior_id, tags)
            (primary, 0, 1, ["terrain.grass", "terrain.unknown"]),
            (primary, 1, 1, ["terrain.grass", "terrain.grass.tall"]),
            (primary, 2, 2, ["terrain.path", "traversal.walkable"]),
            (primary, 3, 3, ["terrain.cave.wall"]),
            (secondary, 0, 1, ["terrain.cave.floor", "traversal.walkable"]),
            (secondary, 1, 1, ["terrain.water.shallow"]),
        ]
        for ts, idx, beh, tags in seed_specs:
            mt = Metatile(
                tileset_id=ts.id,
                metatile_index=idx,
                behavior_id=beh,
                terrain_type=0,
                encounter_type=0,
                layer_type=0,
                attr_raw=b"\x00" * 4,
                composition=[],
                rendered_hash=b"r" * 32,
                phash=b"\x00" * 8,
                is_walkable=("traversal.walkable" in tags),
                is_surfable=False,
                is_encounter_grass=False,
            )
            session.add(mt)
            session.flush()
            for tag in tags:
                session.add(
                    MetatileTag(
                        metatile_id=mt.id,
                        tag_id=tag_ids[tag],
                        confidence=1.0,
                        source="seed",
                    )
                )

        # Adjacency rule: metatile primary/2 (path) must follow primary/0
        # (grass) eastward. Used to check rule-consultation paths.
        first_path = (
            session.query(Metatile)
            .filter_by(tileset_id=primary.id, metatile_index=2)
            .one()
        )
        first_grass = (
            session.query(Metatile)
            .filter_by(tileset_id=primary.id, metatile_index=0)
            .one()
        )
        session.add(
            AdjacencyRule(
                metatile_a=first_grass.id,
                direction=2,  # E
                legal_neighbors=[{"id": first_path.id, "probability": 1.0, "freq": 5}],
                hard_legal_set=[first_path.id],
                total_observations=5,
                entropy=0.0,
                scope="global",
                project_id=None,
            )
        )

    return tag_ids


# ---------------------------------------------------------------------------
# Resolve pipeline
# ---------------------------------------------------------------------------


def test_resolve_fills_grid_with_db_seeded(factory):
    _seed_minimal_db(factory)
    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "test",
                "size": {"w": 6, "h": 4},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.route",
            },
            "regions": [
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 6, "h": 4},
                    "biome": "biome.route",
                    "tags": {"terrain": "terrain.grass", "density": "low"},
                    "elevation": 0,
                    "priority": 0,
                }
            ],
            "paths": [],
            "templates": [],
            "pois": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory, seed=7)
    assert result.width == 6
    assert result.height == 4
    assert result.report.unassigned_cells == 0
    # Every cell should be one of the two primary grass metatiles.
    placed = {cell for row in result.grid for cell in row}
    assert placed - {("tset-pri", 0), ("tset-pri", 1)} == set()


def test_resolve_unassigned_when_tag_missing(factory):
    _seed_minimal_db(factory)
    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "test",
                "size": {"w": 2, "h": 2},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.unknown",
            },
            "regions": [
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 2, "h": 2},
                    "biome": "biome.unknown",
                    "tags": {"terrain": "terrain.does-not-exist"},
                    "elevation": 0,
                    "priority": 0,
                }
            ],
            "paths": [],
            "templates": [],
            "pois": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory)
    assert result.report.unassigned_cells == 4
    assert all(cell is None for row in result.grid for cell in row)
    assert any("unassigned" in w for w in result.report.warnings)


def test_resolve_path_carves_walkable_corridor(factory):
    _seed_minimal_db(factory)
    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "corridor",
                "size": {"w": 8, "h": 4},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.cave",
            },
            # Cave wall surrounds, then a path connects east → west.
            "regions": [
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 8, "h": 4},
                    "biome": "biome.cave",
                    "tags": {"terrain": "terrain.cave.wall"},
                    "elevation": 0,
                    "priority": 0,
                },
                {
                    "id": "floor",
                    "shape": {"kind": "rect", "x": 1, "y": 1, "w": 6, "h": 2},
                    "biome": "biome.cave",
                    "tags": {"terrain": "terrain.cave.floor"},
                    "elevation": 0,
                    "priority": 10,
                },
            ],
            "paths": [
                {
                    "id": "main",
                    "endpoints": [
                        {"x": 1, "y": 1},
                        {"x": 6, "y": 2},
                    ],
                    "width_metatiles": 1,
                }
            ],
            "pois": [],
            "templates": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory)
    assert result.report.paths_solved == 1
    assert result.report.paths_failed == 0
    # Endpoint cells must carry traversal.walkable.
    assert "traversal.walkable" in result.tag_grid[1][1]
    assert "terrain.path" in result.tag_grid[1][1]


def test_resolve_path_failure_when_no_walkable_route(factory):
    _seed_minimal_db(factory)
    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "blocked",
                "size": {"w": 4, "h": 3},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.cave",
            },
            "regions": [
                # Everything is wall - no walkable cells between endpoints.
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 4, "h": 3},
                    "biome": "biome.cave",
                    "tags": {"terrain": "terrain.cave.wall"},
                    "elevation": 0,
                    "priority": 0,
                },
            ],
            "paths": [
                {
                    "id": "blocked",
                    "endpoints": [
                        {"x": 0, "y": 0},
                        {"x": 3, "y": 2},
                    ],
                }
            ],
            "pois": [],
            "templates": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory)
    assert result.report.paths_failed == 1
    assert result.report.paths_solved == 0


def test_resolve_templates_paint_metatile_cells(factory):
    _seed_minimal_db(factory)
    with factory.session() as session:
        ts_pri = session.query(Tileset).filter_by(slug="tset-pri").one()
        # Build a 2x2 template whose cells reference (tset-pri, 1) i.e.
        # the grass.tall metatile.
        t = Template(
            slug="my-2x2",
            display_name="2x2 grass.tall",
            role="uniform_terrain.grass.tall",
            width=2,
            height=2,
            cells=[
                [
                    {"tilesetSlug": "tset-pri", "metatileIndex": 1},
                    {"tilesetSlug": "tset-pri", "metatileIndex": 1},
                ],
                [
                    {"tilesetSlug": "tset-pri", "metatileIndex": 1},
                    {"tilesetSlug": "tset-pri", "metatileIndex": 1},
                ],
            ],
            anchor_x=0,
            anchor_y=0,
            origin_tileset_id=ts_pri.id,
            required_tags=["terrain.grass.tall"],
            scope="global",
            project_id=None,
        )
        session.add(t)

    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "tpl",
                "size": {"w": 4, "h": 4},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.route",
            },
            "regions": [
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 4, "h": 4},
                    "biome": "biome.route",
                    "tags": {"terrain": "terrain.grass"},
                    "elevation": 0,
                    "priority": 0,
                },
            ],
            "templates": [
                {
                    "ref": "my-2x2",
                    "anchor": {"x": 1, "y": 1},
                    "tag_bindings": {},
                }
            ],
            "pois": [],
            "paths": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory)
    assert result.report.template_anchors_placed == 1
    # Template's metatile id (1) should be at (1, 1) etc.
    assert result.grid[1][1] == ("tset-pri", 1)
    assert result.grid[2][2] == ("tset-pri", 1)


def test_resolve_template_skipped_when_slug_unknown(factory):
    _seed_minimal_db(factory)
    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "tpl",
                "size": {"w": 4, "h": 4},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.route",
            },
            "regions": [
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 4, "h": 4},
                    "biome": "biome.route",
                    "tags": {"terrain": "terrain.grass"},
                    "elevation": 0,
                    "priority": 0,
                }
            ],
            "templates": [
                {
                    "ref": "no-such-template",
                    "anchor": {"x": 0, "y": 0},
                    "tag_bindings": {},
                }
            ],
            "pois": [],
            "paths": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory)
    assert result.report.template_anchors_skipped == 1
    assert any("template anchor" in w for w in result.report.warnings)


def test_resolve_prefers_primary_tileset_when_both_match(factory):
    _seed_minimal_db(factory)
    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "pri",
                "size": {"w": 2, "h": 2},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.route",
            },
            "regions": [
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 2, "h": 2},
                    "biome": "biome.route",
                    "tags": {"terrain": "traversal.walkable"},
                    "elevation": 0,
                    "priority": 0,
                }
            ],
            "templates": [],
            "pois": [],
            "paths": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory)
    # The primary tileset has metatile/2 (path, traversal.walkable),
    # the secondary tileset has metatile/0 (cave floor, walkable).
    # Primary should win.
    for row in result.grid:
        for cell in row:
            assert cell is not None
            assert cell[0] == "tset-pri"


def test_resolve_border_filled_when_bg_terrain_available(factory):
    _seed_minimal_db(factory)
    skel = MapSkeleton.model_validate(
        {
            "version": "1.0",
            "map": {
                "name": "border",
                "size": {"w": 4, "h": 4},
                "primary_tileset": "tset-pri",
                "secondary_tileset": "tset-sec",
                "default_biome": "biome.route",
            },
            "regions": [
                {
                    "id": "bg",
                    "shape": {"kind": "rect", "x": 0, "y": 0, "w": 4, "h": 4},
                    "biome": "biome.route",
                    "tags": {"terrain": "terrain.grass"},
                    "elevation": 0,
                    "priority": 0,
                }
            ],
            "templates": [],
            "pois": [],
            "paths": [],
            "constraints": [],
        }
    )
    result = resolve_skeleton(skel, factory=factory)
    assert result.border_blocks[0][0] is not None
    # All four border cells equal.
    assert (
        result.border_blocks[0][0]
        == result.border_blocks[0][1]
        == result.border_blocks[1][0]
        == result.border_blocks[1][1]
    )


def test_resolve_returns_deterministic_grid(factory):
    _seed_minimal_db(factory)
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="route", biome="biome.route", seed=11, size=(8, 6)),
        factory=factory,
    )
    a = resolve_skeleton(skel, factory=factory, seed=42)
    b = resolve_skeleton(skel, factory=factory, seed=42)
    assert a.grid == b.grid
    assert a.tag_grid == b.tag_grid


def test_resolve_endpoint_round_trips_skeleton(client, factory):
    _seed_minimal_db(factory)
    gen = client.post(
        "/v1/generate/skeleton",
        json={
            "theme": "route",
            "biome": "biome.route",
            "width": 8,
            "height": 8,
            "density": "low",
            "seed": 13,
        },
    )
    assert gen.status_code == 200, gen.text
    skel = gen.json()["skeleton"]
    resp = client.post(
        "/v1/generate/resolve", json={"skeleton": skel, "seed": 13}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["width"] == 8
    assert body["height"] == 8
    assert body["report"]["seed"] == 13
    # Every grid row has the right width.
    for row in body["grid"]:
        assert len(row) == 8


def test_resolve_endpoint_rejects_bad_skeleton(client):
    resp = client.post(
        "/v1/generate/resolve",
        json={
            "skeleton": {"version": "1.0"},  # missing the required `map`
            "seed": 0,
        },
    )
    assert resp.status_code == 400
    assert "schema validation" in resp.json()["detail"].lower()
