"""Phase 8E-2 - Tile-grid inference + auto-slicing.

Given a PNG of unknown grid layout, detect:

  - The likely tile size (8, 16, 24, 32, or 48 px) via repeating-
    edge autocorrelation: walk candidate strides and score how well
    each row/column boundary lines up with image-content
    discontinuities (a 32-pixel grid will produce strong horizontal
    + vertical edges every 32 px because each tile starts a new
    pattern).

  - Padding / spacers between tiles (1-pixel gridlines, common in
    DeviantArt-era packs). Detected by checking whether the
    inferred boundary rows/columns themselves are mostly-uniform
    in color.

  - A confidence score the caller can surface in the UI.

This module is pure-Python (NumPy-friendly when available, falls
back to a slow nested-loop variant otherwise). Used by the
Phase 8E-3 community-pack registry to validate / auto-detect the
grid of a freshly-extracted pack archive before ingesting.

The inference is intentionally conservative: returns
`confidence: 'low'` when no candidate stride scores significantly
better than its neighbours, so the caller can ask the user to
specify the grid manually.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# numpy is in requirements transitively (sqlalchemy + pydantic don't
# pull it; we import it lazily where it actually helps).

Confidence = Literal["high", "medium", "low"]

_CANDIDATE_TILE_SIZES = (8, 16, 24, 32, 48, 64)


@dataclass(frozen=True)
class GridInferenceResult:
    """Output of `infer_grid`. `tile_size` is `None` when no
    candidate scored above the confidence threshold."""

    tile_size: int | None
    padding: int  # pixels between tiles; 0 = packed tightly
    confidence: Confidence
    # Per-candidate scores so the caller can render a "we tried 8,
    # 16, 24, 32; 32 won by 2.4x" diagnostic.
    candidate_scores: dict[int, float]
    width: int
    height: int
    notes: list[str]


def _decode_png_to_rgba(png_bytes: bytes) -> tuple[bytes, int, int]:
    """Decode a PNG to RGBA bytes via Pillow. We require Pillow at
    inference time even though the rest of the sidecar is
    Pillow-free, because writing a pure-Python PNG decoder is out
    of scope; community packs are heterogeneous + we benefit from
    Pillow's robustness."""

    from io import BytesIO

    from PIL import Image  # type: ignore[import-untyped]

    img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    return bytes(img.tobytes()), img.width, img.height


def _row_signature(rgba: bytes, width: int, height: int) -> list[float]:
    """For each ROW boundary y ∈ [1, height), compute the L1 distance
    between row y and row y-1 (averaged over the row's pixels).
    High values = a content boundary lives here. The boundary
    signature is the cumulative sum of these deltas; tile sizes
    that consistently line up with content discontinuities score
    high.
    """

    out = [0.0]
    row_bytes = width * 4
    for y in range(1, height):
        off_a = (y - 1) * row_bytes
        off_b = y * row_bytes
        total = 0
        for i in range(row_bytes):
            total += abs(rgba[off_a + i] - rgba[off_b + i])
        out.append(total / row_bytes)
    return out


def _col_signature(rgba: bytes, width: int, height: int) -> list[float]:
    """Column-equivalent of `_row_signature`."""

    out = [0.0]
    for x in range(1, width):
        total = 0
        for y in range(height):
            base = (y * width + x) * 4
            for c in range(4):
                total += abs(rgba[base + c] - rgba[base - 4 + c])
        out.append(total / height)
    return out


def _score_stride(sig: list[float], stride: int) -> float:
    """Score the sum of |sig[k*stride]| for k>=1, divided by the
    sum of the rest. A perfect grid scores >>1; noise scores ~1."""

    if stride <= 0 or stride >= len(sig):
        return 0.0
    on_grid = 0.0
    off_grid = 0.0
    for i, v in enumerate(sig):
        if i == 0:
            continue
        if i % stride == 0:
            on_grid += v
        else:
            off_grid += v
    if off_grid <= 0:
        return on_grid * 1000.0  # extreme cases
    on_count = (len(sig) - 1) // stride
    off_count = (len(sig) - 1) - on_count
    if on_count == 0 or off_count == 0:
        return 0.0
    return (on_grid / on_count) / (off_grid / off_count)


