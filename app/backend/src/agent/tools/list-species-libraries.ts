import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ListSpeciesLibrariesResponse, SpeciesLibrarySummary } from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import { buildSpeciesLibrary, summarizeSpeciesLibrary } from '../../scan/species-library.js';
import type { ToolContext } from '../types.js';

export const LIST_SPECIES_LIBRARIES_TOOL_NAME = 'list_species_libraries';

export const LIST_SPECIES_LIBRARIES_DESCRIPTION =
  "List every locally-scanned project that has Pokémon species data available for cross-project import. " +
  "Returns one summary per managed project (under %APPDATA%\\rom-editor\\projects\\ on Windows, " +
  "~/.rom-editor/projects/ otherwise) - name, project kind, counts of species / moves / learnsets / " +
  "evolutions. Use this when the user says 'I want all Pokémon from <some hack>' - pick the matching " +
  "library + ask them to confirm scope, then call import_species_from_library (1.5b).";

export const listSpeciesLibrariesInputShape = {} as const;

interface DiscoveryDeps {
  /** Override the managed-root parent dir. Tests use a tmpdir. */
  readonly managedRootOverride?: string;
}

function defaultManagedRoot(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'rom-editor', 'projects');
  }
  return path.join(homedir(), '.rom-editor', 'projects');
}

export async function listSpeciesLibraries(
  _ctx: ToolContext,
  deps: DiscoveryDeps = {},
): Promise<ListSpeciesLibrariesResponse> {
  const root = deps.managedRootOverride ?? defaultManagedRoot();
  let dirents: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    dirents = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { libraries: [] };
  }
  const summaries: SpeciesLibrarySummary[] = [];
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const projectRoot = path.join(root, e.name);
    let manifest;
    try {
      manifest = await readManifest(projectRoot);
    } catch {
      continue;
    }
    if (!manifest) continue;
    const library = buildSpeciesLibrary(manifest);
    if (library.species.length === 0 && library.moveNames.length === 0) {
      // No species data lifted - skip.
      continue;
    }
    summaries.push(summarizeSpeciesLibrary(library));
  }
  summaries.sort((a, b) => b.counts.species - a.counts.species);
  return { libraries: summaries };
}
