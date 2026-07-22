import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';

export const GET_DETECTION_REPORT_TOOL_NAME = 'get_detection_report';

export const GET_DETECTION_REPORT_DESCRIPTION =
  'Per-system detection counts for the currently-open ROM project, with ' +
  'expected baselines and a status flag (ok / partial / missing). Use this ' +
  'when you suspect a detector underperformed on the loaded ROM - e.g. the ' +
  'user says "you found 0 trainers, that can\'t be right" and you want to ' +
  'know whether the engine\'s trainer detector actually ran (status=missing ' +
  'means it didn\'t find anything; partial means it returned data but below ' +
  'the expected baseline; ok means the count matches vanilla expectations).\n\n' +
  'Status semantics:\n' +
  '  - "ok": count >= expected baseline (or no baseline defined).\n' +
  '  - "partial": count > 0 but < 0.5× the expected baseline.\n' +
  '  - "missing": count == 0 and the system is universally present in ' +
  'Gen-3 ROMs.\n\n' +
  'Use this alongside `get_workspace_summary` (which only reports the most ' +
  'common counts) when you need to know whether to retry detection or ' +
  'attempt edits against partial data.';

export const getDetectionReportInputShape = {} as const;

/** Per-system row in the report. */
export interface DetectionSystemRow {
  readonly system: string;
  readonly detected: number;
  readonly expectedVanilla: number | null;
  readonly status: 'ok' | 'partial' | 'missing';
  readonly note?: string;
}

export interface GetDetectionReportResult {
  readonly available: boolean;
  readonly reason?: string;
  readonly message?: string;
  readonly projectRoot: string;
  readonly identityDisplayName?: string;
  readonly systems: ReadonlyArray<DetectionSystemRow>;
  /** Counts of rows per status. */
  readonly summary?: { ok: number; partial: number; missing: number };
}

/** Vanilla baselines (FRLG/Emerald) for sanity-checking detection
 *  output. Hacks can exceed these; significant DROP below them
 *  flags a likely detector miss. */
const EXPECTED_VANILLA: Record<string, number> = {
  maps: 200,
  warps: 800,
  triggers: 500,
  objectEvents: 800,
  encounterTables: 100,
  trainers: 400,
  scriptSteps: 5000,
  assets: 30,
  species: 400,
  speciesNames: 400,
  moveNames: 300,
  abilities: 70,
  items: 300,
  trainerClassNames: 60,
  typeNames: 17,
  regionMapSections: 80,
  speciesLearnsets: 400,
  speciesEvolutions: 100,
};

function classifyStatus(detected: number, expected: number | null): DetectionSystemRow['status'] {
  if (detected === 0) return 'missing';
  if (expected === null) return 'ok';
  if (detected < expected * 0.5) return 'partial';
  return 'ok';
}

export async function getDetectionReport(
  ctx: ToolContext,
): Promise<GetDetectionReportResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      available: false,
      reason: 'manifest_not_found',
      message: `No scanned manifest at ${ctx.projectRoot}/.editor/manifest.json.`,
      projectRoot: ctx.projectRoot,
      systems: [],
    };
  }

  const systems: DetectionSystemRow[] = [];
  const counts: Record<string, number> = {
    maps: manifest.maps.length,
    warps: manifest.warps.length,
    triggers: manifest.triggers.length,
    objectEvents: manifest.objectEvents.length,
    encounterTables: manifest.encounterTables.length,
    trainers: manifest.trainers.length,
    scriptSteps: manifest.scriptSteps.length,
    assets: manifest.assets.length,
    species: manifest.species?.length ?? 0,
    speciesNames: manifest.speciesNames?.length ?? 0,
    speciesLearnsets: manifest.speciesLearnsets?.length ?? 0,
    speciesEvolutions: manifest.speciesEvolutions?.length ?? 0,
    moveNames: manifest.moveNames?.length ?? 0,
    abilities: manifest.abilities?.length ?? 0,
    items: manifest.items?.length ?? 0,
    trainerClassNames: manifest.trainerClassNames?.length ?? 0,
    typeNames: manifest.typeNames?.length ?? 0,
    regionMapSections: manifest.regionMapSections?.length ?? 0,
  };

  const summary = { ok: 0, partial: 0, missing: 0 };
  for (const [system, detected] of Object.entries(counts)) {
    const expected = EXPECTED_VANILLA[system] ?? null;
    const status = classifyStatus(detected, expected);
    summary[status]++;
    const row: DetectionSystemRow = {
      system,
      detected,
      expectedVanilla: expected,
      status,
      ...(status === 'partial' && expected !== null
        ? {
            note: `Detected ${detected} but vanilla baseline is ~${expected}. The detector may have hit a false-positive signature match or stopped early. For hacks, this is often legitimate (expansions / trims).`,
          }
        : status === 'missing'
          ? {
              note: `Detector returned 0 entries. The signature scan may have failed to locate the table (relocated by a hack) or the structural detector found nothing matching its shape.`,
            }
          : {}),
    };
    systems.push(row);
  }
  // Sort: missing first, partial next, ok last.
  systems.sort((a, b) => {
    const order = { missing: 0, partial: 1, ok: 2 } as const;
    return order[a.status] - order[b.status];
  });

  return {
    available: true,
    projectRoot: ctx.projectRoot,
    identityDisplayName: manifest.identity.displayName,
    systems,
    summary,
  };
}
