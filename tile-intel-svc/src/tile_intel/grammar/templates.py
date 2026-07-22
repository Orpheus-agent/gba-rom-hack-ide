"""Phase 8F-1 - Template extraction from vanilla layouts.

Consumes `adjacency_patterns` rows (produced by 8C-4's 3×3 sliding
window) and emits `templates` rows that the Phase 8G generator can
instantiate at anchor points. Template role classification uses the
metatile tag corpus from 8C-1 + 8C-2 - if every cell carries
`terrain.grass.tall`, the template is a `grass_filler`; if cells
split into two distinct tag groups along a row/column, it's a
`transition`.

The patterns from 8C-4 are stored per-source; this builder
aggregates across sources before deciding which patterns are
"global enough" to template (default threshold: cross-source
frequency ≥ 3). Re-running deletes existing template rows for the
current scope before re-inserting - idempotent.

2×2 and 4×4 patterns are deferred to a future slice (they need a
corpus-IR extension to extract). The 3×3 patterns here are
sufficient for the Phase 8G two-stage generator to start placing
template anchors.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from sqlalchemy import delete, select

from tile_intel.domain.models import (
    AdjacencyPattern,
    Metatile,
    MetatileTag,
    TagTaxonomy,
    Template,
    TemplateUsage,
    Tileset,
)
from tile_intel.storage.base import SqlAlchemyStorageFactory


@dataclass(frozen=True)
class TemplateBuildReport:
    """Counts emitted by build_templates_from_patterns()."""

    templates_built: int
    patterns_considered: int
    templates_with_role: int  # how many got something more specific than 'mixed'


def _summarise_tags(cell_tag_lists: list[list[str]]) -> tuple[str, set[str]]:
    """Given per-cell tag lists, decide the template's role label
    + required_tags set.

    Heuristic v0 (8F-1):
      - empty / no tags                 → role='mixed', tags={}
      - same tag in every cell          → role=f'uniform_{tag}', tags={tag}
      - top-tag covers ≥ 2/3 of cells   → role=f'majority_{top}', tags={top}
      - cells split exactly two ways    → role=f'transition_{a}__{b}', tags={a,b}
      - otherwise                        → role='mixed', tags={top}
    """

    if not cell_tag_lists or all(not c for c in cell_tag_lists):
        return "mixed", set()

    # Count tag → cells-containing-that-tag.
    tag_counter: Counter[str] = Counter()
    for tags in cell_tag_lists:
        for t in set(tags):
            tag_counter[t] += 1
    if not tag_counter:
        return "mixed", set()

    total_cells = len(cell_tag_lists)
    # Counter.most_common breaks ties by insertion order, which the
    # caller doesn't control (we iterate over `set(tags)` per cell).
    # Use an explicit (count desc, slug asc) sort so two equally-common
    # tags resolve deterministically - "terrain.grass.tall" beats
    # "traversal.walkable" in any test that puts both at frequency 9.
    sorted_tags = sorted(tag_counter.items(), key=lambda kv: (-kv[1], kv[0]))
    top_tag, top_count = sorted_tags[0]

    # All cells share the top tag.
    if top_count == total_cells:
        return f"uniform_{top_tag}", {top_tag}

    # Two-way split: top + runner-up together cover everything,
    # and neither dominates >= total_cells.
    if len(sorted_tags) >= 2:
        second_tag, second_count = sorted_tags[1]
        if (top_count + second_count) >= total_cells and (
            second_count >= total_cells // 4
        ):
            return f"transition_{top_tag}__{second_tag}", {top_tag, second_tag}

    # Top tag covers a majority (≥ 2/3).
    if top_count * 3 >= total_cells * 2:
        return f"majority_{top_tag}", {top_tag}

    return "mixed", {top_tag}


def classify_template_role(
    session,
    cells: list[dict],
) -> tuple[str, list[str], int | None]:
    """Look up each cell's metatile + its tags, return:
      (role: str,
       required_tags: list[str],
       origin_tileset_id: int | None)

    Cells whose metatiles can't be found in the DB (mid-rebuild
    cleanup, missing tileset) are silently skipped.
    """

    # Build cell tag lists in cell order.
    cell_tag_lists: list[list[str]] = []
    tileset_id_counts: Counter[int] = Counter()
    for cell in cells:
        slug = cell.get("tilesetSlug")
        idx = cell.get("metatileIndex")
        if slug is None or idx is None:
            cell_tag_lists.append([])
            continue
        row = session.execute(
            select(Metatile.id, Metatile.tileset_id)
            .join(Tileset, Metatile.tileset_id == Tileset.id)
            .where(Tileset.slug == slug, Metatile.metatile_index == int(idx))
        ).first()
        if row is None:
            cell_tag_lists.append([])
            continue
        metatile_id, ts_id = row
        tileset_id_counts[int(ts_id)] += 1
        tag_slugs = [
            r[0]
            for r in session.execute(
                select(TagTaxonomy.slug)
                .join(MetatileTag, TagTaxonomy.id == MetatileTag.tag_id)
                .where(MetatileTag.metatile_id == metatile_id)
            ).all()
        ]
        cell_tag_lists.append(tag_slugs)

    role, tag_set = _summarise_tags(cell_tag_lists)
    origin_tileset_id = (
        tileset_id_counts.most_common(1)[0][0] if tileset_id_counts else None
    )
    return role, sorted(tag_set), origin_tileset_id


def build_templates_from_patterns(
    factory: SqlAlchemyStorageFactory,
    min_global_frequency: int = 3,
    scope: str = "global",
    project_id: str | None = None,
) -> TemplateBuildReport:
    """Aggregate adjacency_patterns across sources, classify roles
    via tag analysis, emit templates rows.

    `min_global_frequency` filters patterns whose cross-source sum
    falls below the threshold. Default 3 matches the Phase 8 plan."""

    templates_built = 0
    templates_with_role = 0
    patterns_considered = 0

    with factory.session() as session:
        # Wipe existing templates we own. We mark every row we emit
        # with `slug = pattern-3x3-<hash-prefix>`; safer to use
        # source-prefix filter than scope.
        session.execute(
            delete(TemplateUsage).where(
                TemplateUsage.template_id.in_(
                    select(Template.id).where(Template.slug.like("pattern-3x3-%"))
                )
            )
        )
        session.execute(delete(Template).where(Template.slug.like("pattern-3x3-%")))
        session.flush()

        # Aggregate adjacency_patterns by pattern_hash, summing
        # frequencies across sources.
        rows = session.execute(
            select(
                AdjacencyPattern.pattern_hash,
                AdjacencyPattern.pattern_shape,
                AdjacencyPattern.cells,
                AdjacencyPattern.frequency,
                AdjacencyPattern.source_corpus,
            ).where(AdjacencyPattern.scope == "global")
        ).all()
        bucket: dict[bytes, dict] = {}
        for pat_hash, shape, cells, freq, source in rows:
            entry = bucket.get(pat_hash)
            if entry is None:
                bucket[pat_hash] = {
                    "shape": shape,
                    "cells": cells,
                    "total_freq": int(freq),
                    "sources": {source},
                }
            else:
                entry["total_freq"] += int(freq)
                entry["sources"].add(source)
        patterns_considered = len(bucket)

        for pat_hash, entry in bucket.items():
            if entry["total_freq"] < min_global_frequency:
                continue
            role, required_tags, origin_tileset_id = classify_template_role(
                session, entry["cells"]
            )
            slug = "pattern-3x3-" + pat_hash.hex()[:16]
            session.add(
                Template(
                    slug=slug,
                    display_name=f"3×3 {role}",
                    role=role,
                    width=3,
                    height=3,
                    cells=_cells_to_grid(entry["cells"], 3, 3),
                    anchor_x=0,
                    anchor_y=0,
                    origin_tileset_id=origin_tileset_id,
                    required_tags=required_tags,
                    scope=scope,
                    project_id=project_id,
                )
            )
            session.flush()
            templates_built += 1
            if role != "mixed":
                templates_with_role += 1

            # Record template_usage rows per source so 8F-2 can
            # aggregate per-biome frequencies from existing data
            # without re-scanning the corpus.
            for source in entry["sources"]:
                session.add(
                    TemplateUsage(
                        template_id=session.query(Template)
                        .filter_by(slug=slug)
                        .one()
                        .id,
                        map_corpus=source,
                        occurrence_count=entry["total_freq"],
                    )
                )

    return TemplateBuildReport(
        templates_built=templates_built,
        patterns_considered=patterns_considered,
        templates_with_role=templates_with_role,
    )


def _cells_to_grid(
    flat_cells: list[dict], width: int, height: int
) -> list[list[dict]]:
    """Convert the row-major flat cell list emitted by 8C-4 into
    the height-rows-of-width-cells grid the templates table prefers."""

    grid: list[list[dict]] = []
    for y in range(height):
        row = []
        for x in range(width):
            idx = y * width + x
            row.append(flat_cells[idx] if idx < len(flat_cells) else {})
        grid.append(row)
    return grid
