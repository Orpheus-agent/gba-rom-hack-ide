"""Phase 8J-2 human_overrides table

Revision ID: 0005_human_overrides
Revises: 0004_pattern_columns
Create Date: 2026-05-27 23:55:00

Adds the human_overrides table for the Phase 8J-2 curation tools.
Each row is one user judgment ("this placement looks right" /
"this looks wrong") that the adjacency-rule rebuild reads to
bias toward / away from observed patterns.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_human_overrides"
down_revision: Union[str, Sequence[str], None] = "0004_pattern_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "human_overrides",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            primary_key=True,
            autoincrement=True,
        ),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("label", sa.String(length=16), nullable=False),
        sa.Column("weight", sa.Numeric(5, 2), nullable=False, server_default="1.0"),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "scope", sa.String(length=16), nullable=False, server_default="global"
        ),
        sa.Column("project_id", sa.String(length=36), nullable=True),
    )
    op.create_index(
        "idx_human_overrides_kind_label",
        "human_overrides",
        ["kind", "label"],
    )
    op.create_index(
        "ix_human_overrides_project_id",
        "human_overrides",
        ["project_id"],
    )
    op.create_index(
        "ix_human_overrides_kind",
        "human_overrides",
        ["kind"],
    )


def downgrade() -> None:
    op.drop_index("ix_human_overrides_kind", table_name="human_overrides")
    op.drop_index("ix_human_overrides_project_id", table_name="human_overrides")
    op.drop_index("idx_human_overrides_kind_label", table_name="human_overrides")
    op.drop_table("human_overrides")
