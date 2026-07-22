"""Phase 8C-2 - Structural-tag seeder.

Walks every Metatile row, runs `classify_metatile()` from
`tile_intel.features.structural`, and emits MetatileTag rows with
source='heuristic'. Confidence comes from the heuristic.

Idempotent: a re-run wipes existing heuristic tags (source='heuristic')
before re-emitting. Behavior-inference + LLM + human tags are
preserved.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete, select

from tile_intel.domain.models import Metatile, MetatileTag, TagTaxonomy
from tile_intel.features.structural import classify_layer1_overlay, classify_metatile
from tile_intel.storage.base import SqlAlchemyStorageFactory


@dataclass(frozen=True)
class StructuralReport:
    metatiles_examined: int
    tags_emitted: int


def apply_structural_tags(factory: SqlAlchemyStorageFactory) -> StructuralReport:
    """Walk all metatiles, classify each, write heuristic tags."""

    with factory.session() as session:
        slug_to_id = {
            row[0]: row[1]
            for row in session.execute(select(TagTaxonomy.slug, TagTaxonomy.id)).all()
        }
        # Wipe existing heuristic tags.
        session.execute(delete(MetatileTag).where(MetatileTag.source == "heuristic"))
        session.flush()

        metatiles_examined = 0
        tags_emitted = 0
        for mt_id, composition in session.execute(
            select(Metatile.id, Metatile.composition)
        ).all():
            metatiles_examined += 1
            for tag in classify_metatile(composition):
                tag_id = slug_to_id.get(tag.slug)
                if tag_id is None:
                    continue
                session.add(
                    MetatileTag(
                        metatile_id=mt_id,
                        tag_id=tag_id,
                        confidence=tag.confidence,
                        source="heuristic",
                    )
                )
                tags_emitted += 1
            # Layer-1 overlay is a separate per-metatile boolean - emit
            # only when a corresponding tag is in the taxonomy. We use
            # 'structure.anchor' as a stand-in for "has overlay" so
            # callers can filter on it.
            if classify_layer1_overlay(composition):
                anchor_id = slug_to_id.get("structure.anchor")
                if anchor_id is not None:
                    # Only emit if not already present (anchor was emitted
                    # earlier in the 4-unique-quads case).
                    existing = session.execute(
                        select(MetatileTag.metatile_id).where(
                            (MetatileTag.metatile_id == mt_id)
                            & (MetatileTag.tag_id == anchor_id)
                            & (MetatileTag.source == "heuristic")
                        )
                    ).first()
                    if existing is None:
                        session.add(
                            MetatileTag(
                                metatile_id=mt_id,
                                tag_id=anchor_id,
                                confidence=0.4,  # weak signal - overlay alone
                                source="heuristic",
                            )
                        )
                        tags_emitted += 1

    return StructuralReport(
        metatiles_examined=metatiles_examined,
        tags_emitted=tags_emitted,
    )
