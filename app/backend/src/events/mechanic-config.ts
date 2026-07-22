import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { MechanicConfigDoc, MechanicId } from '@rom-editor/shared';
import { emptyMechanicConfigDoc } from '@rom-editor/shared';

export class MechanicConfigError extends Error {
  constructor(
    public readonly code:
      | 'invalid_shape'
      | 'unknown_mechanic_id'
      | 'mutation_failed'
      | 'read_failed',
    message: string,
  ) {
    super(message);
    this.name = 'MechanicConfigError';
  }
}

function configPath(projectRoot: string): string {
  return path.join(projectRoot, '.editor', 'mechanic-config.json');
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new MechanicConfigError(
      'invalid_shape',
      `${fieldName} must be an array`,
    );
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') {
      throw new MechanicConfigError(
        'invalid_shape',
        `${fieldName}[] entries must all be strings`,
      );
    }
    const trimmed = v.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Coerce a (possibly partial / malformed) input object back to a complete
 *  MechanicConfigDoc, filling missing keys with empty defaults and rejecting
 *  shape violations. */
function normalizeDoc(raw: unknown): MechanicConfigDoc {
  const empty = emptyMechanicConfigDoc();
  if (raw === null || typeof raw !== 'object') return empty;
  const obj = raw as Record<string, unknown>;
  const starters = (obj['starter_selection'] as Record<string, unknown>) ?? {};
  const difficulty = (obj['difficulty_system'] as Record<string, unknown>) ?? {};
  const evolution = (obj['evolution_flags'] as Record<string, unknown>) ?? {};
  const encounter = (obj['encounter_variants'] as Record<string, unknown>) ?? {};
  return {
    schemaVersion: 1,
    starter_selection: {
      starters: normalizeStringArray(starters['starters'] ?? [], 'starter_selection.starters'),
    },
    difficulty_system: {
      enabledModes: normalizeStringArray(
        difficulty['enabledModes'] ?? [],
        'difficulty_system.enabledModes',
      ),
    },
    evolution_flags: {
      giftSpecies: normalizeStringArray(
        evolution['giftSpecies'] ?? [],
        'evolution_flags.giftSpecies',
      ),
    },
    encounter_variants: {
      enabledTypes: normalizeStringArray(
        encounter['enabledTypes'] ?? [],
        'encounter_variants.enabledTypes',
      ),
    },
  };
}

export async function readMechanicConfig(projectRoot: string): Promise<MechanicConfigDoc> {
  const p = configPath(projectRoot);
  let raw: string;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (e) {
    // ENOENT = no config yet → return empty doc; any other error surfaces.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyMechanicConfigDoc();
    throw new MechanicConfigError(
      'read_failed',
      `Could not read mechanic config: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new MechanicConfigError(
      'invalid_shape',
      `mechanic-config.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return normalizeDoc(parsed);
}

export async function writeMechanicConfig(
  projectRoot: string,
  doc: MechanicConfigDoc,
): Promise<void> {
  const p = configPath(projectRoot);
  // Validate by round-tripping through normalize - any shape violation throws.
  const normalized = normalizeDoc(doc);
  try {
    await fsp.mkdir(path.dirname(p), { recursive: true });
  } catch (e) {
    throw new MechanicConfigError(
      'mutation_failed',
      `Could not create .editor directory: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const tmp = p + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8');
    await fsp.rename(tmp, p);
  } catch (e) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw new MechanicConfigError(
      'mutation_failed',
      `Atomic write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

const VALID_MECHANIC_IDS: ReadonlySet<MechanicId> = new Set([
  'starter_selection',
  'difficulty_system',
  'evolution_flags',
  'encounter_variants',
]);

/** Apply a partial update for one mechanic. Reads the current doc, patches
 *  the targeted mechanic's fields, atomically writes the result. */
export async function patchMechanicConfig(
  projectRoot: string,
  mechanicId: MechanicId,
  patch: Record<string, unknown>,
): Promise<MechanicConfigDoc> {
  if (!VALID_MECHANIC_IDS.has(mechanicId)) {
    throw new MechanicConfigError(
      'unknown_mechanic_id',
      `Unknown mechanic id '${mechanicId}'`,
    );
  }
  const current = await readMechanicConfig(projectRoot);
  const next: MechanicConfigDoc = {
    ...current,
    [mechanicId]: { ...current[mechanicId], ...patch },
  } as MechanicConfigDoc;
  // Normalize will throw if the merged shape is invalid (e.g. wrong array
  // element type), keeping the on-disk file unchanged.
  const normalized = normalizeDoc(next);
  await writeMechanicConfig(projectRoot, normalized);
  return normalized;
}
