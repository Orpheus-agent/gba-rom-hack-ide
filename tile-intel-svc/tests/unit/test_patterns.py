"""Phase 8C-4 - Multi-cell pattern ingest + query tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import AdjacencyPattern
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.storage.base import make_inmemory_factory

REPEAT_ZERO_64 = "0" * 64
SHA = "a" * 64
PHASH = "b" * 16


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
        "composition": [
            {"layer": L, "quad": Q, "tileIndex": 0, "hflip": False, "vflip": False, "paletteIndex": 0}
            for L in (0, 1) for Q in (0, 1, 2, 3)
        ],
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


def _cell(idx: int) -> dict:
    return {"tilesetSlug": "test-frlg-primary-p", "metatileIndex": idx}


def _pattern(cells: list[int], frequency: int) -> dict:
    return {
        "shape": "3x3",
        "width": 3,
        "height": 3,
        "cells": [_cell(c) for c in cells],
        "frequency": frequency,
    }


def _corpus_with_patterns(source: str, patterns: list[dict]) -> dict:
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": source,
        "toolingVersion": "8C-4-test",
        "tilesets": [_tileset("test-frlg-primary-p", 4)],
        "mapAdjacencies": [
            {
                "mapSlug": "test-map-1",
                "primaryTilesetSlug": "test-frlg-primary-p",
                "secondaryTilesetSlug": "test-frlg-primary-p",
                "width": 5,
                "height": 5,
                "observations": [],
                "patterns": patterns,
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


def test_ingest_persists_patterns(factory):
    pat_a = _pattern([0, 1, 2, 0, 0, 0, 3, 3, 3], frequency=5)
    pat_b = _pattern([1, 1, 1, 1, 1, 1, 1, 1, 1], frequency=10)
    corpus = _corpus_with_patterns("pret-firered", [pat_a, pat_b])
    report = ingest_corpus(factory, IRCorpus.model_validate(corpus))
    assert report.adjacency_patterns_upserted == 2
    with factory.session() as session:
        rows = session.query(AdjacencyPattern).all()
        assert len(rows) == 2
        # Both rows have source_corpus = 'pret-firered'.
        assert all(r.source_corpus == "pret-firered" for r in rows)


def test_ingest_aggregates_same_pattern_across_maps(factory):
    pat = _pattern([0, 1, 2, 0, 0, 0, 3, 3, 3], frequency=5)
    corpus = _corpus_with_patterns("pret-firered", [pat])
    # Add a second map with the SAME pattern but frequency 3.
    corpus["mapAdjacencies"].append({
        "mapSlug": "test-map-2",
        "primaryTilesetSlug": "test-frlg-primary-p",
        "secondaryTilesetSlug": "test-frlg-primary-p",
        "width": 5,
        "height": 5,
        "observations": [],
        "patterns": [{"shape": "3x3", "width": 3, "height": 3, "cells": pat["cells"], "frequency": 3}],
    })
    ingest_corpus(factory, IRCorpus.model_validate(corpus))
    with factory.session() as session:
        rows = session.query(AdjacencyPattern).all()
        # Same pattern_hash → one row, total frequency = 5 + 3 = 8
        assert len(rows) == 1
        assert rows[0].frequency == 8


def test_ingest_is_idempotent_for_patterns(factory):
    pat = _pattern([0, 1, 2, 0, 0, 0, 3, 3, 3], frequency=5)
    corpus = _corpus_with_patterns("pret-firered", [pat])
    ingest_corpus(factory, IRCorpus.model_validate(corpus))
    ingest_corpus(factory, IRCorpus.model_validate(corpus))  # re-run
    with factory.session() as session:
        rows = session.query(AdjacencyPattern).all()
        # Re-run replaces, doesn't double.
        assert len(rows) == 1
        assert rows[0].frequency == 5


def test_two_sources_coexist(factory):
    pat = _pattern([0, 1, 2, 0, 0, 0, 3, 3, 3], frequency=5)
    ingest_corpus(factory, IRCorpus.model_validate(_corpus_with_patterns("pret-firered", [pat])))
    # Same pattern from a different source (pretend it's emerald):
    em_corpus = _corpus_with_patterns("pret-emerald", [pat])
    em_corpus["tilesets"][0]["family"] = "rse"
    em_corpus["tilesets"][0]["slug"] = "test-rse-primary-p"
    em_corpus["mapAdjacencies"][0]["primaryTilesetSlug"] = "test-rse-primary-p"
    em_corpus["mapAdjacencies"][0]["secondaryTilesetSlug"] = "test-rse-primary-p"
    em_corpus["mapAdjacencies"][0]["patterns"][0]["cells"] = [
        {"tilesetSlug": "test-rse-primary-p", "metatileIndex": c}
        for c in [0, 1, 2, 0, 0, 0, 3, 3, 3]
    ]
    ingest_corpus(factory, IRCorpus.model_validate(em_corpus))
    with factory.session() as session:
        rows = session.query(AdjacencyPattern).all()
        # Different tilesetSlug → different pattern_hash → 2 rows.
        sources = sorted(r.source_corpus for r in rows)
        assert sources == ["pret-emerald", "pret-firered"]


def test_http_patterns_endpoint_filters_by_min_frequency(client):
    rare = _pattern([0, 1, 2, 0, 0, 0, 3, 3, 3], frequency=1)
    common = _pattern([1, 1, 1, 1, 1, 1, 1, 1, 1], frequency=20)
    client.post("/v1/ingest/json-corpus", json={"corpus": _corpus_with_patterns("pret-firered", [rare, common])})
    response = client.get("/v1/rules/patterns", params={"min_frequency": 5})
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["patterns"]) == 1
    assert body["patterns"][0]["total_frequency"] == 20


def test_http_patterns_endpoint_aggregates_across_sources(client):
    # Same conceptual pattern but cells reference different tileset slugs,
    # so they aggregate via the pattern_hash function only when slugs match.
    # Use the same slug to force aggregation.
    pat = _pattern([0, 1, 2, 0, 0, 0, 3, 3, 3], frequency=3)
    # Both sources reference 'test-frlg-primary-p' (a tileset that
    # legitimately appears in both for the test).
    client.post("/v1/ingest/json-corpus", json={"corpus": _corpus_with_patterns("pret-firered", [pat])})
    second = _corpus_with_patterns("cfru", [pat])
    second["tilesets"][0]["source"] = "cfru"
    client.post("/v1/ingest/json-corpus", json={"corpus": second})
    response = client.get("/v1/rules/patterns", params={"min_frequency": 5})
    assert response.status_code == 200, response.text
    body = response.json()
    # 3 + 3 = 6 ≥ 5, aggregated.
    assert len(body["patterns"]) == 1
    assert body["patterns"][0]["total_frequency"] == 6
    assert set(body["patterns"][0]["source_corpora"]) == {"pret-firered", "cfru"}


def test_http_patterns_endpoint_default_threshold(client):
    pat3 = _pattern([0, 0, 0, 0, 0, 0, 0, 0, 0], frequency=3)
    pat7 = _pattern([1, 1, 1, 1, 1, 1, 1, 1, 1], frequency=7)
    client.post("/v1/ingest/json-corpus", json={"corpus": _corpus_with_patterns("pret-firered", [pat3, pat7])})
    response = client.get("/v1/rules/patterns")
    assert response.status_code == 200
    body = response.json()
    # Default min_frequency = 5 - pat3 excluded.
    freqs = [p["total_frequency"] for p in body["patterns"]]
    assert freqs == [7]


def test_corpus_without_patterns_field_still_ingests(client):
    """Older corpora (pre-8C-4) don't carry patterns; ingest must not break."""
    corpus = _corpus_with_patterns("pret-firered", [])
    # Strip the patterns key entirely.
    del corpus["mapAdjacencies"][0]["patterns"]
    response = client.post("/v1/ingest/json-corpus", json={"corpus": corpus})
    assert response.status_code == 200
    body = response.json()
    assert body["adjacency_patterns_upserted"] == 0
