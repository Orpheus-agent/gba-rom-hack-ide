// Pure mechanic-detection engine. Reads the canonical manifest and reports
// which common modern-hack mechanics the project appears to use, plus the
// concrete entity ids that imply each detection. Foundation for Phase 9 - 
// makes "what mechanics live in this project" a visible inspector lens
// instead of "go grep the script files yourself".

import type { ProjectManifest } from '@rom-editor/shared';

export type MechanicId =
  | 'starter_selection'
  | 'difficulty_system'
  | 'evolution_flags'
  | 'encounter_variants';

export type MechanicSeverity = 'detected' | 'partial' | 'vanilla';

export interface MechanicDetection {
  readonly id: MechanicId;
  readonly label: string;
  readonly present: boolean;
  readonly severity: MechanicSeverity;
  /** Entity ids that imply the detection - script labels, flag ids, etc. */
  readonly signature: ReadonlyArray<string>;
  /** Plain-English notes the writer can read to understand the detection. */
  readonly notes: ReadonlyArray<string>;
}

export function assessAllMechanics(
  manifest: ProjectManifest,
): ReadonlyArray<MechanicDetection> {
  return [
    detectStarterSelection(manifest),
    detectDifficultySystem(manifest),
    detectEvolutionFlags(manifest),
    detectEncounterVariants(manifest),
  ];
}

// -----------------------------------------------------------------------------
// Individual detectors. Each returns a typed MechanicDetection - `present:false`
// means the project looks vanilla / un-modded for that mechanic.

const STARTER_LABEL_RE = /(birch|starter)/i;

function detectStarterSelection(manifest: ProjectManifest): MechanicDetection {
  const matchedSteps = manifest.scriptSteps.filter((s) =>
    STARTER_LABEL_RE.test(s.id),
  );
  // Group by parent script label for readability.
  const labels = new Set<string>();
  for (const s of matchedSteps) {
    const hashIdx = s.id.lastIndexOf('#');
    if (hashIdx > 0) labels.add(s.id.slice(0, hashIdx));
  }
  if (labels.size === 0) {
    return {
      id: 'starter_selection',
      label: 'Starter selection',
      present: false,
      severity: 'vanilla',
      signature: [],
      notes: ['No script labels matching /birch|starter/i found in the manifest.'],
    };
  }
  const labelList = Array.from(labels).sort();
  // Count msgbox steps in these scripts - proxy for "the script actually does something".
  const msgboxCount = matchedSteps.filter((s) => s.kind === 'dialogue').length;
  return {
    id: 'starter_selection',
    label: 'Starter selection',
    present: true,
    severity: labelList.length > 1 ? 'detected' : 'partial',
    signature: labelList,
    notes: [
      `Detected ${labelList.length} script label${labelList.length === 1 ? '' : 's'} matching the starter-selection pattern.`,
      msgboxCount > 0
        ? `These scripts contain ${msgboxCount} dialogue line${msgboxCount === 1 ? '' : 's'}.`
        : 'The detected scripts have no dialogue steps - possibly a stub.',
    ],
  };
}

const DIFFICULTY_FLAG_RE = /^(FLAG|VAR)_(DIFFICULTY|HARD_MODE|EASY_MODE|NUZLOCKE|RANDOMIZER)/i;

function detectDifficultySystem(manifest: ProjectManifest): MechanicDetection {
  const matchedFlags = manifest.flags.filter((f) => DIFFICULTY_FLAG_RE.test(f.id));
  const matchedVars = manifest.variables.filter((v) => DIFFICULTY_FLAG_RE.test(v.id));
  const sig = [...matchedFlags.map((f) => f.id), ...matchedVars.map((v) => v.id)].sort();
  if (sig.length === 0) {
    return {
      id: 'difficulty_system',
      label: 'Difficulty system',
      present: false,
      severity: 'vanilla',
      signature: [],
      notes: ['No FLAG_DIFFICULTY*/VAR_DIFFICULTY*/HARD_MODE/EASY_MODE/NUZLOCKE/RANDOMIZER identifiers.'],
    };
  }
  return {
    id: 'difficulty_system',
    label: 'Difficulty system',
    present: true,
    severity: sig.length >= 3 ? 'detected' : 'partial',
    signature: sig,
    notes: [
      `Detected ${matchedFlags.length} flag${matchedFlags.length === 1 ? '' : 's'} + ${matchedVars.length} variable${matchedVars.length === 1 ? '' : 's'} matching difficulty/nuzlocke/randomizer patterns.`,
    ],
  };
}

const EVOLUTION_FLAG_RE = /^FLAG_RECEIVED_/i;

function detectEvolutionFlags(manifest: ProjectManifest): MechanicDetection {
  const matched = manifest.flags.filter((f) => EVOLUTION_FLAG_RE.test(f.id));
  if (matched.length === 0) {
    return {
      id: 'evolution_flags',
      label: 'Evolution / received-mon flags',
      present: false,
      severity: 'vanilla',
      signature: [],
      notes: ['No FLAG_RECEIVED_* identifiers.'],
    };
  }
  return {
    id: 'evolution_flags',
    label: 'Evolution / received-mon flags',
    present: true,
    severity: matched.length >= 5 ? 'detected' : 'partial',
    signature: matched.map((f) => f.id).sort(),
    notes: [
      `Detected ${matched.length} FLAG_RECEIVED_* flag${matched.length === 1 ? '' : 's'} - typically one per receivable Pokémon (gift, in-game trade, special evolution).`,
    ],
  };
}

function detectEncounterVariants(manifest: ProjectManifest): MechanicDetection {
  // Group encounter tables by mapId; any map with multiple tables suggests
  // variant systems (e.g. grass + water + fishing + rock_smash).
  const perMap = new Map<string, number>();
  for (const t of manifest.encounterTables) {
    if (!t.mapId) continue;
    perMap.set(t.mapId, (perMap.get(t.mapId) ?? 0) + 1);
  }
  const multiTableMaps = Array.from(perMap.entries()).filter(([, c]) => c > 1);
  if (multiTableMaps.length === 0) {
    return {
      id: 'encounter_variants',
      label: 'Encounter-table variants',
      present: false,
      severity: 'vanilla',
      signature: [],
      notes: ['No map has more than one encounter table - vanilla single-table setup.'],
    };
  }
  return {
    id: 'encounter_variants',
    label: 'Encounter-table variants',
    present: true,
    severity: multiTableMaps.length >= 5 ? 'detected' : 'partial',
    signature: multiTableMaps.map(([mapId, n]) => `${mapId} (${n} tables)`),
    notes: [
      `${multiTableMaps.length} map${multiTableMaps.length === 1 ? '' : 's'} have multiple encounter tables (grass / water / fishing / rock_smash variants).`,
    ],
  };
}

// Helpers exported for tests
export const __test = {
  detectStarterSelection,
  detectDifficultySystem,
  detectEvolutionFlags,
  detectEncounterVariants,
};
