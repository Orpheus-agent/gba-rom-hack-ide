"""Phase 8J-2 - Curation endpoints.

Lets the user mark generator outputs as good / bad / neutral. The
adjacency-rule rebuild reads these rows to bias the legal-neighbor
distributions.

Three endpoints:

  POST   /v1/curation/overrides - record a new override
  GET    /v1/curation/overrides - list recent overrides
  DELETE /v1/curation/overrides/{id} - recall a misclick
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.domain.models import HumanOverride
from tile_intel.storage.base import SqlAlchemyStorageFactory

router = APIRouter(prefix="/v1/curation", tags=["curation"])


OverrideLabel = Literal["good", "bad", "neutral"]
OverrideKind = Literal[
    "metatile_placement", "adjacency_pair", "template", "region"
]


class CreateOverrideRequest(BaseModel):
    """Inputs for POST /v1/curation/overrides.

    `payload` is opaque JSON - its shape depends on `kind`:
      - metatile_placement: { resolved_slug, x, y, tileset_slug, metatile_index }
      - adjacency_pair: { metatile_a_id, direction, metatile_b_id }
      - template: { template_slug }
      - region: { resolved_slug, rect: {x,y,w,h} }
    """

    kind: OverrideKind
    label: OverrideLabel
    weight: float = Field(default=1.0, ge=0.0, le=10.0)
    payload: dict
    note: str | None = Field(default=None, max_length=2000)
    scope: Literal["global", "project"] = "global"
    project_id: str | None = Field(default=None, max_length=36)


class OverrideEntry(BaseModel):
    id: int
    kind: str
    label: str
    weight: float
    payload: dict
    note: str | None
    created_at: str
    scope: str
    project_id: str | None


class ListOverridesResponse(BaseModel):
    overrides: list[OverrideEntry]
    total: int


@router.post("/overrides", response_model=OverrideEntry)
async def create_override_endpoint(
    request: CreateOverrideRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> OverrideEntry:
    """Persist a new human override."""

    if request.scope == "project" and not request.project_id:
        raise HTTPException(
            status_code=400,
            detail="scope=project requires project_id",
        )
    with factory.session() as session:
        row = HumanOverride(
            kind=request.kind,
            label=request.label,
            weight=request.weight,
            payload=request.payload,
            note=request.note,
            scope=request.scope,
            project_id=request.project_id,
        )
        session.add(row)
        session.flush()
        return OverrideEntry(
            id=int(row.id),
            kind=row.kind,
            label=row.label,
            weight=float(row.weight),
            payload=row.payload,
            note=row.note,
            created_at=str(row.created_at) if row.created_at else "",
            scope=row.scope,
            project_id=row.project_id,
        )


@router.get("/overrides", response_model=ListOverridesResponse)
async def list_overrides_endpoint(
    kind: OverrideKind | None = None,
    label: OverrideLabel | None = None,
    project_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> ListOverridesResponse:
    """List overrides with optional filters."""

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit must be in 1..500")
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")
    with factory.session() as session:
        q = select(HumanOverride)
        if kind is not None:
            q = q.where(HumanOverride.kind == kind)
        if label is not None:
            q = q.where(HumanOverride.label == label)
        if project_id is not None:
            q = q.where(HumanOverride.project_id == project_id)
        total_q = q.order_by(None)
        total = sum(1 for _ in session.execute(total_q).scalars())
        q = q.order_by(desc(HumanOverride.created_at)).limit(limit).offset(offset)
        rows = session.execute(q).scalars().all()
        entries = [
            OverrideEntry(
                id=int(r.id),
                kind=r.kind,
                label=r.label,
                weight=float(r.weight),
                payload=r.payload,
                note=r.note,
                created_at=str(r.created_at) if r.created_at else "",
                scope=r.scope,
                project_id=r.project_id,
            )
            for r in rows
        ]
        return ListOverridesResponse(overrides=entries, total=total)


@router.delete("/overrides/{override_id}")
async def delete_override_endpoint(
    override_id: int,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> dict:
    """Recall (delete) a previously-recorded override."""

    with factory.session() as session:
        row = session.execute(
            select(HumanOverride).where(HumanOverride.id == override_id)
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="override not found")
        session.delete(row)
        return {"deleted": override_id}


class OverrideSummary(BaseModel):
    total: int
    good: int
    bad: int
    neutral: int
    by_kind: dict[str, int]


@router.get("/overrides/summary", response_model=OverrideSummary)
async def overrides_summary_endpoint(
    project_id: str | None = None,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> OverrideSummary:
    """Aggregate counts for the curation surface - used by the
    frontend dashboard tab to show "you've curated 47 placements,
    32 good / 12 bad / 3 neutral"."""

    with factory.session() as session:
        q = select(HumanOverride)
        if project_id is not None:
            q = q.where(HumanOverride.project_id == project_id)
        rows = list(session.execute(q).scalars())
        by_kind: dict[str, int] = {}
        good = 0
        bad = 0
        neutral = 0
        for r in rows:
            by_kind[r.kind] = by_kind.get(r.kind, 0) + 1
            if r.label == "good":
                good += 1
            elif r.label == "bad":
                bad += 1
            elif r.label == "neutral":
                neutral += 1
        return OverrideSummary(
            total=len(rows),
            good=good,
            bad=bad,
            neutral=neutral,
            by_kind=by_kind,
        )
