"""Phase 8D-2 - Tileset + map aggregate embeddings tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tile_intel.api.embeddings import get_embedder, get_vector_store
from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import EmbeddingsLookup, Tileset
from tile_intel.embeddings import HashEmbedder
from tile_intel.embeddings.aggregate import (
    build_aggregate_embeddings,
    search_similar_maps,
    search_similar_tilesets,
)
from tile_intel.embeddings.base import (
    MAPS_COLLECTION,
    TILESETS_COLLECTION,
)
from tile_intel.ingest.embeddings import embed_metatiles_pipeline
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.storage.base import make_inmemory_factory
from tile_intel.vectors.base import InMemoryVectorStore

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


def _tile(idx: int, fill_byte: str = "01") -> dict:
    return {
        "tileIndex": idx,
        "pixelBytesHex": fill_byte * 64,
        "pixelHashHex": SHA,
        "paletteNeutralHashHex": SHA,
        "phashHex": PHASH,
        "isBlank": False,
        "isHorizontallySymmetric": True,
        "isVerticallySymmetric": True,
    }


def _metatile(idx: int, tile_index: int = 0) -> dict:
    return {
        "metatileIndex": idx,
        "attrRawHex": "00000000",
        "behaviorId": 0,
        "terrainType": 0,
        "encounterType": 0,
        "layerType": 0,
        "composition": [
            {
                "layer": L,
                "quad": Q,
                "tileIndex": tile_index,
                "hflip": False,
                "vflip": False,
                "paletteIndex": 0,
            }
            for L in (0, 1)
            for Q in (0, 1, 2, 3)
        ],
        "renderedHashHex": SHA,
        "phashHex": PHASH,
    }


def _tileset(slug: str, num_metatiles: int, fill_byte: str = "01") -> dict:
    return {
        "slug": slug,
        "displayName": slug,
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
        "tiles": [_tile(0, fill_byte)],
        "metatiles": [_metatile(i) for i in range(num_metatiles)],
    }


def _obs(slug: str, a: int, b: int, direction: int, freq: int) -> dict:
    return {
        "tilesetSlugA": slug,
        "metatileIndexA": a,
        "tilesetSlugB": slug,
        "metatileIndexB": b,
        "direction": direction,
        "frequency": freq,
    }


def _corpus_with_maps(slug_a: str, slug_b: str | None = None) -> dict:
    tilesets = [_tileset(slug_a, 3, fill_byte="01")]
    maps = [
        {
            "mapSlug": "map-1",
            "primaryTilesetSlug": slug_a,
            "secondaryTilesetSlug": slug_a,
            "width": 4,
            "height": 4,
            "observations": [_obs(slug_a, 0, 1, 2, 5), _obs(slug_a, 1, 2, 2, 5)],
        }
    ]
    if slug_b is not None:
        tilesets.append(_tileset(slug_b, 3, fill_byte="0f"))
        maps.append(
            {
                "mapSlug": "map-2",
                "primaryTilesetSlug": slug_b,
                "secondaryTilesetSlug": slug_b,
                "width": 4,
                "height": 4,
                "observations": [_obs(slug_b, 0, 1, 2, 5)],
            }
        )
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": "pret-firered",
        "toolingVersion": "8D-2-test",
        "tilesets": tilesets,
        "mapAdjacencies": maps,
    }


@pytest.fixture
def factory():
    f = make_inmemory_factory()
    f.create_all()
    yield f
    f.drop_all()


@pytest.fixture
def vector_store():
    return InMemoryVectorStore()


@pytest.fixture
def embedder():
    return HashEmbedder(dim=128)


@pytest.fixture
def client(factory, vector_store, embedder):
    app = create_app(storage_factory=factory)
    app.dependency_overrides[get_vector_store] = lambda: vector_store
    app.dependency_overrides[get_embedder] = lambda: embedder
    return TestClient(app)


def test_build_tileset_and_map_vectors(factory, vector_store, embedder):
    payload = _corpus_with_maps("test-frlg-primary-a", "test-frlg-primary-b")
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    report = build_aggregate_embeddings(factory, vector_store, embedder)
    assert report.tilesets_embedded == 2
    assert report.maps_embedded == 2
    # 2 tileset vectors + 2 map vectors land in Qdrant.
    assert vector_store.count(TILESETS_COLLECTION) == 2
    assert vector_store.count(MAPS_COLLECTION) == 2


def test_aggregate_writes_embeddings_lookup_rows(factory, vector_store, embedder):
    payload = _corpus_with_maps("test-frlg-primary-a", "test-frlg-primary-b")
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    build_aggregate_embeddings(factory, vector_store, embedder)
    with factory.session() as session:
        rows = session.query(EmbeddingsLookup).all()
        kinds = {r.entity_kind for r in rows}
        assert kinds == {"metatile", "tileset", "map"}


def test_aggregate_is_idempotent(factory, vector_store, embedder):
    payload = _corpus_with_maps("test-frlg-primary-a")
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    build_aggregate_embeddings(factory, vector_store, embedder)
    build_aggregate_embeddings(factory, vector_store, embedder)
    with factory.session() as session:
        ts_rows = session.query(EmbeddingsLookup).filter_by(entity_kind="tileset").count()
        map_rows = session.query(EmbeddingsLookup).filter_by(entity_kind="map").count()
        assert ts_rows == 1
        assert map_rows == 1
    # Qdrant upsert by UUID → still single point each.
    assert vector_store.count(TILESETS_COLLECTION) == 1
    assert vector_store.count(MAPS_COLLECTION) == 1


def test_search_similar_tilesets_returns_seed_first(factory, vector_store, embedder):
    payload = _corpus_with_maps("test-frlg-primary-a", "test-frlg-primary-b")
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    build_aggregate_embeddings(factory, vector_store, embedder)
    hits = search_similar_tilesets(
        factory, vector_store, embedder, "test-frlg-primary-a", limit=5
    )
    assert len(hits) >= 1
    assert hits[0]["tileset_slug"] == "test-frlg-primary-a"
    assert hits[0]["score"] == pytest.approx(1.0, rel=1e-4)


def test_search_similar_maps_returns_seed_first(factory, vector_store, embedder):
    payload = _corpus_with_maps("test-frlg-primary-a", "test-frlg-primary-b")
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    build_aggregate_embeddings(factory, vector_store, embedder)
    hits = search_similar_maps(factory, vector_store, embedder, "map-1", limit=5)
    assert len(hits) >= 1
    assert hits[0]["map_slug"] == "map-1"
    assert hits[0]["score"] == pytest.approx(1.0, rel=1e-4)


def test_search_similar_unknown_seed_returns_empty(factory, vector_store, embedder):
    payload = _corpus_with_maps("test-frlg-primary-a")
    ingest_corpus(factory, IRCorpus.model_validate(payload))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    build_aggregate_embeddings(factory, vector_store, embedder)
    assert search_similar_tilesets(factory, vector_store, embedder, "no-such-slug") == []
    assert search_similar_maps(factory, vector_store, embedder, "no-such-map") == []


def test_http_rebuild_endpoint_returns_aggregate_counts(client):
    payload = _corpus_with_maps("test-frlg-primary-a", "test-frlg-primary-b")
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    response = client.post("/v1/embeddings/rebuild", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    # Two tilesets × 3 metatiles each → 6 metatile embeddings; 2 tilesets + 2 maps aggregated.
    assert body["metatiles_embedded"] == 6
    assert body["tilesets_embedded"] == 2
    assert body["maps_embedded"] == 2


def test_http_similar_tileset(client):
    payload = _corpus_with_maps("test-frlg-primary-a", "test-frlg-primary-b")
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    client.post("/v1/embeddings/rebuild", json={})
    response = client.get(
        "/v1/embeddings/similar/tileset",
        params={"tileset_slug": "test-frlg-primary-a", "limit": 5},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["seed_tileset_slug"] == "test-frlg-primary-a"
    assert len(body["hits"]) >= 1
    assert body["hits"][0]["tileset_slug"] == "test-frlg-primary-a"


def test_http_similar_map(client):
    payload = _corpus_with_maps("test-frlg-primary-a", "test-frlg-primary-b")
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    client.post("/v1/embeddings/rebuild", json={})
    response = client.get(
        "/v1/embeddings/similar/map", params={"map_slug": "map-1", "limit": 5}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["seed_map_slug"] == "map-1"
    assert len(body["hits"]) >= 1
    assert body["hits"][0]["map_slug"] == "map-1"


def test_http_similar_validates_limit(client):
    response = client.get(
        "/v1/embeddings/similar/tileset",
        params={"tileset_slug": "anything", "limit": 0},
    )
    assert response.status_code == 400


def test_partial_rebuild_skips_aggregates(client, factory):
    """tileset_id-scoped rebuild should NOT recompute aggregates
    (those are full-corpus). Verify counts stay 0 in that case."""

    payload = _corpus_with_maps("test-frlg-primary-a")
    client.post("/v1/ingest/json-corpus", json={"corpus": payload})
    with factory.session() as session:
        ts_id = session.query(Tileset).first().id
    response = client.post(
        "/v1/embeddings/rebuild", json={"tileset_id": ts_id}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tilesets_embedded"] == 0
    assert body["maps_embedded"] == 0
