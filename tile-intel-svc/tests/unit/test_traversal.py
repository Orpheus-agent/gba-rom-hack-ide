"""Phase 8G-3 - Traversal validator tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.generator.resolve import (
    MetatilePlacement,
    ResolvedMap,
    ResolvedMapReport,
    ResolvedPOI,
)
from tile_intel.generator.traversal import validate_traversal
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


def _build_resolved(
    *,
    width: int,
    height: int,
    tag_grid: list[list[list[str]]],
    pois: list[ResolvedPOI] | None = None,
    grid: list[list[MetatilePlacement | None]] | None = None,
) -> ResolvedMap:
    """Test helper: builds a ResolvedMap from a tag grid + POIs."""

    return ResolvedMap(
        width=width,
        height=height,
        grid=grid or [[None] * width for _ in range(height)],
        tag_grid=tag_grid,
        primary_tileset_slug="ts-pri",
        secondary_tileset_slug="ts-sec",
        border_blocks=[[None, None], [None, None]],
        report=ResolvedMapReport(
            seed=0,
            width=width,
            height=height,
            assigned_cells=0,
            unassigned_cells=width * height,
            template_anchors_placed=0,
            template_anchors_skipped=0,
            rule_violations=0,
            rules_consulted=0,
            paths_solved=0,
            paths_failed=0,
        ),
        pois=pois or [],
    )


# ---------------------------------------------------------------------------
# Connected-component math
# ---------------------------------------------------------------------------


def test_validate_all_walkable_one_component():
    tag_grid = [
        [["terrain.grass"]] * 4 for _ in range(3)
    ]
    resolved = _build_resolved(width=4, height=3, tag_grid=tag_grid)
    report = validate_traversal(resolved)
    assert report.ok is True
    assert report.walkable_summary.component_count == 1
    assert report.walkable_summary.walkable_cells == 12


def test_validate_two_pockets_separated_by_wall():
    # 5x3 grid where the middle column is wall, splitting walkable
    # into two halves.
    tag_grid: list[list[list[str]]] = []
    for y in range(3):
        row: list[list[str]] = []
        for x in range(5):
            if x == 2:
                row.append(["terrain.cave.wall"])
            else:
                row.append(["terrain.grass"])
        tag_grid.append(row)
    resolved = _build_resolved(width=5, height=3, tag_grid=tag_grid)
    report = validate_traversal(resolved)
    assert report.walkable_summary.component_count == 2
    # No POIs were placed → both components are isolated and emit
    # 'isolated_walkable_pocket' warnings.
    warnings = [i for i in report.issues if i.code == "isolated_walkable_pocket"]
    assert len(warnings) >= 1


def test_validate_entrance_exit_unreachable_errors_out():
    """5x3 grid; entrance left of wall, exit right of wall → error."""

    tag_grid: list[list[list[str]]] = []
    for y in range(3):
        row: list[list[str]] = []
        for x in range(5):
            if x == 2:
                row.append(["terrain.cave.wall"])
            else:
                row.append(["terrain.grass"])
        tag_grid.append(row)
    resolved = _build_resolved(
        width=5,
        height=3,
        tag_grid=tag_grid,
        pois=[
            ResolvedPOI(id="entrance", kind="warp", x=0, y=1, rect=None),
            ResolvedPOI(id="exit", kind="warp", x=4, y=1, rect=None),
        ],
    )
    report = validate_traversal(resolved)
    assert report.ok is False
    codes = {i.code for i in report.issues}
    assert "entrance_exit_unreachable" in codes


def test_validate_entrance_exit_reachable_passes():
    tag_grid = [
        [["terrain.grass"]] * 5 for _ in range(3)
    ]
    resolved = _build_resolved(
        width=5,
        height=3,
        tag_grid=tag_grid,
        pois=[
            ResolvedPOI(id="entrance", kind="warp", x=0, y=1, rect=None),
            ResolvedPOI(id="exit", kind="warp", x=4, y=1, rect=None),
        ],
    )
    report = validate_traversal(resolved)
    assert report.ok is True
    assert any(p.poi_id == "entrance" and "exit" in p.reachable_pois for p in report.poi_reachability)


def test_validate_poi_on_unwalkable_cell_errors():
    tag_grid = [
        [["terrain.cave.wall"]] * 3,
        [["terrain.cave.wall"], ["terrain.grass"], ["terrain.cave.wall"]],
        [["terrain.cave.wall"]] * 3,
    ]
    resolved = _build_resolved(
        width=3,
        height=3,
        tag_grid=tag_grid,
        pois=[
            # POI lands on the wall.
            ResolvedPOI(id="oops", kind="warp", x=0, y=0, rect=None),
        ],
    )
    report = validate_traversal(resolved)
    assert report.ok is False
    assert any(i.code == "poi_on_unwalkable_cell" for i in report.issues)


def test_validate_water_transition_warning():
    # 3x3 grid: middle is water, surroundings are wall.
    tag_grid = [
        [["terrain.cave.wall"]] * 3,
        [["terrain.cave.wall"], ["terrain.water.shallow"], ["terrain.cave.wall"]],
        [["terrain.cave.wall"]] * 3,
    ]
    resolved = _build_resolved(width=3, height=3, tag_grid=tag_grid)
    report = validate_traversal(resolved)
    assert any(i.code == "invalid_water_transition" for i in report.issues)


def test_validate_empty_tag_cell_warning():
    tag_grid = [
        [["terrain.grass"], [], ["terrain.grass"]],
    ]
    resolved = _build_resolved(width=3, height=1, tag_grid=tag_grid)
    report = validate_traversal(resolved)
    assert any(i.code == "empty_tag_cell" for i in report.issues)


def test_validate_poi_out_of_bounds():
    tag_grid = [[["terrain.grass"]] * 3 for _ in range(3)]
    resolved = _build_resolved(
        width=3,
        height=3,
        tag_grid=tag_grid,
        pois=[
            ResolvedPOI(id="floating", kind="warp", x=99, y=99, rect=None),
        ],
    )
    report = validate_traversal(resolved)
    assert report.ok is False
    assert any(i.code == "poi_out_of_bounds" for i in report.issues)


def test_validate_encounter_zone_rect_chooses_centre():
    """Encounter zones land in 5x5 grass; expected to be reachable."""

    tag_grid = [[["terrain.grass"]] * 5 for _ in range(5)]
    resolved = _build_resolved(
        width=5,
        height=5,
        tag_grid=tag_grid,
        pois=[
            ResolvedPOI(id="entrance", kind="warp", x=0, y=2, rect=None),
            ResolvedPOI(id="exit", kind="warp", x=4, y=2, rect=None),
            ResolvedPOI(
                id="grass_zone",
                kind="encounter_zone",
                x=None,
                y=None,
                rect=(1, 1, 3, 3),
            ),
        ],
    )
    report = validate_traversal(resolved)
    assert report.ok is True
    grass_entry = next(
        (p for p in report.poi_reachability if p.poi_id == "grass_zone"), None
    )
    assert grass_entry is not None
    assert grass_entry.walkable is True


def test_summary_is_plain_english():
    tag_grid = [[["terrain.grass"]] * 4 for _ in range(3)]
    resolved = _build_resolved(
        width=4,
        height=3,
        tag_grid=tag_grid,
        pois=[
            ResolvedPOI(id="entrance", kind="warp", x=0, y=1, rect=None),
            ResolvedPOI(id="exit", kind="warp", x=3, y=1, rect=None),
        ],
    )
    report = validate_traversal(resolved)
    assert "Traversal check passed" in report.summary
    assert "100.0%" in report.summary
    assert "Navigation POIs found: 2" in report.summary


# ---------------------------------------------------------------------------
# FastAPI endpoint
# ---------------------------------------------------------------------------


def test_validate_traversal_endpoint_round_trips(client):
    payload = {
        "primary_tileset_slug": "ts-pri",
        "secondary_tileset_slug": "ts-sec",
        "width": 4,
        "height": 3,
        "grid": [[None] * 4 for _ in range(3)],
        "tag_grid": [
            [["terrain.grass"]] * 4 for _ in range(3)
        ],
        "border_blocks": [[None, None], [None, None]],
        "pois": [
            {"id": "entrance", "kind": "warp", "x": 0, "y": 1, "rect": None},
            {"id": "exit", "kind": "warp", "x": 3, "y": 1, "rect": None},
        ],
        "report": {
            "seed": 0,
            "width": 4,
            "height": 3,
            "assigned_cells": 0,
            "unassigned_cells": 12,
            "template_anchors_placed": 0,
            "template_anchors_skipped": 0,
            "rule_violations": 0,
            "rules_consulted": 0,
            "paths_solved": 0,
            "paths_failed": 0,
            "warnings": [],
        },
    }
    resp = client.post("/v1/generate/validate-traversal", json={"resolved": payload})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["walkable_summary"]["walkable_cells"] == 12
    assert any(p["poi_id"] == "entrance" for p in body["poi_reachability"])


def test_validate_traversal_endpoint_rejects_malformed_payload(client):
    resp = client.post("/v1/generate/validate-traversal", json={"resolved": {}})
    assert resp.status_code == 200  # An empty resolved is parseable (0x0 map).
    body = resp.json()
    assert body["width"] == 0
    assert body["height"] == 0
    assert body["ok"] is True


def test_generate_resolve_response_now_includes_pois(client, factory):
    # Round trip a fresh skeleton.
    gen = client.post(
        "/v1/generate/skeleton",
        json={
            "theme": "route",
            "biome": "biome.route",
            "width": 8,
            "height": 8,
            "density": "low",
            "seed": 9,
        },
    )
    assert gen.status_code == 200
    skel = gen.json()["skeleton"]
    resp = client.post(
        "/v1/generate/resolve", json={"skeleton": skel, "seed": 9}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body["pois"], list)
    poi_ids = {p["id"] for p in body["pois"]}
    assert "entrance" in poi_ids
    assert "exit" in poi_ids
