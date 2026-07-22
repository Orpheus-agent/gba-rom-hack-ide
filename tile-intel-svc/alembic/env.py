"""Alembic environment - Phase 8A-5 wires target_metadata.

Reads the Postgres DSN from `tile_intel.config.get_settings()` so
migrations honor whatever env vars the rest of the sidecar uses.

target_metadata = Base.metadata so future autogenerate runs can
diff the model declarations against the live database.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from tile_intel.config import get_settings
from tile_intel.domain.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Override the inert alembic.ini DSN with the runtime one.
config.set_main_option("sqlalchemy.url", get_settings().pg_dsn)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
