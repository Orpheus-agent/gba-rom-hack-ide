"""Phase 8D-2 - Tileset + map style embeddings.

Aggregates per-metatile embeddings (already written to `metatiles_v1`
by 8D-1) into:
  - per-tileset style vectors  → `tilesets_v1` collection
  - per-map style vectors       → `maps_v1` collection

Both aggregations are L2-normalised means of constituent metatile
vectors. The plan's "concat(palette median-cut, mean-CLIP)"
approach is deferred to Phase 8D-2b - for the hash-based mock
embedder mean-pooling is the only sensible aggregation, and the
architecture (write-once, query via cosine) is identical when CLIP
swaps in.

Per-tileset entity_id = tilesets.id from Postgres.
Per-map entity_id = stable int hash of map_slug (no Map table
exists yet; the slug is the authoritative key carried in the
payload).
"""

from __future__ import annotations

import hashlib
import math
import uuid as uuid_module
from dataclasses import dataclass

from sqlalchemy import delete, distinct, select

from tile_intel.domain.models import AdjacencyObservation, EmbeddingsLookup, Metatile, Tileset
from tile_intel.embeddings.base import (
    MAPS_COLLECTION,
    TILESETS_COLLECTION,
    Embedder,
)
from tile_intel.embeddings.render import iter_metatile_render_inputs
from tile_intel.storage.base import SqlAlchemyStorageFactory
from tile_intel.vectors.base import VectorRecord, VectorStore


@dataclass(frozen=True)
class AggregateReport:
    tilesets_embedded: int
    maps_embedded: int
    model_id: str
    dim: int


def _mean_normalise(vectors: list[tuple[float, ...]]) -> tuple[float, ...] | None:
    """Mean-pool a list of unit vectors then L2-renormalise. Returns
    None when the input is empty."""

    if not vectors:
        return None
    dim = len(vectors[0])
    accum = [0.0] * dim
    for v in vectors:
        if len(v) != dim:
            continue
        for i in range(dim):
            accum[i] += v[i]
    norm = math.sqrt(sum(x * x for x in accum))
    if norm <= 0.0:
        return tuple(0.0 for _ in accum)
    return tuple(x / norm for x in accum)


def _map_slug_to_entity_id(slug: str) -> int:
    """Stable 63-bit int from a map slug. Deterministic; no Map
    table needed yet. (The slug is the actual key - entity_id is
    just for the EmbeddingsLookup back-pointer.)"""

    digest = hashlib.sha256(slug.encode("utf-8")).digest()
    # Use first 8 bytes as a signed int63 to fit in PG BIGINT.
    val = int.from_bytes(digest[:8], "big", signed=False)
    return val & 0x7FFFFFFFFFFFFFFF


def _entity_uuid(prefix: str, key: str, model_id: str, model_version: str) -> str:
    namespace = uuid_module.uuid5(uuid_module.NAMESPACE_URL, "tile-intel://embeddings")
    return str(
        uuid_module.uuid5(
            namespace,
            f"{prefix}:{key}|model:{model_id}|version:{model_version}",
        )
    )


def build_tileset_vectors(
    factory: SqlAlchemyStorageFactory,
    vector_store: VectorStore,
    embedder: Embedder,
) -> int:
    """Aggregate per-metatile vectors into per-tileset style
    vectors. Writes to `tilesets_v1` collection + EmbeddingsLookup."""

    written = 0
    with factory.session() as session:
        # Wipe stale tileset lookup rows for this model.
        session.execute(
            delete(EmbeddingsLookup).where(
                EmbeddingsLookup.collection == TILESETS_COLLECTION,
                EmbeddingsLookup.entity_kind == "tileset",
                EmbeddingsLookup.model == embedder.model_id,
                EmbeddingsLookup.model_version == embedder.model_version,
            )
        )
        session.flush()

        # Walk tilesets one at a time so we can stream embeddings per
        # tileset without holding all-corpus state in memory.
        for ts in session.execute(select(Tileset)).scalars():
            # Re-render + re-embed this tileset's metatiles. (Cheaper
            # than reading vectors back from Qdrant for the mock-
            # embedder case; the real CLIP path can swap to Qdrant
            # batched-fetch in 8D-2b.)
            seed_inputs = list(iter_metatile_render_inputs(session, tileset_id=ts.id))
            if not seed_inputs:
                continue
            results = embedder.embed_metatiles(seed_inputs)
            vectors = [v for _, v in results]
            agg = _mean_normalise(vectors)
            if agg is None:
                continue
            point_uuid = _entity_uuid("tileset", ts.slug, embedder.model_id, embedder.model_version)
            vector_store.upsert(
                TILESETS_COLLECTION,
                VectorRecord(
                    uuid=point_uuid,
                    vector=agg,
                    payload={
                        "tileset_id": ts.id,
                        "tileset_slug": ts.slug,
                        "family": ts.family,
                        "is_secondary": ts.is_secondary,
                        "metatile_count": len(seed_inputs),
                    },
                ),
            )
            session.add(
                EmbeddingsLookup(
                    uuid_str=point_uuid,
                    collection=TILESETS_COLLECTION,
                    entity_kind="tileset",
                    entity_id=ts.id,
                    model=embedder.model_id,
                    model_version=embedder.model_version,
                    dim=embedder.dim,
                )
            )
            written += 1
    return written


