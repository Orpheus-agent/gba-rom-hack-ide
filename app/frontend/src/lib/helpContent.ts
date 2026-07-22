// Per-view contextual help content surfaced by the HelpOverlay (? button or
// the `?` keyboard shortcut). Each ViewKey gets exactly one HelpEntry - the
// coverage invariant fires at module load if a new ViewKey ships without a
// matching entry, so contributors can't ship a view without explaining it.

import type { ViewKey } from '../state';

export interface HelpShortcut {
  readonly keys: string;
  readonly description: string;
}

export interface HelpEntry {
  readonly view: ViewKey;
  readonly title: string;
  readonly summary: string;
  readonly tips: ReadonlyArray<string>;
  readonly shortcuts?: ReadonlyArray<HelpShortcut>;
  readonly relatedViews?: ReadonlyArray<ViewKey>;
}

const ENTRIES: ReadonlyArray<HelpEntry> = [
  {
    view: 'project',
    title: 'Project',
    summary:
      'Opens, classifies, and scans a Pokémon-decomp or patch-based ROM project. The identity card shows what was detected (decomp / patch / hybrid) and at what confidence. Scan once to index maps + events + flags + dialogue + assets into the canonical manifest the rest of the editor reads from.',
    tips: [
      'Open an absolute path to a project directory - no config file required.',
      'Scan after opening to populate every other tab. Re-scan whenever the source changes outside the editor.',
      'Identity evidence shows WHY the editor classified the project as decomp/patch/hybrid - useful when a fork confuses detection.',
    ],
    relatedViews: ['maps', 'events', 'build'],
  },
  {
    view: 'maps',
    title: 'Maps',
    summary:
      'The world graph. Every indexed map is a node; warps are edges. Drag to pan, click to inspect, double-click to open the per-tile Map Editor. Search by id/name; highlighted matches dim the rest of the graph.',
    tips: [
      'Open a map to edit individual tiles, place events, drag warp endpoints, and toggle layer overlays.',
      'The search bar accepts substrings and matches against id, name, and group.',
      'When a tile / warp / NPC / trigger is selected, its inline editor on the right responds to keyboard save + cancel.',
      'Layer toggles in the toolbar show/hide tiles, collision, objects, warps, triggers, heal locations, and movement ranges (red = trainer line-of-sight, purple = NPC wander zone).',
      'NPC + warp + trigger + heal-location markers are draggable - release on a new tile and the position writes through to the ROM. Trainers have a red triangle badge; items have a yellow diamond badge.',
      'Clicking a heal-location pin jumps you to the Heal Locations sidebar tab so you can edit destination map + slot details numerically.',
    ],
    shortcuts: [
      { keys: '/', description: 'Focus the map search field' },
      { keys: 'Enter', description: 'Save the focused inline editor (warp, tile, NPC, trigger, encounter, header, heal location)' },
      { keys: 'Ctrl+Enter', description: 'Save the focused textarea (msgbox dialogue, multi-line fields)' },
      { keys: 'Esc', description: 'Revert the focused editor / clear selection / close the per-map editor' },
    ],
    relatedViews: ['events', 'dependencies', 'preview', 'healLocations'],
  },
  {
    view: 'events',
    title: 'Events',
    summary:
      'Visual graph of triggers + object events + their script-step branches. Each event becomes a node; flag gates, dialogue jumps, and conditional branches become labeled edges. Inspect to see the exact macro + parameters of each step.',
    tips: [
      'Branches with conditional gates show the flag id on the edge - useful for tracing "why does the player not see this scene".',
      'Click any node to highlight its inbound + outbound references in the inspector.',
      'Trigger + script-step inspectors save on Enter (Ctrl+Enter for multi-line text) and revert on Esc.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused trigger / script-step editor' },
      { keys: 'Ctrl+Enter', description: 'Save the focused msgbox textarea' },
      { keys: 'Esc', description: 'Revert the focused editor' },
    ],
    relatedViews: ['dialogue', 'flags', 'dependencies'],
  },
  {
    view: 'dialogue',
    title: 'Dialogue',
    summary:
      'Every dialogue node parsed from the project (text.inc + per-map files). Inline edits write back atomically to the source file. The narrative graph traces what scripts call this line + what choices link to it.',
    tips: [
      'Edits go straight to disk - there is no separate save step. The op-log records every edit (see the Timeline tab).',
      'If a dialogue node looks orphaned (nobody calls it), the Lint tab will surface it.',
      'Dialogue lines edited through a msgbox script step (in Events or the per-map inspector) save via Ctrl+Enter.',
    ],
    relatedViews: ['events', 'lint', 'timeline'],
  },
  {
    view: 'flags',
    title: 'Flags',
    summary:
      'Every flag + variable indexed from the project. Selecting one shows every cross-reference: which scripts set it, which object events gate on it, which dialogue choices toggle it. Use this to safely answer "what would happen if I renamed FLAG_X".',
    tips: [
      'Flags with zero references are likely dead state - the Lint tab flags them as unused_flag.',
      'The reference list is bidirectional: setters AND readers AND gates are all listed.',
    ],
    relatedViews: ['events', 'lint', 'dependencies'],
  },
  {
    view: 'assets',
    title: 'Assets',
    summary:
      'Sprites, tilesets, palettes, music, UI graphics - every asset the project ships. Click to see every map / object event / dialogue / script step that references it. PNG assets support drag-drop replace with a live PNG-header preview.',
    tips: [
      'Replacement writes atomically to the asset\'s relativePath; the project build picks it up bit-identically on next make.',
      'Importing a brand-new PNG places it under graphics/ or sound/ depending on the picked path.',
    ],
    relatedViews: ['dependencies', 'lint'],
  },
  {
    view: 'preview',
    title: 'Preview',
    summary:
      'Walk any map interactively. Drop a player marker, toggle collision / warps / triggers / flag-gate overlays. The inspector reports what is under the marker. Per D-0017 the in-app scene simulator runs against the real manifest data - no compiled ROM required.',
    tips: [
      'Toggle the collision overlay to debug "the player walks through a wall here".',
      'Trigger zones highlighted in red mean their condition currently fires for the simulated state.',
    ],
    relatedViews: ['maps', 'events'],
  },
  {
    view: 'mechanics',
    title: 'Mechanics',
    summary:
      'Detects common modern-hack mechanics - starter selection, difficulty system, evolution flag groups, encounter-table variants - from the canonical manifest. Per-mechanic config editors let you enable / disable / tune via the UI instead of hand-editing source.',
    tips: [
      'The signature panel shows the exact entity ids that imply each detection - useful for understanding what would change if you disabled it.',
      'Config persists to .editor/mechanic-config.json; safe to commit alongside the project.',
    ],
    relatedViews: ['flags', 'templates', 'dependencies'],
  },
  {
    view: 'lint',
    title: 'Lint',
    summary:
      'Typed design-quality checks over the canonical manifest: orphan dialogue, unused flags, orphan assets, empty triggers, decorative-or-broken object events. Plus any custom validators contributed by plugins (see the Plugins tab).',
    tips: [
      'Severity-bordered findings make warn vs info distinguishable at a glance.',
      'A green clean-state celebrates zero findings - keep it that way before phase exits.',
    ],
    relatedViews: ['dependencies', 'plugins'],
  },
  {
    view: 'dependencies',
    title: 'Dependencies',
    summary:
      'Pick any entity from any kind and the editor reports every entity that depends on it (inbound) plus every entity it depends on (outbound). The universal "what breaks if I rename / remove this" report.',
    tips: [
      'Switching the entity-kind dropdown automatically picks the first id of that kind so the report is never blank.',
      'The datalist autocomplete suggests up to 200 ids per kind to make typing tolerable on large projects.',
    ],
    relatedViews: ['flags', 'assets', 'events', 'lint'],
  },
  {
    view: 'templates',
    title: 'Templates',
    summary:
      'Typed catalog of common Pokémon-decomp building blocks (town skeleton, boss intro, gift event, randomizer toggle, NPC with dialogue). Filling in parameters generates a live preview JSON that you can stage to .editor/staged-templates/ for manual review + application.',
    tips: [
      'Required parameters show a red asterisk. Missing values surface a typed materialization error before staging.',
      'Staging never touches data/maps/* or src/data/* - you review the staged JSON yourself and apply (or via a future P11 follow-up mutator).',
    ],
    relatedViews: ['mechanics', 'plugins'],
  },
  {
    view: 'plugins',
    title: 'Plugins',
    summary:
      'Declarative JSON plugin manifests in <projectRoot>/.editor/plugins/ that extend the editor with project-specific validators, event-type aliases, map-layer hints, and adapter metadata. Per D-0019 no plugin code runs in this process - manifests are pure data the editor evaluates.',
    tips: [
      'Custom validator findings appear inline under each rule + also in the Lint tab when applicable.',
      'Parse errors (invalid_json / invalid_shape / duplicate_id) appear in the rail with the offending filename + reason.',
    ],
    relatedViews: ['lint', 'mechanics'],
  },
  {
    view: 'timeline',
    title: 'Timeline',
    summary:
      'Append-only record of every mutation the editor has written to disk in this project. Reads .editor/op-log.jsonl. Grouped by UTC date, newest-first, with op-kind chips and expandable JSON payloads per entry.',
    tips: [
      'The status bar at the bottom shows the most recent entry at all times.',
      'Use Refresh to pull the latest from disk after an external process appended (rare).',
    ],
    relatedViews: ['build'],
  },
  {
    view: 'build',
    title: 'Build',
    summary:
      'Detected toolchain, build command, and on-disk artifacts the last build produced. Source → toolchain → compiled output, made visible. Use the build launcher to run the project\'s build command and watch the typed result land.',
    tips: [
      'Artifact metadata shows the SHA-1 of the most recent compiled output for trust + reproducibility.',
      'A build that produces no artifact path surfaces the toolchain output for diagnosis.',
    ],
    relatedViews: ['project', 'timeline'],
  },
  {
    view: 'tilesets',
    title: 'Tilesets',
    summary:
      'Universal tileset browser. Every primary + secondary tileset detected across the project is listed with thumbnails, palette previews, and per-metatile attribute summaries. Lets you scout reusable building blocks before painting them onto a map.',
    tips: [
      'Click a tileset row to expand its metatile grid; hover any cell to read its collision + behavior.',
      'Metatile attributes (collision, behavior, terrain, encounter) are edited inline from the Map Editor - open a map and click a tile.',
    ],
    relatedViews: ['maps', 'assets'],
  },
  {
    view: 'species',
    title: 'Species',
    summary:
      'Every Pokémon species lifted from the ROM, with editable base stats, types, abilities, TM/HM compatibility, name, learnset, and evolution slots. The detail panel is a full RPG-data workspace - no source-file edits required.',
    tips: [
      'TM/HM compatibility renders as a checkbox grid; the saved bitfield is patched in place.',
      'Learnset rows accept move + level edits; evolution slots accept method + parameter + target species.',
      'Adding rows (learnset move, evolution) uses the ROM free-space allocator - the new entry is appended and the slot pointer rewritten atomically.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused row (stats, name, TMHM, learnset move, evolution slot)' },
      { keys: 'Esc', description: 'Revert the focused row' },
    ],
    relatedViews: ['moves', 'abilities', 'types', 'pokedex'],
  },
  {
    view: 'moves',
    title: 'Moves',
    summary:
      'Catalog of every battle move with editable name, power, accuracy, PP, priority, type, effect id + parameter, and target. Wired to the binary-rom move struct writer - edits land in the ROM atomically.',
    tips: [
      'Name edits use the 12-byte slot encoder; longer names are rejected with a typed error before any write.',
      'Effect id + parameter pairs control the actual battle behavior (status %, flinch chance, etc.) - the param semantics depend on the effect id.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused move field or name' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['species', 'types', 'abilities'],
  },
  {
    view: 'items',
    title: 'Items',
    summary:
      'Every item lifted from the items_system detector. Editable subset: price (u16), hold effect id + param (u8), importance (u8), pocket (u8), type (u8). Item name + description text editing piggybacks the dialogue-string route.',
    tips: [
      'Pocket changes move the item between bag tabs - confirm with the pocket dropdown.',
      'Importance=1 marks a key item (no quantity, undroppable). Use it carefully.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused item field' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['mechanics', 'dependencies'],
  },
  {
    view: 'abilities',
    title: 'Abilities',
    summary:
      'Every ability + its in-game description lifted from the ability_system detector. Both the 12-byte ability name slot and the variable-length description string are editable - backed by the dialogue-string route.',
    tips: [
      'Name edits enforce the 12-byte slot; description edits enforce the original byte length (no relocation in this pass).',
      'Cross-references show which species can carry the ability - useful for spotting orphan abilities.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused ability name' },
      { keys: 'Ctrl+Enter', description: 'Save the focused ability description textarea' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['species', 'dependencies'],
  },
  {
    view: 'trainerClasses',
    title: 'Trainer Classes',
    summary:
      'Each trainer class - Bug Catcher, Lass, Youngster, Gym Leader, etc. - with editable class name and per-class money modifier. The class drives prize money + battle theme; the per-trainer party is edited from the trainer node in the Events graph.',
    tips: [
      'Money modifiers stack with trainer level - the final payout is class_modifier × highest_level.',
      'Renaming a class affects every trainer using it; the manifest re-scan picks up the change project-wide.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused class field or name' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['events', 'species', 'moves'],
  },
  {
    view: 'types',
    title: 'Types',
    summary:
      'The full type chart - every type, its name, and its matchup multipliers against every other type. The matrix patches in place against the type-effectiveness table (sentinel-terminated u8 triplets in vanilla Gen-3).',
    tips: [
      'Multiplier values are encoded as 0/5/10/20 (= 0×/0.5×/1×/2×). The editor exposes the four valid choices.',
      'Type name edits use the 7-byte slot (Gen-3 type names are short - IRON/PSYCHIC/etc.).',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused matchup cell or type name' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['moves', 'species'],
  },
  {
    view: 'pokedex',
    title: 'Pokédex',
    summary:
      'Per-species Pokédex entry editor - category (12-byte slot, "Seed", "Lizard", etc.) and flavor text (multi-paragraph description). Both edit through the binary-rom dialogue-string route, in place.',
    tips: [
      'Flavor text edits must fit within the original byte length (no relocation). Encoded length is verified pre-write.',
      'Use \\p for paragraph breaks and \\l for line breaks inside the textarea - they render as proper breaks in the preview.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused category name' },
      { keys: 'Ctrl+Enter', description: 'Save the focused flavor-text textarea' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['species', 'dialogue'],
  },
  {
    view: 'choices',
    title: 'Choices',
    summary:
      'Every multichoice list the game pops up - starter selection, sell-yes-no, region selectors, etc. Each list shows its choice strings + count; edits rewrite the multichoice list pointer + entries via the multichoice-list route.',
    tips: [
      'Each choice string honors the 12-byte slot. Encoded length is verified before any write.',
      'Adding a choice grows the list via the ROM free-space allocator + repoints the multichoice; deleting compacts in place.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused choice text' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['dialogue', 'events'],
  },
  {
    view: 'healLocations',
    title: 'Heal locations',
    summary:
      'Every sHealLocations entry - the destinations the game warps the player to on white-out, after Fly / Teleport, and for mom\'s house initial spawn. Each SPAWN_* slot is a (map group, map num, x, y) tuple; the editor lets you pick a different map or shift the tile coords for each slot. Patches the 6-byte struct in place.',
    tips: [
      'Slot indices are SPAWN_* constants the game logic references by index. Changing slot 0\'s destination changes where the white-out warp sends the player.',
      'Adding / removing slots is not exposed - that requires script changes elsewhere in the ROM since the SPAWN_* indices are hardcoded constants.',
      'The destination map dropdown shows every lifted map by display name. Cross-ref 21 resolves the (group, mapNum) pair to a manifest map id automatically when both bytes match a known map.',
      '"→ Show on map" jumps to the destination map\'s editor - the green heal-location pin will already be drawn at this slot\'s (x, y).',
      'On the Map Editor canvas, heal-location pins are draggable. Drop on a new tile and the (x, y) bytes patch in place; clicking the pin jumps you back here.',
    ],
    shortcuts: [
      { keys: 'Enter', description: 'Save the focused heal-location field' },
      { keys: 'Esc', description: 'Revert the focused field' },
    ],
    relatedViews: ['maps', 'events'],
  },
];

export class HelpError extends Error {
  constructor(
    public readonly code: 'unknown_view' | 'invalid_coverage',
    message: string,
  ) {
    super(message);
    this.name = 'HelpError';
  }
}

export function listHelpEntries(): ReadonlyArray<HelpEntry> {
  return ENTRIES;
}

export function getHelpEntry(view: ViewKey): HelpEntry {
  const e = ENTRIES.find((x) => x.view === view);
  if (!e) {
    throw new HelpError('unknown_view', `No help entry for view '${view}'`);
  }
  return e;
}

// Coverage invariant - runs at module load. Fails loudly if a new ViewKey is
// added without a matching help entry (so contributors can't ship an
// unexplained view).
export function validateHelpCoverage(allViewKeys: ReadonlyArray<ViewKey>): void {
  const seen = new Set<ViewKey>();
  for (const e of ENTRIES) {
    if (seen.has(e.view)) {
      throw new HelpError(
        'invalid_coverage',
        `Duplicate help entry for view '${e.view}'`,
      );
    }
    seen.add(e.view);
  }
  for (const k of allViewKeys) {
    if (!seen.has(k)) {
      throw new HelpError(
        'invalid_coverage',
        `No help entry for ViewKey '${k}' - add one to helpContent.ts ENTRIES`,
      );
    }
  }
}
