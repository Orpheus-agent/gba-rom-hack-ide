/**
 * Phase 4.1B - Scene-boot recipe types.
 *
 * A SceneBootRecipe captures everything the editor needs to start
 * a play session at a specific narrative point: warp the player to
 * a chosen map, pre-seed a list of flags + vars, and optionally
 * trigger a script at boot.
 *
 * Recipes are project-scoped and persist under
 * `<projectRoot>/.editor/scene-boots/index.json` so the user can
 * re-launch a scene as fast as clicking a saved recipe.
 *
 * Wire format mirrors save-state.ts conventions: numeric ids stored
 * as numbers (flagId, varId, mapGroup/mapNum); strings reserved for
 * human-readable fields (name, notes, scriptId reference).
 */

/** A single (varId, value) pair to write into the running game's
 *  WRAM before the scene starts. */
export interface SceneBootVarSeed {
  readonly varId: number;
  readonly value: number;
}

/** Direction the player should be facing after the warp.
 *  Mirrors the Gen-3 engine's facing enum. */
export type SceneBootFacing = 'down' | 'up' | 'left' | 'right';

/** Persistent record of a scene-boot recipe. */
export interface SceneBootRecipe {
  /** UUID. */
  readonly id: string;
  /** Display name (1..80 chars). */
  readonly name: string;
  /** Optional free-form note. */
  readonly notes: string | null;
  /** ISO timestamp of creation. */
  readonly createdAt: string;
  /** Manifest map id (`map_group_num` or whatever scheme the project uses).
   *  Stored as a string so we never have to keep the recipe in sync with
   *  changes to the map index. The orchestrator resolves it back to
   *  (group, num) at boot time. */
  readonly startingMapId: string;
  /** Optional tile coordinates + facing. When omitted, the player lands
   *  on the map's default warp/spawn tile. */
  readonly startingPosition: {
    readonly x: number;
    readonly y: number;
    readonly facing: SceneBootFacing;
  } | null;
  /** Flag ids to SET (i.e. all of these are written truthy before the
   *  scene starts). Each flag id is a Gen-3 numeric id, e.g. 0x820 for
   *  FLAG_BADGE01_GET. */
  readonly initialFlags: ReadonlyArray<number>;
  /** Var (id, value) pairs to write. Order is preserved. */
  readonly initialVars: ReadonlyArray<SceneBootVarSeed>;
  /** Optional script id (from the manifest) to trigger immediately after
   *  the warp + seed step. The orchestrator looks up the script's ROM
   *  offset and writes it into the engine's pending-script slot. */
  readonly triggerScriptId: string | null;
  /** When true, the boot orchestrator fast-forwards through the title
   *  + intro screens before pausing to patch WRAM. When false, the user
   *  drives the game manually to a save state first and the recipe only
   *  patches state from there. */
  readonly skipIntro: boolean;
}

/** Wire shape: GET /api/projects/:id/scene-boot-recipes response. */
export interface SceneBootListResponse {
  readonly recipes: ReadonlyArray<SceneBootRecipe>;
}

/** Wire shape: POST /api/projects/:id/scene-boot-recipes body. */
export interface SceneBootCreateRequest {
  readonly name: string;
  readonly notes?: string | null;
  readonly startingMapId: string;
  readonly startingPosition?: {
    readonly x: number;
    readonly y: number;
    readonly facing: SceneBootFacing;
  } | null;
  readonly initialFlags?: ReadonlyArray<number>;
  readonly initialVars?: ReadonlyArray<SceneBootVarSeed>;
  readonly triggerScriptId?: string | null;
  readonly skipIntro?: boolean;
}

/** Wire shape: POST /api/projects/:id/scene-boot-recipes response. */
export interface SceneBootCreateResponse {
  readonly recipe: SceneBootRecipe;
}

/** Wire shape: PUT /api/projects/:id/scene-boot-recipes/:id body.
 *  Partial update - only fields that are set are applied. */
export interface SceneBootUpdateRequest {
  readonly name?: string;
  readonly notes?: string | null;
  readonly startingMapId?: string;
  readonly startingPosition?: {
    readonly x: number;
    readonly y: number;
    readonly facing: SceneBootFacing;
  } | null;
  readonly initialFlags?: ReadonlyArray<number>;
  readonly initialVars?: ReadonlyArray<SceneBootVarSeed>;
  readonly triggerScriptId?: string | null;
  readonly skipIntro?: boolean;
}

/** Wire shape: PUT /api/projects/:id/scene-boot-recipes/:id response. */
export interface SceneBootUpdateResponse {
  readonly recipe: SceneBootRecipe;
}