def build_map_vectors(
    factory: SqlAlchemyStorageFactory,
    vector_store: VectorStore,
    embedder: Embedder,
) -> int:
    """Aggregate per-metatile vectors into per-map style vectors.

    "Constituent metatiles" = the set of distinct metatiles
    referenced by this map's adjacency observations (via
    source_corpus = mapSlug). When we eventually keep the raw map
    grid, we'd weight by area; for now we mean-pool distinct ids."""

    written = 0
    with factory.session() as session:
        session.execute(
            delete(EmbeddingsLookup).where(
                EmbeddingsLookup.collection == MAPS_COLLECTION,
                EmbeddingsLookup.entity_kind == "map",
                EmbeddingsLookup.model == embedder.model_id,
                EmbeddingsLookup.model_version == embedder.model_version,
            )
        )
        session.flush()

        # Map slug → set of distinct metatile ids used on that map.
        map_slugs = [
            slug
            for (slug,) in session.execute(
                select(distinct(AdjacencyObservation.source_corpus))
            ).all()
        ]
        for map_slug in map_slugs:
            mt_ids = [
                int(row[0])
                for row in session.execute(
                    select(distinct(AdjacencyObservation.metatile_a)).where(
                        AdjacencyObservation.source_corpus == map_slug
                    )
                ).all()
            ]
            mt_ids.extend(
                int(row[0])
                for row in session.execute(
                    select(distinct(AdjacencyObservation.metatile_b)).where(
                        AdjacencyObservation.source_corpus == map_slug
                    )
                ).all()
            )
            mt_ids = sorted(set(mt_ids))
            if not mt_ids:
                continue

            # Re-render + embed only this map's metatiles.
            metatiles = (
                session.execute(
                    select(
                        Metatile.id,
                        Metatile.tileset_id,
                        Metatile.composition,
                        Metatile.behavior_id,
                        Metatile.is_walkable,
                    ).where(Metatile.id.in_(mt_ids))
                ).all()
            )
            if not metatiles:
                continue

            # Group by tileset so iter_metatile_render_inputs can amortise.
            tileset_ids = sorted({int(t_id) for _, t_id, _, _, _ in metatiles})
            seed_inputs = []
            wanted_ids = set(mt_ids)
            for t_id in tileset_ids:
                for inp in iter_metatile_render_inputs(session, tileset_id=t_id):
                    if inp.metatile_id in wanted_ids:
                        seed_inputs.append(inp)
            if not seed_inputs:
                continue
            results = embedder.embed_metatiles(seed_inputs)
            vectors = [v for _, v in results]
            agg = _mean_normalise(vectors)
            if agg is None:
                continue

            entity_id = _map_slug_to_entity_id(map_slug)
            point_uuid = _entity_uuid("map", map_slug, embedder.model_id, embedder.model_version)
            vector_store.upsert(
                MAPS_COLLECTION,
                VectorRecord(
                    uuid=point_uuid,
                    vector=agg,
                    payload={
                        "map_slug": map_slug,
                        "metatile_count": len(seed_inputs),
                    },
                ),
            )
            session.add(
                EmbeddingsLookup(
                    uuid_str=point_uuid,
                    collection=MAPS_COLLECTION,
                    entity_kind="map",
                    entity_id=entity_id,
                    model=embedder.model_id,
                    model_version=embedder.model_version,
                    dim=embedder.dim,
                )
            )
            written += 1
    return written