def _detect_padding(sig: list[float], stride: int) -> int:
    """If a 1-px gridline separates tiles, the boundary signature
    spikes at (k*stride) AND the row just after it is near-zero
    (gridline is uniform). Detect 0/1/2 px padding by checking
    whether rows right after the spike are quiet."""

    if stride < 4:
        return 0
    score = 0
    samples = 0
    for k in range(1, len(sig) // stride):
        center = k * stride
        if center + 2 >= len(sig):
            break
        if sig[center + 1] < sig[center] * 0.25:
            score += 1
        samples += 1
    if samples == 0:
        return 0
    if score / samples > 0.6:
        return 1
    return 0


def infer_grid(png_bytes: bytes) -> GridInferenceResult:
    """Top-level: decode PNG and infer the tile grid.

    Returns a result the caller can act on:
      - `tile_size` non-None + confidence='high': trust the slice.
      - `tile_size` non-None + confidence='medium': use as a hint;
        let the user override.
      - `tile_size=None` + confidence='low': require manual input.
    """

    rgba, width, height = _decode_png_to_rgba(png_bytes)
    notes: list[str] = []

    if width < 32 or height < 32:
        return GridInferenceResult(
            tile_size=None,
            padding=0,
            confidence="low",
            candidate_scores={},
            width=width,
            height=height,
            notes=[
                f"image too small to infer a grid ({width}x{height}); "
                f"minimum 32x32"
            ],
        )

    row_sig = _row_signature(rgba, width, height)
    col_sig = _col_signature(rgba, width, height)

    candidate_scores: dict[int, float] = {}
    max_score = 0.0
    for stride in _CANDIDATE_TILE_SIZES:
        if stride >= min(width, height):
            continue
        row_score = _score_stride(row_sig, stride)
        col_score = _score_stride(col_sig, stride)
        combined = (row_score + col_score) / 2
        candidate_scores[stride] = combined
        if combined > max_score:
            max_score = combined

    # Subharmonic-aware tiebreak: when cells are solid blocks, a
    # 32-px grid produces equally strong scores at 8, 16, and 32
    # (every 32-divisible boundary is also 16- + 8-divisible). The
    # correct answer is the LARGEST stride that scores within 20%
    # of the max - that's the true grid period.
    near_max_threshold = max_score * 0.8 if max_score > 0 else 0
    qualified = [
        (s, score) for s, score in candidate_scores.items() if score >= near_max_threshold
    ]
    if not qualified:
        return GridInferenceResult(
            tile_size=None,
            padding=0,
            confidence="low",
            candidate_scores=candidate_scores,
            width=width,
            height=height,
            notes=["no candidate stride passed the score threshold"],
        )
    qualified.sort(key=lambda kv: kv[0], reverse=True)
    best_stride = qualified[0][0]
    best_score = qualified[0][1]

    # Now compute confidence by comparing the winner to the largest
    # NON-divisor of it. (Strides that divide the winner are
    # expected to score similarly; the diagnostic is "is there a
    # competing stride that ISN'T a divisor?")
    non_divisor_scores = [
        score
        for s, score in candidate_scores.items()
        if best_stride % s != 0 and s != best_stride
    ]
    runner_up = max(non_divisor_scores, default=0.0)

    if best_score < 1.2:
        confidence: Confidence = "low"
        notes.append(
            f"no candidate stride scored above 1.2× the noise floor "
            f"(best={best_stride}px at {best_score:.2f})"
        )
        return GridInferenceResult(
            tile_size=None,
            padding=0,
            confidence=confidence,
            candidate_scores=candidate_scores,
            width=width,
            height=height,
            notes=notes,
        )

    if runner_up <= 0:
        confidence = "high"  # nothing else competes
    else:
        ratio = best_score / runner_up
        if ratio > 1.5:
            confidence = "high"
        elif ratio > 1.15:
            confidence = "medium"
        else:
            confidence = "low"
            notes.append(
                f"best stride ({best_stride}px) only {ratio:.2f}× better than "
                f"non-divisor runner-up; consider asking the user to confirm"
            )

    # Padding check (use row_sig since rows are usually a stronger
    # signal than columns for sprite sheets).
    padding = _detect_padding(row_sig, best_stride)
    if padding > 0:
        notes.append(
            f"detected {padding}px padding/spacer between tiles"
        )

    # Cross-check: do the image dimensions divide cleanly by the
    # winning stride (accounting for padding)?
    effective = best_stride + padding
    if width % effective != 0:
        notes.append(
            f"width {width} not divisible by {effective}px "
            f"(stride + padding); slicing will truncate"
        )
    if height % effective != 0:
        notes.append(
            f"height {height} not divisible by {effective}px "
            f"(stride + padding); slicing will truncate"
        )

    return GridInferenceResult(
        tile_size=best_stride,
        padding=padding,
        confidence=confidence,
        candidate_scores=candidate_scores,
        width=width,
        height=height,
        notes=notes,
    )


@dataclass(frozen=True)
class SlicedCell:
    """One cell extracted by `slice_grid`."""

    x: int
    y: int
    width: int
    height: int
    # Cell pixels as raw RGBA bytes - caller can hash, embed, etc.
    rgba: bytes


def slice_grid(
    png_bytes: bytes,
    tile_size: int,
    padding: int = 0,
) -> tuple[list[SlicedCell], int, int]:
    """Slice a PNG into (tile_size × tile_size) cells given the
    optional `padding` between them.

    Returns `(cells, cols, rows)`. Cells partially outside the
    image are dropped (truncated edge tiles are not emitted).
    """

    rgba, width, height = _decode_png_to_rgba(png_bytes)
    effective = tile_size + padding
    cols = width // effective
    rows = height // effective
    cells: list[SlicedCell] = []
    for ry in range(rows):
        for rx in range(cols):
            cx = rx * effective
            cy = ry * effective
            buf = bytearray(tile_size * tile_size * 4)
            for y in range(tile_size):
                src_off = ((cy + y) * width + cx) * 4
                dst_off = y * tile_size * 4
                buf[dst_off : dst_off + tile_size * 4] = rgba[
                    src_off : src_off + tile_size * 4
                ]
            cells.append(
                SlicedCell(
                    x=cx,
                    y=cy,
                    width=tile_size,
                    height=tile_size,
                    rgba=bytes(buf),
                )
            )
    return cells, cols, rows


__all__ = [
    "Confidence",
    "GridInferenceResult",
    "SlicedCell",
    "infer_grid",
    "slice_grid",
]
