"""Phase 8D-1 - Embedding ingest pipeline.

Walks every metatile, renders its 16×16 RGBA frame, embeds via the
configured Embedder, and writes:
  - the vector → Qdrant (`metatiles_v1` collection)
  - an EmbeddingsLookup row → Postgres (point UUID → entity_id back-pointer)

Idempotent: re-running deletes any prior EmbeddingsLookup rows for
the same (collection, entity_kind, model, model_version) tuple
before re-inserting. Qdrant points are upserted by UUID so the
re-run produces identical IDs.
"""

from __future__ import annotations

import uuid as uuid_module
from dataclasses import dataclass

from sqlalchemy import delete, select

from tile_intel.domain.models import EmbeddingsLookup
from tile_intel.embeddings.base import (
    METATILES_COLLECTION,
    Embedder,
    MetatileRenderingInput,
)
from tile_intel.embeddings.render import iter_metatile_render_inputs
from tile_intel.storage.base import SqlAlchemyStorageFactory
from tile_intel.vectors.base import VectorRecord, VectorStore


@dataclass(frozen=True)
class EmbeddingsReport:
    """Counts emitted by `embed_metatiles_pipeline()`."""

    metatiles_embedded: int
    qdrant_points_written: int
    embeddings_lookup_rows: int
    model_id: str
    model_version: str
    dim: int


def _deterministic_uuid(metatile_id: int, model_id: str, model_version: str) -> str:
    """A stable UUID for (metatile, model, version). Re-running the
    pipeline with the same inputs writes to the SAME Qdrant point
    and the SAME EmbeddingsLookup row."""

    namespace = uuid_module.uuid5(uuid_module.NAMESPACE_URL, "tile-intel://embeddings")
    return str(
        uuid_module.uuid5(
            namespace,
            f"metatile:{metatile_id}|model:{model_id}|version:{model_version}",
        )
    )


def embed_metatiles_pipeline(
    factory: SqlAlchemyStorageFactory,
    vector_store: VectorStore,
    embedder: Embedder,
    batch_size: int = 64,
    tileset_id: int | None = None,
) -> EmbeddingsReport:
    """Run the full embed pass.

    `batch_size` controls how many metatiles are sent to
    `embed_metatiles()` per call. Real CLIP throughput hits a sweet
    spot around 64-128; the hash embedder is essentially free.

    `tileset_id` restricts the pass to one tileset - useful when a
    single tileset is re-imported and we don't want to re-embed
    everything else.
    """

    metatiles_done = 0
    points_written = 0
    lookup_rows = 0
    with factory.session() as session:
        # Wipe old lookup rows for the same (collection, model).
        session.execute(
            delete(EmbeddingsLookup).where(
                EmbeddingsLookup.collection == METATILES_COLLECTION,
                EmbeddingsLookup.entity_kind == "metatile",
                EmbeddingsLookup.model == embedder.model_id,
                EmbeddingsLookup.model_version == embedder.model_version,
            )
        )
        session.flush()

        batch: list[MetatileRenderingInput] = []
        for inp in iter_metatile_render_inputs(session, tileset_id=tileset_id):
            batch.append(inp)
            if len(batch) >= batch_size:
                _flush_batch(
                    session, vector_store, embedder, batch
                )
                metatiles_done += len(batch)
                points_written += len(batch)
                lookup_rows += len(batch)
                batch = []
        if batch:
            _flush_batch(session, vector_store, embedder, batch)
            metatiles_done += len(batch)
            points_written += len(batch)
            lookup_rows += len(batch)

    return EmbeddingsReport(
        metatiles_embedded=metatiles_done,
        qdrant_points_written=points_written,
        embeddings_lookup_rows=lookup_rows,
        model_id=embedder.model_id,
        model_version=embedder.model_version,
        dim=embedder.dim,
    )


def _flush_batch(
    session,
    vector_store: VectorStore,
    embedder: Embedder,
    batch: list[MetatileRenderingInput],
) -> None:
    """Embed + write one batch."""

    results = embedder.embed_metatiles(batch)
    inputs_by_id = {b.metatile_id: b for b in batch}
    for metatile_id, vector in results:
        if metatile_id not in inputs_by_id:
            continue
        inp = inputs_by_id[metatile_id]
        point_uuid = _deterministic_uuid(metatile_id, embedder.model_id, embedder.model_version)
        vector_store.upsert(
            METATILES_COLLECTION,
            VectorRecord(
                uuid=point_uuid,
                vector=vector,
                payload={
                    "metatile_id": metatile_id,
                    "tileset_id": inp.tileset_id,
                    "tileset_slug": inp.tileset_slug,
                    "family": inp.family,
                    "behavior_id": inp.behavior_id,
                    "is_walkable": inp.is_walkable,
                    "is_secondary": inp.is_secondary,
                },
            ),
        )
        session.add(
            EmbeddingsLookup(
                uuid_str=point_uuid,
                collection=METATILES_COLLECTION,
                entity_kind="metatile",
                entity_id=metatile_id,
                model=embedder.model_id,
                model_version=embedder.model_version,
                dim=embedder.dim,
            )
        )


def search_similar_metatiles(
    factory: SqlAlchemyStorageFactory,
    vector_store: VectorStore,
    embedder: Embedder,
    seed_metatile_id: int,
    limit: int = 12,
) -> list[dict]:
    """Cosine-nearest metatiles to a seed. Looks up the seed's
    vector in Qdrant by its known UUID, then runs a similarity
    search."""

    seed_uuid = _deterministic_uuid(seed_metatile_id, embedder.model_id, embedder.model_version)
    with factory.session() as session:
        lookup = session.execute(
            select(EmbeddingsLookup).where(EmbeddingsLookup.uuid_str == seed_uuid)
        ).scalar_one_or_none()
    if lookup is None:
        return []

    # Re-derive the seed's vector by re-rendering and embedding it.
    # Cheaper than fetching from Qdrant for the test-stack case.
    with factory.session() as session:
        seed_inputs = []
        for inp in iter_metatile_render_inputs(session):
            if inp.metatile_id == seed_metatile_id:
                seed_inputs.append(inp)
                break
    if not seed_inputs:
        return []
    seed_vec = embedder.embed_metatiles(seed_inputs)[0][1]

    hits = vector_store.search(METATILES_COLLECTION, seed_vec, limit=limit)
    return [
        {
            "metatile_id": int(hit.payload.get("metatile_id", -1)),
            "tileset_slug": str(hit.payload.get("tileset_slug", "")),
            "score": float(hit.score),
            "is_walkable": bool(hit.payload.get("is_walkable", False)),
        }
        for hit in hits
    ]
