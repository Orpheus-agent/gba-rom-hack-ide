// Universal vocabulary for the canonical project manifest. Per MASTER_PROMPT §5,
// every editor speaks this vocabulary; only project translators speak engine
// dialects. Field surfaces here are minimal and real - expanded by Phase 1+
// detection adapters without breaking shape.

export type EntityId = string;

export interface BaseEntity {
  readonly id: EntityId;
  readonly name: string;
}

export type MapGroup =
  | 'town'
  | 'route'
  | 'interior'
  | 'cave'
  | 'dungeon'
  | 'special'
  | 'unknown';

export interface MapDimensions {
  readonly width: number;
  readonly height: number;
}

export interface MapNode extends BaseEntity {
  readonly group: MapGroup;
  readonly dimensions: MapDimensions;
  readonly tilesetIds: ReadonlyArray<EntityId>;
  readonly warpIds: ReadonlyArray<EntityId>;
  readonly scriptIds: ReadonlyArray<EntityId>;
  readonly objectEventIds: ReadonlyArray<EntityId>;
  readonly encounterTableIds: ReadonlyArray<EntityId>;
  readonly musicId: EntityId | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  /** Phase N - 4-directional map connections (DOWN/UP/LEFT/RIGHT) +
   *  dive/emerge. Each entry knows its struct file offset for in-place
   *  edits. Optional: absent on decomp maps where connections live in
   *  map.json instead. */
  readonly connections?: ReadonlyArray<MapConnectionLink>;
}

export interface MapConnectionLink {
  /** 1=DOWN, 2=UP, 3=LEFT, 4=RIGHT, 5=DIVE, 6=EMERGE per pret/pokefirered. */
  readonly direction: number;
  /** Tile offset along the shared edge (signed). */
  readonly offset: number;
  /** Resolved destination map id (matches `binary_map_<group>_<num>`)
   *  or null when the dest indices are out-of-range. */
  readonly destMapId: EntityId | null;
  /** Raw destination group + num for diagnostic surfaces. */
  readonly destMapGroup: number;
  readonly destMapNum: number;
  /** File offset of this 12-byte MapConnection struct. */
  readonly fileOffset: number;
}

export interface MapCoordinate {
  readonly x: number;
  readonly y: number;
}

export interface Warp extends BaseEntity {
  readonly fromMapId: EntityId;
  readonly fromCoord: MapCoordinate;
  readonly toMapId: EntityId;
  readonly toCoord: MapCoordinate;
  /** Phase K.2 - free-form metadata bag used by the binary-rom lifter
   *  to stash the 8-byte Warp struct file offset so the editor can
   *  delete the warp via /binary-rom-edit/map-event-table. Optional;
   *  decomp / older manifests leave undefined. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type TriggerKind =
  | 'on_enter'
  | 'on_interact'
  | 'on_flag_set'
  | 'on_battle_end'
  | 'on_first_visit'
  | 'custom';

export interface Trigger extends BaseEntity {
  readonly kind: TriggerKind;
  readonly mapId: EntityId | null;
  readonly coord: MapCoordinate | null;
  readonly conditionExpression: string | null;
  readonly scriptStepIds: ReadonlyArray<EntityId>;
  /** Phase J.1 - free-form metadata bag used by the binary-rom lifter
   *  to stash struct file offsets + raw byte fields (bg-event kind,
   *  coord-trigger var/value) so the inspector can edit them in place.
   *  Optional + defaults to `{}` so older manifests stay schema-compatible. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DialogueChoice {
  readonly label: string;
  readonly nextDialogueId: EntityId | null;
  readonly setsFlagIds: ReadonlyArray<EntityId>;
}

export interface DialogueNode extends BaseEntity {
  readonly speakerName: string | null;
  readonly portraitAssetId: EntityId | null;
  readonly text: string;
  readonly choices: ReadonlyArray<DialogueChoice>;
}

export type FlagScope = 'global' | 'map_local' | 'temporary';

export interface Flag extends BaseEntity {
  readonly scope: FlagScope;
  readonly defaultValue: boolean;
  readonly description: string | null;
  /** Raw engine identifier exactly as it appears in the project source (e.g. "0x807"
   *  or "(TRAINER_FLAGS_START + 0x4)" for unresolved macros). Surfaces hidden engine
   *  state per Pillar 5. */
  readonly engineValue: string;
}

export interface Variable extends BaseEntity {
  readonly scope: FlagScope;
  readonly defaultValue: number;
  readonly description: string | null;
  readonly engineValue: string;
}

export type EncounterTableType =
  | 'grass'
  | 'water'
  | 'fishing'
  | 'cave'
  | 'rock_smash'
  | 'custom';

export interface EncounterSlot {
  readonly speciesId: EntityId;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly weight: number;
  /** Phase J - file offset of this 4-byte WildPokemon slot. When set,
   *  the slot is editable via the binary-rom-edit/encounter-slot route.
   *  Decomp / older manifests leave this undefined. */
  readonly fileOffset?: number;
}

export interface EncounterTable extends BaseEntity {
  readonly mapId: EntityId | null;
  readonly type: EncounterTableType;
  /** Overall chance (0..100) of an encounter check producing a wild battle on this table. */
  readonly encounterRate: number;
  readonly slots: ReadonlyArray<EncounterSlot>;
  /** WP-C1 - file offset of the WildPokemonInfo struct (8 bytes). The
   *  first byte is the editable encounterRate; the rest is padding +
   *  the slots-array pointer. Used by /binary-rom-edit/encounter-rate. */
  readonly infoFileOffset?: number;
  /** WP-C1 - file offset of the WildPokemon[] array. Slot counts are
   *  fixed per encounter kind in Gen-3 (engine-hardcoded loop bounds:
   *  land=12, water=5, fishing=10, rockSmash=5), so add/remove isn't
   *  possible without ARM patches; reorder IS - writes a permuted
   *  (slotCount × 4)-byte array back over the existing one. Used by
   *  /binary-rom-edit/encounter-reorder. */
  readonly slotsFileOffset?: number;
}

