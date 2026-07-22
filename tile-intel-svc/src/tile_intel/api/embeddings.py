"""Phase 8D-1 - Embeddings + similarity endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.embeddings import get_default_embedder
from tile_intel.embeddings.aggregate import (
    build_aggregate_embeddings,
    search_similar_maps,
    search_similar_tilesets,
)
from tile_intel.embeddings.base import Embedder
from tile_intel.ingest.embeddings import (
    embed_metatiles_pipeline,
    search_similar_metatiles,
)
from tile_intel.storage.base import SqlAlchemyStorageFactory
from tile_intel.vectors.base import VectorStore

router = APIRouter(prefix="/v1/embeddings", tags=["embeddings"])


# Test override-able. The production app wires a Qdrant-backed
# store; tests inject InMemoryVectorStore.
_default_vector_store: VectorStore | None = None
_default_embedder: Embedder | None = None


def get_vector_store() -> VectorStore:
    """Tests override via app.dependency_overrides."""

    global _default_vector_store
    if _default_vector_store is None:
        # Production default: Qdrant via the config-driven factory.
        # We construct lazily because Qdrant may not be reachable at
        # module-load time.
        from tile_intel.config import get_settings
        from tile_intel.vectors.qdrant import QdrantVectorStore

        settings = get_settings()
        _default_vector_store = QdrantVectorStore(
            host=settings.qdrant_host, port=settings.qdrant_port
        )
    return _default_vector_store


def get_embedder() -> Embedder:
    """Tests override via app.dependency_overrides."""

    global _default_embedder
    if _default_embedder is None:
        _default_embedder = get_default_embedder()
    return _default_embedder


class RebuildEmbeddingsRequest(BaseModel):
    """Inputs for /v1/embeddings/rebuild."""

    tileset_id: int | None = None
    batch_size: int = Field(default=64, ge=1, le=512)


class RebuildEmbeddingsResponse(BaseModel):
    metatiles_embedded: int
    qdrant_points_written: int
    embeddings_lookup_rows: int
    tilesets_embedded: int = 0
    maps_embedded: int = 0
    model_id: str
    model_version: str
    dim: int


@router.post("/rebuild", response_model=RebuildEmbeddingsResponse)
async def rebuild_endpoint(
    request: RebuildEmbeddingsRequest | None = None,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
    vector_store: VectorStore = Depends(get_vector_store),
    embedder: Embedder = Depends(get_embedder),
) -> RebuildEmbeddingsResponse:
    """Re-render + re-embed every metatile.

    Idempotent - re-running with the same embedder produces
    identical Qdrant point UUIDs + EmbeddingsLookup rows.
    """

    req = request or RebuildEmbeddingsRequest()
    report = embed_metatiles_pipeline(
        factory,
        vector_store,
        embedder,
        batch_size=req.batch_size,
        tileset_id=req.tileset_id,
    )
    # Phase 8D-2: build per-tileset + per-map style vectors as a
    # second pass. Only runs on full rebuilds (tileset_id is None);
    # a single-tileset re-embed should also refresh that tileset's
    # style vector but leave maps alone - handled in 8D-2b if needed.
    if req.tileset_id is None:
        agg = build_aggregate_embeddings(factory, vector_store, embedder)
        tilesets_count = agg.tilesets_embedded
        maps_count = agg.maps_embedded
    else:
        tilesets_count = 0
        maps_count = 0
    return RebuildEmbeddingsResponse(
        metatiles_embedded=report.metatiles_embedded,
        qdrant_points_written=report.qdrant_points_written,
        embeddings_lookup_rows=report.embeddings_lookup_rows,
        tilesets_embedded=tilesets_count,
        maps_embedded=maps_count,
        model_id=report.model_id,
        model_version=report.model_version,
        dim=report.dim,
    )


class SimilarMetatileEntry(BaseModel):
    metatile_id: int
    tileset_slug: str
    score: float
    is_walkable: bool


class SimilarMetatilesResponse(BaseModel):
    seed_metatile_id: int
    model_id: str
    hits: list[SimilarMetatileEntry]


@router.get("/similar/metatile", response_model=SimilarMetatilesResponse)
async def similar_metatile_endpoint(
    metatile_id: int,
    limit: int = 12,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
    vector_store: VectorStore = Depends(get_vector_store),
    embedder: Embedder = Depends(get_embedder),
) -> SimilarMetatilesResponse:
    """Find the top-N most-similar metatiles to a seed by cosine
    distance over the embeddings collection."""

    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be in 1..200")
    hits = search_similar_metatiles(
        factory, vector_store, embedder, metatile_id, limit=limit
    )
    return SimilarMetatilesResponse(
        seed_metatile_id=metatile_id,
        model_id=embedder.model_id,
        hits=[SimilarMetatileEntry(**h) for h in hits],
    )


class SimilarTilesetEntry(BaseModel):
    tileset_slug: str
    family: str
    is_secondary: bool
    score: float
    metatile_count: int


class SimilarTilesetsResponse(BaseModel):
    seed_tileset_slug: str
    model_id: str
    hits: list[SimilarTilesetEntry]


@router.get("/similar/tileset", response_model=SimilarTilesetsResponse)
async def similar_tileset_endpoint(
    tileset_slug: str,
    limit: int = 12,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
    vector_store: VectorStore = Depends(get_vector_store),
    embedder: Embedder = Depends(get_embedder),
) -> SimilarTilesetsResponse:
    """Phase 8D-2 - find tilesets most similar in style to the seed.

    The aggregate style vector is the L2-normalised mean of the
    tileset's per-metatile embeddings (Phase 8D-1 mock; real CLIP
    later). Top-N by cosine."""

    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be in 1..200")
    hits = search_similar_tilesets(factory, vector_store, embedder, tileset_slug, limit=limit)
    return SimilarTilesetsResponse(
        seed_tileset_slug=tileset_slug,
        model_id=embedder.model_id,
        hits=[SimilarTilesetEntry(**h) for h in hits],
    )


class SimilarMapEntry(BaseModel):
    map_slug: str
    score: float
    metatile_count: int


class SimilarMapsResponse(BaseModel):
    seed_map_slug: str
    model_id: str
    hits: list[SimilarMapEntry]


@router.get("/similar/map", response_model=SimilarMapsResponse)
async def similar_map_endpoint(
    map_slug: str,
    limit: int = 12,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
    vector_store: VectorStore = Depends(get_vector_store),
    embedder: Embedder = Depends(get_embedder),
) -> SimilarMapsResponse:
    """Phase 8D-2 - find maps most similar in metatile usage to the
    seed.

    Aggregates over the set of distinct metatiles each map references
    via adjacency_observations. L2-normalised mean → cosine search."""

    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be in 1..200")
    hits = search_similar_maps(factory, vector_store, embedder, map_slug, limit=limit)
    return SimilarMapsResponse(
        seed_map_slug=map_slug,
        model_id=embedder.model_id,
        hits=[SimilarMapEntry(**h) for h in hits],
    )
