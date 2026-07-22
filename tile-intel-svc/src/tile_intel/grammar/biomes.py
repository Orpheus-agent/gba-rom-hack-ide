"""Phase 8F-2 - Template-frequency analysis per biome.

Maps templates to biomes by inspecting their required_tags. The
generator (Phase 8G) calls `templates_by_biome(biome='forest')` to
get a frequency-ranked list of templates appropriate for placing in
a forest region.

Biome assignment is rule-based, not learned: a template's biome is
inferred from which TERRAIN family dominates its tag set. This is
the simplest path that yields useful results today; per-map biome
labelling (using pret's map metadata) is deferred to 8F-2b.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select

from tile_intel.domain.models import Template, TemplateUsage
from tile_intel.storage.base import SqlAlchemyStorageFactory

# Maps a terrain-family slug → biomes that family is characteristic
# of. The rules are conservative: terrain.grass → forest/route/town,
# terrain.cave → cave/dungeon, etc. A template with grass + water
# tags lands in BOTH "forest" and "beach" categories - biome
# membership is overlapping, not exclusive.
TERRAIN_TO_BIOMES: dict[str, list[str]] = {
    # Grass family
    "terrain.grass": ["biome.forest", "biome.route", "biome.town", "biome.plains"],
    "terrain.grass.short": ["biome.town", "biome.route"],
    "terrain.grass.tall": ["biome.route", "biome.forest", "biome.plains"],
    "terrain.grass.long": ["biome.route", "biome.forest"],
    # Water family
    "terrain.water": ["biome.beach", "biome.tropical"],
    "terrain.water.pond": ["biome.forest", "biome.route"],
    "terrain.water.ocean": ["biome.beach", "biome.tropical"],
    "terrain.water.deep": ["biome.tropical"],
    "terrain.water.shallow": ["biome.beach", "biome.route"],
    # Sand
    "terrain.sand": ["biome.beach", "biome.tropical"],
    # Cave / mountain
    "terrain.cave": ["biome.cave", "biome.dungeon", "biome.mountain"],
    "terrain.cave.floor": ["biome.cave", "biome.dungeon"],
    "terrain.cave.wall": ["biome.cave", "biome.dungeon", "biome.mountain"],
    "terrain.rock": ["biome.mountain", "biome.cave"],
    "terrain.lava": ["biome.dungeon", "biome.victory_road"],
    # Ice
    "terrain.ice": ["biome.arctic"],
    "terrain.ice.solid": ["biome.arctic"],
    "terrain.ice.thin": ["biome.arctic"],
    "terrain.snow": ["biome.arctic"],
    # Indoor / structure
    "terrain.path": ["biome.town", "biome.urban", "biome.route"],
    "terrain.bridge": ["biome.route", "biome.urban"],
    "terrain.dirt": ["biome.route", "biome.cave", "biome.town"],
    "terrain.flowerbed": ["biome.town", "biome.forest"],
}


@dataclass(frozen=True)
class TemplateByBiomeEntry:
    template_slug: str
    role: str
    required_tags: list[str]
    biomes: list[str]
    total_usage: int


def derive_biomes_for_tags(tags: list[str]) -> list[str]:
    """Walk the required_tags list, look up each terrain-family
    entry in TERRAIN_TO_BIOMES, return the deduplicated biome list.

    Tags that aren't a recognised terrain family are skipped (this
    is the policy: structural / traversal tags don't imply a
    biome). Returns a sorted list for deterministic output."""

    out: set[str] = set()
    for tag in tags:
        biomes = TERRAIN_TO_BIOMES.get(tag)
        if biomes:
            out.update(biomes)
            continue
        # Allow prefix lookups: a tag of "terrain.grass.tall" should
        # ALSO benefit from "terrain.grass" → biome rules.
        for family_slug, biomes in TERRAIN_TO_BIOMES.items():
            if tag.startswith(family_slug + ".") or tag == family_slug:
                out.update(biomes)
    return sorted(out)


def templates_by_biome(
    factory: SqlAlchemyStorageFactory,
    biome_slug: str,
    limit: int = 50,
) -> list[TemplateByBiomeEntry]:
    """Return templates whose required_tags imply membership in the
    given biome. Sorted by total_usage descending."""

    with factory.session() as session:
        templates = session.execute(select(Template)).scalars().all()
        # Per-template usage totals.
        usage_totals: dict[int, int] = {}
        for usage in session.execute(select(TemplateUsage)).scalars().all():
            usage_totals[usage.template_id] = (
                usage_totals.get(usage.template_id, 0) + int(usage.occurrence_count)
            )

        out: list[TemplateByBiomeEntry] = []
        for t in templates:
            biomes = derive_biomes_for_tags(list(t.required_tags))
            if biome_slug not in biomes:
                continue
            out.append(
                TemplateByBiomeEntry(
                    template_slug=t.slug,
                    role=t.role,
                    required_tags=list(t.required_tags),
                    biomes=biomes,
                    total_usage=usage_totals.get(t.id, 0),
                )
            )
        out.sort(key=lambda e: (-e.total_usage, e.template_slug))
        return out[:limit]


def list_biomes_for_templates(
    factory: SqlAlchemyStorageFactory,
) -> dict[str, int]:
    """Return `{biome_slug: template_count}` summarising the
    biome coverage of all currently-stored templates."""

    counter: dict[str, int] = {}
    with factory.session() as session:
        templates = session.execute(select(Template)).scalars().all()
        for t in templates:
            for biome in derive_biomes_for_tags(list(t.required_tags)):
                counter[biome] = counter.get(biome, 0) + 1
    return counter
