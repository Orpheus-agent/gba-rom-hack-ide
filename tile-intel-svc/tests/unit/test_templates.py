"""Phase 8F-1 - Template extraction tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import Template, TemplateUsage
from tile_intel.grammar import build_templates_from_patterns
from tile_intel.grammar.templates import _summarise_tags
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.ingest.ontology import seed_ontology
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


def _metatile(idx: int, behavior_id: int = 0) -> dict:
    return {
        "metatileIndex": idx,
        "attrRawHex": "00000000",
        "behaviorId": behavior_id,
        "terrainType": 0,
        "encounterType": 0,
        "layerType": 0,
        "composition": [
            {"layer": L, "quad": Q, "tileIndex": 0, "hflip": False, "vflip": False, "paletteIndex": 0}
            for L in (0, 1)
            for Q in (0, 1, 2, 3)
        ],
        "renderedHashHex": SHA,
        "phashHex": PHASH,
    }


def _cell(slug: str, idx: int) -> dict:
    return {"tilesetSlug": slug, "metatileIndex": idx}


def _pattern(slug: str, cell_indices: list[int], frequency: int) -> dict:
    return {
        "shape": "3x3",
        "width": 3,
        "height": 3,
        "cells": [_cell(slug, c) for c in cell_indices],
        "frequency": frequency,
    }


def _corpus(
    source: str,
    metatile_behaviors: list[int],
    patterns: list[dict],
) -> dict:
    slug = "test-frlg-primary-t"
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": source,
        "toolingVersion": "8F-1-test",
        "tilesets": [
            {
                "slug": slug,
                "displayName": slug,
                "source": source,
                "sourceCommit": "abcdef0123",
                "attribution": "pret (MIT)",
                "licenseSpdx": "MIT",
                "family": "frlg",
                "isSecondary": False,
                "isCompressed": True,
                "tileCount": 1,
                "metatileCount": len(metatile_behaviors),
                "palettes": [_palette()],
                "tiles": [_tile()],
                "metatiles": [_metatile(i, b) for i, b in enumerate(metatile_behaviors)],
            }
        ],
        "mapAdjacencies": [
            {
                "mapSlug": "test-map-1",
                "primaryTilesetSlug": slug,
                "secondaryTilesetSlug": slug,
                "width": 4,
                "height": 4,
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


# ---------------------------------------------------------------------------
# Tag-summary heuristic (pure)
# ---------------------------------------------------------------------------


def test_summarise_uniform_tags():
    role, tags = _summarise_tags([["terrain.grass.tall"]] * 9)
    assert role == "uniform_terrain.grass.tall"
    assert tags == {"terrain.grass.tall"}


def test_summarise_two_way_split():
    cells = (
        [["terrain.grass.tall"]] * 5 + [["terrain.dirt"]] * 4
    )
    role, tags = _summarise_tags(cells)
    assert role.startswith("transition_")
    assert tags == {"terrain.grass.tall", "terrain.dirt"}


def test_summarise_majority():
    cells = (
        [["terrain.grass.tall"]] * 7 + [["other.x"]] + [["other.y"]]
    )
    role, tags = _summarise_tags(cells)
    assert role == "majority_terrain.grass.tall"
    assert tags == {"terrain.grass.tall"}


def test_summarise_mixed_when_no_clear_winner():
    # 4 different tags, no majority.
    cells = [
        ["a"], ["a"], ["b"], ["b"], ["c"], ["c"], ["d"], ["d"], ["e"]
    ]
    role, tags = _summarise_tags(cells)
    assert role == "mixed"


def test_summarise_empty_input():
    assert _summarise_tags([])[0] == "mixed"
    assert _summarise_tags([[], [], []])[0] == "mixed"


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def test_build_templates_filters_by_min_frequency(factory):
    """Frequency 2 < threshold 3 → no template emitted."""

    # MB_TALL_GRASS = 0x02 (FRLG); cells reference metatile_index 0
    # which has behaviorId 0x02 → tag terrain.grass.tall + traversal.walkable
    payload = _corpus(
        source="pret-firered",
        metatile_behaviors=[0x02],
        patterns=[_pattern("test-frlg-primary-t", [0] * 9, frequency=2)],
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    report = build_templates_from_patterns(factory, min_global_frequency=3)
    assert report.templates_built == 0
    assert report.patterns_considered == 1


def test_build_templates_uniform_grass(factory):
    payload = _corpus(
        source="pret-firered",
        metatile_behaviors=[0x02],
        patterns=[_pattern("test-frlg-primary-t", [0] * 9, frequency=5)],
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    report = build_templates_from_patterns(factory, min_global_frequency=3)
    assert report.templates_built == 1
    assert report.templates_with_role == 1
    with factory.session() as session:
        t = session.query(Template).one()
        assert t.role.startswith("uniform_")
        # Should mention grass since MB_TALL_GRASS maps to terrain.grass.tall.
        assert any("grass" in tag for tag in t.required_tags)


def test_build_templates_records_usage(factory):
    payload = _corpus(
        source="pret-firered",
        metatile_behaviors=[0x02],
        patterns=[_pattern("test-frlg-primary-t", [0] * 9, frequency=5)],
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    build_templates_from_patterns(factory)
    with factory.session() as session:
        usage = session.query(TemplateUsage).all()
        assert len(usage) == 1
        assert usage[0].occurrence_count == 5
        assert usage[0].map_corpus == "pret-firered"


def test_build_templates_aggregates_across_sources(factory):
    # Same pattern from two sources, frequency 2 each → total 4 → above threshold 3.
    pat = _pattern("test-frlg-primary-t", [0] * 9, frequency=2)
    ingest_corpus(
        factory,
        IRCorpus.model_validate(
            _corpus("pret-firered", [0x02], [pat])
        ),
    )
    ingest_corpus(
        factory,
        IRCorpus.model_validate(
            _corpus("cfru", [0x02], [pat])
        ),
    )
    seed_ontology(factory)
    report = build_templates_from_patterns(factory, min_global_frequency=3)
    assert report.templates_built == 1
    with factory.session() as session:
        # Both source corpora referenced.
        usage_rows = session.query(TemplateUsage).all()
        sources = {u.map_corpus for u in usage_rows}
        assert sources == {"pret-firered", "cfru"}


def test_build_templates_is_idempotent(factory):
    payload = _corpus(
        source="pret-firered",
        metatile_behaviors=[0x02],
        patterns=[_pattern("test-frlg-primary-t", [0] * 9, frequency=5)],
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    build_templates_from_patterns(factory)
    build_templates_from_patterns(factory)
    with factory.session() as session:
        # Re-run replaces, doesn't double.
        assert session.query(Template).count() == 1
        assert session.query(TemplateUsage).count() == 1


def test_build_templates_origin_tileset_id_set(factory):
    payload = _corpus(
        source="pret-firered",
        metatile_behaviors=[0x02],
        patterns=[_pattern("test-frlg-primary-t", [0] * 9, frequency=5)],
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    build_templates_from_patterns(factory)
    with factory.session() as session:
        t = session.query(Template).one()
        assert t.origin_tileset_id is not None


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def test_http_build_templates(client, factory):
    payload = _corpus(
        source="pret-firered",
        metatile_behaviors=[0x02],
        patterns=[_pattern("test-frlg-primary-t", [0] * 9, frequency=5)],
    )
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    client.post("/v1/seed/ontology")
    response = client.post("/v1/grammar/templates/build", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["templates_built"] == 1
    assert body["patterns_considered"] == 1
    assert body["templates_with_role"] == 1


def test_http_list_templates_with_role_filter(client):
    pat_grass = _pattern("test-frlg-primary-t", [0] * 9, frequency=5)
    pat_dirt = _pattern("test-frlg-primary-t", [1] * 9, frequency=5)
    payload = _corpus(
        source="pret-firered",
        metatile_behaviors=[0x02, 0x00],  # tall_grass + dirt
        patterns=[pat_grass, pat_dirt],
    )
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    client.post("/v1/seed/ontology")
    client.post("/v1/grammar/templates/build", json={})
    response = client.get("/v1/grammar/templates", params={"role": "uniform_terrain.grass"})
    assert response.status_code == 200
    body = response.json()
    assert len(body["templates"]) >= 1
    assert all("grass" in t["role"] for t in body["templates"])


def test_http_build_validates_scope(client):
    response = client.post(
        "/v1/grammar/templates/build", json={"scope": "project"}
    )
    assert response.status_code == 400
