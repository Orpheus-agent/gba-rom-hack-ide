"""Phase 8A-5 - Vector-store protocol + in-memory fake tests.

The Qdrant-backed impl is exercised separately via integration
tests (Docker-gated) - the unit suite uses the in-memory store
which gives deterministic behaviour without a network round-trip.
"""

from __future__ import annotations

import math

import pytest

from tile_intel.vectors.base import (
    InMemoryVectorStore,
    SimilaritySearchHit,
    VectorRecord,
    cosine_similarity,
)


def test_cosine_similarity_identity() -> None:
    a = (1.0, 0.0, 0.0)
    assert cosine_similarity(a, a) == pytest.approx(1.0)


def test_cosine_similarity_orthogonal() -> None:
    assert cosine_similarity((1.0, 0.0), (0.0, 1.0)) == pytest.approx(0.0)


def test_cosine_similarity_opposite() -> None:
    assert cosine_similarity((1.0, 0.0), (-1.0, 0.0)) == pytest.approx(-1.0)


def test_cosine_similarity_zero_norm() -> None:
    # By convention we return 0.0 rather than NaN.
    assert cosine_similarity((0.0, 0.0), (1.0, 1.0)) == 0.0


def test_cosine_similarity_length_mismatch() -> None:
    with pytest.raises(ValueError):
        cosine_similarity((1.0, 0.0), (1.0,))


def test_in_memory_upsert_and_search_orders_by_score() -> None:
    store = InMemoryVectorStore()
    store.upsert(
        "metatiles_v1",
        VectorRecord(uuid="a", vector=(1.0, 0.0), payload={"label": "exact"}),
    )
    store.upsert(
        "metatiles_v1",
        VectorRecord(uuid="b", vector=(0.0, 1.0), payload={"label": "orthogonal"}),
    )
    store.upsert(
        "metatiles_v1",
        VectorRecord(uuid="c", vector=(math.sqrt(0.5), math.sqrt(0.5)), payload={"label": "45deg"}),
    )
    hits = store.search("metatiles_v1", (1.0, 0.0), limit=3)
    assert len(hits) == 3
    assert hits[0].uuid == "a"
    # 45deg sits between exact and orthogonal
    assert hits[1].uuid == "c"
    assert hits[2].uuid == "b"
    assert all(isinstance(h, SimilaritySearchHit) for h in hits)


def test_in_memory_search_respects_limit() -> None:
    store = InMemoryVectorStore()
    for i in range(20):
        store.upsert("x", VectorRecord(uuid=f"v{i}", vector=(float(i), 0.0)))
    assert len(store.search("x", (1.0, 0.0), limit=5)) == 5


def test_in_memory_count_per_collection() -> None:
    store = InMemoryVectorStore()
    store.upsert("a", VectorRecord(uuid="1", vector=(1.0,)))
    store.upsert("a", VectorRecord(uuid="2", vector=(2.0,)))
    store.upsert("b", VectorRecord(uuid="3", vector=(3.0,)))
    assert store.count("a") == 2
    assert store.count("b") == 1
    assert store.count("c") == 0


def test_in_memory_upsert_replaces_existing_uuid() -> None:
    """Upserting the same uuid should replace, not duplicate - the
    Qdrant-backed impl matches this semantics."""
    store = InMemoryVectorStore()
    store.upsert("x", VectorRecord(uuid="1", vector=(1.0,), payload={"v": "old"}))
    store.upsert("x", VectorRecord(uuid="1", vector=(2.0,), payload={"v": "new"}))
    assert store.count("x") == 1
    hits = store.search("x", (1.0,), limit=10)
    assert hits[0].payload == {"v": "new"}


def test_in_memory_clear() -> None:
    store = InMemoryVectorStore()
    store.upsert("z", VectorRecord(uuid="1", vector=(1.0,)))
    assert store.count("z") == 1
    store.clear("z")
    assert store.count("z") == 0
    # Idempotent
    store.clear("z")
    store.clear("never-existed")
