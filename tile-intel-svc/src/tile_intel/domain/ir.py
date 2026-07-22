"""Phase 8B-2 - Pydantic mirror of the Tile-Intel IR.

Mirrors the TypeScript interfaces in `app/shared/src/tile-intel-ir.ts`.
A CI step (Phase 8B-3 follow-up) will diff this module's
`TileIntelIRCorpus.model_json_schema()` output against the Zod
schema's JSON Schema export to keep the two languages in lock-step.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Schema-version literals exported as type aliases so callers can
# narrow on them.
IRSchemaVersion = Literal[1]
IRSource = Literal[
    "pret-firered",
    "pret-emerald",
    "cfru",
    "dpe",
    "essentials",
    "community",
    "user",
]
# Phase 8E extension - `'essentials'` for Pokémon Essentials stock
# tilesets, `'community'` for hand-picked community packs. Both are
# atomic (empty composition).
IRFamily = Literal["frlg", "rse", "essentials", "community"]


class IRMetatileSlot(BaseModel):
    """One quadrant inside a metatile composition."""

    model_config = ConfigDict(extra="forbid")

    layer: Literal[0, 1]
    quad: Literal[0, 1, 2, 3]
    tileIndex: int = Field(ge=0, le=0x3ff)
    hflip: bool
    vflip: bool
    paletteIndex: int = Field(ge=0, le=15)


class IRMetatile(BaseModel):
    """One metatile.

    Gen-3 (FRLG / RSE) metatiles are 16×16 composed of 2×2 quads
    drawn from 8×8 tiles in two layers - `composition` carries 8
    slots in that case.

    Phase 8E community formats (Essentials, hand-picked packs) are
    ATOMIC: each cell is one indivisible PNG and there's no 8-slot
    composition to record. We allow `composition: []` for those.
    """

    model_config = ConfigDict(extra="forbid")

    metatileIndex: int = Field(ge=0, le=0x3ff)
    attrRawHex: str = Field(pattern=r"^[0-9a-f]+$")
    behaviorId: int = Field(ge=0, le=0x1ff)
    terrainType: int = Field(ge=0, le=0x1f)
    encounterType: int = Field(ge=0, le=0x7)
    layerType: int = Field(ge=0, le=0x3)
    # Either empty (atomic non-gen3 tile) or exactly 8 slots (gen-3
    # 2-layer × 4-quad composition).
    composition: list[IRMetatileSlot] = Field(max_length=8)
    renderedHashHex: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]+$")
    phashHex: str = Field(min_length=16, max_length=16, pattern=r"^[0-9a-f]+$")


class IRTile(BaseModel):
    """One 8×8 tile in a tileset's tile-table."""

    model_config = ConfigDict(extra="forbid")

    tileIndex: int = Field(ge=0, le=0x3ff)
    pixelBytesHex: str = Field(min_length=128, max_length=128, pattern=r"^[0-9a-f]+$")
    pixelHashHex: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]+$")
    paletteNeutralHashHex: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]+$")
    phashHex: str = Field(min_length=16, max_length=16, pattern=r"^[0-9a-f]+$")
    isBlank: bool
    isHorizontallySymmetric: bool
    isVerticallySymmetric: bool


class IRPalette(BaseModel):
    """One 16-color palette block."""

    model_config = ConfigDict(extra="forbid")

    paletteIndex: int = Field(ge=0, le=15)
    bgr555Hex: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]+$")
    medianCut5: list[str] = Field(min_length=1, max_length=5)
    dominantHue: int | None = Field(default=None, ge=0, le=359)
    luminanceAvg: int = Field(ge=0, le=255)


class IRTileset(BaseModel):
    """A complete tileset record."""

    model_config = ConfigDict(extra="forbid")

    slug: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    displayName: str = Field(min_length=1, max_length=200)
    source: IRSource
    sourceCommit: str | None = Field(default=None, min_length=7, max_length=64)
    attribution: str = Field(min_length=1, max_length=500)
    licenseSpdx: str = Field(min_length=1, max_length=64)
    family: IRFamily
    isSecondary: bool
    isCompressed: bool
    tileCount: int = Field(ge=0, le=0x400)
    metatileCount: int = Field(ge=0, le=0x400)
    palettes: list[IRPalette] = Field(max_length=16)
    tiles: list[IRTile] = Field(max_length=0x400)
    metatiles: list[IRMetatile] = Field(max_length=0x400)


class IRAdjacencyObservation(BaseModel):
    """One co-occurrence observation."""

    model_config = ConfigDict(extra="forbid")

    tilesetSlugA: str
    metatileIndexA: int = Field(ge=0, le=0x3ff)
    tilesetSlugB: str
    metatileIndexB: int = Field(ge=0, le=0x3ff)
    direction: Literal[0, 1, 2, 3, 4, 5, 6, 7]
    frequency: int = Field(ge=1, le=1_000_000)


class IRPatternCell(BaseModel):
    """One cell inside a multi-cell pattern."""

    model_config = ConfigDict(extra="forbid")

    tilesetSlug: str
    metatileIndex: int = Field(ge=0, le=0x3FF)


class IRPattern(BaseModel):
    """One multi-cell pattern observation. Phase 8C-4 only emits
    `shape == '3x3'`; future phases may add other shapes."""

    model_config = ConfigDict(extra="forbid")

    shape: Literal["3x3"]
    width: int = Field(ge=1, le=8)
    height: int = Field(ge=1, le=8)
    cells: list[IRPatternCell]
    frequency: int = Field(ge=1, le=1_000_000)


class IRMapAdjacency(BaseModel):
    """One map's adjacency observations."""

    model_config = ConfigDict(extra="forbid")

    mapSlug: str = Field(min_length=1, max_length=200)
    primaryTilesetSlug: str
    secondaryTilesetSlug: str
    width: int = Field(ge=1, le=1024)
    height: int = Field(ge=1, le=1024)
    observations: list[IRAdjacencyObservation]
    patterns: list[IRPattern] = Field(default_factory=list)


class IRCorpus(BaseModel):
    """Top-level corpus shape."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: IRSchemaVersion
    generatedAtUtc: str
    source: IRSource
    toolingVersion: str
    tilesets: list[IRTileset]
    mapAdjacencies: list[IRMapAdjacency]