def build_aggregate_embeddings(
    factory: SqlAlchemyStorageFactory,
    vector_store: VectorStore,
    embedder: Embedder,
) -> AggregateReport:
    """One-shot helper: build tileset + map style vectors."""

    tilesets = build_tileset_vectors(factory, vector_store, embedder)
    maps = build_map_vectors(factory, vector_store, embedder)
    return AggregateReport(
        tilesets_embedded=tilesets,
        maps_embedded=maps,
        model_id=embedder.model_id,
        dim=embedder.dim,
    )


def search_similar_tilesets(
    factory: SqlAlchemyStorageFactory,
    vector_store: VectorStore,
    embedder: Embedder,
    seed_tileset_slug: str,
    limit: int = 12,
) -> list[dict]:
    """Top-N most-similar tilesets by cosine distance over style
    vectors."""

    seed_uuid = _entity_uuid(
        "tileset", seed_tileset_slug, embedder.model_id, embedder.model_version
    )
    with factory.session() as session:
        lookup = session.execute(
            select(EmbeddingsLookup).where(EmbeddingsLookup.uuid_str == seed_uuid)
        ).scalar_one_or_none()
    if lookup is None:
        return []

    # Re-derive the seed vector + run search.
    with factory.session() as session:
        seed_tileset = session.execute(
            select(Tileset).where(Tileset.id == lookup.entity_id)
        ).scalar_one_or_none()
        if seed_tileset is None:
            return []
        seed_inputs = list(
            iter_metatile_render_inputs(session, tileset_id=seed_tileset.id)
        )
    if not seed_inputs:
        return []
    seed_vec = _mean_normalise([v for _, v in embedder.embed_metatiles(seed_inputs)])
    if seed_vec is None:
        return []
    hits = vector_store.search(TILESETS_COLLECTION, seed_vec, limit=limit)
    return [
        {
            "tileset_slug": str(hit.payload.get("tileset_slug", "")),
            "family": str(hit.payload.get("family", "")),
            "is_secondary": bool(hit.payload.get("is_secondary", False)),
            "score": float(hit.score),
            "metatile_count": int(hit.payload.get("metatile_count", 0)),
        }
        for hit in hits
    ]


def search_similar_maps(
    factory: SqlAlchemyStorageFactory,
    vector_store: VectorStore,
    embedder: Embedder,
    seed_map_slug: str,
    limit: int = 12,
) -> list[dict]:
    """Top-N most-similar maps by cosine distance over map-style
    vectors."""

    seed_uuid = _entity_uuid("map", seed_map_slug, embedder.model_id, embedder.model_version)
    with factory.session() as session:
        lookup = session.execute(
            select(EmbeddingsLookup).where(EmbeddingsLookup.uuid_str == seed_uuid)
        ).scalar_one_or_none()
    if lookup is None:
        return []

    # Re-derive seed.
    with factory.session() as session:
        # Same algorithm as build_map_vectors but only for the seed.
        mt_ids = [
            int(row[0])
            for row in session.execute(
                select(distinct(AdjacencyObservation.metatile_a)).where(
                    AdjacencyObservation.source_corpus == seed_map_slug
                )
            ).all()
        ]
        mt_ids.extend(
            int(row[0])
            for row in session.execute(
                select(distinct(AdjacencyObservation.metatile_b)).where(
                    AdjacencyObservation.source_corpus == seed_map_slug
                )
            ).all()
        )
        mt_ids = sorted(set(mt_ids))
        if not mt_ids:
            return []
        wanted_ids = set(mt_ids)
        tileset_ids = sorted(
            {
                int(row[0])
                for row in session.execute(
                    select(distinct(Metatile.tileset_id)).where(Metatile.id.in_(mt_ids))
                ).all()
            }
        )
        seed_inputs = []
        for t_id in tileset_ids:
            for inp in iter_metatile_render_inputs(session, tileset_id=t_id):
                if inp.metatile_id in wanted_ids:
                    seed_inputs.append(inp)
    if not seed_inputs:
        return []
    seed_vec = _mean_normalise([v for _, v in embedder.embed_metatiles(seed_inputs)])
    if seed_vec is None:
        return []
    hits = vector_store.search(MAPS_COLLECTION, seed_vec, limit=limit)
    return [
        {
            "map_slug": str(hit.payload.get("map_slug", "")),
            "score": float(hit.score),
            "metatile_count": int(hit.payload.get("metatile_count", 0)),
        }
        for hit in hits
    ]
