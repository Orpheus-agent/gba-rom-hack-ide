"""Phase 8B-2 phash bytea

Revision ID: 0003_phash_bytea
Revises: a94bcc78431f
Create Date: 2026-05-27 20:39:31.594277

Switches tiles.phash + metatiles.phash from BIGINT to BYTEA(8). The
underlying value is a u64; Postgres BIGINT is signed so the upper
half overflows. Storing 8 raw bytes avoids the signed/unsigned
mismatch entirely and lets us Hamming-distance compare via
bit-level ops at query time.

Autogenerate couldn't detect the type change (Alembic's column-type
diff for BigInteger ↔ LargeBinary is unreliable), so the migration
is hand-written. We drop and re-add the column since (a) phash data
hasn't been ingested yet and (b) there's no canonical bigint-to-bytea
cast.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_phash_bytea"
down_revision: Union[str, Sequence[str], None] = "a94bcc78431f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop the BigInteger phash columns + indexes and recreate as
    LargeBinary. Data loss is acceptable here - no phash has been
    ingested yet at the 8A-5 → 8B-2 transition."""

    # tiles.phash
    op.drop_index("ix_tiles_phash", table_name="tiles")
    op.drop_column("tiles", "phash")
    op.add_column("tiles", sa.Column("phash", sa.LargeBinary(), nullable=False))
    op.create_index("ix_tiles_phash", "tiles", ["phash"])

    # metatiles.phash
    op.drop_index("ix_metatiles_phash", table_name="metatiles")
    op.drop_column("metatiles", "phash")
    op.add_column("metatiles", sa.Column("phash", sa.LargeBinary(), nullable=False))
    op.create_index("ix_metatiles_phash", "metatiles", ["phash"])


def downgrade() -> None:
    """Reverse: LargeBinary → BigInteger. Symmetrically loses data."""

    op.drop_index("ix_tiles_phash", table_name="tiles")
    op.drop_column("tiles", "phash")
    op.add_column("tiles", sa.Column("phash", sa.BigInteger(), nullable=False))
    op.create_index("ix_tiles_phash", "tiles", ["phash"])

    op.drop_index("ix_metatiles_phash", table_name="metatiles")
    op.drop_column("metatiles", "phash")
    op.add_column("metatiles", sa.Column("phash", sa.BigInteger(), nullable=False))
    op.create_index("ix_metatiles_phash", "metatiles", ["phash"])
