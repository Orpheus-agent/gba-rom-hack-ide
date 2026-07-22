import type {
  ProjectManifest,
  SpeciesLibrary,
  SpeciesLibraryEntry,
  SpeciesLibraryMoveRef,
  SpeciesLibrarySummary,
} from '@rom-editor/shared';

/**
 * Materialize a portable SpeciesLibrary from a project manifest.
 *
 * The library is denormalized: every entry includes resolved
 * name strings (move names, ability names, type names) rather
 * than raw indices, so a downstream project can read the
 * library without needing the source manifest's cross-ref tables.
 *
 * 1.5a returns whatever the engine's species lifters captured - 
 * which may be partial (e.g. only 21 species struct entries
 * lifted from FireRed's species table) but is real data. The
 * library is reused as-is when the engine improves; no schema
 * change needed.
 */
export function buildSpeciesLibrary(manifest: ProjectManifest): SpeciesLibrary {
  const moveNameByIndex = new Map<number, string>();
  for (const m of manifest.moveNames ?? []) {
    if (typeof m.name === 'string' && m.name.length > 0) {
      moveNameByIndex.set(m.moveIndex, m.name);
    }
  }
  for (const m of manifest.battleMoves ?? []) {
    if (!moveNameByIndex.has(m.moveIndex) && typeof m.name === 'string' && m.name.length > 0) {
      moveNameByIndex.set(m.moveIndex, m.name);
    }
  }

  const speciesNameByIndex = new Map<number, string>();
  for (const s of manifest.speciesNames ?? []) {
    if (typeof s.name === 'string' && s.name.length > 0) {
      speciesNameByIndex.set(s.speciesIndex, s.name);
    }
  }
  for (const s of manifest.species ?? []) {
    if (!speciesNameByIndex.has(s.speciesIndex) && typeof s.name === 'string' && s.name.length > 0) {
      speciesNameByIndex.set(s.speciesIndex, s.name);
    }
  }

  const learnsetByIndex = new Map<number, SpeciesLibraryEntry['learnset']>();
  for (const ls of manifest.speciesLearnsets ?? []) {
    learnsetByIndex.set(
      ls.speciesIndex,
      ls.moves.map((m) => ({
        level: m.level,
        moveIndex: m.move,
        moveName: moveNameByIndex.get(m.move),
      })),
    );
  }

  const evolutionsByIndex = new Map<number, SpeciesLibraryEntry['evolutions']>();
  for (const ev of manifest.speciesEvolutions ?? []) {
    evolutionsByIndex.set(
      ev.speciesIndex,
      ev.slots.map((s) => ({
        method: s.method,
        param: s.param,
        targetSpeciesIndex: s.targetSpecies,
        targetSpeciesName: s.targetSpeciesName ?? speciesNameByIndex.get(s.targetSpecies),
      })),
    );
  }

  // Build the per-species union: speciesIndex appears if ANY of the
  // upstream lifters captured something for it.
  const allIndices = new Set<number>();
  for (const idx of speciesNameByIndex.keys()) allIndices.add(idx);
  for (const s of manifest.species ?? []) allIndices.add(s.speciesIndex);
  for (const idx of learnsetByIndex.keys()) allIndices.add(idx);
  for (const idx of evolutionsByIndex.keys()) allIndices.add(idx);

  const speciesByIndex = new Map<number, SpeciesLibraryEntry>();
  for (const idx of [...allIndices].sort((a, b) => a - b)) {
    const struct = (manifest.species ?? []).find((s) => s.speciesIndex === idx);
    const entry: SpeciesLibraryEntry = {
      speciesIndex: idx,
      name: speciesNameByIndex.get(idx) ?? `species_${idx}`,
      ...(struct?.type1Name ? { type1Name: struct.type1Name } : {}),
      ...(struct?.type2Name ? { type2Name: struct.type2Name } : {}),
      ...(struct
        ? {
            baseStats: {
              hp: struct.baseHP,
              attack: struct.baseAttack,
              defense: struct.baseDefense,
              speed: struct.baseSpeed,
              spAttack: struct.baseSpAttack,
              spDefense: struct.baseSpDefense,
            },
            catchRate: struct.catchRate,
            expYield: struct.expYield,
            genderRatio: struct.genderRatio,
            eggCycles: struct.eggCycles,
            friendship: struct.friendship,
            growthRate: struct.growthRate,
          }
        : {}),
      ...(struct?.ability1Name ? { ability1Name: struct.ability1Name } : {}),
      ...(struct?.ability2Name ? { ability2Name: struct.ability2Name } : {}),
      ...(learnsetByIndex.has(idx) ? { learnset: learnsetByIndex.get(idx) } : {}),
      ...(evolutionsByIndex.has(idx) ? { evolutions: evolutionsByIndex.get(idx) } : {}),
    };
    speciesByIndex.set(idx, entry);
  }

  const species = [...speciesByIndex.values()];

  const moveNames: SpeciesLibraryMoveRef[] = [];
  for (const [moveIndex, name] of [...moveNameByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    moveNames.push({ moveIndex, name });
  }

  const abilities = (manifest.abilities ?? []).map((a) => ({ id: a.id, name: a.name }));
  const typeNames = (manifest.typeNames ?? []).map((t) => ({
    typeIndex: t.typeIndex,
    name: t.name,
  }));

  return {
    sourceProjectRoot: manifest.projectRoot,
    sourceDisplayName: manifest.identity.displayName,
    sourceProjectKind: manifest.identity.kind,
    generatedAtUtc: new Date().toISOString(),
    species,
    moveNames,
    abilities,
    typeNames,
  };
}

export function summarizeSpeciesLibrary(library: SpeciesLibrary): SpeciesLibrarySummary {
  const learnsets = library.species.filter((s) => s.learnset && s.learnset.length > 0).length;
  const evolutions = library.species.filter((s) => s.evolutions && s.evolutions.length > 0).length;
  return {
    sourceProjectRoot: library.sourceProjectRoot,
    sourceDisplayName: library.sourceDisplayName,
    sourceProjectKind: library.sourceProjectKind,
    generatedAtUtc: library.generatedAtUtc,
    counts: {
      species: library.species.length,
      moveNames: library.moveNames.length,
      learnsets,
      evolutions,
      abilities: library.abilities.length,
      typeNames: library.typeNames.length,
    },
  };
}
