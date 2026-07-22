// Per-mechanic configuration types. Persisted to <projectRoot>/.editor/mechanic-config.json
// by the backend; surfaced + editable in the MechanicsView detail pane.
//
// Each MechanicId from the detector engine has its own typed config shape;
// the union is keyed by id so adding a new mechanic doesn't break existing
// stored docs (unknown keys are preserved on read, then ignored).

export type MechanicId =
  | 'starter_selection'
  | 'difficulty_system'
  | 'evolution_flags'
  | 'encounter_variants';

export interface StarterSelectionConfig {
  /** Species ids the writer has chosen as the project's starter trio (or however
   *  many slots the mod offers). Each is an opaque string identifier - the
   *  editor doesn't validate against a species table; that's a separate
   *  iteration. Empty array = vanilla / default starters. */
  readonly starters: ReadonlyArray<string>;
}

export interface DifficultySystemConfig {
  /** Difficulty mode flag ids the writer wants enabled at new-game start.
   *  Subset of FLAG_DIFFICULTY/VAR_DIFFICULTY identifiers detected by the
   *  difficulty_system detector. */
  readonly enabledModes: ReadonlyArray<string>;
}

export interface EvolutionFlagsConfig {
  /** Species the writer wants the player to receive as gifts/in-game trades.
   *  Each maps to a FLAG_RECEIVED_<SPECIES> flag the build pipeline can wire
   *  into the gift script. */
  readonly giftSpecies: ReadonlyArray<string>;
}

export interface EncounterVariantsConfig {
  /** Encounter table types (grass/water/fishing/cave/rock_smash/custom) the
   *  writer wants enabled project-wide. */
  readonly enabledTypes: ReadonlyArray<string>;
}

export interface MechanicConfigDoc {
  readonly schemaVersion: 1;
  readonly starter_selection: StarterSelectionConfig;
  readonly difficulty_system: DifficultySystemConfig;
  readonly evolution_flags: EvolutionFlagsConfig;
  readonly encounter_variants: EncounterVariantsConfig;
}

export function emptyMechanicConfigDoc(): MechanicConfigDoc {
  return {
    schemaVersion: 1,
    starter_selection: { starters: [] },
    difficulty_system: { enabledModes: [] },
    evolution_flags: { giftSpecies: [] },
    encounter_variants: { enabledTypes: [] },
  };
}

// Partial-update request body shape - caller sends just the keys they want to
// change for the specified mechanicId. Keys not in the request are preserved.
export type MechanicConfigPatch =
  | Partial<StarterSelectionConfig>
  | Partial<DifficultySystemConfig>
  | Partial<EvolutionFlagsConfig>
  | Partial<EncounterVariantsConfig>;

export interface MechanicConfigResponse {
  readonly sessionId: string;
  readonly doc: MechanicConfigDoc;
}
