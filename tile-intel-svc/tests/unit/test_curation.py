"""Phase 8J-2 - Curation endpoint tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
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


def _good_override(**over) -> dict:
    return {
        "kind": "metatile_placement",
        "label": "good",
        "weight": 1.0,
        "payload": {
            "resolved_slug": "route-1",
            "x": 5,
            "y": 5,
            "tileset_slug": "pret-frlg-route1",
            "metatile_index": 7,
        },
        **over,
    }


def test_create_override_returns_persisted_row(client):
    resp = client.post(
        "/v1/curation/overrides", json=_good_override(note="looks right")
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] > 0
    assert body["kind"] == "metatile_placement"
    assert body["label"] == "good"
    assert body["note"] == "looks right"


def test_create_override_rejects_project_scope_without_id(client):
    resp = client.post(
        "/v1/curation/overrides",
        json=_good_override(scope="project"),
    )
    assert resp.status_code == 400


def test_create_override_accepts_project_scope_with_id(client):
    resp = client.post(
        "/v1/curation/overrides",
        json=_good_override(scope="project", project_id="proj-x"),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["scope"] == "project"
    assert body["project_id"] == "proj-x"


def test_list_overrides_returns_recently_created(client):
    client.post("/v1/curation/overrides", json=_good_override())
    client.post(
        "/v1/curation/overrides",
        json=_good_override(label="bad", note="ugly transition"),
    )
    resp = client.get("/v1/curation/overrides")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert len(body["overrides"]) == 2


def test_list_overrides_filters_by_label(client):
    client.post("/v1/curation/overrides", json=_good_override(label="good"))
    client.post("/v1/curation/overrides", json=_good_override(label="bad"))
    client.post("/v1/curation/overrides", json=_good_override(label="bad"))
    resp = client.get("/v1/curation/overrides?label=bad")
    body = resp.json()
    assert body["total"] == 2


def test_list_overrides_filters_by_kind(client):
    client.post("/v1/curation/overrides", json=_good_override())
    client.post(
        "/v1/curation/overrides",
        json={
            **_good_override(),
            "kind": "template",
            "payload": {"template_slug": "pattern-3x3-deadbeef"},
        },
    )
    resp = client.get("/v1/curation/overrides?kind=template")
    body = resp.json()
    assert body["total"] == 1
    assert body["overrides"][0]["kind"] == "template"


def test_delete_override(client):
    create = client.post("/v1/curation/overrides", json=_good_override())
    oid = create.json()["id"]
    resp = client.delete(f"/v1/curation/overrides/{oid}")
    assert resp.status_code == 200
    assert resp.json()["deleted"] == oid
    # 404 the second time.
    resp2 = client.delete(f"/v1/curation/overrides/{oid}")
    assert resp2.status_code == 404


def test_overrides_summary_aggregates_counts(client):
    client.post("/v1/curation/overrides", json=_good_override(label="good"))
    client.post("/v1/curation/overrides", json=_good_override(label="good"))
    client.post("/v1/curation/overrides", json=_good_override(label="bad"))
    client.post(
        "/v1/curation/overrides",
        json={
            **_good_override(),
            "kind": "adjacency_pair",
            "label": "neutral",
            "payload": {"metatile_a_id": 1, "direction": 2, "metatile_b_id": 5},
        },
    )
    resp = client.get("/v1/curation/overrides/summary")
    body = resp.json()
    assert body["total"] == 4
    assert body["good"] == 2
    assert body["bad"] == 1
    assert body["neutral"] == 1
    assert body["by_kind"]["metatile_placement"] == 3
    assert body["by_kind"]["adjacency_pair"] == 1
