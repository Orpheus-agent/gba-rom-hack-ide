"""Phase 8E-3 - Community-pack registry + ingest tests."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image  # type: ignore[import-untyped]

from tile_intel.app import create_app
from tile_intel.ingest.community_packs import (
    CommunityPack,
    REGISTRY_FILE,
    build_pack_corpus,
    list_community_packs,
)
from tile_intel.storage.base import make_inmemory_factory


@pytest.fixture
def factory():
    f = make_inmemory_factory()
    f.create_all()
    yield f
    f.drop_all()


@pytest.fixture
def client(factory):
    return TestClient(create_app(storage_factory=factory))


def _build_grid_png(cell_size: int, cols: int, rows: int) -> bytes:
    img = Image.new("RGBA", (cols * cell_size, rows * cell_size), (0, 0, 0, 255))
    pixels = img.load()
    for ry in range(rows):
        for rx in range(cols):
            r = (rx * 37) % 256
            g = (ry * 67) % 256
            b = ((rx * 41 + ry * 53) * 7) % 256
            for y in range(cell_size):
                for x in range(cell_size):
                    pixels[rx * cell_size + x, ry * cell_size + y] = (r, g, b, 255)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Registry parsing
# ---------------------------------------------------------------------------


def test_list_community_packs_returns_curated_entries():
    packs = list_community_packs()
    # Registry ships 10 hand-picked entries.
    assert len(packs) == 10
    slugs = {p.slug for p in packs}
    assert "kyledove-hgss-style" in slugs
    assert "pokemonruby-rip-rgss" in slugs


def test_each_pack_has_required_fields():
    for pack in list_community_packs():
        assert pack.slug
        assert pack.display_name
        assert pack.source_url
        assert pack.attribution
        assert pack.license_spdx
        assert pack.palette_strategy in {"per-sheet", "per-pack", "native-indexed"}


# ---------------------------------------------------------------------------
# Pack corpus builder
# ---------------------------------------------------------------------------


def test_build_pack_corpus_emits_ir(tmp_path: Path):
    pack = CommunityPack(
        slug="test-pack",
        display_name="Test Pack",
        source_url="https://example.com",
        attribution="Test attrib",
        license_spdx="CC0-1.0",
        cell_size=16,
        padding=0,
        palette_strategy="per-sheet",
        notes="",
    )
    png_path = tmp_path / "sheet1.png"
    png_path.write_bytes(_build_grid_png(16, 4, 4))
    corpus, reports = build_pack_corpus(pack, [png_path])
    assert corpus["source"] == "community"
    assert len(corpus["tilesets"]) == 1
    ts = corpus["tilesets"][0]
    assert ts["slug"] == "test-pack-sheet1"
    assert ts["family"] == "community"
    assert ts["isSecondary"] is False
    assert ts["licenseSpdx"] == "CC0-1.0"
    assert ts["metatileCount"] == 16
    assert reports[0].detected_cell_size == 16
    assert reports[0].confidence in {"high", "medium"}


def test_build_pack_corpus_falls_back_to_inference(tmp_path: Path):
    """When the registry omits cell_size, the inference module
    runs and picks a stride. We don't care which stride the
    synth image lands on - just that we got SOME pages out."""

    pack = CommunityPack(
        slug="test-pack",
        display_name="Test Pack",
        source_url="https://example.com",
        attribution="Test attrib",
        license_spdx="unknown",
        cell_size=None,
        padding=0,
        palette_strategy="per-sheet",
        notes="",
    )
    png_path = tmp_path / "sheet.png"
    png_path.write_bytes(_build_grid_png(32, 3, 3))
    corpus, reports = build_pack_corpus(pack, [png_path])
    assert len(corpus["tilesets"]) >= 1
    assert reports[0].detected_cell_size is not None


# ---------------------------------------------------------------------------
# FastAPI endpoints
# ---------------------------------------------------------------------------


def test_known_packs_endpoint(client):
    resp = client.get("/v1/ingest/pack/known")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["packs"]) == 10
    assert {"slug", "display_name", "license_spdx", "cell_size"}.issubset(
        body["packs"][0].keys()
    )


def test_ingest_pack_endpoint_404_unknown_slug(client):
    resp = client.post(
        "/v1/ingest/pack",
        json={"pack_slug": "no-such-pack", "extracted_dir": "/tmp"},
    )
    assert resp.status_code == 404


def test_ingest_pack_endpoint_404_missing_dir(client):
    resp = client.post(
        "/v1/ingest/pack",
        json={
            "pack_slug": "kyledove-hgss-style",
            "extracted_dir": "/does/not/exist",
        },
    )
    assert resp.status_code == 404


def test_ingest_pack_endpoint_ingests_synthetic_sheet(
    client, tmp_path: Path
):
    sheet_dir = tmp_path / "kyledove-extract"
    sheet_dir.mkdir()
    (sheet_dir / "sheet1.png").write_bytes(_build_grid_png(16, 4, 4))
    resp = client.post(
        "/v1/ingest/pack",
        json={
            "pack_slug": "kyledove-hgss-style",
            "extracted_dir": str(sheet_dir),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ingest"]["tilesets_upserted"] == 1
    assert body["ingest"]["metatiles_upserted"] == 16
    assert len(body["reports"]) == 1
    assert body["reports"][0]["detected_cell_size"] == 16


def test_ingest_pack_endpoint_rejects_empty_dir(
    client, tmp_path: Path
):
    sheet_dir = tmp_path / "empty-extract"
    sheet_dir.mkdir()
    resp = client.post(
        "/v1/ingest/pack",
        json={
            "pack_slug": "kyledove-hgss-style",
            "extracted_dir": str(sheet_dir),
        },
    )
    assert resp.status_code == 400
