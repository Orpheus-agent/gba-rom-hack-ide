"""Phase 8C-1 - Ontology seeder.

Loads three committed data files under `tile-intel-svc/data/`:
  - behaviors-frlg.json  (111 entries from pret/pokefirered)
  - behaviors-rse.json   (~241 entries from pret/pokeemerald)
  - tag-taxonomy.json    (6 axes × hierarchical tree)
  - behavior-to-tags.json (curated mapping, ~30 entries)

…and upserts them into Postgres:
  - `behaviors` rows keyed by (family, id)
  - `tag_taxonomy` rows keyed by slug (parent links resolve lazily
    after every row is in the session)
  - `metatile_tags` rows derived from the behavior_id → tag mapping,
    applied to every existing Metatile row at seed time

Idempotent on the seeder's data side: re-running upserts the same
behaviors + taxonomy rows. metatile_tags get rewritten on each
seed to reflect any taxonomy changes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import delete, select

from tile_intel.domain.models import Behavior, Metatile, MetatileTag, TagTaxonomy, Tileset
from tile_intel.storage.base import SqlAlchemyStorageFactory

DATA_DIR = Path(__file__).resolve().parents[3] / "data"


@dataclass(frozen=True)
class OntologyReport:
    """Counts emitted by `seed_ontology()`."""

    behaviors_upserted: int
    tags_upserted: int
    metatile_tags_applied: int


def _load_json(filename: str) -> dict | list:
    path = DATA_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"ontology data file missing: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def seed_ontology(factory: SqlAlchemyStorageFactory) -> OntologyReport:
    """Upsert behaviors + tag taxonomy + apply behavior-driven tags
    to every existing metatile. Returns counts of each kind upserted."""

    frlg_behaviors = _load_json("behaviors-frlg.json")
    rse_behaviors = _load_json("behaviors-rse.json")
    taxonomy_payload = _load_json("tag-taxonomy.json")
    btt_payload = _load_json("behavior-to-tags.json")

    behaviors_count = 0
    tags_count = 0
    metatile_tags_count = 0

    with factory.session() as session:
        # ---- behaviors ----
        # delete-then-insert by primary key (id) per family.
        for family_entries in (frlg_behaviors, rse_behaviors):
            for entry in family_entries:
                family = entry["family"]
                existing = session.execute(
                    select(Behavior).where(Behavior.id == entry["id"])
                ).scalar_one_or_none()
                if existing is not None:
                    session.delete(existing)
                    session.flush()
                session.add(
                    Behavior(
                        id=entry["id"],
                        family=family,
                        name=entry["name"],
                        category=entry.get("category", "unknown"),
                    )
                )
                behaviors_count += 1

        # ---- tag_taxonomy ----
        # Two-pass insertion so parent_id can resolve.
        slug_to_id: dict[str, int] = {}
        # Wipe and re-insert; safer than upsert because tag content
        # is small (~80 rows) and reflects the canonical tree.
        session.execute(delete(MetatileTag))
        session.execute(delete(TagTaxonomy))
        session.flush()

        for tag in taxonomy_payload["tags"]:
            row = TagTaxonomy(
                slug=tag["slug"],
                axis=tag["axis"],
                display_name=tag["display_name"],
                is_leaf=tag.get("is_leaf", True),
                description=tag.get("description"),
            )
            session.add(row)
            session.flush()
            slug_to_id[tag["slug"]] = row.id
            tags_count += 1

        for tag in taxonomy_payload["tags"]:
            parent_slug = tag.get("parent_slug")
            if parent_slug:
                row = session.execute(
                    select(TagTaxonomy).where(TagTaxonomy.slug == tag["slug"])
                ).scalar_one()
                row.parent_id = slug_to_id[parent_slug]

        # ---- metatile_tags from behavior→tag rules ----
        rules: dict[str, list[str]] = btt_payload["rules"]
        # Map MB_* name → list of tag IDs.
        name_to_tag_ids: dict[str, list[int]] = {}
        for name, slugs in rules.items():
            ids = []
            for s in slugs:
                if s in slug_to_id:
                    ids.append(slug_to_id[s])
            if ids:
                name_to_tag_ids[name] = ids

        # Build behavior_id → name lookup for both families. The same
        # numeric id has different names in FRLG vs RSE; we apply
        # rules family-aware via the metatile's tileset.family.
        family_id_to_name: dict[tuple[str, int], str] = {}
        for family_entries in (frlg_behaviors, rse_behaviors):
            for entry in family_entries:
                family_id_to_name[(entry["family"], entry["id"])] = entry["name"]

        # Walk every metatile, look up its (family, behavior_id) → name,
        # then look up name → tag_ids, and emit one MetatileTag row per
        # (metatile, tag).
        mt_rows = session.execute(
            select(Metatile.id, Metatile.behavior_id, Tileset.family)
            .join(Tileset, Metatile.tileset_id == Tileset.id)
        ).all()
        for mt_id, behavior_id, family in mt_rows:
            name = family_id_to_name.get((family, behavior_id))
            if not name:
                continue
            tag_ids = name_to_tag_ids.get(name)
            if not tag_ids:
                continue
            for tag_id in tag_ids:
                session.add(
                    MetatileTag(
                        metatile_id=mt_id,
                        tag_id=tag_id,
                        confidence=1.0,
                        source="behavior_inference",
                    )
                )
                metatile_tags_count += 1

    return OntologyReport(
        behaviors_upserted=behaviors_count,
        tags_upserted=tags_count,
        metatile_tags_applied=metatile_tags_count,
    )
