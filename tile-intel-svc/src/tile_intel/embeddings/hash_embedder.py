"""Phase 8D-1 - Deterministic hash-based embedder.

Stable + dependency-free fallback that gives the rest of the
pipeline something to read while we wait for the user to install
open-clip-torch (Phase 8D-1b). The vectors are NOT meaningful for
visual similarity; they ARE useful for:
  - smoke-testing the end-to-end pipeline (ingest → embed → Qdrant)
  - exact-equality dedup (two identical metatiles produce
    identical vectors)
  - keeping the integration tests Docker-free + GPU-free

When the real CLIP is wired in (8D-1b), swap by changing
`get_default_embedder()` in `embeddings/__init__.py`.
"""

from __future__ import annotations

import hashlib
import math

from tile_intel.embeddings.base import MetatileRenderingInput


class HashEmbedder:
    """SHA-256 of the upsampled RGBA buffer → dim-N float vector.

    The vectors are L2-normalised so cosine similarity falls in
    [-1, 1]. Two identical rgba buffers produce IDENTICAL vectors;
    two different buffers produce vectors with similarity ≈ 0 (the
    hash is not visually meaningful). This is intentional - it
    makes the pipeline test deterministic.
    """

    def __init__(self, dim: int = 512, model_version: str = "1.0.0") -> None:
        if dim <= 0 or dim > 4096:
            raise ValueError("dim must be in (0, 4096]")
        self._dim = dim
        self._model_version = model_version

    @property
    def dim(self) -> int:
        return self._dim

    @property
    def model_id(self) -> str:
        return "hash-sha256-mock"

    @property
    def model_version(self) -> str:
        return self._model_version

    def embed_metatiles(
        self, metatiles: list[MetatileRenderingInput]
    ) -> list[tuple[int, tuple[float, ...]]]:
        out: list[tuple[int, tuple[float, ...]]] = []
        for m in metatiles:
            vec = _hash_to_vector(m.rgba_16x16, self._dim)
            out.append((m.metatile_id, vec))
        return out


def _hash_to_vector(payload: bytes, dim: int) -> tuple[float, ...]:
    """Stable, L2-normalised float vector of length `dim` derived
    from SHA-256(payload). Output values are in roughly [-1, 1]."""

    # Each hash gives 32 bytes; repeat-extend until we have enough.
    raw = bytearray()
    counter = 0
    while len(raw) < dim * 4:
        h = hashlib.sha256(payload + counter.to_bytes(4, "little")).digest()
        raw.extend(h)
        counter += 1
    # Interpret as signed int8 (-128..127), normalise to [-1, 1].
    floats = []
    for i in range(dim):
        b = raw[i * 4]
        signed = b - 128
        floats.append(float(signed) / 128.0)
    norm = math.sqrt(sum(f * f for f in floats))
    if norm <= 0.0:
        return tuple(0.0 for _ in floats)
    return tuple(f / norm for f in floats)
