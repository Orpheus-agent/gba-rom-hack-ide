"""Runtime configuration for tile-intel-svc.

Environment-driven (matches the rest of the editor's lifecycle).
Defaults assume the local Docker stack from the repo's
`docker-compose.yml` and the supervisor lifecycle in
`app/backend/src/tile-intel/supervisor.ts` (Phase 8A-4).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Process-wide settings, loaded once from env vars at startup."""

    model_config = SettingsConfigDict(
        env_prefix="TILE_INTEL_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---- HTTP / process ----
    host: str = "127.0.0.1"
    port: int = 58080
    log_level: str = "info"

    # ---- Postgres ----
    pg_host: str = "127.0.0.1"
    pg_port: int = 15432
    pg_user: str = "tile_intel"
    # No default: supply TILE_INTEL_PG_PASSWORD via the environment or a
    # local .env file (see .env.example at the repo root).
    pg_password: str = "your-postgres-password-here"
    pg_database: str = "tile_intel"

    @property
    def pg_dsn(self) -> str:
        return (
            f"postgresql+psycopg://{self.pg_user}:{self.pg_password}"
            f"@{self.pg_host}:{self.pg_port}/{self.pg_database}"
        )

    # ---- Qdrant ----
    qdrant_host: str = "127.0.0.1"
    qdrant_port: int = 16333
    qdrant_grpc_port: int = 16334

    # ---- Model + ingestion paths ----
    model_cache_dir: str = "models"
    # When True, the sidecar boots in test/CI mode: SQLite for storage,
    # FAISS for vectors, no model download. Set by the test harness in
    # 8A-5; default off so the FastAPI app uses real Postgres + Qdrant.
    test_mode: bool = False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings accessor. Tests can monkey-patch
    `tile_intel.config.get_settings` to inject a different instance."""
    return Settings()
