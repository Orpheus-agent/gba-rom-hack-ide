"""Phase 8H - Interactive endpoint tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.models import (
    AdjacencyRule,
    Metatile,
    Template,
    Tileset,
)
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


def _seed(factory) -> dict:
    """Seed: two tilesets, four metatiles, one adjacency rule."""

    ids: dict[str, int] = {}
    with factory.session() as session:
        pri = Tileset(
            slug="tset-pri",
            display_name="Primary",
            family="frlg",
            is_secondary=False,
            is_compressed=True,
            scope="global",
            project_id=None,
            source="pret-firered",
            source_commit="abc1234",
            license_spdx="MIT",
            attribution="pret/pokefirered",
            content_hash=b"a" * 32,
            raw_bytes_size=0,
        )
        sec = Tileset(
            slug="tset-sec",
            display_name="Secondary",
            family="frlg",
            is_secondary=True,
            is_compressed=True,
            scope="global",
            project_id=None,
            source="pret-firered",
            source_commit="abc1234",
            license_spdx="MIT",
            attribution="pret/pokefirered",
            content_hash=b"b" * 32,
            raw_bytes_size=0,
        )
        session.add(pri)
        session.add(sec)
        session.flush()
        ids["pri_id"] = pri.id
        ids["sec_id"] = sec.id

        mts: list[Metatile] = []
        for ts, idx in ((pri, 0), (pri, 1), (sec, 0), (sec, 1)):
            m = Metatile(
                tileset_id=ts.id,
                metatile_index=idx,
                behavior_id=idx + 1,
                terrain_type=0,
                encounter_type=0,
                layer_type=0,
                attr_raw=b"\x00" * 4,
                composition=[],
                rendered_hash=b"r" * 32,
                phash=bytes([idx] * 8),
                is_walkable=(idx == 0),
                is_surfable=False,
                is_encounter_grass=False,
            )
            session.add(m)
            session.flush()
            mts.append(m)

        ids["pri_0"] = mts[0].id
        ids["pri_1"] = mts[1].id
        ids["sec_0"] = mts[2].id
        ids["sec_1"] = mts[3].id

        # Adjacency rule: tset-pri/0 → east → [tset-pri/1 (p=0.7), tset-sec/0 (p=0.3)]
        session.add(
            AdjacencyRule(
                metatile_a=mts[0].id,
                direction=2,  # E
                legal_neighbors=[
                    {"id": mts[1].id, "probability": 0.7, "freq": 35},
                    {"id": mts[2].id, "probability": 0.3, "freq": 15},
                ],
                hard_legal_set=[mts[1].id, mts[2].id],
                total_observations=50,
                entropy=0.7,
                scope="global",
                project_id=None,
            )
        )

        # Template for 8H-4 test.
        session.add(
            Template(
                slug="my-2x2",
                display_name="2x2 grass",
                role="uniform_terrain.grass",
                width=2,
                height=2,
                cells=[
                    [
                        {"tilesetSlug": "tset-pri", "metatileIndex": 0},
                        {"tilesetSlug": "tset-pri", "metatileIndex": 1},
                    ],
                    [
                        {"tilesetSlug": "tset-sec", "metatileIndex": 0},
                        {"tilesetSlug": "tset-sec", "metatileIndex": 1},
                    ],
                ],
                anchor_x=0,
                anchor_y=0,
                origin_tileset_id=pri.id,
                required_tags=["terrain.grass"],
                scope="global",
                project_id=None,
            )
        )

    return ids


# ---------------------------------------------------------------------------
# 8H-1 - suggest_neighbors
# ---------------------------------------------------------------------------


def test_neighbors_suggest_returns_ranked_candidates(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/neighbors/suggest",
        json={
            "tileset_slug": "tset-pri",
            "metatile_index": 0,
            "direction": 2,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_observations"] == 50
    assert len(body["suggestions"]) == 2
    # The first suggestion (highest probability) is tset-pri/1.
    first = body["suggestions"][0]
    assert first["tileset_slug"] == "tset-pri"
    assert first["metatile_index"] == 1
    assert first["probability"] == pytest.approx(0.7)
    assert first["support_count"] == 35
    # phash hex round-trips: index 1 → byte 0x01 × 8.
    assert first["phash_hex"] == "0101010101010101"


def test_neighbors_suggest_with_limit_truncates(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/neighbors/suggest",
        json={
            "tileset_slug": "tset-pri",
            "metatile_index": 0,
            "direction": 2,
            "limit": 1,
        },
    )
    body = resp.json()
    assert len(body["suggestions"]) == 1


def test_neighbors_suggest_returns_empty_when_no_rule(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/neighbors/suggest",
        json={
            "tileset_slug": "tset-pri",
            "metatile_index": 0,
            "direction": 0,  # North - no rule seeded.
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_observations"] == 0
    assert body["suggestions"] == []


def test_neighbors_suggest_404_for_unknown_seed(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/neighbors/suggest",
        json={
            "tileset_slug": "no-such-tileset",
            "metatile_index": 0,
            "direction": 2,
        },
    )
    assert resp.status_code == 404


def test_neighbors_suggest_rejects_bad_direction(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/neighbors/suggest",
        json={
            "tileset_slug": "tset-pri",
            "metatile_index": 0,
            "direction": 8,  # Out of range.
        },
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 8H-3 - tileset library
# ---------------------------------------------------------------------------


def test_tileset_library_returns_seeded_entries(client, factory):
    _seed(factory)
    resp = client.get("/v1/tilesets/library")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_tilesets"] == 2
    slugs = {e["slug"] for e in body["entries"]}
    assert slugs == {"tset-pri", "tset-sec"}


def test_tileset_library_filter_by_secondary(client, factory):
    _seed(factory)
    resp = client.get("/v1/tilesets/library?is_secondary=true")
    body = resp.json()
    assert body["total_tilesets"] == 1
    assert body["entries"][0]["slug"] == "tset-sec"


def test_tileset_library_pagination(client, factory):
    _seed(factory)
    resp = client.get("/v1/tilesets/library?limit=1&offset=1")
    body = resp.json()
    assert body["total_tilesets"] == 2
    assert len(body["entries"]) == 1
    assert body["entries"][0]["slug"] == "tset-sec"


def test_tileset_library_filter_by_source(client, factory):
    _seed(factory)
    resp = client.get("/v1/tilesets/library?source=non-existent-source")
    body = resp.json()
    assert body["total_tilesets"] == 0
    assert body["entries"] == []


def test_tileset_library_carries_attribution(client, factory):
    _seed(factory)
    resp = client.get("/v1/tilesets/library")
    body = resp.json()
    pri = next(e for e in body["entries"] if e["slug"] == "tset-pri")
    assert pri["license_spdx"] == "MIT"
    assert pri["attribution"] == "pret/pokefirered"
    assert pri["source_commit"] == "abc1234"


# ---------------------------------------------------------------------------
# 8H-4 - apply template
# ---------------------------------------------------------------------------


def test_templates_apply_emits_cells_at_anchor(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/templates/apply",
        json={
            "template_slug": "my-2x2",
            "anchor": {"x": 4, "y": 5},
            "tag_bindings": {},
            "map_width": 20,
            "map_height": 20,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["template_slug"] == "my-2x2"
    assert len(body["cells"]) == 4
    assert body["cells_out_of_bounds"] == 0
    # Top-left cell.
    tl = next(c for c in body["cells"] if c["x"] == 4 and c["y"] == 5)
    assert tl["tileset_slug"] == "tset-pri"
    assert tl["metatile_index"] == 0
    # Bottom-right.
    br = next(c for c in body["cells"] if c["x"] == 5 and c["y"] == 6)
    assert br["tileset_slug"] == "tset-sec"
    assert br["metatile_index"] == 1


def test_templates_apply_truncates_out_of_bounds(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/templates/apply",
        json={
            "template_slug": "my-2x2",
            "anchor": {"x": 9, "y": 9},
            "map_width": 10,
            "map_height": 10,
        },
    )
    body = resp.json()
    # Anchor at (9, 9) on a 10x10 → cells (9,9), (10,9), (9,10), (10,10).
    # Only (9, 9) is in bounds.
    assert len(body["cells"]) == 1
    assert body["cells_out_of_bounds"] == 3


def test_templates_apply_404_for_unknown(client, factory):
    _seed(factory)
    resp = client.post(
        "/v1/templates/apply",
        json={
            "template_slug": "no-such-template",
            "anchor": {"x": 0, "y": 0},
        },
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 8H-2 - complete_region
# ---------------------------------------------------------------------------


def _seed_for_completion(factory) -> None:
    """Lighter seed: just enough tagged metatiles to fill a rect."""

    from tile_intel.domain.models import MetatileTag, TagTaxonomy

    with factory.session() as session:
        # Tag taxonomy.
        for slug in ("terrain.grass.tall", "terrain.path"):
            session.add(
                TagTaxonomy(
                    slug=slug,
                    parent_id=None,
                    axis="terrain",
                    display_name=slug,
                    is_leaf=True,
                )
            )
        session.flush()
        grass_tag = (
            session.query(TagTaxonomy).filter_by(slug="terrain.grass.tall").one()
        )

        pri = Tileset(
            slug="t-comp-pri",
            display_name="Comp Primary",
            family="frlg",
            is_secondary=False,
            is_compressed=True,
            scope="global",
            project_id=None,
            source="pret-firered",
            content_hash=b"c" * 32,
            raw_bytes_size=0,
        )
        session.add(pri)
        session.flush()
        m = Metatile(
            tileset_id=pri.id,
            metatile_index=42,
            behavior_id=1,
            terrain_type=0,
            encounter_type=0,
            layer_type=0,
            attr_raw=b"\x00" * 4,
            composition=[],
            rendered_hash=b"x" * 32,
            phash=b"\x42" * 8,
            is_walkable=True,
            is_surfable=False,
            is_encounter_grass=True,
        )
        session.add(m)
        session.flush()
        session.add(
            MetatileTag(
                metatile_id=m.id,
                tag_id=grass_tag.id,
                confidence=1.0,
                source="seed",
            )
        )


def test_complete_region_fills_uniformly_tagged_rect(client, factory):
    _seed_for_completion(factory)
    width = 3
    height = 2
    resp = client.post(
        "/v1/regions/complete",
        json={
            "width": width,
            "height": height,
            "tag_grid": [
                [["terrain.grass.tall"]] * width for _ in range(height)
            ],
            "primary_tileset_slug": "t-comp-pri",
            "secondary_tileset_slug": "t-comp-pri",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["unassigned_cells"] == 0
    assert len(body["cells"]) == width * height
    for cell in body["cells"]:
        assert cell["tileset_slug"] == "t-comp-pri"
        assert cell["metatile_index"] == 42


def test_complete_region_respects_seed_cells(client, factory):
    _seed_for_completion(factory)
    resp = client.post(
        "/v1/regions/complete",
        json={
            "width": 2,
            "height": 1,
            "tag_grid": [[["terrain.grass.tall"], ["terrain.grass.tall"]]],
            "seed_cells": {
                "0,0": {"tileset_slug": "custom-ts", "metatile_index": 99}
            },
            "primary_tileset_slug": "t-comp-pri",
            "secondary_tileset_slug": "t-comp-pri",
        },
    )
    body = resp.json()
    # Seed cell preserved.
    seed = next(c for c in body["cells"] if c["x"] == 0 and c["y"] == 0)
    assert seed["tileset_slug"] == "custom-ts"
    assert seed["metatile_index"] == 99
    # The other cell is filled from the DB.
    filled = next(c for c in body["cells"] if c["x"] == 1 and c["y"] == 0)
    assert filled["tileset_slug"] == "t-comp-pri"


def test_complete_region_unassigned_when_no_match(client, factory):
    _seed_for_completion(factory)
    resp = client.post(
        "/v1/regions/complete",
        json={
            "width": 2,
            "height": 1,
            "tag_grid": [[["terrain.nope"], ["terrain.nope"]]],
            "primary_tileset_slug": "t-comp-pri",
            "secondary_tileset_slug": "t-comp-pri",
        },
    )
    body = resp.json()
    assert body["unassigned_cells"] == 2
    assert body["cells"] == []


def test_complete_region_rejects_mismatched_grid_dims(client, factory):
    _seed_for_completion(factory)
    resp = client.post(
        "/v1/regions/complete",
        json={
            "width": 3,
            "height": 2,
            "tag_grid": [[["terrain.grass.tall"]] * 3],  # only 1 row, not 2
            "primary_tileset_slug": "t-comp-pri",
            "secondary_tileset_slug": "t-comp-pri",
        },
    )
    assert resp.status_code == 400
