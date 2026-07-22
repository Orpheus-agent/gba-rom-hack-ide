"""Phase 8J-1 - Generated-map harness tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.generator.harness import (
    check_resolved_map,
    fingerprint_resolved_map,
    load_baseline,
    save_baseline,
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


def _good_resolved(width: int = 2, height: int = 2) -> dict:
    """A minimal resolved-map that passes every invariant."""

    return {
        "primary_tileset_slug": "ts-pri",
        "secondary_tileset_slug": "ts-sec",
        "width": width,
        "height": height,
        "grid": [
            [
                {"tileset_slug": "ts-pri", "metatile_index": x + y * width}
                for x in range(width)
            ]
            for y in range(height)
        ],
        "tag_grid": [
            [["terrain.grass"] for _ in range(width)] for _ in range(height)
        ],
        "border_blocks": [
            [
                {"tileset_slug": "ts-pri", "metatile_index": 0},
                {"tileset_slug": "ts-pri", "metatile_index": 0},
            ],
            [
                {"tileset_slug": "ts-pri", "metatile_index": 0},
                {"tileset_slug": "ts-pri", "metatile_index": 0},
            ],
        ],
        "pois": [],
        "report": {
            "seed": 0,
            "width": width,
            "height": height,
            "assigned_cells": width * height,
            "unassigned_cells": 0,
            "template_anchors_placed": 0,
            "template_anchors_skipped": 0,
            "rule_violations": 0,
            "rules_consulted": 0,
            "paths_solved": 0,
            "paths_failed": 0,
            "warnings": [],
        },
    }


def test_check_resolved_map_passes_clean():
    report = check_resolved_map(_good_resolved())
    assert report.ok is True
    assert report.assigned_cells == 4
    assert report.unassigned_cells == 0
    assert report.distinct_tileset_slugs == ["ts-pri"]


def test_check_resolved_map_detects_grid_size_drift():
    resolved = _good_resolved()
    resolved["grid"].pop()  # drop a row
    report = check_resolved_map(resolved)
    assert report.ok is False
    assert any(i.code == "grid_height_mismatch" for i in report.issues)


def test_check_resolved_map_warns_on_empty_border():
    resolved = _good_resolved()
    resolved["border_blocks"] = [[None, None], [None, None]]
    report = check_resolved_map(resolved)
    assert any(i.code == "border_empty" for i in report.issues)


def test_check_resolved_map_warns_on_tileset_drift():
    resolved = _good_resolved()
    resolved["grid"][0][0] = {
        "tileset_slug": "rogue-pack",
        "metatile_index": 0,
    }
    report = check_resolved_map(resolved)
    assert any(i.code == "tileset_slug_drift" for i in report.issues)


def test_check_resolved_map_detects_count_mismatch():
    resolved = _good_resolved()
    resolved["report"]["assigned_cells"] = 100  # wrong
    report = check_resolved_map(resolved)
    assert report.ok is False
    assert any(i.code == "assigned_count_mismatch" for i in report.issues)


def test_check_resolved_map_flags_poi_out_of_bounds():
    resolved = _good_resolved()
    resolved["pois"] = [
        {"id": "exit", "kind": "warp", "x": 99, "y": 99, "rect": None},
    ]
    report = check_resolved_map(resolved)
    assert report.ok is False
    assert any(i.code == "poi_out_of_bounds" for i in report.issues)


def test_fingerprint_is_deterministic():
    a = fingerprint_resolved_map(_good_resolved())
    b = fingerprint_resolved_map(_good_resolved())
    assert a == b


def test_fingerprint_changes_when_grid_changes():
    a = fingerprint_resolved_map(_good_resolved())
    drifted = _good_resolved()
    drifted["grid"][0][0] = {
        "tileset_slug": "ts-pri",
        "metatile_index": 999,
    }
    b = fingerprint_resolved_map(drifted)
    assert a != b


def test_baseline_drift_detected():
    fp = fingerprint_resolved_map(_good_resolved())
    drifted = _good_resolved()
    drifted["grid"][0][0]["metatile_index"] = 999
    report = check_resolved_map(drifted, baseline_fingerprint=fp)
    assert report.baseline_match is False
    assert any(i.code == "baseline_drift" for i in report.issues)


def test_baseline_match_when_unchanged():
    fp = fingerprint_resolved_map(_good_resolved())
    report = check_resolved_map(_good_resolved(), baseline_fingerprint=fp)
    assert report.baseline_match is True


def test_save_and_load_baseline(tmp_path: Path):
    baseline = tmp_path / "baseline.json"
    save_baseline(baseline, "abc123")
    assert load_baseline(baseline) == "abc123"


def test_load_missing_baseline_returns_none(tmp_path: Path):
    assert load_baseline(tmp_path / "no-such") is None


# ---------------------------------------------------------------------------
# FastAPI endpoint
# ---------------------------------------------------------------------------


def test_harness_endpoint_ok(client):
    resp = client.post(
        "/v1/generate/harness",
        json={"resolved": _good_resolved()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["fingerprint"] != ""
    assert body["distinct_tileset_slugs"] == ["ts-pri"]


def test_harness_endpoint_surfaces_drift(client):
    resp_a = client.post(
        "/v1/generate/harness", json={"resolved": _good_resolved()}
    )
    fp = resp_a.json()["fingerprint"]
    drifted = _good_resolved()
    drifted["grid"][0][0]["metatile_index"] = 999
    resp_b = client.post(
        "/v1/generate/harness",
        json={"resolved": drifted, "baseline_fingerprint": fp},
    )
    assert resp_b.status_code == 200
    body = resp_b.json()
    assert body["baseline_match"] is False
    assert any(i["code"] == "baseline_drift" for i in body["issues"])
