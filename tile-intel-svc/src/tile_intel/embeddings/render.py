"""Phase 8D-1 - Metatile rendering pipeline.

Composes 16×16 RGBA bytes for each metatile from its 8-slot
composition + the underlying 8×8 tile pixel buffers + the 16
palette BGR555 blocks. Implemented in pure Python so it has no
torch / NumPy dependency.

The output is intentionally raw bytes (1024 = 16*16*4) rather
than a NumPy array - the embedder takes whatever shape it
prefers. Mock embedder hashes the buffer; real CLIP wraps it
into a PIL Image internally.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import select

from tile_intel.domain.models import Metatile, Palette, Tile, Tileset
from tile_intel.embeddings.base import MetatileRenderingInput


def _bgr555_byte_to_rgba_lookup(palette_bytes: bytes) -> list[tuple[int, int, int, int]]:
    """Decode 32 bytes of BGR555 palette into 16 (r, g, b, a) tuples."""

    if len(palette_bytes) < 32:
        # Pad with black; some palettes are short.
        palette_bytes = palette_bytes + b"\x00" * (32 - len(palette_bytes))
    out = []
    for i in range(16):
        word = palette_bytes[i * 2] | (palette_bytes[i * 2 + 1] << 8)
        r5 = word & 0x1F
        g5 = (word >> 5) & 0x1F
        b5 = (word >> 10) & 0x1F
        r = (r5 << 3) | (r5 >> 2)
        g = (g5 << 3) | (g5 >> 2)
        b = (b5 << 3) | (b5 >> 2)
        out.append((r, g, b, 255))
    return out


def render_metatile_rgba(
    composition: list[dict],
    tile_pixels: dict[int, bytes],
    palettes_rgba: list[list[tuple[int, int, int, int]]],
) -> bytes:
    """Compose one metatile's 8 slots into a 16×16 RGBA buffer.

    `composition`: 8 slot dicts as stored in Postgres
                   (`{layer, quad, tileIndex, hflip, vflip, paletteIndex}`).
    `tile_pixels`: mapping from tile_index → 64-byte palette-indexed
                   pixel buffer. We tolerate missing entries by
                   filling with palette index 0 (transparent).
    `palettes_rgba`: 16 palette lookups, each a list of 16 (r,g,b,a)
                     tuples.

    Returns 16*16*4 = 1024 bytes. Layer 0 is the base; layer 1 is
    overlaid with palette index 0 treated as transparent.
    """

    out = bytearray(16 * 16 * 4)
    for slot in composition:
        layer = int(slot["layer"])
        quad = int(slot["quad"])
        tile_index = int(slot["tileIndex"])
        hflip = bool(slot["hflip"])
        vflip = bool(slot["vflip"])
        palette_index = int(slot["paletteIndex"])

        tile = tile_pixels.get(tile_index)
        if tile is None:
            continue
        if palette_index >= len(palettes_rgba):
            continue
        palette = palettes_rgba[palette_index]
        base_x = 0 if quad % 2 == 0 else 8
        base_y = 0 if quad < 2 else 8
        for py in range(8):
            for px in range(8):
                sx = 7 - px if hflip else px
                sy = 7 - py if vflip else py
                color_index = tile[sy * 8 + sx]
                if layer == 1 and color_index == 0:
                    continue  # transparent
                r, g, b, a = palette[color_index]
                pixel_index = ((base_y + py) * 16 + (base_x + px)) * 4
                out[pixel_index] = r
                out[pixel_index + 1] = g
                out[pixel_index + 2] = b
                out[pixel_index + 3] = a
    return bytes(out)


def nearest_upsample_4x(rgba_16x16: bytes) -> bytes:
    """16×16 RGBA → 64×64 RGBA by nearest-neighbor 4×. CLIP wants
    inputs ≥ 64×64; this is the cheapest way to satisfy that."""

    if len(rgba_16x16) != 16 * 16 * 4:
        raise ValueError(f"expected 1024-byte input, got {len(rgba_16x16)}")
    out = bytearray(64 * 64 * 4)
    for y in range(16):
        for x in range(16):
            src_index = (y * 16 + x) * 4
            r, g, b, a = (
                rgba_16x16[src_index],
                rgba_16x16[src_index + 1],
                rgba_16x16[src_index + 2],
                rgba_16x16[src_index + 3],
            )
            for dy in range(4):
                for dx in range(4):
                    dst_x = x * 4 + dx
                    dst_y = y * 4 + dy
                    dst_index = (dst_y * 64 + dst_x) * 4
                    out[dst_index] = r
                    out[dst_index + 1] = g
                    out[dst_index + 2] = b
                    out[dst_index + 3] = a
    return bytes(out)


def iter_metatile_render_inputs(
    session,
    tileset_id: int | None = None,
) -> Iterator[MetatileRenderingInput]:
    """Yield rendered RGBA + Postgres-id metadata for every metatile.

    Filters to one tileset when `tileset_id` is provided so callers
    can batch by tileset (lets us load tiles + palettes once per
    tileset instead of once per metatile)."""

    # Group metatiles by tileset to amortise tile/palette loads.
    tileset_q = select(Tileset)
    if tileset_id is not None:
        tileset_q = tileset_q.where(Tileset.id == tileset_id)
    for ts in session.execute(tileset_q).scalars():
        # Load all tiles for this tileset.
        tile_rows = session.execute(
            select(Tile.tile_index, Tile.pixel_bytes).where(Tile.tileset_id == ts.id)
        ).all()
        tile_pixels = {int(idx): bytes(pixels) for idx, pixels in tile_rows}
        # Load all 16 palettes.
        palette_rows = session.execute(
            select(Palette.palette_index, Palette.colors_bgr555).where(
                Palette.tileset_id == ts.id
            )
        ).all()
        palettes_bgr555: dict[int, bytes] = {int(i): bytes(p) for i, p in palette_rows}
        palettes_rgba: list[list[tuple[int, int, int, int]]] = []
        for i in range(16):
            pal = palettes_bgr555.get(i, b"\x00" * 32)
            palettes_rgba.append(_bgr555_byte_to_rgba_lookup(pal))

        # Render every metatile in this tileset.
        metatile_rows = session.execute(
            select(
                Metatile.id,
                Metatile.composition,
                Metatile.behavior_id,
                Metatile.is_walkable,
            ).where(Metatile.tileset_id == ts.id)
        ).all()
        for mt_id, composition, behavior_id, is_walkable in metatile_rows:
            rgba = render_metatile_rgba(composition, tile_pixels, palettes_rgba)
            yield MetatileRenderingInput(
                metatile_id=int(mt_id),
                tileset_id=int(ts.id),
                tileset_slug=ts.slug,
                family=ts.family,
                behavior_id=int(behavior_id),
                is_walkable=bool(is_walkable),
                is_secondary=bool(ts.is_secondary),
                rgba_16x16=rgba,
            )
