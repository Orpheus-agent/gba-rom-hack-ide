/**
 * Phase 4.1A - Named save-state library types.
 *
 * The editor lets the user capture mGBA save states with names + notes,
 * and load any of them on demand. Replaces the previous 3-fixed-slot
 * model. State binary lives at `<projectRoot>/.editor/save-states/<id>.state`
 * and the index lives at `<projectRoot>/.editor/save-states/index.json`.
 */

/** Persistent metadata for a saved emulator state. */
export interface SaveStateRecord {
  /** UUID - used as the on-disk filename and as the deep-link target. */
  readonly id: string;
  /** User-supplied display name. 1..80 chars. */
  readonly name: string;
  /** Optional free-form note ("after Cosmog handoff", "right before gym 1", …). */
  readonly notes: string | null;
  /** ISO timestamp of capture. */
  readonly createdAt: string;
  /** SHA-1 of the project ROM at capture time. Loading on a divergent ROM
   *  shows a confirmation but is permitted (mGBA savestates work across
   *  small ROM edits as long as the entry point + WRAM layout match). */
  readonly gameSha1: string;
  /** Length in bytes of the saved state file on disk. Mostly cosmetic. */
  readonly byteLength: number;
  /** True when this state was the one most-recently loaded (the editor uses
   *  this to highlight "where you last were"). At most one record carries this. */
  readonly lastLoaded: boolean;
}

/** Wire shape: GET /api/projects/:id/save-states response. */
export interface SaveStateListResponse {
  readonly states: ReadonlyArray<SaveStateRecord>;
}

/** Wire shape: POST /api/projects/:id/save-states request body.
 *  `data` is the raw savestate bytes captured via mGBA's
 *  `forceAutoSaveState` + `getAutoSaveState` pair, base64-encoded. */
export interface SaveStateCreateRequest {
  readonly name: string;
  readonly notes?: string | null;
  /** Base64-encoded savestate bytes. */
  readonly dataBase64: string;
}

/** Wire shape: POST /api/projects/:id/save-states response. */
export interface SaveStateCreateResponse {
  readonly state: SaveStateRecord;
}

/** Wire shape: PUT /api/projects/:id/save-states/:stateId request body. */
export interface SaveStateUpdateRequest {
  /** Update the display name. Length 1..80 (validated server-side). */
  readonly name?: string;
  /** Update the note. Pass empty string or null to clear. */
  readonly notes?: string | null;
  /** Mark this state as the most-recently loaded (clears the flag on every
   *  other record in the same project). */
  readonly markLastLoaded?: boolean;
}

/** Wire shape: PUT /api/projects/:id/save-states/:stateId response. */
export interface SaveStateUpdateResponse {
  readonly state: SaveStateRecord;
}

/** Wire shape: GET /api/projects/:id/save-states/:stateId/bytes returns
 *  the raw .state bytes (Content-Type: application/octet-stream). The
 *  client wraps them with mGBA's `uploadAutoSaveState` to restore. */
