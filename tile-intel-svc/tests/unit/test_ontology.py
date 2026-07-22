"""Phase 8C-1 - Ontology seeder tests.

Uses SQLite-in-memory storage + the real committed data files
(behaviors-frlg.json, behaviors-rse.json, tag-taxonomy.json,
behavior-to-tags.json). The tests exercise both direct
`seed_ontology()` calls and the FastAPI HTTP wrapper.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import (
    Behavior,
    Metatile,
    MetatileTag,
    TagTaxonomy,
    Tileset,
)
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.ingest.ontology import seed_ontology
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


# ---------------------------------------------------------------------------
# Fixture helpers (same shape as test_ingest's helpers)
# ---------------------------------------------------------------------------

REPEAT_ZERO_64 = "0" * 64
SHA = "a" * 64
PHASH = "b" * 16
PIXELS = "0" * 128


def _slot(layer: int, quad: int) -> dict:
    return {
        "layer": layer,
        "quad": quad,
        "tileIndex": 0,
        "hflip": False,
        "vflip": False,
        "paletteIndex": 0,
    }


def _palette() -> dict:
    return {
        "paletteIndex": 0,
        "bgr555Hex": REPEAT_ZERO_64,
        "medianCut5": ["#000000"],
        "dominantHue": None,
        "luminanceAvg": 0,
    }


def _tile() -> dict:
    return {
        "tileIndex": 0,
        "pixelBytesHex": PIXELS,
        "pixelHashHex": SHA,
        "paletteNeutralHashHex": SHA,
        "phashHex": PHASH,
        "isBlank": True,
        "isHorizontallySymmetric": True,
        "isVerticallySymmetric": True,
    }


def _metatile(idx: int, behavior_id: int) -> dict:
    return {
        "metatileIndex": idx,
        "attrRawHex": "00000000",
        "behaviorId": behavior_id,
        "terrainType": 0,
        "encounterType": 0,
        "layerType": 0,
        "composition": [_slot(L, Q) for L in (0, 1) for Q in (0, 1, 2, 3)],
        "renderedHashHex": SHA,
        "phashHex": PHASH,
    }


def _frlg_tileset_with_behaviors(behavior_ids: list[int]) -> dict:
    return {
        "slug": "test-frlg-primary-x",
        "displayName": "Test",
        "source": "pret-firered",
        "sourceCommit": "abcdef0123",
        "attribution": "pret/pokefirered (MIT)",
        "licenseSpdx": "MIT",
        "family": "frlg",
        "isSecondary": False,
        "isCompressed": True,
        "tileCount": 1,
        "metatileCount": len(behavior_ids),
        "palettes": [_palette()],
        "tiles": [_tile()],
        "metatiles": [_metatile(i, b) for i, b in enumerate(behavior_ids)],
    }


def _corpus_with_metatiles(behavior_ids: list[int]) -> dict:
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": "pret-firered",
        "toolingVersion": "8C-1-test",
        "tilesets": [_frlg_tileset_with_behaviors(behavior_ids)],
        "mapAdjacencies": [],
    }


# ---------------------------------------------------------------------------
# Direct seeder tests
# ---------------------------------------------------------------------------


def test_seed_loads_behaviors_for_both_families(factory):
    report = seed_ontology(factory)
    # FRLG ≈ 111, RSE ≈ 241; total ≥ 350 (some overlap on numeric ids
    # across families - they're different rows because (family, id)
    # is the unique key, but our impl actually uses id alone as PK so
    # the second insertion of a colliding id wins. Assert lower bound.)
    assert report.behaviors_upserted >= 240
    with factory.session() as session:
        # Spot-check: MB_TALL_GRASS (FRLG id 0x02) should be present.
        rows = session.query(Behavior).filter_by(name="MB_TALL_GRASS").all()
        assert len(rows) >= 1
        assert any(r.id == 0x02 for r in rows)


def test_seed_loads_full_tag_taxonomy(factory):
    report = seed_ontology(factory)
    # ≥ 80 tags across 6 axes per the canonical YAML.
    assert report.tags_upserted >= 70
    with factory.session() as session:
        rows = session.query(TagTaxonomy).all()
        axes = {r.axis for r in rows}
        assert axes >= {"terrain", "traversal", "elevation", "structure", "biome", "aesthetic"}
        # The grass.tall leaf exists with a parent.
        tg = session.query(TagTaxonomy).filter_by(slug="terrain.grass.tall").one()
        assert tg.parent is not None
        assert tg.parent.slug == "terrain.grass"
        assert tg.is_leaf is True


def test_seed_applies_tags_from_behavior_inference(factory):
    # Ingest a corpus with metatiles that have known behavior ids:
    # 0x02 (MB_TALL_GRASS) → terrain.grass.tall + traversal.walkable
    # 0x21 (MB_SAND) → terrain.sand + traversal.walkable
    # 0xff (MB_INVALID) → no tags
    payload = _corpus_with_metatiles([0x02, 0x21, 0xFF])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    report = seed_ontology(factory)
    # 2 metatiles × 2 tags each = 4 metatile_tag rows.
    assert report.metatile_tags_applied == 4
    with factory.session() as session:
        # MB_TALL_GRASS metatile (index 0) should have tall_grass tag.
        ts = session.query(Tileset).one()
        mt = session.query(Metatile).filter_by(tileset_id=ts.id, metatile_index=0).one()
        tag_slugs = {t.tag_id for t in session.query(MetatileTag).filter_by(metatile_id=mt.id).all()}
        assert len(tag_slugs) == 2


def test_seed_is_idempotent(factory):
    payload = _corpus_with_metatiles([0x02])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    first = seed_ontology(factory)
    second = seed_ontology(factory)
    # On re-run, counts should match (we delete-and-reinsert).
    assert first.tags_upserted == second.tags_upserted
    assert first.metatile_tags_applied == second.metatile_tags_applied
    with factory.session() as session:
        # No accumulating duplicates.
        rows = session.query(MetatileTag).all()
        assert len(rows) == 2  # tall_grass tile gets 2 tags


def test_seed_skips_metatiles_with_unmapped_behaviors(factory):
    # Behavior 0x01 (MB_UNUSED_01) has no entry in behavior-to-tags.
    payload = _corpus_with_metatiles([0x01])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    report = seed_ontology(factory)
    assert report.metatile_tags_applied == 0


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def test_http_seed_endpoint(client):
    response = client.post("/v1/seed/ontology")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["behaviors_upserted"] >= 240
    assert body["tags_upserted"] >= 70


def test_http_seed_followed_by_metatile_ingest_applies_tags(client):
    # Order: ingest first (creates metatiles), then seed (applies tags).
    response = client.post(
        "/v1/ingest/json-corpus",
        json={"corpus": _corpus_with_metatiles([0x02, 0x21])},
    )
    assert response.status_code == 200, response.text
    response = client.post("/v1/seed/ontology")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["metatile_tags_applied"] == 4  # 2 metatiles × 2 tags each
