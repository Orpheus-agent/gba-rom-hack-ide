# Backlog (Phase Z.3)

Scope-creep buckets discovered while shipping subphases. A subphase
should NOT silently expand to cover these - they are tracked here and
picked up explicitly.

Organized by phase anchor. Each entry: short title + rationale +
estimated impact.

## P - Workspace Foundation

- **P-fu - auto-default to maps view on scan complete**
  Tried in Phase P.4; broke 14 App.test.tsx assertions because the
  scan-summary visibility races with the view transition. Requires
  rewriting the affected tests to either reset scan state in
  `beforeEach` or restructure the auto-switch as a one-shot CTA on
  the scan-summary card.

- **P.6 - full view inlining**
  Old views (EventsView, DialogueView, FlagsView, SpeciesView, etc.)
  still exist as standalone routes for backwards compatibility.
  Phase S delivers their content via per-entity inspectors in the
  workspace dock; a final cleanup pass can demote or remove the
  standalone routes once every cross-ref is replaced.

## Q - Semantic Reality

- **Q.2 follow-up - script-flow flag-name inference**
  Heuristic that walks the script bytecode to assign semantic names
  to flags based on context ("Got Bulbasaur" from a flag set just
  after `give_pokemon`). Today flags rely on the symbol DB OR the
  manifest's `Flag.name`; this would close gaps for binary-ROM hacks
  that don't expose constants on disk.

- **Q.3 - script semantic names from first-msgbox heuristic**
  Many scripts have no symbol-DB entry. First-msgbox-text-as-name
  (`"Hello there! Welcome to the world..."` → "Oak Intro Speech")
  would give a useful display name for most scripts. Truncate to
  40 chars + "...".

- **Q.6 follow-up - on-disk annotations.json**
  Current annotation persistence is localStorage. To share
  annotations across machines / collaborators, write to
  `<projectRoot>/.editor/annotations.json` via a backend route.

- **Q.5 - strip remaining ID fallbacks**
  `git grep -E '(script@0x|flag_0x|map_[0-9]|binary_[a-z]+_)'` in
  JSX files surfaces edge-case ID leaks. Audit + replace with
  `displayName()` calls.

## R - Region-First World

- **R.1 - full PixiJS region-tile renderer**
  WorldAtlasBanner is a quiet text strip today. R.1 calls for a
  real region tile sheet rendered with PixiJS (the engine already
  decodes region map tiles).

- **R.3 - story-flow overlay arrows**
  Toggleable progression arrows on the world atlas showing canonical
  story order (Pallet → Pewter Gym → Cerulean → ...). Inputs:
  badge-gate flags from Q.1 symbol DB + manifest scripts.

- **R.4 - encounter / weather / badge / shop overlays**
  Per-overlay heatmaps + pins on the world atlas. Each is a
  small dedicated layer.

- **R.5 - quick filter / minimap**
  Top of atlas: filter bar "Show only [gym maps]", minimap in corner.

## S - Per-Entity Inspectors

Unregistered EntityKinds (8 of 34):
- **sign** - subtype of objectEvent; the existing ObjectEventInspector
  could grow a kind-aware variant.
- **door** - same pattern.
- **sprite** - graphics asset; AssetInspector partially covers.
- **choice** - sub-entity of multichoice; MultichoiceInspector covers.
- **connection** - map-to-map adjacency; WarpInspector partially
  covers per-warp; a true connection inspector surfaces N/S/E/W
  alignment + seamless toggles.
- **tile** - single map cell with collision/elevation/metatile id;
  MapEditor's TilePropertiesEditor covers this in-context; could be
  registered for workspace-dock too.
- **encounterSlot** - sub-entity of encounterTable; inline edit is
  inside EncounterTableInspector.
- **cutscene** - script-derived; could surface a timeline view of
  cutscene-specific scripts.

Edit-everywhere expansion candidates (additional inline-edit forms):
- **trainer party** - change a Pokémon's species/level/moves in
  TrainerInspector without leaving the panel.
- **ability descriptions** - depends on a backend write route.
- **species description (Pokédex)** - extend PokedexInspector with
  flavor-text edit form.
- **trainer rewards** - money + item dropdowns.

## T - Rendering Correctness

All subphases pending. T is engine-side work and benefits from a
visual-regression suite (T.5) that snapshots the renderer against
known-good frames.

## U - Map Editing Power Tools

All subphases pending. Tiled has good documentation on the Wang/
Terrain brush algorithm; the existing usePaintStore + PixiJS
metatile renderer is the foundation.

## V - Visual Event Scripting

- **V-lite → V.1 full editable graph**
  ScriptStepInspector shows params with click-through but doesn't
  yet replace the existing ReactFlow read-only EventGraph. V.1
  makes that graph editable: drag-create edges, drag-add node from
  palette, save via bytecode round-trip.

- **V.5 unknown-opcode blackbox nodes**
  CFRU's mission system + Unbound's max-raid system inject new
  opcodes. V.5 renders them as opaque blackbox nodes with byte-
  editor fallback so the user can pass through unknown opcodes
  without losing them.

## W - Live Preview / Emulator

All subphases pending. mGBA-wasm exists as a published JS bundle;
integration is substantial but not novel. Hot-reload (W.4) is the
killer feature once W.1 + W.2 land.

## X - Semantic Search

- **X.2 follow-up - natural-language → DSL translation**
  Today the palette accepts `kind:trainer gym`. NL→DSL translates
  "all gym trainers" → that query. Small lookup table for common
  phrasings.

- **X.3 follow-up - smart collections that re-evaluate live**
  A saved search whose results update when the manifest changes
  (e.g., "every NPC giving an item" automatically gains/loses
  entries as scripts gain/lose `give_item` opcodes).

## Y - Universal ROM Support

- **Y.3 - unknown subsystem surfacing**
  Detector emits `UnknownSubsystem` records (byte range, confidence,
  inferred shape). Inspector lets the user annotate fields ("this
  u16 is mission_id") and label the system ("Quest System"). Once
  labeled, the system auto-generates an inspector from the
  annotated shape. Highest-leverage Y subphase for Unbound support.

- **Y.4 - user-extensible adapter packs**
  Community adapter directory: drop in `<adapter>/manifest.json` +
  symbol overrides + opcode tables for a specific hack. PluginsView
  is the surface for install/enable/disable.

## Z - Autonomous Loop Drivers

- **Z.4 - completion checkpoints**
  Explicit "Phase X exit gate" markers in KPIs.json so the loop
  knows when to transition phases from active to maintenance mode.

---

## Out-of-roadmap discoveries

Tracked here so they're not lost; reclassify into a phase when
addressed.

- **Pre-existing typecheck failures** in
  `app/backend/src/routes/binary-rom-graphics.ts` (missing
  `findFreeRomSpace` symbol). Predates the Phase P–Z roadmap;
  doesn't block any P–Z subphase. Should be fixed in a maintenance
  pass.

- **Pre-existing lint warnings** in `UniversalTilePicker.tsx`,
  `MapHeaderEditor.tsx`, `mapEditorScene.ts`,
  `plainEnglishRegression.test.tsx`. Same disposition as above.