export interface TrainerPartyMember {
  readonly speciesId: EntityId;
  readonly level: number;
  readonly moveIds: ReadonlyArray<EntityId>;
  readonly heldItemId: EntityId | null;
  /** Phase K.4 - file offset of this party member's struct (size
   *  depends on partyFlags: 8 bytes for Basic/Items, 16 for Moves/
   *  MovesItems). Editor uses this to write back species/level/moves/
   *  heldItem in place. */
  readonly fileOffset?: number;
}

export interface Trainer extends BaseEntity {
  readonly className: string;
  readonly party: ReadonlyArray<TrainerPartyMember>;
  readonly aiFlags: ReadonlyArray<string>;
  readonly mapId: EntityId | null;
  /** Phase K.4 - metadata bag for binary-rom trainer struct offsets +
   *  party flags + party size. Lets the inspector edit party members
   *  in place and surfaces which struct-variant each member uses. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type ScriptStepKind =
  | 'dialogue'
  | 'set_flag'
  | 'clear_flag'
  | 'branch'
  | 'branch_on_var'
  | 'give_item'
  | 'start_battle'
  | 'play_sound'
  | 'move_npc'
  | 'fade_scene'
  | 'warp_player'
  | 'set_variable'
  | 'randomize_branch'
  | 'raw';

/**
 * Phase 2B - conditional-jump operator used by `branch_on_var` steps.
 * Matches engine's `BranchOperator` byte mapping:
 *   less=0, equal=1, greater=2, lessorequal=3, greaterorequal=4, notequal=5
 */
export type BranchOnVarOperator =
  | 'less'
  | 'equal'
  | 'greater'
  | 'lessorequal'
  | 'greaterorequal'
  | 'notequal';

export interface ScriptStep {
  readonly id: EntityId;
  readonly kind: ScriptStepKind;
  readonly params: Readonly<Record<string, unknown>>;
}

export type ObjectEventKind = 'npc' | 'trainer' | 'item' | 'misc';

export interface ObjectEvent extends BaseEntity {
  readonly mapId: EntityId;
  readonly coord: MapCoordinate;
  readonly elevation: number;
  readonly kind: ObjectEventKind;
  readonly graphicsId: string | null;
  readonly movementType: string | null;
  readonly scriptId: EntityId | null;
  readonly flagId: EntityId | null;
  readonly trainerType: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Phase 2E - Form-change rule. Registers a species transform driven by
 * a held signature item. The rule is bidirectional by default:
 * attaching the held item triggers `species → targetSpecies`; detaching
 * (or transferring) reverts. Set `oneWay: true` when the transformation
 * is permanent (the user must explicitly opt in - Pokémon that won't
 * revert on PC deposit must also be added to CFRU's
 * sBannedBackupSpecies list, which the propose tool surfaces).
 *
 * Lifted from / patched into CFRU's `src/form_change.c`
 * `HoldItemFormChange` dispatcher; the tool produces a paste-able C
 * snippet rather than trying to rewrite the switch directly.
 */
export interface FormChangeRule {
  readonly id: string;
  /** Symbolic species constant (e.g. SPECIES_ZACIAN) - must exist in
   *  the manifest's species set or the user's CFRU symbol DB. */
  readonly speciesId: string;
  /** Symbolic item constant (e.g. ITEM_RUSTED_SWORD). */
  readonly heldItemId: string;
  /** Symbolic target species constant for the transformed form
   *  (e.g. SPECIES_ZACIAN_CROWNED). */
  readonly targetSpeciesId: string;
  /** When true, the rule is one-way (no revert on item detach). The
   *  target species must usually also be added to sBannedBackupSpecies
   *  so it doesn't revert on PC deposit. */
  readonly oneWay: boolean;
  /** Optional free-form notes shown in the inspector. */
  readonly notes: string | null;
}

/**
 * Phase 2D - Level cap table.
 *
 * CFRU's per-badge obedience-level system. The player's traded Pokémon
 * disobey at levels above `BADGE_N_OBEDIENCE_LEVEL` until they hold the
 * N-th badge. With the `originalOtObedienceCheck` toggle, the rule also
 * applies to the player's own Pokémon - turning this into a hard
 * difficulty gate.
 *
 * Source: `src/config.h` lines 166-174 of Complete Fire Red Upgrade.
 * The editor emits source-file edits + a fresh CFRU bundle rebuild;
 * the on-ROM effect lands after `build-cfru-bundle.mjs` re-runs.
 */
export interface LevelCapTable {
  /** Level at which Pokémon disobey before earning any badge. */
  readonly base: number;
  /** Per-badge obedience caps. Index 0 = after Badge 1, index 6 = after
   *  Badge 7. After Badge 8 (Earth) the cap is removed by the engine. */
  readonly badges: readonly [number, number, number, number, number, number, number];
  /** Whether the obedience check applies to the player's own original
   *  Pokémon (default false → only traded mons can disobey). When true,
   *  the level cap becomes a hard difficulty ceiling on the player's
   *  entire party until each badge is earned. */
  readonly originalOtObedienceCheck: boolean;
}

export type AssetKind =
  | 'overworld_sprite'
  | 'trainer_sprite'
  | 'battle_sprite'
  | 'tileset'
  | 'palette'
  | 'ui_graphic'
  | 'portrait'
  | 'animation'
  | 'icon'
  | 'music'
  | 'sound';

export interface Asset extends BaseEntity {
  readonly kind: AssetKind;
  readonly relativePath: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
