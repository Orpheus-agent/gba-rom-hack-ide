"""FastAPI app - Phase 8A-3 skeleton.

Exposes only `/health` and `/v1/version` at this slice. Subsequent
phases register additional routers (8B-2 ingest, 8C-3 neighbors,
8D-1 embeddings, 8F-3 grammar, etc.) under the existing `/v1`
prefix.

The TS-side `TileIntelSupervisor` (Phase 8A-4) polls `/health` to
decide when the sidecar is ready; the `/v1/version` payload's
`api_version` is the contract the supervisor compares against
its own expected version to refuse mismatched mixed-version
deployments.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

from tile_intel import API_VERSION, SCHEMA_VERSION, __version__
from tile_intel.api.curation import router as curation_router
from tile_intel.api.embeddings import router as embeddings_router
from tile_intel.api.generate import router as generate_router
from tile_intel.api.grammar import router as grammar_router
from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.api.ingest import router as ingest_router
from tile_intel.api.neighbors import router as neighbors_router
from tile_intel.api.rules import router as rules_router
from tile_intel.api.seed import router as seed_router
from tile_intel.config import get_settings
from tile_intel.storage.base import SqlAlchemyStorageFactory, make_production_factory

logger = logging.getLogger(__name__)


class HealthResponse(BaseModel):
    """Minimal liveness response. The supervisor only checks that
    `ok == true`; the version fields are diagnostic."""

    ok: bool
    schema_version: int
    api_version: int


class VersionResponse(BaseModel):
    """Returned from /v1/version. The supervisor refuses to invoke
    tools when its expected `api_version` doesn't match this."""

    package_version: str
    schema_version: int
    api_version: int
    # `test_mode` surfaces in dev/CI runs so the supervisor can
    # warn the user if the sidecar isn't talking to real storage.
    test_mode: bool


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Process-wide startup + shutdown hooks. Phase 8A-3 has no
    background workers yet; Phase 8A-5 wires Alembic auto-upgrade
    here and Phase 8D-1 starts the model-load + embedder pool."""

    settings = get_settings()
    logger.info(
        "tile-intel-svc starting (host=%s port=%d test_mode=%s pg=%s:%d qdrant=%s:%d)",
        settings.host,
        settings.port,
        settings.test_mode,
        settings.pg_host,
        settings.pg_port,
        settings.qdrant_host,
        settings.qdrant_port,
    )
    yield
    logger.info("tile-intel-svc shutting down")


def create_app(
    storage_factory: SqlAlchemyStorageFactory | None = None,
) -> FastAPI:
    """Factory; the test harness uses this directly so it can
    override settings via dependency injection before the lifespan
    runs.

    Pass `storage_factory` to override the Postgres-backed default
    with (for example) the SQLite-in-memory test factory. The
    factory is wired into ingest endpoints via
    `app.dependency_overrides`. Phase 8A-3 + earlier callers can
    keep passing None to get the production factory."""

    app = FastAPI(
        title="tile-intel-svc",
        version=__version__,
        lifespan=lifespan,
    )

    if storage_factory is not None:
        # Tests inject SQLite-in-memory; production uses
        # make_production_factory() lazily on first request.
        app.dependency_overrides[get_storage_factory_dependency] = lambda: storage_factory
    else:
        # Lazy production wiring: build the factory the first time
        # ingest hits it. This keeps create_app() free of side
        # effects on Postgres.
        cached: dict[str, SqlAlchemyStorageFactory] = {}

        def _production_factory() -> SqlAlchemyStorageFactory:
            if "factory" not in cached:
                cached["factory"] = make_production_factory()
            return cached["factory"]

        app.dependency_overrides[get_storage_factory_dependency] = _production_factory

    app.include_router(ingest_router)
    app.include_router(seed_router)
    app.include_router(rules_router)
    app.include_router(embeddings_router)
    app.include_router(grammar_router)
    app.include_router(generate_router)
    app.include_router(neighbors_router)
    app.include_router(curation_router)

    @app.get("/health", response_model=HealthResponse, tags=["health"])
    async def health() -> HealthResponse:
        """Liveness probe. Returns 200 + `ok=true` as soon as the
        ASGI loop is alive - does NOT check Postgres/Qdrant
        reachability (those are checked on first dependent call,
        not at every health poll). See `/v1/version` for the
        readiness contract."""
        return HealthResponse(
            ok=True,
            schema_version=SCHEMA_VERSION,
            api_version=API_VERSION,
        )

    @app.get("/v1/version", response_model=VersionResponse, tags=["health"])
    async def version() -> VersionResponse:
        """Deeper readiness response. The TS supervisor refuses tool
        invocation when its compiled-against `api_version` doesn't
        match what this returns - the editor surfaces it as
        `{available:false, reason:'version_mismatch'}`."""
        settings = get_settings()
        return VersionResponse(
            package_version=__version__,
            schema_version=SCHEMA_VERSION,
            api_version=API_VERSION,
            test_mode=settings.test_mode,
        )

    return app


app = create_app()
