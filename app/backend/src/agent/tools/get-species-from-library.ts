import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  SpeciesLibrary,
  SpeciesLibraryEntry,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import { buildSpeciesLibrary } from '../../scan/species-library.js';
import type { ToolContext } from '../types.js';

export const GET_SPECIES_FROM_LIBRARY_TOOL_NAME = 'get_species_from_library';

export const GET_SPECIES_FROM_LIBRARY_DESCRIPTION =
  "Pull specific species entries out of another scanned project's library. " +
  "Use this after list_species_libraries to drill into a candidate source: " +
  "ask for { sourceProjectRoot: '<path from list_species_libraries result>', " +
  "speciesIds: [1, 4, 7] } to get BULBASAUR, CHARMANDER, and SQUIRTLE's full " +
  "denormalized data (base stats, types, abilities, learnset with resolved move " +
  "names, evolutions with resolved target names).\n\n" +
  "When speciesIds is omitted, returns ALL species in the library - useful for " +
  "small libraries but watch the payload size (Radical Red's library has 412 " +
  "species, ~150KB JSON). When the source project hasn't been scanned, returns " +
  "an empty list with reason='source_manifest_missing'.";

export const getSpeciesFromLibraryInputShape = {
  sourceProjectRoot: z.string().min(1),
  speciesIds: z.array(z.number().int().nonnegative()).optional(),
} as const;

export interface GetSpeciesFromLibraryResult {
  readonly available: boolean;
  readonly reason?: 'source_manifest_missing' | 'no_species_data';
  readonly sourceDisplayName?: string;
  readonly sourceProjectKind?: string;
  readonly entries: ReadonlyArray<SpeciesLibraryEntry>;
  /** Move-name reference table from the source library; only present
   *  when entries[] is non-empty. The agent uses this to resolve any
   *  moveIndex in entries[].learnset that didn't get a moveName
   *  inline (rare - usually the library resolves them eagerly). */
  readonly moveNames: ReadonlyArray<{ moveIndex: number; name: string }>;
  /** Type-name reference table from the source library. */
  readonly typeNames: ReadonlyArray<{ typeIndex: number; name: string }>;
  readonly totalSpeciesInLibrary: number;
  readonly message: string;
}

export async function getSpeciesFromLibrary(
  _ctx: ToolContext,
  args: { sourceProjectRoot: string; speciesIds?: number[] },
): Promise<GetSpeciesFromLibraryResult> {
  // Defense-in-depth: the source project root must be an absolute path
  // that exists. We don't restrict to %APPDATA% - the agent might be
  // pointed at a sibling project that lives elsewhere on disk - but we
  // do require the manifest to be readable from it.
  const sourceRoot = path.resolve(args.sourceProjectRoot);
  let manifest;
  try {
    manifest = await readManifest(sourceRoot);
  } catch {
    manifest = null;
  }
  if (!manifest) {
    return {
      available: false,
      reason: 'source_manifest_missing',
      entries: [],
      moveNames: [],
      typeNames: [],
      totalSpeciesInLibrary: 0,
      message: `No manifest found at '${sourceRoot}/.editor/manifest.json'. Use list_species_libraries to discover valid sources.`,
    };
  }
  const library: SpeciesLibrary = buildSpeciesLibrary(manifest);
  if (library.species.length === 0) {
    return {
      available: false,
      reason: 'no_species_data',
      sourceDisplayName: library.sourceDisplayName,
      sourceProjectKind: library.sourceProjectKind,
      entries: [],
      moveNames: [],
      typeNames: [],
      totalSpeciesInLibrary: 0,
      message: `Source '${library.sourceDisplayName}' has no species data lifted yet.`,
    };
  }

  let entries: ReadonlyArray<SpeciesLibraryEntry>;
  if (args.speciesIds && args.speciesIds.length > 0) {
    const wanted = new Set(args.speciesIds);
    entries = library.species.filter((s) => wanted.has(s.speciesIndex));
  } else {
    entries = library.species;
  }

  const messageParts: string[] = [
    `Returned ${entries.length} species from '${library.sourceDisplayName}'`,
  ];
  if (args.speciesIds && args.speciesIds.length > 0) {
    const found = new Set(entries.map((e) => e.speciesIndex));
    const missing = args.speciesIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      messageParts.push(`(${missing.length} requested id${missing.length === 1 ? '' : 's'} not present in the library)`);
    }
  } else {
    messageParts.push(`(all species - pass speciesIds to narrow the payload)`);
  }

  return {
    available: true,
    sourceDisplayName: library.sourceDisplayName,
    sourceProjectKind: library.sourceProjectKind,
    entries,
    moveNames: library.moveNames,
    typeNames: library.typeNames,
    totalSpeciesInLibrary: library.species.length,
    message: messageParts.join(' '),
  };
}
