"""Phase 8A-5 - SQLAlchemy domain models for tile-intel-svc.

The shape mirrors the schema design from the Phase 8 plan (see
`docs/MASTER_PLAN.md`).
Fourteen tables, four logical clusters:

- **Attribution + content**: tilesets, tiles, metatiles, palettes.
- **Ontology**: behaviors, tag_taxonomy, metatile_tags, tile_tags.
- **Adjacency**: adjacency_observations, adjacency_rules,
  adjacency_patterns.
- **Grammar**: templates, template_usage.
- **Embedding pointer**: embeddings_lookup.

Cross-DB portability: this file uses SQLAlchemy's cross-dialect
column types (`String`, `JSON`, `LargeBinary`) rather than Postgres
extensions (`JSONB`, `BYTEA`) so the same models drive both the
production Postgres migration AND the SQLite-backed test storage
used by the unit tests. Postgres-specific index types (GIN, etc.)
are deferred to a follow-up Alembic op when their performance
matters; the schema works on day one without them.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Common declarative base. Alembic uses this metadata for
    autogenerate; subclassed by every model below."""


# SQLite doesn't autoincrement BIGINT - it needs INTEGER PRIMARY KEY.
# Postgres handles BIGINT autoincrement natively via SERIAL/IDENTITY.
# This variant keeps production at BIGINT while letting the SQLite-
# backed test suite use INTEGER, which IS the rowid + autoincrements.
PrimaryBigInt = BigInteger().with_variant(Integer(), "sqlite")
ForeignBigInt = BigInteger().with_variant(Integer(), "sqlite")


# ---------------------------------------------------------------------------
# Attribution + content
# ---------------------------------------------------------------------------


class Tileset(Base):
    """A physical tileset (one row per imported pack)."""

    __tablename__ = "tilesets"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    uuid_str: Mapped[str] = mapped_column(String(36), unique=True, default=lambda: str(uuid.uuid4()))
    slug: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(255))
    family: Mapped[str] = mapped_column(String(16))  # 'frlg' | 'rse'
    is_secondary: Mapped[bool] = mapped_column(Boolean)
    is_compressed: Mapped[bool] = mapped_column(Boolean)
    scope: Mapped[str] = mapped_column(String(16))  # 'global' | 'project'
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    source: Mapped[str] = mapped_column(String(32))
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_commit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    license_spdx: Mapped[str | None] = mapped_column(String(64), nullable=True)
    attribution: Mapped[str | None] = mapped_column(Text, nullable=True)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    ingested_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    content_hash: Mapped[bytes] = mapped_column(LargeBinary, index=True)
    raw_bytes_size: Mapped[int] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    palettes: Mapped[list[Palette]] = relationship(back_populates="tileset", cascade="all, delete-orphan")
    tiles: Mapped[list[Tile]] = relationship(back_populates="tileset", cascade="all, delete-orphan")
    metatiles: Mapped[list[Metatile]] = relationship(back_populates="tileset", cascade="all, delete-orphan")


class Tile(Base):
    """An 8x8 tile in a tileset's tile-table."""

    __tablename__ = "tiles"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    tileset_id: Mapped[int] = mapped_column(ForeignBigInt, ForeignKey("tilesets.id", ondelete="CASCADE"), index=True)
    tile_index: Mapped[int] = mapped_column(SmallInteger)
    pixel_bytes: Mapped[bytes] = mapped_column(LargeBinary)
    content_hash: Mapped[bytes] = mapped_column(LargeBinary, index=True)
    palette_neutral_hash: Mapped[bytes] = mapped_column(LargeBinary, index=True)
    phash: Mapped[bytes] = mapped_column(LargeBinary, index=True)  # u64 -> 8 bytes
    is_blank: Mapped[bool] = mapped_column(Boolean)
    is_horizontal_symm: Mapped[bool] = mapped_column(Boolean)
    is_vertical_symm: Mapped[bool] = mapped_column(Boolean)
    feature_vec_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    tileset: Mapped[Tileset] = relationship(back_populates="tiles")

    __table_args__ = (UniqueConstraint("tileset_id", "tile_index", name="uq_tiles_tileset_index"),)


