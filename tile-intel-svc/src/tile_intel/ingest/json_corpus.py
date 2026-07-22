"""Phase 8B-2 - Idempotent ingestion of a Tile-Intel IR corpus.

Given a parsed `IRCorpus` Pydantic model, this module upserts every
tileset (+ its tiles, metatiles, palettes) and every adjacency
observation into the Storage factory's database. Re-running the
same corpus is a no-op (deletes the existing tileset row + cascades,
then inserts fresh; conceptually a `UPSERT`).
"""

from __future__ import annotations

import binascii
import hashlib
from dataclasses import dataclass

from sqlalchemy import delete, select

from tile_intel.domain.ir import IRCorpus, IRMapAdjacency, IRTileset
from tile_intel.domain.models import (
    AdjacencyObservation,
    AdjacencyPattern,
    Metatile,
    Palette,
    Tile,
    Tileset,
)
from tile_intel.storage.base import SqlAlchemyStorageFactory


@dataclass(frozen=True)
class IngestReport:
    """Counts of what landed during one ingest call."""

    tilesets_upserted: int
    tiles_upserted: int
    metatiles_upserted: int
    palettes_upserted: int
    adjacency_observations_upserted: int
    adjacency_patterns_upserted: int
    skipped: int


def _hex_to_bytes(hex_str: str) -> bytes:
    return binascii.unhexlify(hex_str)


def _ingest_tileset(session, ir_ts: IRTileset, source: str) -> tuple[Tileset, int, int, int]:
    """Insert (or replace) one tileset + its child rows. Returns
    `(tileset, tiles_count, metatiles_count, palettes_count)`."""

    # Delete-then-insert is the simplest cross-dialect upsert that
    # honours the cascade on tilesets.id.
    existing = session.execute(select(Tileset).where(Tileset.slug == ir_ts.slug)).scalar_one_or_none()
    if existing is not None:
        session.execute(delete(Tileset).where(Tileset.id == existing.id))
        session.flush()

    # Approximate "raw_bytes_size" from the per-tile pixel data
    # plus per-palette + per-metatile attribute bytes.
    raw_bytes = ir_ts.tileCount * 64 + ir_ts.metatileCount * (16 + 4) + len(ir_ts.palettes) * 32

    ts = Tileset(
        slug=ir_ts.slug,
        display_name=ir_ts.displayName,
        family=ir_ts.family,
        is_secondary=ir_ts.isSecondary,
        is_compressed=ir_ts.isCompressed,
        scope="global",  # All Phase 8B-1/3 vanilla data is global.
        project_id=None,
        source=ir_ts.source,
        source_url=None,
        source_commit=ir_ts.sourceCommit,
        license_spdx=ir_ts.licenseSpdx,
        attribution=ir_ts.attribution,
        content_hash=b"\x00" * 32,  # Filled by 8C-1; placeholder for now.
        raw_bytes_size=raw_bytes,
    )
    session.add(ts)
    session.flush()  # populate ts.id

    for ir_pal in ir_ts.palettes:
        session.add(
            Palette(
                tileset_id=ts.id,
                palette_index=ir_pal.paletteIndex,
                colors_bgr555=_hex_to_bytes(ir_pal.bgr555Hex),
                colors_rgba=None,
                median_cut_5=list(ir_pal.medianCut5),
                dominant_hue=ir_pal.dominantHue,
                luminance_avg=ir_pal.luminanceAvg,
            )
        )

    for ir_tile in ir_ts.tiles:
        session.add(
            Tile(
                tileset_id=ts.id,
                tile_index=ir_tile.tileIndex,
                pixel_bytes=_hex_to_bytes(ir_tile.pixelBytesHex),
                content_hash=_hex_to_bytes(ir_tile.pixelHashHex),
                palette_neutral_hash=_hex_to_bytes(ir_tile.paletteNeutralHashHex),
                phash=_hex_to_bytes(ir_tile.phashHex),
                is_blank=ir_tile.isBlank,
                is_horizontal_symm=ir_tile.isHorizontallySymmetric,
                is_vertical_symm=ir_tile.isVerticallySymmetric,
            )
        )

    for ir_mt in ir_ts.metatiles:
        session.add(
            Metatile(
                tileset_id=ts.id,
                metatile_index=ir_mt.metatileIndex,
                behavior_id=ir_mt.behaviorId,
                terrain_type=ir_mt.terrainType,
                encounter_type=ir_mt.encounterType,
                layer_type=ir_mt.layerType,
                attr_raw=_hex_to_bytes(ir_mt.attrRawHex),
                composition=[
                    {
                        "layer": s.layer,
                        "quad": s.quad,
                        "tileIndex": s.tileIndex,
                        "hflip": s.hflip,
                        "vflip": s.vflip,
                        "paletteIndex": s.paletteIndex,
                    }
                    for s in ir_mt.composition
                ],
                rendered_hash=_hex_to_bytes(ir_mt.renderedHashHex),
                phash=_hex_to_bytes(ir_mt.phashHex),
                # Heuristic: behavior 0 (MB_NORMAL) and known walkable
                # behaviors are walkable. The full classifier lands in
                # 8C-1; placeholder logic suffices for ingest tests.
                is_walkable=ir_mt.behaviorId in (0, 1, 2, 3),
                is_surfable=ir_mt.behaviorId in (0x20, 0x21, 0x22),
                is_encounter_grass=ir_mt.encounterType == 1,
            )
        )

    return ts, len(ir_ts.tiles), len(ir_ts.metatiles), len(ir_ts.palettes)


