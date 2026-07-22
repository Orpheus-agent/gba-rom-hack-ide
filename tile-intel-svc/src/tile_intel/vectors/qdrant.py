"""Phase 8A-5 - Qdrant-backed vector store implementation.

A thin wrapper over `qdrant_client.QdrantClient` that satisfies the
`VectorStore` protocol. Phase 8D-1 will extend this with batch
upsert, filtered search, and HNSW tuning; for now it ships the
minimum API surface the storage protocol promises.

The qdrant collection naming convention mirrors the plan:
`metatiles_v1`, `tiles_v1`, `tilesets_v1`, `maps_v1`. Collections
are auto-created on first upsert when they don't exist.
"""

from __future__ import annotations

from qdrant_client import QdrantClient
from qdrant_client.http.models import Distance, PointStruct, VectorParams

from tile_intel.vectors.base import SimilaritySearchHit, VectorRecord


class QdrantVectorStore:
    """Qdrant-backed `VectorStore` impl."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 16333,
        default_distance: Distance = Distance.COSINE,
    ) -> None:
        self._client = QdrantClient(host=host, port=port)
        self._default_distance = default_distance
        # Collections we've already created in this process - avoids
        # re-checking on every upsert.
        self._known_collections: set[str] = set()

    def _ensure_collection(self, collection: str, dim: int) -> None:
        if collection in self._known_collections:
            return
        existing = {c.name for c in self._client.get_collections().collections}
        if collection not in existing:
            self._client.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=dim, distance=self._default_distance),
            )
        self._known_collections.add(collection)

    def upsert(self, collection: str, record: VectorRecord) -> None:
        self._ensure_collection(collection, len(record.vector))
        self._client.upsert(
            collection_name=collection,
            points=[
                PointStruct(
                    id=record.uuid,
                    vector=list(record.vector),
                    payload=dict(record.payload),
                )
            ],
        )

    def search(
        self,
        collection: str,
        query_vector: tuple[float, ...],
        limit: int = 12,
    ) -> list[SimilaritySearchHit]:
        results = self._client.search(
            collection_name=collection,
            query_vector=list(query_vector),
            limit=limit,
        )
        return [
            SimilaritySearchHit(
                uuid=str(point.id),
                score=float(point.score),
                payload=dict(point.payload or {}),
            )
            for point in results
        ]

    def count(self, collection: str) -> int:
        try:
            info = self._client.get_collection(collection)
            return int(info.points_count or 0)
        except Exception:
            return 0

    def clear(self, collection: str) -> None:
        try:
            self._client.delete_collection(collection)
        finally:
            self._known_collections.discard(collection)
