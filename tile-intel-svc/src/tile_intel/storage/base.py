"""Phase 8A-5 - Storage protocol + session factory.

The same SQLAlchemy code works against both Postgres (production)
and SQLite (tests) - only the engine URL differs. This module
exposes a factory that returns a configured `sessionmaker` for
either, plus a thin `Storage` facade that ingest endpoints in
Phase 8B-2 onwards will hang their CRUD on.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Protocol

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from tile_intel.config import get_settings
from tile_intel.domain.models import Base


class StorageFactory(Protocol):
    """The contract storage backends fulfil. Phase 8A-5 ships one
    concrete impl (SqlAlchemyStorageFactory) that works against
    both Postgres + SQLite via dialect autodetection."""

    @property
    def engine(self) -> Engine: ...
    @contextmanager
    def session(self) -> Iterator[Session]: ...
    def create_all(self) -> None: ...
    def drop_all(self) -> None: ...


class SqlAlchemyStorageFactory:
    """SQLAlchemy-backed storage factory. `url` determines dialect:
    `postgresql+psycopg://...` for production, `sqlite:///:memory:`
    for tests."""

    def __init__(
        self,
        url: str,
        echo: bool = False,
        connect_args: dict | None = None,
        poolclass: type | None = None,
    ) -> None:
        kwargs: dict = {"echo": echo, "future": True}
        if connect_args is not None:
            kwargs["connect_args"] = connect_args
        if poolclass is not None:
            kwargs["poolclass"] = poolclass
        self._engine = create_engine(url, **kwargs)
        self._sessionmaker = sessionmaker(self._engine, expire_on_commit=False, future=True)
        # SQLite doesn't enable FK enforcement by default; without it,
        # cascade-on-delete is silently skipped and idempotent ingest
        # breaks with UNIQUE-constraint violations. Postgres handles
        # this natively at the engine level.
        if url.startswith("sqlite"):
            @event.listens_for(self._engine, "connect")
            def _enable_sqlite_fks(dbapi_connection, _connection_record):
                cursor = dbapi_connection.cursor()
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()

    @property
    def engine(self) -> Engine:
        return self._engine

    @contextmanager
    def session(self) -> Iterator[Session]:
        """Context-managed session - commits on success, rolls back
        on exception, always closes."""
        session = self._sessionmaker()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def create_all(self) -> None:
        """Create every table from `Base.metadata`. Used by tests
        instead of alembic upgrade (faster + dialect-portable)."""
        Base.metadata.create_all(self._engine)

    def drop_all(self) -> None:
        Base.metadata.drop_all(self._engine)


def make_production_factory() -> SqlAlchemyStorageFactory:
    """Read pg_dsn from `tile_intel.config.get_settings()` and
    return a factory pointed at it. The sidecar's lifespan hook
    (Phase 8A-5+) calls this once at startup."""
    return SqlAlchemyStorageFactory(get_settings().pg_dsn)


def make_inmemory_factory() -> SqlAlchemyStorageFactory:
    """SQLite-in-memory factory for tests. Each call returns a fresh
    factory with its own private database - perfect test isolation
    without touching disk.

    Uses `StaticPool` so every connection in the pool reuses the
    SAME in-memory database. Without this each pool checkout sees
    its own private :memory: instance, which breaks any test that
    runs queries across multiple connections (the HTTP layer pulls
    a fresh connection for each FastAPI request)."""
    return SqlAlchemyStorageFactory(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
