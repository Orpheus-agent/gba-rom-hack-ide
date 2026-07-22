"""Phase 8D-1 - Embedder protocol + rendering primitives.

The Embedder protocol lets us swap the underlying model (mock hash
for tests, open-clip-torch ViT-B/32 for production) without
touching the ingest pipeline. Both implementations satisfy the
same `dim` + `embed_metatiles` contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class MetatileRenderingInput:
    """One metatile ready to embed: a 16×16 RGBA buffer + the
    Postgres ids it belongs to."""

    metatile_id: int
    tileset_id: int
    tileset_slug: str
    family: str
    behavior_id: int
    is_walkable: bool
    is_secondary: bool
    rgba_16x16: bytes  # 16*16*4 = 1024 bytes


class Embedder(Protocol):
    """Anything that maps a batch of metatile RGBA bytes → vectors."""

    @property
    def dim(self) -> int: ...

    @property
    def model_id(self) -> str: ...

    @property
    def model_version(self) -> str: ...

    def embed_metatiles(
        self, metatiles: list[MetatileRenderingInput]
    ) -> list[tuple[int, tuple[float, ...]]]:
        """Returns `[(metatile_id, vector), ...]` aligned with input
        order. Implementations may batch internally for throughput;
        the API surface stays one-call-per-batch."""


# Qdrant collection name conventions per the Phase 8 plan.
METATILES_COLLECTION = "metatiles_v1"
TILESETS_COLLECTION = "tilesets_v1"
MAPS_COLLECTION = "maps_v1"
