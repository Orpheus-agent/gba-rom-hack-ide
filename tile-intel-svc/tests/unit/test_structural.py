"""Phase 8C-2 - Structural heuristic tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import Metatile, MetatileTag, TagTaxonomy
from tile_intel.features.structural import classify_layer1_overlay, classify_metatile
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.ingest.ontology import seed_ontology
from tile_intel.ingest.structural_tags import apply_structural_tags
from tile_intel.storage.base import make_inmemory_factory


def _slot(layer: int, quad: int, tile_index: int, hflip: bool = False, vflip: bool = False, palette: int = 0) -> dict:
    return {
        "layer": layer,
        "quad": quad,
        "tileIndex": tile_index,
        "hflip": hflip,
        "vflip": vflip,
        "paletteIndex": palette,
    }


def _uniform(tile_index: int = 7) -> list[dict]:
    """All 4 layer-0 quads identical → filler."""
    return [
        _slot(0, 0, tile_index),
        _slot(0, 1, tile_index),
        _slot(0, 2, tile_index),
        _slot(0, 3, tile_index),
        _slot(1, 0, 0),
        _slot(1, 1, 0),
        _slot(1, 2, 0),
        _slot(1, 3, 0),
    ]


def _horizontal_stripe() -> list[dict]:
    """NW == NE, SW == SE, two pairs → edge."""
    return [
        _slot(0, 0, 5),
        _slot(0, 1, 5),
        _slot(0, 2, 6),
        _slot(0, 3, 6),
        _slot(1, 0, 0),
        _slot(1, 1, 0),
        _slot(1, 2, 0),
        _slot(1, 3, 0),
    ]


def _three_same_one_ne() -> list[dict]:
    """NW=SW=SE differ from NE → corner_ne."""
    return [
        _slot(0, 0, 5),
        _slot(0, 1, 9),  # NE differs
        _slot(0, 2, 5),
        _slot(0, 3, 5),
        _slot(1, 0, 0),
        _slot(1, 1, 0),
        _slot(1, 2, 0),
        _slot(1, 3, 0),
    ]


def _all_different() -> list[dict]:
    return [
        _slot(0, 0, 1),
        _slot(0, 1, 2),
        _slot(0, 2, 3),
        _slot(0, 3, 4),
        _slot(1, 0, 0),
        _slot(1, 1, 0),
        _slot(1, 2, 0),
        _slot(1, 3, 0),
    ]


def _with_overlay() -> list[dict]:
    """Filler base + nonzero layer-1 → overlay detected."""
    return [
        _slot(0, 0, 5),
        _slot(0, 1, 5),
        _slot(0, 2, 5),
        _slot(0, 3, 5),
        _slot(1, 0, 12),  # overlay
        _slot(1, 1, 0),
        _slot(1, 2, 0),
        _slot(1, 3, 0),
    ]


# ---------------------------------------------------------------------------
# Pure-function tests
# ---------------------------------------------------------------------------


def test_uniform_quads_tagged_filler():
    tags = classify_metatile(_uniform())
    assert any(t.slug == "structure.filler" for t in tags)
    assert all(0 < t.confidence <= 1.0 for t in tags)


def test_horizontal_stripe_tagged_edge():
    tags = classify_metatile(_horizontal_stripe())
    slugs = {t.slug for t in tags}
    assert "structure.edge" in slugs


def test_three_same_one_ne_tagged_corner_ne():
    tags = classify_metatile(_three_same_one_ne())
    assert any(t.slug == "structure.corner_ne" for t in tags)


def test_all_different_tagged_anchor():
    tags = classify_metatile(_all_different())
    assert any(t.slug == "structure.anchor" for t in tags)


def test_overlay_detection():
    assert classify_layer1_overlay(_with_overlay()) is True
    assert classify_layer1_overlay(_uniform()) is False


# ---------------------------------------------------------------------------
# DB-applying tests
# ---------------------------------------------------------------------------


REPEAT_ZERO_64 = "0" * 64
SHA = "a" * 64
PHASH = "b" * 16


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
        "pixelBytesHex": "0" * 128,
        "pixelHashHex": SHA,
        "paletteNeutralHashHex": SHA,
        "phashHex": PHASH,
        "isBlank": True,
        "isHorizontallySymmetric": True,
        "isVerticallySymmetric": True,
    }


def _metatile(idx: int, composition: list[dict]) -> dict:
    return {
        "metatileIndex": idx,
        "attrRawHex": "00000000",
        "behaviorId": 0,
        "terrainType": 0,
        "encounterType": 0,
        "layerType": 0,
        "composition": composition,
        "renderedHashHex": SHA,
        "phashHex": PHASH,
    }


def _corpus(metatile_compositions: list[list[dict]]) -> dict:
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": "pret-firered",
        "toolingVersion": "8C-2-test",
        "tilesets": [
            {
                "slug": "test-frlg-primary-y",
                "displayName": "Test",
                "source": "pret-firered",
                "sourceCommit": "abcdef0123",
                "attribution": "pret (MIT)",
                "licenseSpdx": "MIT",
                "family": "frlg",
                "isSecondary": False,
                "isCompressed": True,
                "tileCount": 1,
                "metatileCount": len(metatile_compositions),
                "palettes": [_palette()],
                "tiles": [_tile()],
                "metatiles": [_metatile(i, c) for i, c in enumerate(metatile_compositions)],
            }
        ],
        "mapAdjacencies": [],
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


def test_apply_structural_emits_tags_for_known_compositions(factory):
    payload = _corpus(
        [
            _uniform(),  # → structure.filler
            _horizontal_stripe(),  # → structure.edge + structure.repeating
            _three_same_one_ne(),  # → structure.corner_ne
            _all_different(),  # → structure.anchor
        ]
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)  # taxonomy must be in place first
    report = apply_structural_tags(factory)
    assert report.metatiles_examined == 4
    assert report.tags_emitted >= 4
    with factory.session() as session:
        rows = (
            session.query(TagTaxonomy.slug)
            .join(MetatileTag, TagTaxonomy.id == MetatileTag.tag_id)
            .filter(MetatileTag.source == "heuristic")
            .all()
        )
        slugs = {r[0] for r in rows}
        assert "structure.filler" in slugs
        assert "structure.edge" in slugs
        assert "structure.corner_ne" in slugs
        assert "structure.anchor" in slugs


def test_apply_structural_is_idempotent(factory):
    payload = _corpus([_uniform()])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    apply_structural_tags(factory)
    first_count = factory.session().__enter__().query(MetatileTag).filter_by(
        source="heuristic"
    ).count()
    apply_structural_tags(factory)
    second_count = (
        factory.session().__enter__().query(MetatileTag).filter_by(source="heuristic").count()
    )
    assert first_count == second_count


def test_apply_structural_preserves_behavior_inference_tags(factory):
    payload = _corpus([_uniform()])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    # behavior_id=0 is MB_NORMAL → terrain.dirt + traversal.walkable.
    inferred_before = factory.session().__enter__().query(MetatileTag).filter_by(
        source="behavior_inference"
    ).count()
    assert inferred_before >= 2
    apply_structural_tags(factory)
    inferred_after = factory.session().__enter__().query(MetatileTag).filter_by(
        source="behavior_inference"
    ).count()
    assert inferred_after == inferred_before


def test_overlay_metatile_gets_anchor_tag(factory):
    payload = _corpus([_with_overlay()])
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    seed_ontology(factory)
    apply_structural_tags(factory)
    with factory.session() as session:
        # The uniform base would tag filler; the overlay adds a weak
        # anchor signal.
        mt = session.query(Metatile).one()
        heuristic_slugs = {
            tt.slug
            for tt in session.query(TagTaxonomy)
            .join(MetatileTag, TagTaxonomy.id == MetatileTag.tag_id)
            .filter(MetatileTag.metatile_id == mt.id, MetatileTag.source == "heuristic")
            .all()
        }
        assert "structure.filler" in heuristic_slugs
        assert "structure.anchor" in heuristic_slugs


def test_http_seed_structural_endpoint(client):
    response = client.post(
        "/v1/ingest/json-corpus",
        json={"corpus": _corpus([_uniform(), _horizontal_stripe()])},
    )
    assert response.status_code == 200, response.text
    response = client.post("/v1/seed/ontology")
    assert response.status_code == 200
    response = client.post("/v1/seed/structural")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["metatiles_examined"] == 2
    assert body["tags_emitted"] >= 2
