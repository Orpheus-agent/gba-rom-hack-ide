"""Phase 8B-2 - FastAPI router for ingest endpoints."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from tile_intel.domain.ir import IRCorpus
from tile_intel.ingest.json_corpus import IngestReport, ingest_corpus
from tile_intel.storage.base import SqlAlchemyStorageFactory

router = APIRouter(prefix="/v1/ingest", tags=["ingest"])


class IngestJsonCorpusRequest(BaseModel):
    """Either `path` (server-side filesystem path to a JSON file) or
    `corpus` (inline) - never both. The supervisor (Phase 8A-4) sends
    `path` to avoid round-tripping 75 MB JSON over the wire."""

    path: str | None = Field(default=None, description="Server-relative path to corpus JSON.")
    corpus: dict | None = Field(default=None, description="Inline corpus payload (small or test).")


class IngestJsonCorpusResponse(BaseModel):
    """Counts emitted by ingest_corpus()."""

    tilesets_upserted: int
    tiles_upserted: int
    metatiles_upserted: int
    palettes_upserted: int
    adjacency_observations_upserted: int
    adjacency_patterns_upserted: int = 0
    skipped: int


def _report_to_response(report: IngestReport) -> IngestJsonCorpusResponse:
    return IngestJsonCorpusResponse(
        tilesets_upserted=report.tilesets_upserted,
        tiles_upserted=report.tiles_upserted,
        metatiles_upserted=report.metatiles_upserted,
        palettes_upserted=report.palettes_upserted,
        adjacency_observations_upserted=report.adjacency_observations_upserted,
        adjacency_patterns_upserted=report.adjacency_patterns_upserted,
        skipped=report.skipped,
    )


def get_storage_factory_dependency() -> SqlAlchemyStorageFactory:
    """Overridden by app.py at startup time. The default raises so
    misconfiguration is loud, not silent."""

    raise RuntimeError(
        "storage factory not configured - register an override via app.dependency_overrides"
    )


@router.post("/json-corpus", response_model=IngestJsonCorpusResponse)
async def ingest_json_corpus(
    request: IngestJsonCorpusRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> IngestJsonCorpusResponse:
    """Idempotent corpus ingest.

    Pass either `path` (preferred - avoids large request bodies) or
    `corpus` (inline; useful for tests + small synthetic corpora).
    """

    if request.path is None and request.corpus is None:
        raise HTTPException(
            status_code=400,
            detail="exactly one of `path` or `corpus` must be provided",
        )
    if request.path is not None and request.corpus is not None:
        raise HTTPException(
            status_code=400,
            detail="`path` and `corpus` are mutually exclusive",
        )

    if request.path is not None:
        path = Path(request.path)
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"corpus path not found: {path}")
        raw = path.read_text(encoding="utf-8")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"invalid JSON: {e}") from e
    else:
        payload = request.corpus

    try:
        corpus = IRCorpus.model_validate(payload)
    except Exception as e:  # pydantic.ValidationError + others
        raise HTTPException(status_code=400, detail=f"corpus failed IR validation: {e}") from e

    report = ingest_corpus(factory, corpus)
    return _report_to_response(report)


# ---------------------------------------------------------------------------
# Phase 8E-3 - Community-pack listing + ingest
# ---------------------------------------------------------------------------


class CommunityPackPayload(BaseModel):
    slug: str
    display_name: str
    source_url: str
    attribution: str
    license_spdx: str
    cell_size: int | None
    padding: int
    palette_strategy: str
    notes: str


class ListPacksResponse(BaseModel):
    packs: list[CommunityPackPayload]


@router.get("/pack/known", response_model=ListPacksResponse)
async def list_known_packs_endpoint() -> ListPacksResponse:
    """Phase 8E-3 - Return the curated community-pack registry."""

    from tile_intel.ingest.community_packs import list_community_packs

    packs = list_community_packs()
    return ListPacksResponse(
        packs=[
            CommunityPackPayload(
                slug=p.slug,
                display_name=p.display_name,
                source_url=p.source_url,
                attribution=p.attribution,
                license_spdx=p.license_spdx,
                cell_size=p.cell_size,
                padding=p.padding,
                palette_strategy=p.palette_strategy,
                notes=p.notes,
            )
            for p in packs
        ]
    )


class IngestPackRequest(BaseModel):
    """Inputs for POST /v1/ingest/pack.

    The pack must already be extracted on the server's filesystem
    (we don't fetch archives over the network from the sidecar).
    `pack_slug` keys into the curated registry for metadata;
    `extracted_dir` points at the directory containing PNG sheets.
    """

    pack_slug: str = Field(min_length=1, max_length=120)
    extracted_dir: str = Field(min_length=1)
    # Optional override for the registry's cell_size - useful when
    # the registry says "varies per sheet" or the user wants to
    # re-slice an existing pack with a different grid.
    cell_size_override: int | None = Field(default=None, ge=8, le=128)


class IngestPackReportPayload(BaseModel):
    pack_slug: str
    tileset_count: int
    cell_count: int
    detected_cell_size: int | None
    detected_padding: int
    confidence: str
    warnings: list[str]


class IngestPackResponse(BaseModel):
    ingest: IngestJsonCorpusResponse
    reports: list[IngestPackReportPayload]


@router.post("/pack", response_model=IngestPackResponse)
async def ingest_pack_endpoint(
    request: IngestPackRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> IngestPackResponse:
    """Phase 8E-3 - Ingest a community-pack directory.

    Walks `extracted_dir` for PNGs, infers each sheet's grid via
    Phase 8E-2 (or uses the registry-supplied cell_size), builds an
    IR corpus, and pipes it through the existing JSON-corpus
    ingest pipeline.
    """

    from tile_intel.ingest.community_packs import (
        build_pack_corpus,
        list_community_packs,
    )

    packs_by_slug = {p.slug: p for p in list_community_packs()}
    pack = packs_by_slug.get(request.pack_slug)
    if pack is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown pack slug: {request.pack_slug!r}",
        )
    dir_path = Path(request.extracted_dir)
    if not dir_path.exists() or not dir_path.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"extracted_dir does not exist or is not a directory: {dir_path}",
        )

    png_files = sorted(dir_path.rglob("*.png"))
    if not png_files:
        raise HTTPException(
            status_code=400,
            detail=f"no PNG files found under {dir_path}",
        )

    corpus_dict, reports = build_pack_corpus(
        pack,
        png_files,
        cell_size_override=request.cell_size_override,
    )
    try:
        corpus = IRCorpus.model_validate(corpus_dict)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail=f"pack corpus failed IR validation: {e}",
        ) from e
    report = ingest_corpus(factory, corpus)
    return IngestPackResponse(
        ingest=_report_to_response(report),
        reports=[
            IngestPackReportPayload(
                pack_slug=r.pack_slug,
                tileset_count=r.tileset_count,
                cell_count=r.cell_count,
                detected_cell_size=r.detected_cell_size,
                detected_padding=r.detected_padding,
                confidence=r.confidence,
                warnings=r.warnings,
            )
            for r in reports
        ],
    )
