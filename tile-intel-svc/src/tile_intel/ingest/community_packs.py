"""Phase 8E-3 - Community-pack registry + ingest workflow.

Reads `tile-intel-svc/data/community-packs.yaml` and exposes:

  - `list_community_packs()` - the registry as a list of
    `CommunityPack` dataclass instances, used by the
    `/v1/ingest/pack/known` endpoint to surface available
    packs in the UI.

  - `ingest_pack_from_png_paths()` - turn a directory of PNGs
    (already-extracted pack archive) into IR tilesets using the
    Phase 8E-2 grid-inference module + a per-PNG palette quantize,
    and ingest them into the sidecar's storage. Used by the
    `/v1/ingest/pack` endpoint and by the `tile-intel ingest-pack`
    CLI command.

Packs are ingested as `family='community'`, `source='community'`,
`license_spdx=<from registry>`. Their slugs are prefixed with the
registry's `slug` field so packs from different sources never
collide.

This module is the pivot point between Phase 8E-2's grid inference
and the sidecar's already-shipping JSON-corpus ingest pipeline - 
we reuse `ingest_corpus()` end-to-end after building an IR.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import yaml  # type: ignore[import-untyped]

from tile_intel.ingest.grid_inference import (
    GridInferenceResult,
    infer_grid,
    slice_grid,
)


PaletteStrategy = Literal["per-sheet", "per-pack", "native-indexed"]


@dataclass(frozen=True)
class CommunityPack:
    slug: str
    display_name: str
    source_url: str
    attribution: str
    license_spdx: str
    cell_size: int | None
    padding: int
    palette_strategy: PaletteStrategy
    notes: str


@dataclass(frozen=True)
class PackIngestReport:
    pack_slug: str
    tileset_count: int
    cell_count: int
    detected_cell_size: int | None
    detected_padding: int
    confidence: str
    warnings: list[str] = field(default_factory=list)


REGISTRY_FILE = (
    Path(__file__).resolve().parents[3] / "data" / "community-packs.yaml"
)


def list_community_packs(
    registry_path: Path = REGISTRY_FILE,
) -> list[CommunityPack]:
    """Parse the YAML registry."""

    if not registry_path.exists():
        return []
    raw = yaml.safe_load(registry_path.read_text(encoding="utf-8"))
    out: list[CommunityPack] = []
    for entry in raw.get("packs", []) or []:
        out.append(
            CommunityPack(
                slug=str(entry["slug"]),
                display_name=str(entry.get("display_name", entry["slug"])),
                source_url=str(entry.get("source_url", "")),
                attribution=str(entry.get("attribution", "")),
                license_spdx=str(entry.get("license_spdx", "unknown")),
                cell_size=int(entry["cell_size"])
                if entry.get("cell_size") is not None
                else None,
                padding=int(entry.get("padding", 0)),
                palette_strategy=str(entry.get("palette_strategy", "per-sheet")),  # type: ignore[arg-type]
                notes=str(entry.get("notes", "")),
            )
        )
    return out


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _phash64(rgba: bytes, width: int, height: int) -> bytes:
    """8x8 mean-luminance perceptual hash - mirrors the Node
    miner's algorithm so cross-source phashes line up."""

    if width <= 0 or height <= 0:
        return b"\x00" * 8
    grid = [0.0] * 64
    for by in range(8):
        for bx in range(8):
            x0 = (bx * width) // 8
            x1 = ((bx + 1) * width) // 8
            y0 = (by * height) // 8
            y1 = ((by + 1) * height) // 8
            total = 0.0
            count = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    i = (y * width + x) * 4
                    r = rgba[i]
                    g = rgba[i + 1]
                    b = rgba[i + 2]
                    total += 0.299 * r + 0.587 * g + 0.114 * b
                    count += 1
            grid[by * 8 + bx] = total / count if count else 0.0
    mean = sum(grid) / 64
    out = bytearray(8)
    for i, v in enumerate(grid):
        if v > mean:
            out[i >> 3] |= 1 << (i & 7)
    return bytes(out)


