"""Phase 8B-2 - Ingest endpoint + idempotence tests.

Uses an in-process FastAPI TestClient + SQLite-in-memory storage so
the suite stays Docker-free.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import (
    AdjacencyObservation,
    Metatile,
    Palette,
    Tile,
    Tileset,
)
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.storage.base import make_inmemory_factory

# ---------------------------------------------------------------------------
# Fixtures
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


def _palette(idx: int) -> dict:
    return {
        "paletteIndex": idx,
        "bgr555Hex": REPEAT_ZERO_64,
        "medianCut5": ["#000000"],
        "dominantHue": None,
        "luminanceAvg": 0,
    }


def _tile(idx: int) -> dict:
    return {
        "tileIndex": idx,
        "pixelBytesHex": PIXELS,
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


def _tileset(slug: str, num_tiles: int = 1, num_metatiles: int = 1) -> dict:
    return {
        "slug": slug,
        "displayName": slug.replace("-", " ").title(),
        "source": "pret-firered",
        "sourceCommit": "abcdef0123",
        "attribution": "pret/pokefirered (MIT)",
        "licenseSpdx": "MIT",
        "family": "frlg",
        "isSecondary": False,
        "isCompressed": True,
        "tileCount": num_tiles,
        "metatileCount": num_metatiles,
        "palettes": [_palette(0)],
        "tiles": [_tile(i) for i in range(num_tiles)],
        "metatiles": [_metatile(i) for i in range(num_metatiles)],
    }


def _corpus(tilesets: list[dict] | None = None, maps: list[dict] | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": "pret-firered",
        "toolingVersion": "8B-2-test",
        "tilesets": tilesets or [_tileset("test-frlg-primary-x", 2, 2)],
        "mapAdjacencies": maps or [],
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
# Direct ingest_corpus() tests - no HTTP layer.
# ---------------------------------------------------------------------------


def test_ingest_one_tileset_creates_all_rows(factory):
    corpus = IRCorpus.model_validate(_corpus())
    report = ingest_corpus(factory, corpus)
    assert report.tilesets_upserted == 1
    assert report.tiles_upserted == 2
    assert report.metatiles_upserted == 2
    assert report.palettes_upserted == 1
    assert report.skipped == 0
    with factory.session() as session:
        assert session.query(Tileset).count() == 1
        assert session.query(Tile).count() == 2
        assert session.query(Metatile).count() == 2
        assert session.query(Palette).count() == 1


def test_ingest_is_idempotent_when_re_run(factory):
    payload = _corpus()
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    # Second run shouldn't double the rows.
    with factory.session() as session:
        assert session.query(Tileset).count() == 1
        assert session.query(Tile).count() == 2
        assert session.query(Metatile).count() == 2


def test_ingest_adjacency_observations(factory):
    ts = _tileset("test-frlg-secondary-y", num_tiles=1, num_metatiles=3)
    ts["isSecondary"] = True
    payload = _corpus(
        tilesets=[
            _tileset("test-frlg-primary-x", num_tiles=1, num_metatiles=2),
            ts,
        ],
        maps=[
            {
                "mapSlug": "test-map-1",
                "primaryTilesetSlug": "test-frlg-primary-x",
                "secondaryTilesetSlug": "test-frlg-secondary-y",
                "width": 4,
                "height": 4,
                "observations": [
                    {
                        "tilesetSlugA": "test-frlg-primary-x",
                        "metatileIndexA": 0,
                        "tilesetSlugB": "test-frlg-primary-x",
                        "metatileIndexB": 1,
                        "direction": 2,
                        "frequency": 5,
                    },
                    {
                        "tilesetSlugA": "test-frlg-primary-x",
                        "metatileIndexA": 1,
                        "tilesetSlugB": "test-frlg-secondary-y",
                        "metatileIndexB": 2,
                        "direction": 4,
                        "frequency": 3,
                    },
                ],
            }
        ],
    )
    report = ingest_corpus(factory, IRCorpus.model_validate(payload))
    assert report.adjacency_observations_upserted == 2
    with factory.session() as session:
        assert session.query(AdjacencyObservation).count() == 2


def test_ingest_replaces_observations_on_rerun(factory):
    payload = _corpus(
        tilesets=[_tileset("test-frlg-primary-x", num_tiles=1, num_metatiles=2)],
        maps=[
            {
                "mapSlug": "test-map-rerun",
                "primaryTilesetSlug": "test-frlg-primary-x",
                "secondaryTilesetSlug": "test-frlg-primary-x",
                "width": 2,
                "height": 2,
                "observations": [
                    {
                        "tilesetSlugA": "test-frlg-primary-x",
                        "metatileIndexA": 0,
                        "tilesetSlugB": "test-frlg-primary-x",
                        "metatileIndexB": 1,
                        "direction": 2,
                        "frequency": 1,
                    }
                ],
            }
        ],
    )
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    # Second run with different frequency for the same (a, b, dir).
    payload["mapAdjacencies"][0]["observations"][0]["frequency"] = 99
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    with factory.session() as session:
        rows = session.query(AdjacencyObservation).all()
        assert len(rows) == 1
        assert rows[0].frequency == 99


# ---------------------------------------------------------------------------
# HTTP layer tests - exercise the FastAPI route + dependency override.
# ---------------------------------------------------------------------------


def test_http_post_inline_corpus(client):
    response = client.post("/v1/ingest/json-corpus", json={"corpus": _corpus()})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tilesets_upserted"] == 1
    assert body["tiles_upserted"] == 2
    assert body["metatiles_upserted"] == 2


def test_http_post_path_loads_from_disk(client, tmp_path: Path):
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps(_corpus()), encoding="utf-8")
    response = client.post("/v1/ingest/json-corpus", json={"path": str(path)})
    assert response.status_code == 200, response.text
    assert response.json()["tilesets_upserted"] == 1


def test_http_post_missing_payload_400(client):
    response = client.post("/v1/ingest/json-corpus", json={})
    assert response.status_code == 400


def test_http_post_both_path_and_corpus_400(client, tmp_path: Path):
    path = tmp_path / "x.json"
    path.write_text(json.dumps(_corpus()), encoding="utf-8")
    response = client.post(
        "/v1/ingest/json-corpus",
        json={"path": str(path), "corpus": _corpus()},
    )
    assert response.status_code == 400


def test_http_post_nonexistent_path_404(client):
    response = client.post(
        "/v1/ingest/json-corpus",
        json={"path": "C:/this/path/does/not/exist.json"},
    )
    assert response.status_code == 404


def test_http_post_invalid_corpus_400(client):
    bad = _corpus()
    bad["schemaVersion"] = 99  # not a literal of 1
    response = client.post("/v1/ingest/json-corpus", json={"corpus": bad})
    assert response.status_code == 400


def test_http_post_invalid_json_at_path_400(client, tmp_path: Path):
    path = tmp_path / "broken.json"
    path.write_text("this is not json", encoding="utf-8")
    response = client.post("/v1/ingest/json-corpus", json={"path": str(path)})
    assert response.status_code == 400


def test_http_health_still_works(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True
