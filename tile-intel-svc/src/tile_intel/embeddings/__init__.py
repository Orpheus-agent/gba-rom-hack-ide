"""Embeddings - Phase 8D."""

from __future__ import annotations

from tile_intel.embeddings.base import (
    MAPS_COLLECTION,
    METATILES_COLLECTION,
    TILESETS_COLLECTION,
    Embedder,
    MetatileRenderingInput,
)
from tile_intel.embeddings.hash_embedder import HashEmbedder

__all__ = [
    "Embedder",
    "MetatileRenderingInput",
    "HashEmbedder",
    "METATILES_COLLECTION",
    "TILESETS_COLLECTION",
    "MAPS_COLLECTION",
    "get_default_embedder",
]


def get_default_embedder() -> Embedder:
    """Return the production embedder.

    Phase 8D-1 ships only the hash-based mock. Phase 8D-1b (a
    follow-up the user runs after installing open-clip-torch) will
    return a real CLIP ViT-B/32 instance when the dep is detected.
    Until then we use the hash embedder so the pipeline is
    operational + tests stay fast.
    """

    return HashEmbedder(dim=512)
