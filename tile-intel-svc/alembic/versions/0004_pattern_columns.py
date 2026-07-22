"""Phase 8C-4 pattern columns

Revision ID: 0004_pattern_columns
Revises: 0003_phash_bytea
Create Date: 2026-05-27 21:00:00

Adds pattern_hash + source_corpus columns to adjacency_patterns,
plus the matching unique constraint that lets per-source re-ingest
delete-then-replace cleanly while different sources still
coexist for global aggregation at query time.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_pattern_columns"
down_revision: Union[str, Sequence[str], None] = "0003_phash_bytea"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # No existing patterns yet (8C-4 is the first writer), so we can
    # add the new columns NOT NULL without a server-default - the
    # ALTER won't fail on a backfill because there's nothing to
    # backfill.
    op.add_column("adjacency_patterns", sa.Column("pattern_hash", sa.LargeBinary(), nullable=False))
    op.add_column(
        "adjacency_patterns",
        sa.Column("source_corpus", sa.String(length=120), nullable=False),
    )
    op.create_index(
        "ix_adjacency_patterns_pattern_hash",
        "adjacency_patterns",
        ["pattern_hash"],
    )
    op.create_index(
        "ix_adjacency_patterns_source_corpus",
        "adjacency_patterns",
        ["source_corpus"],
    )
    op.create_unique_constraint(
        "uq_adj_patterns_hash_corpus_scope",
        "adjacency_patterns",
        ["pattern_hash", "source_corpus", "scope", "project_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_adj_patterns_hash_corpus_scope", "adjacency_patterns", type_="unique")
    op.drop_index("ix_adjacency_patterns_source_corpus", table_name="adjacency_patterns")
    op.drop_index("ix_adjacency_patterns_pattern_hash", table_name="adjacency_patterns")
    op.drop_column("adjacency_patterns", "source_corpus")
    op.drop_column("adjacency_patterns", "pattern_hash")
