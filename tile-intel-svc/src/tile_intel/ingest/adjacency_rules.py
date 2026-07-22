"""Phase 8C-3 - Adjacency rule derivation.

Reads `adjacency_observations` and aggregates into `adjacency_rules`,
which is the queryable answer to "what metatiles legally go east of
this one?".

Each rule row stores three views of the same distribution:
  - `legal_neighbors`: full sorted [{metatile_b_id, probability, freq}]
    list. Used by frequency-weighted sampling at generation time.
  - `hard_legal_set`: ids only, filtered to probability ≥ threshold.
    Used as a fast hard-constraint check (`metatile_b IN
    rule.hard_legal_set`).
  - `entropy`: -Σ p_i log2(p_i). Low entropy means the rule is
    near-deterministic (one or two dominant neighbors).

Idempotent: re-running deletes existing rule rows for the same
(scope, project_id) before re-deriving.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from sqlalchemy import delete, func, select

from tile_intel.domain.models import AdjacencyObservation, AdjacencyRule
from tile_intel.storage.base import SqlAlchemyStorageFactory


@dataclass(frozen=True)
class AdjacencyRulesReport:
    rules_built: int
    observations_aggregated: int
    threshold: float


def _shannon_entropy(weights: list[float]) -> float:
    """Compute H(X) = -Σ p log2 p for a distribution. Returns 0 for
    a single-element distribution (no uncertainty)."""

    total = sum(weights)
    if total <= 0:
        return 0.0
    h = 0.0
    for w in weights:
        if w <= 0:
            continue
        p = w / total
        h -= p * math.log2(p)
    return h


def rebuild_adjacency_rules(
    factory: SqlAlchemyStorageFactory,
    threshold: float = 0.005,
    scope: str = "global",
    project_id: str | None = None,
) -> AdjacencyRulesReport:
    """Aggregate adjacency_observations into adjacency_rules.

    threshold: minimum probability for a neighbor to qualify for the
               hard_legal_set. 0.5% by default. Below this we treat
               the neighbor as observation-noise.
    scope: which observations to aggregate ('global', 'project',
           'merged'). 'merged' is project's observations plus the
           global ones.
    project_id: required when scope='project' or 'merged'. None
                when scope='global'."""

    rules_built = 0
    observations_aggregated = 0

    with factory.session() as session:
        # Wipe stale rules for the scope we're rebuilding.
        session.execute(
            delete(AdjacencyRule).where(
                AdjacencyRule.scope == scope,
                AdjacencyRule.project_id == project_id,
            )
        )
        session.flush()

        # Aggregate over observations.
        if scope == "global":
            obs_filter = AdjacencyObservation.scope == "global"
        elif scope == "project":
            obs_filter = (AdjacencyObservation.scope == "project") & (
                AdjacencyObservation.project_id == project_id
            )
        else:  # 'merged'
            obs_filter = (AdjacencyObservation.scope == "global") | (
                (AdjacencyObservation.scope == "project")
                & (AdjacencyObservation.project_id == project_id)
            )

        # SUM frequencies grouped by (metatile_a, direction, metatile_b)
        # so each (a, b, dir) tuple appears once with the total count
        # across all source corpora.
        agg = (
            select(
                AdjacencyObservation.metatile_a,
                AdjacencyObservation.direction,
                AdjacencyObservation.metatile_b,
                func.sum(AdjacencyObservation.frequency).label("freq"),
            )
            .where(obs_filter)
            .group_by(
                AdjacencyObservation.metatile_a,
                AdjacencyObservation.direction,
                AdjacencyObservation.metatile_b,
            )
            .order_by(
                AdjacencyObservation.metatile_a,
                AdjacencyObservation.direction,
            )
        )
        rows = session.execute(agg).all()
        observations_aggregated = len(rows)

        # Re-group in Python by (metatile_a, direction) → list of
        # (metatile_b, freq) pairs.
        per_key: dict[tuple[int, int], list[tuple[int, int]]] = {}
        for a, d, b, freq in rows:
            per_key.setdefault((a, d), []).append((b, int(freq)))

        # Build one AdjacencyRule per key.
        for (metatile_a, direction), pairs in per_key.items():
            total = sum(f for _, f in pairs)
            if total <= 0:
                continue
            # Sort by frequency desc for predictable serialization.
            pairs.sort(key=lambda p: (-p[1], p[0]))
            legal_neighbors = [
                {"metatile_b": int(b), "probability": float(f) / total, "freq": int(f)}
                for b, f in pairs
            ]
            hard_legal_set = [
                int(b) for b, f in pairs if (float(f) / total) >= threshold
            ]
            entropy = _shannon_entropy([float(f) for _, f in pairs])
            session.add(
                AdjacencyRule(
                    metatile_a=int(metatile_a),
                    direction=int(direction),
                    legal_neighbors=legal_neighbors,
                    hard_legal_set=hard_legal_set,
                    total_observations=total,
                    entropy=entropy,
                    scope=scope,
                    project_id=project_id,
                )
            )
            rules_built += 1

    return AdjacencyRulesReport(
        rules_built=rules_built,
        observations_aggregated=observations_aggregated,
        threshold=threshold,
    )
