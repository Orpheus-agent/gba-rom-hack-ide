"""Phase 8C-2 - Structural heuristic tagging.

Classifies a metatile's *role* in a map composition (filler / edge /
corner_* / transition / repeating) by inspecting the 8-slot
composition JSON, NOT pixels. This is intentional:
  - Fast (no LZ77 decode, no rendering).
  - Dialect-independent (FRLG + RSE compositions share the same
    8-quad structure).
  - Lossless against the structural categories - corner placement
    is fully determined by which quads of layer-0 differ.

The pixel-based heuristics (mean luminance, edge density) come in
Phase 8D-1 alongside CLIP embeddings; they live in a separate file.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StructuralTag:
    """One inferred structural tag with a numeric confidence."""

    slug: str
    confidence: float


def _quad_key(slot: dict) -> tuple:
    """Canonical key for "is this quad equivalent to that quad?"
    Two quads are equivalent if they reference the same tile, with
    the same flips, on the same palette."""
    return (
        int(slot["tileIndex"]),
        bool(slot["hflip"]),
        bool(slot["vflip"]),
        int(slot["paletteIndex"]),
    )


def classify_metatile(composition: list[dict]) -> list[StructuralTag]:
    """Apply structural heuristics to one metatile's composition.

    Composition shape: list of 8 dicts, 4 per layer × 4 quads.
    Quad ordering: 0=NW, 1=NE, 2=SW, 3=SE.

    Returns 0..N tags. Empty list when no heuristic fires above
    threshold (the metatile is "unstructured" - usually a unique
    decoration or a single-use anchor)."""

    layer0 = [s for s in composition if s["layer"] == 0]
    if len(layer0) != 4:
        return []
    # Index by quad for stable lookup.
    by_quad = {s["quad"]: s for s in layer0}
    if set(by_quad.keys()) != {0, 1, 2, 3}:
        return []

    keys = {q: _quad_key(s) for q, s in by_quad.items()}
    unique = set(keys.values())
    tags: list[StructuralTag] = []

    # 1. ALL FOUR EQUAL → filler / repeating
    if len(unique) == 1:
        # Same quad replicated 4× - classic ground texture.
        # The flip pattern across NW/NE/SW/SE matters for distinguishing
        # "true filler" (all identical, no flips) from "mirrored fill"
        # which is also fillery but more visually structured.
        all_no_flips = all(not s["hflip"] and not s["vflip"] for s in layer0)
        tags.append(
            StructuralTag(
                slug="structure.filler",
                confidence=1.0 if all_no_flips else 0.85,
            )
        )
        return tags

    # 2. TWO PAIRS → edge / repeating mirrors
    if len(unique) == 2:
        # NW == NE && SW == SE  (horizontal stripe) OR
        # NW == SW && NE == SE  (vertical stripe) OR
        # NW == SE && NE == SW  (diagonal mirror) OR
        # NW == NE == SW != SE (corner_se) - handled in case 3
        if keys[0] == keys[1] and keys[2] == keys[3] and keys[0] != keys[2]:
            tags.append(StructuralTag(slug="structure.edge", confidence=0.95))
            tags.append(StructuralTag(slug="structure.repeating", confidence=0.7))
            return tags
        if keys[0] == keys[2] and keys[1] == keys[3] and keys[0] != keys[1]:
            tags.append(StructuralTag(slug="structure.edge", confidence=0.95))
            tags.append(StructuralTag(slug="structure.repeating", confidence=0.7))
            return tags
        if keys[0] == keys[3] and keys[1] == keys[2] and keys[0] != keys[1]:
            # Diagonal mirror - common in cliff faces.
            tags.append(StructuralTag(slug="structure.transition", confidence=0.7))
            return tags

    # 3. THREE EQUAL + ONE DIFFERENT → corner_*
    if len(unique) == 2:
        counts = {k: list(keys.values()).count(k) for k in unique}
        majority = max(counts, key=lambda k: counts[k])
        minority = min(counts, key=lambda k: counts[k])
        if counts[majority] == 3 and counts[minority] == 1:
            different_quad = next(q for q in (0, 1, 2, 3) if keys[q] == minority)
            corner_slug = {
                0: "structure.corner_nw",
                1: "structure.corner_ne",
                2: "structure.corner_sw",
                3: "structure.corner_se",
            }[different_quad]
            tags.append(StructuralTag(slug=corner_slug, confidence=0.9))
            return tags

    # 4. ALL FOUR DIFFERENT → anchor / transition
    if len(unique) == 4:
        tags.append(StructuralTag(slug="structure.anchor", confidence=0.65))
        return tags

    # 5. THREE UNIQUE → transition (used in cliffs / corners + adjacent tile)
    if len(unique) == 3:
        tags.append(StructuralTag(slug="structure.transition", confidence=0.75))
        return tags

    return tags


def classify_layer1_overlay(composition: list[dict]) -> bool:
    """Phase 8C-2 helper - returns True when layer-1 is NOT entirely
    transparent (tileIndex 0 means transparent). Used by callers to
    decorate metatiles that decorate their layer-0 base with overlays
    like flowers, signs, lampposts."""

    layer1 = [s for s in composition if s["layer"] == 1]
    return any(int(s["tileIndex"]) != 0 for s in layer1)
