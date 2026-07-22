"""Phase 8G - Map generation pipeline.

Two complementary entry points:

  - `generate_skeleton(...)` (Phase 8G-1) composes a high-level
    `MapSkeleton` DSL document from theme + biome + size + density.
    Pure-Python, deterministic given a seed.

  - `resolve_skeleton(...)` (Phase 8G-2) walks the DSL and emits a
    concrete plan of `propose_create_map` + `propose_paint_map_blocks`
    tool calls. Reads templates / adjacency rules from the DB.

  - `validate_traversal(...)` (Phase 8G-3) - A* + flood-fill over a
    map's walkability mask.

This package is import-light on purpose; the heavy lifting lives in
the per-module submodules so a partial import (e.g. only the
skeleton generator from a test fixture) doesn't pull SQLAlchemy
into the test path.
"""

from __future__ import annotations

from tile_intel.generator.resolve import (
    MetatilePlacement,
    ResolvedMap,
    ResolvedMapReport,
    ResolvedPOI,
    resolve_skeleton,
)
from tile_intel.generator.skeleton import (
    SkeletonGenerationInput,
    SkeletonGenerationReport,
    generate_skeleton,
)
from tile_intel.generator.traversal import (
    TraversalIssue,
    TraversalReport,
    validate_traversal,
)

__all__ = [
    "MetatilePlacement",
    "ResolvedMap",
    "ResolvedMapReport",
    "ResolvedPOI",
    "resolve_skeleton",
    "SkeletonGenerationInput",
    "SkeletonGenerationReport",
    "generate_skeleton",
    "TraversalIssue",
    "TraversalReport",
    "validate_traversal",
]
