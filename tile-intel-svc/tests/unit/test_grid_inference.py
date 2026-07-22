"""Phase 8E-2 - Tile-grid inference tests."""

from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image  # type: ignore[import-untyped]

from tile_intel.ingest.grid_inference import infer_grid, slice_grid


def _build_grid_png(
    cell_size: int,
    cols: int,
    rows: int,
    padding: int = 0,
    cell_color_pattern: bool = True,
) -> bytes:
    """Synthesize a PNG with a clear grid: each cell is solid color,
    distinct from its neighbours. Optional 1-px white padding."""

    effective = cell_size + padding
    width = cols * effective
    height = rows * effective
    img = Image.new("RGBA", (width, height), (0, 0, 0, 255))
    pixels = img.load()
    for ry in range(rows):
        for rx in range(cols):
            r = (rx * 37) % 256
            g = (ry * 67) % 256
            b = ((rx * 41 + ry * 53) * 7) % 256 if cell_color_pattern else 128
            for y in range(cell_size):
                for x in range(cell_size):
                    pixels[rx * effective + x, ry * effective + y] = (
                        r,
                        g,
                        b,
                        255,
                    )
            # White padding between cells (if any).
    if padding > 0:
        for ry in range(rows):
            for rx in range(cols):
                for x in range(effective):
                    for p in range(padding):
                        # bottom row of cell + padding
                        if ry < rows - 1:
                            pixels[
                                rx * effective + x,
                                (ry + 1) * effective - padding + p,
                            ] = (255, 255, 255, 255)
                        if rx < cols - 1:
                            pixels[
                                (rx + 1) * effective - padding + p,
                                ry * effective + x,
                            ] = (255, 255, 255, 255)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_infer_grid_detects_32px():
    png = _build_grid_png(32, 4, 4)
    result = infer_grid(png)
    assert result.tile_size == 32
    assert result.confidence in {"medium", "high"}


def test_infer_grid_detects_16px():
    png = _build_grid_png(16, 6, 6)
    result = infer_grid(png)
    assert result.tile_size == 16


def test_infer_grid_returns_none_for_uniform_image():
    img = Image.new("RGBA", (64, 64), (40, 40, 40, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    result = infer_grid(buf.getvalue())
    assert result.tile_size is None
    assert result.confidence == "low"


def test_infer_grid_rejects_too_small():
    img = Image.new("RGBA", (20, 20), (40, 40, 40, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    result = infer_grid(buf.getvalue())
    assert result.tile_size is None
    assert any("too small" in n for n in result.notes)


def test_slice_grid_returns_correct_cell_count():
    png = _build_grid_png(16, 5, 3)
    cells, cols, rows = slice_grid(png, 16, 0)
    assert cols == 5
    assert rows == 3
    assert len(cells) == 15
    # Cell rgba is 16*16*4 bytes.
    assert all(len(c.rgba) == 16 * 16 * 4 for c in cells)


def test_slice_grid_with_padding_skips_lines():
    png = _build_grid_png(16, 3, 3, padding=1)
    cells, cols, rows = slice_grid(png, 16, 1)
    # 16+1 = 17 px per effective cell; 3*17 = 51 px total, but our
    # synth image uses width=3*17 by construction. cols/rows = 3.
    assert cols == 3
    assert rows == 3
    assert len(cells) == 9


def test_infer_grid_scores_capture_all_candidates():
    png = _build_grid_png(32, 4, 4)
    result = infer_grid(png)
    # We probe 8/16/24/32/48/64 (filtered by image size).
    assert 8 in result.candidate_scores
    assert 16 in result.candidate_scores
    assert 32 in result.candidate_scores
    # 32 should be selected - subharmonics (8/16) score equally on
    # synthetic solid-cell images, but the inference picks the
    # largest near-max stride which IS the true grid.
    assert result.tile_size == 32
