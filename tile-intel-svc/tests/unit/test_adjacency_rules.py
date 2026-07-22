"""Phase 8C-3 - Adjacency rule derivation tests."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import AdjacencyRule
from tile_intel.ingest.adjacency_rules import rebuild_adjacency_rules
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.storage.base import make_inmemory_factory

REPEAT_ZERO_64 = "0" * 64
SHA = "a" * 64
PHASH = "b" * 16


def _slot(layer: int, quad: int) -> dict:
    return {"layer": layer, "quad": quad, "tileIndex": 0, "hflip": False, "vflip": False, "paletteIndex": 0}


def _palette() -> dict:
    return {
        "paletteIndex": 0,
        "bgr555Hex": REPEAT_ZERO_64,
        "medianCut5": ["#000"],
        "dominantHue": None,
        "luminanceAvg": 0,
    }


def _tile() -> dict:
    return {
        "tileIndex": 0,
        "pixelBytesHex": "0" * 128,
        "pixelHashHex": SHA,
        "paletteNeutralHashHex": SHA,
        "phashHex": PHASH,
        "isBlank": True,
        "isHorizontallySymmetric": True,
        "isVerticallySymmetric": True,
    }


def _metatile(idx: int) -> dict:
    return {
        "metatileIndex": idx,
        "attrRawHex": "00000000",
        "behaviorId": 0,
        "terrainType": 0,
        "encounterType": 0,
        "layerType": 0,
        "composition": [_slot(L, Q) for L in (0, 1) for Q in (0, 1, 2, 3)],
        "renderedHashHex": SHA,
        "phashHex": PHASH,
    }


def _tileset(slug: str, num_metatiles: int) -> dict:
    return {
        "slug": slug,
        "displayName": "X",
        "source": "pret-firered",
        "sourceCommit": "abcdef0123",
        "attribution": "pret (MIT)",
        "licenseSpdx": "MIT",
        "family": "frlg",
        "isSecondary": False,
        "isCompressed": True,
        "tileCount": 1,
        "metatileCount": num_metatiles,
        "palettes": [_palette()],
        "tiles": [_tile()],
        "metatiles": [_metatile(i) for i in range(num_metatiles)],
    }


def _corpus(observations: list[dict], num_metatiles: int = 4) -> dict:
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": "pret-firered",
        "toolingVersion": "8C-3-test",
        "tilesets": [_tileset("test-frlg-primary-z", num_metatiles)],
        "mapAdjacencies": [
            {
                "mapSlug": "test-map-1",
                "primaryTilesetSlug": "test-frlg-primary-z",
                "secondaryTilesetSlug": "test-frlg-primary-z",
                "width": 4,
                "height": 4,
                "observations": observations,
            }
        ],
    }


@pytest.fixture
def factory():
    f = make_inmemory_factory()
    f.create_all()
    yield f
    f.drop_all()


@pytest.fixture
def client(factory):
    return TestClient(create_app(storage_factory=factory))


def _obs(a: int, b: int, direction: int, freq: int) -> dict:
    return {
        "tilesetSlugA": "test-frlg-primary-z",
        "metatileIndexA": a,
        "tilesetSlugB": "test-frlg-primary-z",
        "metatileIndexB": b,
        "direction": direction,
        "frequency": freq,
    }


def test_rebuild_with_single_observation(factory):
    payload = _corpus([_obs(0, 1, 2, 5)])  # metatile 0 → east → metatile 1, count 5
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    report = rebuild_adjacency_rules(factory)
    assert report.rules_built == 1
    with factory.session() as session:
        rule = session.query(AdjacencyRule).one()
        assert rule.direction == 2
        assert rule.total_observations == 5
        assert float(rule.entropy) == pytest.approx(0.0)  # single neighbor → 0 entropy
        assert len(rule.legal_neighbors) == 1
        assert rule.legal_neighbors[0]["probability"] == pytest.approx(1.0)
        assert len(rule.hard_legal_set) == 1


def test_rebuild_distribution_and_entropy(factory):
    # metatile 0 → east → 50% to metatile 1, 50% to metatile 2
    payload = _corpus([_obs(0, 1, 2, 50), _obs(0, 2, 2, 50)])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    rebuild_adjacency_rules(factory)
    with factory.session() as session:
        rule = session.query(AdjacencyRule).one()
        assert rule.total_observations == 100
        # H(½, ½) = 1.0
        assert float(rule.entropy) == pytest.approx(1.0)
        probs = sorted(n["probability"] for n in rule.legal_neighbors)
        assert probs == pytest.approx([0.5, 0.5])


def test_rebuild_hard_legal_set_respects_threshold(factory):
    # metatile 0 → east → 99% to metatile 1, 1% to metatile 2 (just above threshold),
    # 0.1% to metatile 3 (below threshold).
    payload = _corpus(
        [_obs(0, 1, 2, 990), _obs(0, 2, 2, 10), _obs(0, 3, 2, 1)],
        num_metatiles=4,
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    rebuild_adjacency_rules(factory, threshold=0.005)
    with factory.session() as session:
        rule = session.query(AdjacencyRule).one()
        assert sorted(rule.hard_legal_set) != sorted([n["metatile_b"] for n in rule.legal_neighbors])
        # All three are in legal_neighbors (full distribution).
        assert len(rule.legal_neighbors) == 3
        # But the 0.1% case is below threshold (0.5%) → excluded.
        assert len(rule.hard_legal_set) == 2


def test_rebuild_aggregates_multiple_maps(factory):
    # Two maps both contributing (0 → east → 1).
    payload = _corpus([_obs(0, 1, 2, 5)])
    payload["mapAdjacencies"].append({
        "mapSlug": "test-map-2",
        "primaryTilesetSlug": "test-frlg-primary-z",
        "secondaryTilesetSlug": "test-frlg-primary-z",
        "width": 4,
        "height": 4,
        "observations": [_obs(0, 1, 2, 7)],
    })
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    rebuild_adjacency_rules(factory)
    with factory.session() as session:
        rule = session.query(AdjacencyRule).one()
        assert rule.total_observations == 12  # 5 + 7


def test_rebuild_is_idempotent(factory):
    payload = _corpus([_obs(0, 1, 2, 5)])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    rebuild_adjacency_rules(factory)
    rebuild_adjacency_rules(factory)
    with factory.session() as session:
        rules = session.query(AdjacencyRule).all()
        assert len(rules) == 1


def test_rebuild_emits_one_rule_per_direction(factory):
    # Same a→b pair observed in two different directions.
    payload = _corpus([_obs(0, 1, 2, 5), _obs(0, 1, 4, 3)])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    rebuild_adjacency_rules(factory)
    with factory.session() as session:
        rules = session.query(AdjacencyRule).all()
        assert len(rules) == 2
        dirs = sorted(r.direction for r in rules)
        assert dirs == [2, 4]


def test_http_rebuild_returns_counts(client, factory):
    payload = _corpus([_obs(0, 1, 2, 5), _obs(0, 2, 2, 5)])
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    response = client.post("/v1/rules/rebuild", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["rules_built"] == 1
    assert body["observations_aggregated"] == 2
    assert body["threshold"] == pytest.approx(0.005)


def test_http_rebuild_validates_scope(client):
    response = client.post("/v1/rules/rebuild", json={"scope": "project"})
    assert response.status_code == 400


def test_http_neighbors_query(client):
    payload = _corpus([_obs(0, 1, 2, 5), _obs(0, 2, 2, 5)])
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    client.post("/v1/rules/rebuild", json={})
    response = client.get("/v1/rules/neighbors", params={"metatile_a": 1, "direction": 2})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["metatile_a"] == 1
    assert body["direction"] == 2
    assert body["total_observations"] == 10
    assert float(body["entropy"]) == pytest.approx(1.0)


def test_http_neighbors_404_when_no_rule(client):
    response = client.get("/v1/rules/neighbors", params={"metatile_a": 99, "direction": 2})
    assert response.status_code == 404


def test_http_neighbors_validates_direction(client):
    response = client.get("/v1/rules/neighbors", params={"metatile_a": 0, "direction": 99})
    assert response.status_code == 400


def test_entropy_zero_for_single_neighbor():
    """Direct math check - entropy must be 0 when only one neighbor exists."""
    from tile_intel.ingest.adjacency_rules import _shannon_entropy
    assert _shannon_entropy([10.0]) == pytest.approx(0.0)


def test_entropy_max_for_uniform_distribution():
    """Direct math check - entropy for 4 equally-likely neighbors is log2(4) = 2."""
    from tile_intel.ingest.adjacency_rules import _shannon_entropy
    assert _shannon_entropy([1.0, 1.0, 1.0, 1.0]) == pytest.approx(math.log2(4))
