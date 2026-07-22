"""Map-grammar - Phase 8F."""

from __future__ import annotations

from tile_intel.grammar.biomes import (
    TERRAIN_TO_BIOMES,
    TemplateByBiomeEntry,
    derive_biomes_for_tags,
    list_biomes_for_templates,
    templates_by_biome,
)
from tile_intel.grammar.templates import (
    TemplateBuildReport,
    build_templates_from_patterns,
    classify_template_role,
)

__all__ = [
    "TemplateBuildReport",
    "TemplateByBiomeEntry",
    "TERRAIN_TO_BIOMES",
    "build_templates_from_patterns",
    "classify_template_role",
    "derive_biomes_for_tags",
    "list_biomes_for_templates",
    "templates_by_biome",
]
