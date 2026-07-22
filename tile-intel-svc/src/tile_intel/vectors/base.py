"""Phase 8A-5 - Vector store protocol + in-memory test fake.

Embedding writes + similarity queries cross this protocol. Phase
8D-1 fills in the real Qdrant-backed implementation; tests use the
in-memory cosine-similarity fake here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class VectorRecord:
    """One stored vector + its payload metadata."""

    uuid: str
    vector: tuple[float, ...]
    payload: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class SimilaritySearchHit:
    """One result from a similarity query."""

    uuid: str
    score: float
    payload: dict[str, object]


class VectorStore(Protocol):
    """Phase 8 vector store contract. Operations are intentionally
    minimal at this slice - embedding writes + similarity queries.
    Phase 8D adds batch upsert + filtered search."""

    def upsert(self, collection: str, record: VectorRecord) -> None: ...
    def search(
        self,
        collection: str,
        query_vector: tuple[float, ...],
        limit: int = 12,
    ) -> list[SimilaritySearchHit]: ...
    def count(self, collection: str) -> int: ...
    def clear(self, collection: str) -> None: ...


def cosine_similarity(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    """Standard cosine. Returns 1.0 for identical vectors, -1.0 for
    opposite. Used by the in-memory store + as a reference for the
    Qdrant-backed impl in 8D-1."""
    if len(a) != len(b):
        raise ValueError(f"vector length mismatch: {len(a)} vs {len(b)}")
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


class InMemoryVectorStore:
    """Linear-scan, brute-force, deterministic. Suitable for unit
    tests + small corpora. The plan's full Phase 8 stack uses Qdrant
    for production; this is here so the storage protocol has at
    least one working backend before 8D-1 lands."""

    def __init__(self) -> None:
        self._collections: dict[str, dict[str, VectorRecord]] = {}

    def upsert(self, collection: str, record: VectorRecord) -> None:
        self._collections.setdefault(collection, {})[record.uuid] = record

    def search(
        self,
        collection: str,
        query_vector: tuple[float, ...],
        limit: int = 12,
    ) -> list[SimilaritySearchHit]:
        items = self._collections.get(collection, {})
        scored = [
            SimilaritySearchHit(
                uuid=rec.uuid,
                score=cosine_similarity(query_vector, rec.vector),
                payload=dict(rec.payload),
            )
            for rec in items.values()
        ]
        scored.sort(key=lambda h: h.score, reverse=True)
        return scored[:limit]

    def count(self, collection: str) -> int:
        return len(self._collections.get(collection, {}))

    def clear(self, collection: str) -> None:
        self._collections.pop(collection, None)
