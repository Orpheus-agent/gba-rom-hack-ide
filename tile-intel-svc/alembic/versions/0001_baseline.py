"""Baseline - Phase 8A-3.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-05-27

The baseline migration is intentionally empty; it exists so
subsequent migrations (8A-5's full schema) have a stable ancestor.
"""

from __future__ import annotations

# pylint: disable=invalid-name

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """No-op."""


def downgrade() -> None:
    """No-op."""
