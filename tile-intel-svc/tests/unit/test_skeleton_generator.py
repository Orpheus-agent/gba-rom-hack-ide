"""Phase 8G-1 - Skeleton generator tests.

Covers the pure-Python generator with both a fresh empty factory
(no templates in DB) and a populated one. Then a small HTTP-level
smoke through the FastAPI router.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.models import Template, TemplateUsage, Tileset
from tile_intel.generator import (
    SkeletonGenerationInput,
    SkeletonGenerationReport,
    generate_skeleton,
)
from tile_intel.grammar.dsl import (
    MapSkeleton,
    PathEndpointRef,
    RectShape,
    validate_skeleton,
)
from tile_intel.storage.base import make_inmemory_factory


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def factory():
    f = make_inmemory_factory()
    f.create_all()
    yield f
    f.drop_all()


@pytest.fixture
def client(factory):
    return TestClient(create_app(storage_factory=factory))


def _seed_one_tileset_and_template(factory, biome_terrain: str = "terrain.grass") -> None:
    """Helper that inserts a tileset + template tagged with the
    requested terrain. Used to verify the generator picks templates
    from the DB when they exist."""

    with factory.session() as session:
        ts = Tileset(
            slug="test-frlg-route1",
            display_name="Test FRLG Route 1",
            family="frlg",
            is_secondary=True,
            is_compressed=True,
            scope="global",
            project_id=None,
            source="pret-test",
            content_hash=b"x" * 32,
            raw_bytes_size=0,
        )
        session.add(ts)
        session.flush()
        t = Template(
            slug="pattern-3x3-deadbeef",
            display_name="3×3 majority_terrain.grass.tall",
            role="majority_terrain.grass.tall",
            width=3,
            height=3,
            cells=[
                [{"tilesetSlug": ts.slug, "metatileIndex": 0}] * 3
            ] * 3,
            anchor_x=0,
            anchor_y=0,
            origin_tileset_id=ts.id,
            required_tags=[biome_terrain],
            scope="global",
            project_id=None,
        )
        session.add(t)
        session.flush()
        session.add(
            TemplateUsage(
                template_id=t.id, map_corpus="pret-firered", occurrence_count=42
            )
        )


# ---------------------------------------------------------------------------
# Pure-Python generator
# ---------------------------------------------------------------------------


def test_generate_returns_valid_skeleton_with_no_db(factory):
    inputs = SkeletonGenerationInput(
        theme="route",
        biome="biome.route",
        density="medium",
        seed=42,
    )
    skeleton, report = generate_skeleton(inputs, factory=None)
    assert isinstance(skeleton, MapSkeleton)
    assert isinstance(report, SkeletonGenerationReport)
    # Validates clean against the DSL semantic checker.
    issues = validate_skeleton(skeleton)
    errors = [i for i in issues if i.severity == "error"]
    assert errors == [], f"unexpected validation errors: {errors}"


def test_generator_is_deterministic(factory):
    inputs = SkeletonGenerationInput(
        theme="route", biome="biome.route", density="medium", seed=42
    )
    a, _ = generate_skeleton(inputs)
    b, _ = generate_skeleton(inputs)
    assert a.model_dump() == b.model_dump()


def test_different_seeds_produce_different_pois(factory):
    skel_a, _ = generate_skeleton(
        SkeletonGenerationInput(theme="route", biome="biome.route", seed=1)
    )
    skel_b, _ = generate_skeleton(
        SkeletonGenerationInput(theme="route", biome="biome.route", seed=2)
    )
    # At least one trainer_spawn POI must differ in coordinates.
    a_trainers = sorted(
        (p.x, p.y) for p in skel_a.pois if p.kind == "trainer_spawn"
    )
    b_trainers = sorted(
        (p.x, p.y) for p in skel_b.pois if p.kind == "trainer_spawn"
    )
    assert a_trainers != b_trainers


def test_default_size_for_route_is_corridor_shape(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="route", biome="biome.route")
    )
    # Routes default to tall/narrow.
    assert skel.map.size.h > skel.map.size.w


def test_default_size_for_town_is_square(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="town", biome="biome.town")
    )
    # Town default is 24x24.
    assert skel.map.size.w == skel.map.size.h


def test_explicit_size_overrides_default(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(
            theme="route", biome="biome.route", size=(50, 30)
        )
    )
    assert skel.map.size.w == 50
    assert skel.map.size.h == 30


def test_entrance_and_exit_pois_always_present(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="forest", biome="biome.forest")
    )
    ids = {p.id for p in skel.pois}
    assert "entrance" in ids
    assert "exit" in ids


def test_entrance_exit_path_present_and_resolves(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="route", biome="biome.route")
    )
    assert len(skel.paths) >= 1
    main = next(p for p in skel.paths if p.id == "main_corridor")
    # Endpoints reference poi:entrance and poi:exit.
    refs = [ep for ep in main.endpoints if isinstance(ep, PathEndpointRef)]
    assert any(r.ref == "poi:entrance" for r in refs)
    assert any(r.ref == "poi:exit" for r in refs)


def test_density_high_produces_more_pois_than_low(factory):
    low, _ = generate_skeleton(
        SkeletonGenerationInput(
            theme="route", biome="biome.route", density="low", seed=1
        )
    )
    high, _ = generate_skeleton(
        SkeletonGenerationInput(
            theme="route", biome="biome.route", density="high", seed=1
        )
    )
    assert len(high.pois) > len(low.pois)


def test_cave_has_wall_regions(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="cave", biome="biome.cave")
    )
    region_ids = {r.id for r in skel.regions}
    assert "wall_west" in region_ids
    assert "wall_east" in region_ids


def test_beach_has_water_region(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="beach", biome="biome.beach")
    )
    assert any(r.id == "water" for r in skel.regions)


def test_warning_when_no_templates_in_db(factory):
    _, report = generate_skeleton(
        SkeletonGenerationInput(
            theme="route", biome="biome.route", density="medium"
        ),
        factory=factory,
    )
    # Empty DB means tileset resolution falls back to defaults +
    # template anchors skip with a warning.
    assert any("no templates" in w for w in report.warnings)
    assert report.template_anchor_count == 0
    # Tileset defaults were used.
    assert report.chosen_primary_tileset.startswith("pret-frlg-")


def test_template_anchors_appear_when_db_has_matching_templates(factory):
    _seed_one_tileset_and_template(factory, biome_terrain="terrain.grass.tall")
    skel, report = generate_skeleton(
        SkeletonGenerationInput(
            theme="route", biome="biome.route", density="low", seed=42
        ),
        factory=factory,
    )
    # Low density tunes to 2 anchors; library has only 1 template so the
    # generator picks it twice.
    assert report.template_anchor_count == 2
    assert all(r.ref == "pattern-3x3-deadbeef" for r in skel.templates)
    # The chosen tileset should be the one with the matching template.
    assert report.chosen_primary_tileset == "test-frlg-route1"


def test_explicit_tileset_overrides_db_selection(factory):
    _seed_one_tileset_and_template(factory)
    _, report = generate_skeleton(
        SkeletonGenerationInput(
            theme="route",
            biome="biome.route",
            primary_tileset="my-custom-primary",
            secondary_tileset="my-custom-secondary",
        ),
        factory=factory,
    )
    assert report.chosen_primary_tileset == "my-custom-primary"
    assert report.chosen_secondary_tileset == "my-custom-secondary"


def test_default_name_derives_from_theme(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="forest", biome="biome.forest")
    )
    assert "Forest" in skel.map.name


def test_explicit_name_wins(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(
            theme="forest", biome="biome.forest", name="Sleeping Hollow"
        )
    )
    assert skel.map.name == "Sleeping Hollow"


def test_connectivity_constraint_added(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="route", biome="biome.route")
    )
    # Should have one connectivity constraint entrance → exit.
    conn = [c for c in skel.constraints if c.kind == "connectivity"]
    assert len(conn) == 1
    assert conn[0].from_ == "poi:entrance"
    assert conn[0].to == "poi:exit"


def test_regions_within_bounds(factory):
    skel, _ = generate_skeleton(
        SkeletonGenerationInput(theme="route", biome="biome.route", seed=7)
    )
    for region in skel.regions:
        if isinstance(region.shape, RectShape):
            assert region.shape.x + region.shape.w <= skel.map.size.w
            assert region.shape.y + region.shape.h <= skel.map.size.h


# ---------------------------------------------------------------------------
# FastAPI endpoint
# ---------------------------------------------------------------------------


def test_generate_endpoint_returns_skeleton(client):
    resp = client.post(
        "/v1/generate/skeleton",
        json={
            "theme": "route",
            "biome": "biome.route",
            "density": "medium",
            "seed": 123,
        },
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["skeleton"]["version"] == "1.0"
    assert payload["report"]["seed"] == 123
    assert payload["report"]["region_count"] >= 1
    assert payload["report"]["poi_count"] >= 2  # entrance + exit


def test_generate_endpoint_rejects_mismatched_size(client):
    resp = client.post(
        "/v1/generate/skeleton",
        json={
            "theme": "route",
            "biome": "biome.route",
            "width": 20,
            # height missing
        },
    )
    assert resp.status_code == 400
    assert "width" in resp.json()["detail"].lower()


def test_generate_endpoint_roundtrips_through_parser(client):
    """Generate a skeleton, then POST it back to /v1/grammar/parse - 
    it must validate clean."""

    gen = client.post(
        "/v1/generate/skeleton",
        json={"theme": "forest", "biome": "biome.forest", "seed": 7},
    )
    skel = gen.json()["skeleton"]
    parse = client.post("/v1/grammar/parse", json=skel)
    assert parse.status_code == 200
    parsed = parse.json()
    assert parsed["ok"] is True, parsed
    # No error-severity issues.
    assert all(i["severity"] != "error" for i in parsed["issues"])