class Metatile(Base):
    """One 16x16 metatile = 2x2 tile composition + attribute bytes."""

    __tablename__ = "metatiles"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    tileset_id: Mapped[int] = mapped_column(ForeignBigInt, ForeignKey("tilesets.id", ondelete="CASCADE"), index=True)
    metatile_index: Mapped[int] = mapped_column(SmallInteger)
    behavior_id: Mapped[int] = mapped_column(SmallInteger, index=True)
    terrain_type: Mapped[int] = mapped_column(SmallInteger)
    encounter_type: Mapped[int] = mapped_column(SmallInteger)
    layer_type: Mapped[int] = mapped_column(SmallInteger)
    attr_raw: Mapped[bytes] = mapped_column(LargeBinary)
    # 8 slots x {layer, quad, tileIndex, hflip, vflip, paletteIndex}
    composition: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    rendered_hash: Mapped[bytes] = mapped_column(LargeBinary, index=True)
    phash: Mapped[bytes] = mapped_column(LargeBinary, index=True)  # u64 -> 8 bytes
    is_walkable: Mapped[bool] = mapped_column(Boolean, index=True)
    is_surfable: Mapped[bool] = mapped_column(Boolean)
    is_encounter_grass: Mapped[bool] = mapped_column(Boolean)
    feature_vec_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    tileset: Mapped[Tileset] = relationship(back_populates="metatiles")
    tags: Mapped[list[MetatileTag]] = relationship(back_populates="metatile", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("tileset_id", "metatile_index", name="uq_metatiles_tileset_index"),
    )


class Palette(Base):
    """A 16-color palette block; one of 16 per tileset."""

    __tablename__ = "palettes"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    tileset_id: Mapped[int] = mapped_column(ForeignBigInt, ForeignKey("tilesets.id", ondelete="CASCADE"), index=True)
    palette_index: Mapped[int] = mapped_column(SmallInteger)
    colors_bgr555: Mapped[bytes] = mapped_column(LargeBinary)
    colors_rgba: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    median_cut_5: Mapped[list[str]] = mapped_column(JSON)  # ['#aabbcc', ...]
    dominant_hue: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    luminance_avg: Mapped[int] = mapped_column(SmallInteger)

    tileset: Mapped[Tileset] = relationship(back_populates="palettes")

    __table_args__ = (
        UniqueConstraint("tileset_id", "palette_index", name="uq_palettes_tileset_index"),
    )


# ---------------------------------------------------------------------------
# Ontology
# ---------------------------------------------------------------------------


class Behavior(Base):
    """pret's metatile-behavior enum, seeded once at ingest time."""

    __tablename__ = "behaviors"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)
    family: Mapped[str] = mapped_column(String(16))  # 'frlg' | 'rse' | 'common'
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40))
    walkable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_encounter: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (UniqueConstraint("family", "name", name="uq_behaviors_family_name"),)


