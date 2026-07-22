"""Phase 8F-3 - DSL parser + validator tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.grammar.dsl import (
    MapSkeleton,
    NoOverlapConstraint,
    validate_skeleton,
)
from tile_intel.storage.base import make_inmemory_factory


def _minimal_skeleton() -> dict:
    return {
        "version": "1.0",
        "map": {
            "name": "test",
            "size": {"w": 20, "h": 15},
            "primary_tileset": "pret-frlg-primary-general",
            "secondary_tileset": "pret-frlg-secondary-pallet_town",
            "default_biome": "biome.town",
        },
    }


def _skeleton_with_region() -> dict:
    return {
        "version": "1.0",
        "map": {
            "name": "with-region",
            "size": {"w": 20, "h": 15},
            "primary_tileset": "p",
            "secondary_tileset": "s",
            "default_biome": "biome.town",
        },
        "regions": [
            {
                "id": "main",
                "shape": {"kind": "rect", "x": 5, "y": 5, "w": 10, "h": 5},
                "biome": "biome.town",
            }
        ],
    }


# ---------------------------------------------------------------------------
# Pydantic parse
# ---------------------------------------------------------------------------


def test_parse_minimal_skeleton():
    skel = MapSkeleton.model_validate(_minimal_skeleton())
    assert skel.version == "1.0"
    assert skel.map.size.w == 20
    assert skel.regions == []
    assert skel.pois == []


def test_parse_rejects_invalid_version():
    payload = _minimal_skeleton()
    payload["version"] = "0.9"
    with pytest.raises(Exception):
        MapSkeleton.model_validate(payload)


def test_parse_rejects_extra_top_level_keys():
    payload = _minimal_skeleton()
    payload["extra"] = "nope"
    with pytest.raises(Exception):
        MapSkeleton.model_validate(payload)


def test_parse_full_skeleton_with_all_layers():
    payload = {
        "version": "1.0",
        "map": {
            "name": "complete",
            "size": {"w": 40, "h": 30},
            "primary_tileset": "p",
            "secondary_tileset": "s",
            "default_biome": "biome.forest",
            "elevation": {"layers": 2, "default_layer": 0},
        },
        "regions": [
            {
                "id": "clearing",
                "shape": {"kind": "rect", "x": 5, "y": 5, "w": 10, "h": 8},
                "biome": "biome.forest",
                "tags": {"terrain": "tall_grass", "density": "high", "extra": "ok"},
                "elevation": 0,
                "priority": 10,
            },
            {
                "id": "trees",
                "shape": {"kind": "polygon", "points": [[0, 0], [40, 0], [40, 4], [0, 4]]},
                "biome": "biome.forest",
                "tags": {"terrain": "tree_wall"},
            },
        ],
        "paths": [
            {
                "id": "main-path",
                "endpoints": [{"ref": "poi:entrance"}, {"ref": "poi:exit"}],
                "width_metatiles": 2,
                "constraints": {"min_turns": 1, "max_turns": 5},
            }
        ],
        "templates": [{"ref": "pattern-3x3-abc123", "anchor": {"x": 20, "y": 15}}],
        "pois": [
            {"id": "entrance", "kind": "warp", "x": 20, "y": 0, "metadata": {"target_map": "route-2"}},
            {"id": "exit", "kind": "warp", "x": 39, "y": 15},
        ],
        "constraints": [
            {"kind": "no_overlap", "regions": ["clearing", "trees"]},
            {"kind": "connectivity", "from": "poi:entrance", "to": "poi:exit"},
        ],
    }
    skel = MapSkeleton.model_validate(payload)
    assert len(skel.regions) == 2
    assert skel.regions[0].tags.density == "high"
    # extra tag passes through because RegionTags allows extra fields
    assert getattr(skel.regions[0].tags, "extra", None) == "ok"
    assert len(skel.constraints) == 2
    assert isinstance(skel.constraints[0], NoOverlapConstraint)


# ---------------------------------------------------------------------------
# Semantic validation
# ---------------------------------------------------------------------------


def test_validate_clean_minimal_skeleton():
    skel = MapSkeleton.model_validate(_minimal_skeleton())
    issues = validate_skeleton(skel)
    assert issues == []


def test_validate_flags_duplicate_region_ids():
    skel = MapSkeleton.model_validate(_skeleton_with_region())
    # Add another region with the same id.
    skel = MapSkeleton.model_validate(
        {
            **_skeleton_with_region(),
            "regions": [
                _skeleton_with_region()["regions"][0],
                {
                    "id": "main",
                    "shape": {"kind": "rect", "x": 1, "y": 1, "w": 1, "h": 1},
                    "biome": "biome.town",
                },
            ],
        }
    )
    issues = validate_skeleton(skel)
    assert any("duplicate region id" in i.message for i in issues)


def test_validate_flags_oob_rect():
    skel = MapSkeleton.model_validate(
        {
            **_minimal_skeleton(),
            "regions": [
                {
                    "id": "oob",
                    "shape": {"kind": "rect", "x": 18, "y": 12, "w": 10, "h": 10},
                    "biome": "biome.town",
                }
            ],
        }
    )
    issues = validate_skeleton(skel)
    assert any("outside map bounds" in i.message for i in issues)


def test_validate_flags_unknown_path_endpoint_ref():
    skel = MapSkeleton.model_validate(
        {
            **_minimal_skeleton(),
            "paths": [
                {
                    "id": "bad-ref",
                    "endpoints": [
                        {"ref": "poi:nonexistent"},
                        {"x": 5, "y": 5},
                    ],
                }
            ],
        }
    )
    issues = validate_skeleton(skel)
    assert any("unresolved POI ref" in i.message for i in issues)


def test_validate_flags_constraint_referencing_unknown_region():
    skel = MapSkeleton.model_validate(
        {
            **_minimal_skeleton(),
            "constraints": [
                {"kind": "no_overlap", "regions": ["nonexistent_a", "nonexistent_b"]}
            ],
        }
    )
    issues = validate_skeleton(skel)
    assert sum(1 for i in issues if "unknown region id" in i.message) == 2


def test_validate_flags_poi_without_coords_or_shape():
    skel = MapSkeleton.model_validate(
        {
            **_minimal_skeleton(),
            "pois": [{"id": "ghost", "kind": "warp"}],
        }
    )
    issues = validate_skeleton(skel)
    assert any("must have either shape or" in i.message for i in issues)


def test_validate_passes_full_correct_skeleton():
    payload = {
        "version": "1.0",
        "map": {
            "name": "good",
            "size": {"w": 40, "h": 30},
            "primary_tileset": "p",
            "secondary_tileset": "s",
            "default_biome": "biome.forest",
        },
        "regions": [
            {
                "id": "main",
                "shape": {"kind": "rect", "x": 5, "y": 5, "w": 10, "h": 10},
                "biome": "biome.forest",
            }
        ],
        "pois": [{"id": "north", "kind": "warp", "x": 20, "y": 0}],
        "paths": [
            {
                "id": "p1",
                "endpoints": [{"ref": "poi:north"}, {"x": 10, "y": 10}],
            }
        ],
        "constraints": [
            {"kind": "connectivity", "from": "poi:north", "to": "region:main"}
        ],
    }
    skel = MapSkeleton.model_validate(payload)
    issues = validate_skeleton(skel)
    assert not any(i.severity == "error" for i in issues)


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    factory = make_inmemory_factory()
    factory.create_all()
    yield TestClient(create_app(storage_factory=factory))
    factory.drop_all()


def test_http_parse_ok(client):
    response = client.post("/v1/grammar/parse", json=_minimal_skeleton())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["map_name"] == "test"
    assert body["region_count"] == 0


def test_http_parse_returns_schema_error(client):
    response = client.post(
        "/v1/grammar/parse", json={"version": "0.5"}  # missing `map` etc.
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert any(
        "schema validation failed" in i["message"] for i in body["issues"]
    )


def test_http_parse_surfaces_semantic_errors(client):
    response = client.post(
        "/v1/grammar/parse",
        json={
            **_minimal_skeleton(),
            "regions": [
                {
                    "id": "x",
                    "shape": {"kind": "rect", "x": 100, "y": 100, "w": 10, "h": 10},
                    "biome": "biome.town",
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert any("outside map bounds" in i["message"] for i in body["issues"])
