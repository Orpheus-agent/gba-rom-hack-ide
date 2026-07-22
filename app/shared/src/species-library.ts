/**
 * Cross-project species library - Phase AI-1.5.
 *
 * A portable, denormalized snapshot of all Pokémon-species-related
 * data the engine has lifted from a single project's manifest:
 * names, base stats, types, abilities, learnsets, evolutions, plus
 * the reference tables (moveNames, abilities, typeNames) that
 * species data points into.
 *
 * Usage shape: a target project's agent calls
 * `list_species_libraries()` → sees that the user's open Radical Red
 * project has a library with N species → calls
 * `import_species_from_library({ sourceProjectRoot, speciesIds })`
 * → backend generates an AgentPatchProposal[] to append the source
 * species' data into the target's manifest + ROM tables.
 *
 * 1.5a (this slice) ships materialization + discovery. 1.5b will
 * add the actual import patch generation.
 */

export interface SpeciesLibraryEntry {
  readonly speciesIndex: number;
  readonly name: string;
  readonly type1Name?: string;
  readonly type2Name?: string;
  readonly baseStats?: {
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
    readonly speed: number;
    readonly spAttack: number;
    readonly spDefense: number;
  };
  readonly catchRate?: number;
  readonly expYield?: number;
  readonly genderRatio?: number;
  readonly eggCycles?: number;
  readonly friendship?: number;
  readonly growthRate?: number;
  readonly ability1Name?: string;
  readonly ability2Name?: string;
  readonly learnset?: ReadonlyArray<{
    readonly level: number;
    readonly moveIndex: number;
    readonly moveName?: string;
  }>;
  readonly evolutions?: ReadonlyArray<{
    readonly method: number;
    readonly param: number;
    readonly targetSpeciesIndex: number;
    readonly targetSpeciesName?: string;
  }>;
}

export interface SpeciesLibraryMoveRef {
  readonly moveIndex: number;
  readonly name: string;
}

export interface SpeciesLibraryAbilityRef {
  readonly id: string;
  readonly name: string;
}

export interface SpeciesLibraryTypeRef {
  readonly typeIndex: number;
  readonly name: string;
}

export interface SpeciesLibrary {
  readonly sourceProjectRoot: string;
  readonly sourceDisplayName: string;
  readonly sourceProjectKind: string;
  readonly generatedAtUtc: string;
  readonly species: ReadonlyArray<SpeciesLibraryEntry>;
  readonly moveNames: ReadonlyArray<SpeciesLibraryMoveRef>;
  readonly abilities: ReadonlyArray<SpeciesLibraryAbilityRef>;
  readonly typeNames: ReadonlyArray<SpeciesLibraryTypeRef>;
}

/**
 * Lightweight summary surfaced by the agent's
 * `list_species_libraries()` MCP tool. The agent picks one of these
 * and asks for the full SpeciesLibrary via the backend route or by
 * calling `import_species_from_library`.
 */
export interface SpeciesLibrarySummary {
  readonly sourceProjectRoot: string;
  readonly sourceDisplayName: string;
  readonly sourceProjectKind: string;
  readonly generatedAtUtc: string;
  readonly counts: {
    readonly species: number;
    readonly moveNames: number;
    readonly learnsets: number;
    readonly evolutions: number;
    readonly abilities: number;
    readonly typeNames: number;
  };
}

export interface ListSpeciesLibrariesResponse {
  readonly libraries: ReadonlyArray<SpeciesLibrarySummary>;
}