class TagTaxonomy(Base):
    """The 6-axis controlled vocabulary (terrain / traversal /
    elevation / structure / biome / aesthetic). Hierarchical via
    `parent_id`."""

    __tablename__ = "tag_taxonomy"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("tag_taxonomy.id", ondelete="SET NULL"), nullable=True, index=True
    )
    axis: Mapped[str] = mapped_column(String(40), index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_leaf: Mapped[bool] = mapped_column(Boolean)

    parent: Mapped[TagTaxonomy | None] = relationship(remote_side="TagTaxonomy.id")


class MetatileTag(Base):
    """Many-to-many assertion linking metatiles to taxonomy entries.
    Source + confidence let the system downrank LLM/CLIP-derived tags
    relative to human-curated ones."""

    __tablename__ = "metatile_tags"

    metatile_id: Mapped[int] = mapped_column(
        ForeignKey("metatiles.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tag_taxonomy.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    confidence: Mapped[float] = mapped_column(Numeric(4, 3), default=1.0)
    source: Mapped[str] = mapped_column(String(40))

    metatile: Mapped[Metatile] = relationship(back_populates="tags")


class TileTag(Base):
    """Sparse tile-level tags (typically used only for shared
    structural components like a reused tree-canopy 8x8 tile)."""

    __tablename__ = "tile_tags"

    tile_id: Mapped[int] = mapped_column(
        ForeignKey("tiles.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tag_taxonomy.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    confidence: Mapped[float] = mapped_column(Numeric(4, 3), default=1.0)
    source: Mapped[str] = mapped_column(String(40))


# ---------------------------------------------------------------------------
# Adjacency
# ---------------------------------------------------------------------------


class AdjacencyObservation(Base):
    """Immutable raw co-occurrence from observed maps. Append-only.
    Aggregated within-map by the corpus builder so each
    (metatile_a, metatile_b, direction, source_corpus) tuple appears
    at most once with frequency carrying the count."""

    __tablename__ = "adjacency_observations"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    metatile_a: Mapped[int] = mapped_column(ForeignBigInt, ForeignKey("metatiles.id", ondelete="CASCADE"), index=True)
    metatile_b: Mapped[int] = mapped_column(ForeignBigInt, ForeignKey("metatiles.id", ondelete="CASCADE"), index=True)
    direction: Mapped[int] = mapped_column(SmallInteger)  # 0..7
    frequency: Mapped[int] = mapped_column(Integer)
    source_corpus: Mapped[str] = mapped_column(String(120))
    scope: Mapped[str] = mapped_column(String(16))
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "metatile_a", "metatile_b", "direction", "source_corpus",
            name="uq_adj_obs_pair_dir_corpus",
        ),
    )


class AdjacencyRule(Base):
    """Derived view: legal-neighbor distributions per
    (metatile_a, direction) at a given scope. Re-computable from
    `adjacency_observations` at any threshold."""

    __tablename__ = "adjacency_rules"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    metatile_a: Mapped[int] = mapped_column(ForeignBigInt, ForeignKey("metatiles.id", ondelete="CASCADE"), index=True)
    direction: Mapped[int] = mapped_column(SmallInteger)
    # [{metatile_b_id: int, probability: float, freq: int}, ...]
    legal_neighbors: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    # IDs only - for fast hard-constraint checks
    hard_legal_set: Mapped[list[int]] = mapped_column(JSON)
    total_observations: Mapped[int] = mapped_column(Integer)
    entropy: Mapped[float] = mapped_column(Numeric(7, 4))
    scope: Mapped[str] = mapped_column(String(16))
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    built_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "metatile_a", "direction", "scope", "project_id",
            name="uq_adj_rules_metatile_dir_scope",
        ),
    )


class AdjacencyPattern(Base):
    """Multi-cell legality rules (L-shapes, transitions, 3x3 corners)
    that pairwise rules can't capture."""

    __tablename__ = "adjacency_patterns"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    pattern_shape: Mapped[str] = mapped_column(String(40))
    pattern_hash: Mapped[bytes] = mapped_column(LargeBinary, index=True)
    cells: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    role: Mapped[str] = mapped_column(String(40), index=True)
    frequency: Mapped[int] = mapped_column(Integer)
    source_corpus: Mapped[str] = mapped_column(String(120), index=True)
    scope: Mapped[str] = mapped_column(String(16))
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "pattern_hash", "source_corpus", "scope", "project_id",
            name="uq_adj_patterns_hash_corpus_scope",
        ),
    )


# ---------------------------------------------------------------------------
# Grammar
# ---------------------------------------------------------------------------


