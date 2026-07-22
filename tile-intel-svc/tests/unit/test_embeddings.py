"""Phase 8D-1 - Embeddings pipeline tests."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from tile_intel.api.embeddings import get_embedder, get_vector_store
from tile_intel.app import create_app
from tile_intel.domain.ir import IRCorpus
from tile_intel.domain.models import EmbeddingsLookup
from tile_intel.embeddings import HashEmbedder, MetatileRenderingInput
from tile_intel.embeddings.base import METATILES_COLLECTION
from tile_intel.embeddings.render import (
    nearest_upsample_4x,
    render_metatile_rgba,
)
from tile_intel.ingest.embeddings import (
    embed_metatiles_pipeline,
    search_similar_metatiles,
)
from tile_intel.ingest.json_corpus import ingest_corpus
from tile_intel.storage.base import make_inmemory_factory
from tile_intel.vectors.base import InMemoryVectorStore

# ---------------------------------------------------------------------------
# Render primitives
# ---------------------------------------------------------------------------


def test_render_metatile_blank_when_no_tiles():
    """Empty tile lookup → all-zero output (alpha 0)."""

    rgba = render_metatile_rgba([], {}, [[(0, 0, 0, 255)] * 16 for _ in range(16)])
    assert len(rgba) == 16 * 16 * 4
    assert all(b == 0 for b in rgba)


def test_render_metatile_uniform_layer_0():
    """Single solid-color tile filling all 4 layer-0 quads → solid 16×16."""

    # Tile = 64 pixels all using palette index 1.
    tile_pixels = {0: bytes([1] * 64)}
    palettes = [
        [(0, 0, 0, 0)] + [(0xAB, 0xCD, 0xEF, 0xFF)] * 15,  # palette 0 entry 1 = magenta-ish
        *[[(0, 0, 0, 0)] * 16 for _ in range(15)],
    ]
    composition = [
        {"layer": 0, "quad": q, "tileIndex": 0, "hflip": False, "vflip": False, "paletteIndex": 0}
        for q in (0, 1, 2, 3)
    ] + [
        {"layer": 1, "quad": q, "tileIndex": 0, "hflip": False, "vflip": False, "paletteIndex": 0}
        for q in (0, 1, 2, 3)
    ]
    rgba = render_metatile_rgba(composition, tile_pixels, palettes)
    # Every pixel should be the palette[0][1] color (since layer 1
    # quad uses index 1 which is non-transparent).
    for i in range(0, len(rgba), 4):
        assert rgba[i] == 0xAB
        assert rgba[i + 1] == 0xCD
        assert rgba[i + 2] == 0xEF
        assert rgba[i + 3] == 0xFF


def test_render_respects_hflip():
    """Tile with one non-zero pixel at (0, 0); hflip should move it to (7, 0)."""

    pixels = bytearray(64)
    pixels[0] = 2  # only NW corner pixel non-zero
    tile_pixels = {0: bytes(pixels)}
    palettes = [[(0, 0, 0, 0), (1, 1, 1, 0), (5, 5, 5, 0xFF)] + [(0, 0, 0, 0)] * 13] + [
        [(0, 0, 0, 0)] * 16 for _ in range(15)
    ]
    # One layer-0 NW quad, no hflip:
    no_flip = render_metatile_rgba(
        [
            {"layer": 0, "quad": 0, "tileIndex": 0, "hflip": False, "vflip": False, "paletteIndex": 0},
        ],
        tile_pixels,
        palettes,
    )
    # Same composition WITH hflip:
    flipped = render_metatile_rgba(
        [
            {"layer": 0, "quad": 0, "tileIndex": 0, "hflip": True, "vflip": False, "paletteIndex": 0},
        ],
        tile_pixels,
        palettes,
    )
    # No-flip should have non-black at output[0..3] (top-left):
    assert no_flip[0] == 5 and no_flip[3] == 0xFF
    # Flipped should have non-black at output [(0,7)*4 .. (0,7)*4+3] (top-right of NW quad):
    flipped_index = (0 * 16 + 7) * 4
    assert flipped[flipped_index] == 5 and flipped[flipped_index + 3] == 0xFF


def test_nearest_upsample_4x_size():
    rgba = bytes([7] * (16 * 16 * 4))
    upsampled = nearest_upsample_4x(rgba)
    assert len(upsampled) == 64 * 64 * 4
    # All bytes the same - uniform input stays uniform.
    assert upsampled.count(7) == len(upsampled)


def test_nearest_upsample_4x_rejects_bad_length():
    with pytest.raises(ValueError):
        nearest_upsample_4x(b"\x00" * 16)


# ---------------------------------------------------------------------------
# HashEmbedder
# ---------------------------------------------------------------------------


def _input(metatile_id: int, rgba: bytes) -> MetatileRenderingInput:
    return MetatileRenderingInput(
        metatile_id=metatile_id,
        tileset_id=1,
        tileset_slug="test",
        family="frlg",
        behavior_id=0,
        is_walkable=True,
        is_secondary=False,
        rgba_16x16=rgba,
    )


def test_hash_embedder_outputs_dim_and_normalized():
    emb = HashEmbedder(dim=512)
    rgba = bytes([5] * 1024)
    out = emb.embed_metatiles([_input(1, rgba)])
    assert len(out) == 1
    mid, vec = out[0]
    assert mid == 1
    assert len(vec) == 512
    norm = math.sqrt(sum(v * v for v in vec))
    assert norm == pytest.approx(1.0, rel=1e-4)


def test_hash_embedder_identical_inputs_identical_vectors():
    emb = HashEmbedder(dim=128)
    rgba = bytes([3] * 1024)
    [(_, v1)] = emb.embed_metatiles([_input(1, rgba)])
    [(_, v2)] = emb.embed_metatiles([_input(7, rgba)])
    # Same payload → same vector (metatile_id doesn't influence hash).
    assert v1 == v2


def test_hash_embedder_different_inputs_different_vectors():
    emb = HashEmbedder(dim=128)
    [(_, v1)] = emb.embed_metatiles([_input(1, bytes([1] * 1024))])
    [(_, v2)] = emb.embed_metatiles([_input(1, bytes([2] * 1024))])
    assert v1 != v2


def test_hash_embedder_dim_validation():
    with pytest.raises(ValueError):
        HashEmbedder(dim=0)
    with pytest.raises(ValueError):
        HashEmbedder(dim=10_000)


# ---------------------------------------------------------------------------
# Pipeline + DB integration
# ---------------------------------------------------------------------------


REPEAT_ZERO_64 = "0" * 64
SHA = "a" * 64
PHASH = "b" * 16


def _palette(idx: int = 0) -> dict:
    return {
        "paletteIndex": idx,
        "bgr555Hex": REPEAT_ZERO_64,
        "medianCut5": ["#000"],
        "dominantHue": None,
        "luminanceAvg": 0,
    }


def _tile(idx: int) -> dict:
    return {
        "tileIndex": idx,
        "pixelBytesHex": ("01" * 64),  # all pixels index 1
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


def _corpus(num_metatiles: int = 3) -> dict:
    return {
        "schemaVersion": 1,
        "generatedAtUtc": "2026-05-27T00:00:00Z",
        "source": "pret-firered",
        "toolingVersion": "8D-1-test",
        "tilesets": [
            {
                "slug": "test-frlg-primary-e",
                "displayName": "T",
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
                "tiles": [_tile(0)],
                "metatiles": [_metatile(i, tile_index=0) for i in range(num_metatiles)],
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


def test_pipeline_embeds_every_metatile(factory, vector_store, embedder):
    ingest_corpus(factory, IRCorpus.model_validate(_corpus(num_metatiles=3)))
    report = embed_metatiles_pipeline(factory, vector_store, embedder)
    assert report.metatiles_embedded == 3
    assert report.qdrant_points_written == 3
    assert report.embeddings_lookup_rows == 3
    assert report.dim == 128
    assert report.model_id == "hash-sha256-mock"

    with factory.session() as session:
        rows = session.query(EmbeddingsLookup).all()
        assert len(rows) == 3
        assert vector_store.count(METATILES_COLLECTION) == 3


def test_pipeline_is_idempotent(factory, vector_store, embedder):
    ingest_corpus(factory, IRCorpus.model_validate(_corpus(num_metatiles=3)))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    embed_metatiles_pipeline(factory, vector_store, embedder)
    with factory.session() as session:
        # Re-run replaces, doesn't accumulate.
        assert session.query(EmbeddingsLookup).count() == 3
    # Qdrant upserts by UUID - count stays at 3.
    assert vector_store.count(METATILES_COLLECTION) == 3


def test_pipeline_respects_tileset_filter(factory, vector_store, embedder):
    # Two tilesets in the same corpus.
    corpus = _corpus(num_metatiles=2)
    corpus["tilesets"].append(
        {
            "slug": "test-frlg-secondary-q",
            "displayName": "Q",
            "source": "pret-firered",
            "sourceCommit": "abcdef0123",
            "attribution": "pret (MIT)",
            "licenseSpdx": "MIT",
            "family": "frlg",
            "isSecondary": True,
            "isCompressed": True,
            "tileCount": 1,
            "metatileCount": 1,
            "palettes": [_palette()],
            "tiles": [_tile(0)],
            "metatiles": [_metatile(0)],
        }
    )
    ingest_corpus(factory, IRCorpus.model_validate(corpus))
    with factory.session() as session:
        first_ts = session.query(__import__("tile_intel.domain.models", fromlist=["Tileset"]).Tileset).first()
        first_ts_id = first_ts.id
    report = embed_metatiles_pipeline(
        factory, vector_store, embedder, tileset_id=first_ts_id
    )
    # Only the 2 metatiles from the first tileset.
    assert report.metatiles_embedded == 2


def test_search_similar_returns_seed_first(factory, vector_store, embedder):
    ingest_corpus(factory, IRCorpus.model_validate(_corpus(num_metatiles=3)))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    with factory.session() as session:
        from tile_intel.domain.models import Metatile

        seed_id = session.query(Metatile.id).first()[0]
    hits = search_similar_metatiles(factory, vector_store, embedder, seed_id, limit=5)
    # Seed is most-similar to itself.
    assert len(hits) > 0
    assert hits[0]["metatile_id"] == seed_id
    assert hits[0]["score"] == pytest.approx(1.0, rel=1e-4)


def test_search_similar_unknown_seed_returns_empty(factory, vector_store, embedder):
    ingest_corpus(factory, IRCorpus.model_validate(_corpus(num_metatiles=1)))
    embed_metatiles_pipeline(factory, vector_store, embedder)
    hits = search_similar_metatiles(factory, vector_store, embedder, 99999)
    assert hits == []


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def test_http_rebuild_endpoint(client):
    response = client.post(
        "/v1/ingest/json-corpus",
        json={"corpus": _corpus(num_metatiles=2)},
    )
    assert response.status_code == 200, response.text
    response = client.post("/v1/embeddings/rebuild", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["metatiles_embedded"] == 2
    assert body["model_id"] == "hash-sha256-mock"


def test_http_similar_endpoint(client, factory):
    client.post(
        "/v1/ingest/json-corpus",
        json={"corpus": _corpus(num_metatiles=3)},
    )
    client.post("/v1/embeddings/rebuild", json={})
    from tile_intel.domain.models import Metatile

    with factory.session() as session:
        seed_id = session.query(Metatile.id).first()[0]
    response = client.get(
        "/v1/embeddings/similar/metatile",
        params={"metatile_id": seed_id, "limit": 5},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["seed_metatile_id"] == seed_id
    assert body["model_id"] == "hash-sha256-mock"
    assert len(body["hits"]) > 0
    assert body["hits"][0]["metatile_id"] == seed_id


def test_http_similar_limit_validation(client):
    response = client.get(
        "/v1/embeddings/similar/metatile",
        params={"metatile_id": 1, "limit": 0},
    )
    assert response.status_code == 400