def _median_cut_palette16(rgba: bytes) -> tuple[bytes, list[int]]:
    """Synthesize a 16-color palette via median-cut. Returns
    (bgr555_hex, rgba_lookup). Mirrors the Node miner."""

    samples: list[tuple[int, int, int]] = []
    stride = max(1, len(rgba) // (4 * 4096))
    for i in range(0, len(rgba), 4 * stride):
        r = rgba[i]
        g = rgba[i + 1]
        b = rgba[i + 2]
        a = rgba[i + 3]
        if a < 16:
            continue
        samples.append((r, g, b))
    if not samples:
        samples.append((0, 0, 0))
    buckets = [samples]
    while len(buckets) < 16:
        max_idx = 0
        max_range = -1
        split_axis = 0
        for bi, bucket in enumerate(buckets):
            if len(bucket) <= 1:
                continue
            rs = [s[0] for s in bucket]
            gs = [s[1] for s in bucket]
            bs = [s[2] for s in bucket]
            rR = max(rs) - min(rs)
            rG = max(gs) - min(gs)
            rB = max(bs) - min(bs)
            r = max(rR, rG, rB)
            if r > max_range:
                max_range = r
                max_idx = bi
                split_axis = 0 if rR >= rG and rR >= rB else (1 if rG >= rB else 2)
        if max_range <= 0:
            break
        target = buckets[max_idx]
        target.sort(key=lambda s: s[split_axis])
        mid = len(target) // 2
        buckets[max_idx] = target[:mid]
        buckets.append(target[mid:])

    palette: list[tuple[int, int, int]] = []
    for bucket in buckets:
        if not bucket:
            palette.append((0, 0, 0))
            continue
        r = sum(s[0] for s in bucket) // len(bucket)
        g = sum(s[1] for s in bucket) // len(bucket)
        b = sum(s[2] for s in bucket) // len(bucket)
        palette.append((r, g, b))
    while len(palette) < 16:
        palette.append((0, 0, 0))

    bgr555 = bytearray(32)
    rgba_lookup: list[int] = []
    for i, (r, g, b) in enumerate(palette[:16]):
        r5 = (r >> 3) & 0x1F
        g5 = (g >> 3) & 0x1F
        b5 = (b >> 3) & 0x1F
        word = r5 | (g5 << 5) | (b5 << 10)
        bgr555[i * 2] = word & 0xFF
        bgr555[i * 2 + 1] = (word >> 8) & 0xFF
        r8 = (r5 << 3) | (r5 >> 2)
        g8 = (g5 << 3) | (g5 >> 2)
        b8 = (b5 << 3) | (b5 >> 2)
        rgba_lookup.append(
            (r8 | (g8 << 8) | (b8 << 16) | (0xFF << 24)) & 0xFFFFFFFF
        )
    return bytes(bgr555), rgba_lookup


def _rgba_cell_to_indexed_8x8(
    rgba: bytes, cell_size: int, lookup: list[int]
) -> bytes:
    """Downsample to one 8x8 indexed tile by nearest-neighbor."""

    out = bytearray(64)
    for ty in range(8):
        for tx in range(8):
            sx = ((tx * 2 + 1) * cell_size) // 16
            sy = ((ty * 2 + 1) * cell_size) // 16
            if sx >= cell_size:
                sx = cell_size - 1
            if sy >= cell_size:
                sy = cell_size - 1
            idx = (sy * cell_size + sx) * 4
            r = rgba[idx]
            g = rgba[idx + 1]
            b = rgba[idx + 2]
            best = 0
            best_d = 1 << 30
            for k, p in enumerate(lookup):
                dr = (p & 0xFF) - r
                dg = ((p >> 8) & 0xFF) - g
                db = ((p >> 16) & 0xFF) - b
                d = dr * dr + dg * dg + db * db
                if d < best_d:
                    best_d = d
                    best = k
            out[ty * 8 + tx] = best
    return bytes(out)


def build_pack_corpus(
    pack: CommunityPack,
    png_files: list[Path],
    cell_size_override: int | None = None,
) -> tuple[dict, list[PackIngestReport]]:
    """Build a JSON IR corpus from a list of PNG files belonging to
    `pack`. Returns the corpus dict + per-PNG inference reports
    so callers can surface the inference confidence to the user.

    Each PNG yields one or more "page" tilesets (chunked at 1024
    cells to stay under the IR's u10 metatileIndex cap)."""

    tilesets: list[dict] = []
    reports: list[PackIngestReport] = []

    for png_path in png_files:
        png_bytes = png_path.read_bytes()
        cell_size = cell_size_override or pack.cell_size
        padding = pack.padding
        if cell_size is None:
            result: GridInferenceResult = infer_grid(png_bytes)
            if result.tile_size is None:
                reports.append(
                    PackIngestReport(
                        pack_slug=pack.slug,
                        tileset_count=0,
                        cell_count=0,
                        detected_cell_size=None,
                        detected_padding=0,
                        confidence=result.confidence,
                        warnings=[
                            f"could not infer grid for {png_path.name}; "
                            f"specify cell_size in registry"
                        ]
                        + result.notes,
                    )
                )
                continue
            cell_size = result.tile_size
            padding = result.padding
            confidence = result.confidence
            inference_notes = result.notes
        else:
            confidence = "high"  # caller-supplied
            inference_notes = []

        cells, cols, rows = slice_grid(png_bytes, cell_size, padding)
        # Build palette from the full sheet (per-sheet strategy is
        # the default; per-pack is a future enhancement).
        from io import BytesIO

        from PIL import Image  # type: ignore[import-untyped]

        img = Image.open(BytesIO(png_bytes)).convert("RGBA")
        full_rgba = bytes(img.tobytes())
        bgr555, rgba_lookup = _median_cut_palette16(full_rgba)

        # Chunk cells into pages of up to 1024.
        PAGE_MAX = 1024
        page_count = max(1, (len(cells) + PAGE_MAX - 1) // PAGE_MAX)

        for page in range(page_count):
            start = page * PAGE_MAX
            end = min(len(cells), start + PAGE_MAX)
            page_cells = cells[start:end]
            tile_entries = []
            metatile_entries = []
            for idx, cell in enumerate(page_cells):
                indexed = _rgba_cell_to_indexed_8x8(
                    cell.rgba, cell_size, rgba_lookup
                )
                phash = _phash64(cell.rgba, cell.width, cell.height)
                indexed_hex = indexed.hex()
                tile_entries.append(
                    {
                        "tileIndex": idx,
                        "pixelBytesHex": indexed_hex,
                        "pixelHashHex": _sha256_hex(indexed),
                        "paletteNeutralHashHex": _sha256_hex(indexed),
                        "phashHex": phash.hex(),
                        "isBlank": all(
                            indexed[i] == indexed[0] for i in range(64)
                        ),
                        "isHorizontallySymmetric": False,
                        "isVerticallySymmetric": False,
                    }
                )
                metatile_entries.append(
                    {
                        "metatileIndex": idx,
                        "attrRawHex": "00000000",
                        "behaviorId": 0,
                        "terrainType": 0,
                        "encounterType": 0,
                        "layerType": 0,
                        "composition": [],
                        "renderedHashHex": _sha256_hex(cell.rgba),
                        "phashHex": phash.hex(),
                    }
                )

            sheet_stem = png_path.stem.lower().replace(" ", "-")
            slug_base = f"{pack.slug}-{sheet_stem}"
            slug = slug_base if page_count == 1 else f"{slug_base}-page-{page}"
            display_name = (
                pack.display_name
                if page_count == 1
                else f"{pack.display_name} - {sheet_stem} (page {page + 1}/{page_count})"
            )

            tilesets.append(
                {
                    "slug": slug,
                    "displayName": display_name,
                    "source": "community",
                    "sourceCommit": None,
                    "attribution": pack.attribution,
                    "licenseSpdx": pack.license_spdx,
                    "family": "community",
                    "isSecondary": False,
                    "isCompressed": False,
                    "tileCount": len(tile_entries),
                    "metatileCount": len(metatile_entries),
                    "palettes": [
                        {
                            "paletteIndex": 0,
                            "bgr555Hex": bgr555.hex(),
                            "medianCut5": ["#000000"] * 5,
                            "dominantHue": None,
                            "luminanceAvg": 128,
                        }
                    ],
                    "tiles": tile_entries,
                    "metatiles": metatile_entries,
                }
            )

        reports.append(
            PackIngestReport(
                pack_slug=pack.slug,
                tileset_count=page_count,
                cell_count=len(cells),
                detected_cell_size=cell_size,
                detected_padding=padding,
                confidence=confidence,
                warnings=inference_notes,
            )
        )

    corpus = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
        .replace(".000Z", "Z"),
        "source": "community",
        "toolingVersion": "8E-3",
        "tilesets": tilesets,
        "mapAdjacencies": [],
    }
    return corpus, reports


__all__ = [
    "CommunityPack",
    "PackIngestReport",
    "build_pack_corpus",
    "list_community_packs",
    "REGISTRY_FILE",
]


# Suppress unused-import warnings for the JSON helper used by tests
# that round-trip the corpus to a file.
_REEXPORT = (json,)  # noqa: F841