class Template(Base):
    """A map-grammar primitive: house facade, fence row, tree wall,
    etc. Cells can reference concrete metatile IDs or tag-slot
    bindings."""

    __tablename__ = "templates"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    uuid_str: Mapped[str] = mapped_column(String(36), unique=True, default=lambda: str(uuid.uuid4()))
    slug: Mapped[str] = mapped_column(String(200))
    display_name: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(40), index=True)
    width: Mapped[int] = mapped_column(SmallInteger)
    height: Mapped[int] = mapped_column(SmallInteger)
    cells: Mapped[list[list[dict[str, Any]]]] = mapped_column(JSON)
    anchor_x: Mapped[int] = mapped_column(SmallInteger)
    anchor_y: Mapped[int] = mapped_column(SmallInteger)
    origin_tileset_id: Mapped[int | None] = mapped_column(
        ForeignKey("tilesets.id", ondelete="SET NULL"), nullable=True
    )
    required_tags: Mapped[list[str]] = mapped_column(JSON)
    scope: Mapped[str] = mapped_column(String(16))
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    __table_args__ = (
        UniqueConstraint("slug", "scope", "project_id", name="uq_templates_slug_scope_project"),
    )


class TemplateUsage(Base):
    """How often each template appears in each map corpus (for
    frequency analysis per biome in Phase 8F-2)."""

    __tablename__ = "template_usage"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    template_id: Mapped[int] = mapped_column(ForeignBigInt, ForeignKey("templates.id", ondelete="CASCADE"), index=True)
    map_corpus: Mapped[str] = mapped_column(String(200), index=True)
    occurrence_count: Mapped[int] = mapped_column(Integer)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# Embedding pointer
# ---------------------------------------------------------------------------


class EmbeddingsLookup(Base):
    """Authoritative back-pointer from a Qdrant point to a Postgres
    row. Qdrant stores small payloads only; full metadata lives here."""

    __tablename__ = "embeddings_lookup"

    uuid_str: Mapped[str] = mapped_column(String(36), primary_key=True)
    collection: Mapped[str] = mapped_column(String(64))
    entity_kind: Mapped[str] = mapped_column(String(40))  # tile/metatile/tileset/map
    entity_id: Mapped[int] = mapped_column(BigInteger)
    model: Mapped[str] = mapped_column(String(64))
    model_version: Mapped[str] = mapped_column(String(64))
    dim: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_emb_lookup_entity", "entity_kind", "entity_id"),
        Index("idx_emb_lookup_collection_model", "collection", "model", "model_version"),
    )


# ---------------------------------------------------------------------------
# Phase 8J-2 - Human curation overrides
# ---------------------------------------------------------------------------


class HumanOverride(Base):
    """One human judgment on a resolver output.

    The Phase 8J-2 curation UI lets users mark generator output as
    good or bad. We persist each judgment as a row here; the
    adjacency-rule rebuild (`POST /v1/rules/rebuild`) reads these
    rows + adjusts the underlying observation weights so the next
    rebuild's `legal_neighbors` distribution biases toward the
    placements humans approved + away from the ones they rejected.

    `kind` is the dimension being judged:
      - `'metatile_placement'`: a specific (resolved_slug, x, y, metatile_id)
      - `'adjacency_pair'`: a specific (metatile_a, direction, metatile_b)
      - `'template'`: a specific template_slug
    The payload field carries the type-specific data.
    """

    __tablename__ = "human_overrides"

    id: Mapped[int] = mapped_column(PrimaryBigInt, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    label: Mapped[str] = mapped_column(String(16))  # 'good' | 'bad' | 'neutral'
    weight: Mapped[float] = mapped_column(Numeric(5, 2), default=1.0)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    scope: Mapped[str] = mapped_column(String(16), default="global")
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    __table_args__ = (
        Index("idx_human_overrides_kind_label", "kind", "label"),
    )


__all__ = [
    "Base",
    "Tileset",
    "Tile",
    "Metatile",
    "Palette",
    "Behavior",
    "TagTaxonomy",
    "MetatileTag",
    "TileTag",
    "AdjacencyObservation",
    "AdjacencyRule",
    "AdjacencyPattern",
    "Template",
    "TemplateUsage",
    "EmbeddingsLookup",
    "HumanOverride",
]