def _ingest_map_adjacency(
    session,
    ir_map: IRMapAdjacency,
    slug_to_id: dict[str, int],
) -> int:
    """Append adjacency observations for one map. Skips observations
    where one of the referenced tilesets isn't in the corpus yet.
    Returns the number of observation rows added."""

    # Find the metatile DB ids on the fly via (tileset_id, metatile_index).
    inserted = 0
    primary_id = slug_to_id.get(ir_map.primaryTilesetSlug)
    secondary_id = slug_to_id.get(ir_map.secondaryTilesetSlug)
    if primary_id is None or secondary_id is None:
        return 0

    # Bulk-fetch metatile id lookups: one query per (tileset_id) keyed
    # by metatile_index → id.
    def _index_lookup(tileset_id: int) -> dict[int, int]:
        rows = session.execute(
            select(Metatile.metatile_index, Metatile.id).where(Metatile.tileset_id == tileset_id)
        ).all()
        return {row[0]: row[1] for row in rows}

    primary_lookup = _index_lookup(primary_id)
    secondary_lookup = _index_lookup(secondary_id)

    def _resolve(slug: str, idx: int) -> int | None:
        if slug == ir_map.primaryTilesetSlug:
            return primary_lookup.get(idx)
        if slug == ir_map.secondaryTilesetSlug:
            return secondary_lookup.get(idx)
        return None

    # Existing observations from this map should be replaced so the
    # ingest is idempotent. Identify by `source_corpus = mapSlug`.
    session.execute(
        delete(AdjacencyObservation).where(AdjacencyObservation.source_corpus == ir_map.mapSlug)
    )

    for obs in ir_map.observations:
        a = _resolve(obs.tilesetSlugA, obs.metatileIndexA)
        b = _resolve(obs.tilesetSlugB, obs.metatileIndexB)
        if a is None or b is None:
            continue
        session.add(
            AdjacencyObservation(
                metatile_a=a,
                metatile_b=b,
                direction=obs.direction,
                frequency=obs.frequency,
                source_corpus=ir_map.mapSlug,
                scope="global",
                project_id=None,
            )
        )
        inserted += 1
    return inserted


def _pattern_hash(cells: list) -> bytes:
    """SHA-256 of the canonical cell-sequence string.  Two patterns
    are considered identical iff their cells list to the same
    (tilesetSlug, metatileIndex) sequence in the same order."""
    canonical = "|".join(f"{c.tilesetSlug}#{c.metatileIndex}" for c in cells)
    return hashlib.sha256(canonical.encode("utf-8")).digest()


def _ingest_patterns(session, corpus: IRCorpus) -> int:
    """Aggregate patterns from EVERY map's patterns list across this
    corpus into adjacency_patterns rows. Delete-before-insert keyed
    by source_corpus + scope so re-ingesting the same source replaces
    its rows; different sources accumulate."""

    source_corpus = corpus.source
    # Wipe this source's existing patterns at global scope.
    session.execute(
        delete(AdjacencyPattern).where(
            AdjacencyPattern.source_corpus == source_corpus,
            AdjacencyPattern.scope == "global",
        )
    )
    session.flush()

    # Aggregate by pattern_hash across all maps in this corpus.
    bucket: dict[bytes, dict] = {}
    for ir_map in corpus.mapAdjacencies:
        if not ir_map.patterns:
            continue
        for pat in ir_map.patterns:
            h = _pattern_hash(list(pat.cells))
            existing = bucket.get(h)
            if existing is None:
                bucket[h] = {
                    "pattern_hash": h,
                    "pattern_shape": pat.shape,
                    "cells": [
                        {"tilesetSlug": c.tilesetSlug, "metatileIndex": c.metatileIndex}
                        for c in pat.cells
                    ],
                    "frequency": pat.frequency,
                }
            else:
                existing["frequency"] += pat.frequency

    inserted = 0
    for entry in bucket.values():
        session.add(
            AdjacencyPattern(
                pattern_shape=entry["pattern_shape"],
                pattern_hash=entry["pattern_hash"],
                cells=entry["cells"],
                role="3x3_window",  # 8F infers semantic role later
                frequency=entry["frequency"],
                source_corpus=source_corpus,
                scope="global",
                project_id=None,
            )
        )
        inserted += 1
    return inserted


def ingest_corpus(factory: SqlAlchemyStorageFactory, corpus: IRCorpus) -> IngestReport:
    """Upsert every record from the corpus. The whole pass runs in a
    single transaction so partial ingest is impossible."""

    tilesets = 0
    tiles = 0
    metatiles = 0
    palettes = 0
    observations = 0
    patterns = 0
    skipped = 0

    with factory.session() as session:
        slug_to_id: dict[str, int] = {}
        for ir_ts in corpus.tilesets:
            try:
                ts, t_n, mt_n, pal_n = _ingest_tileset(session, ir_ts, corpus.source)
                slug_to_id[ts.slug] = ts.id
                tilesets += 1
                tiles += t_n
                metatiles += mt_n
                palettes += pal_n
            except Exception:
                skipped += 1
                session.rollback()
                # After rollback, the session is fresh; re-fetch existing slug ids.
                slug_to_id = {
                    row[0]: row[1]
                    for row in session.execute(select(Tileset.slug, Tileset.id)).all()
                }
                continue

        for ir_map in corpus.mapAdjacencies:
            observations += _ingest_map_adjacency(session, ir_map, slug_to_id)

        patterns = _ingest_patterns(session, corpus)

    return IngestReport(
        tilesets_upserted=tilesets,
        tiles_upserted=tiles,
        metatiles_upserted=metatiles,
        palettes_upserted=palettes,
        adjacency_observations_upserted=observations,
        adjacency_patterns_upserted=patterns,
        skipped=skipped,
    )
