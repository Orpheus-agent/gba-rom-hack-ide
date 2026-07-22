import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const OP_LOG_DIR = '.editor';
const OP_LOG_FILE = 'op-log.jsonl';

export type OpKind =
  | 'move_event'
  | 'patch_event_fields'
  | 'edit_dialogue'
  /** Decomp expansion trainer-party edit (src/data/trainers.party). Payload
   *  carries before/after block text for undo. */
  | 'edit_trainer_party'
  /** Decomp species data-table edit (src/data/pokemon/species_info/*.h). */
  | 'edit_species'
  /** Decomp move data-table edit (src/data/moves_info.h). */
  | 'edit_move'
  /** Decomp ability data-table edit (src/data/abilities.h). */
  | 'edit_ability'
  /** Decomp item data-table edit (src/data/items.h). */
  | 'edit_item'
  /** Decomp wild-encounter slot edit (src/data/wild_encounters.json). */
  | 'edit_encounter_slot'
  /** Decomp level-up learnset entry edit (level_up_learnsets/gen_N.h). */
  | 'edit_learnset'
  /** Decomp type-chart matchup edit (src/data/types_info.h). */
  | 'edit_type_matchup'
  /** Decomp: append a new ObjectEvent (NPC) to a map's map.json. */
  | 'add_object_event'
  /** Decomp: create an event script (talk/trainer) + bind it to an NPC. */
  | 'add_decomp_script'
  | 'replace_asset'
  | 'import_asset'
  | 'stage_template'
  | 'patch_mechanic_config'
  | 'agent_patch_apply'
  /** Modernize-and-Ship slice 4 - one-click application of the bundled
   *  CFRU patch to a vanilla FRLG ROM. Payload carries metadata only
   *  (previous/new SHA-1, CFRU version, backup path); the actual byte
   *  delta lives in the on-disk pre-modernize backup file referenced
   *  by `previousRomBackupPath`. */
  | 'modernize_rom'
  | 'undo'
  | 'redo';

export interface OpLogEntry {
  readonly entryId: string;
  readonly atUtc: string;
  readonly sessionId: string;
  readonly op: OpKind;
  readonly payload: Record<string, unknown>;
  /** When this entry was produced by undoing a prior entry, the originating
   *  entryId. Lets the undo engine skip-over already-undone entries when
   *  walking backward for the next undo target. */
  readonly undoOf?: string;
  /** When this entry was produced by redoing a prior undo, the originating
   *  undo entryId. Lets the redo engine know what was last redone. */
  readonly redoOf?: string;
}

export interface OpLogParseError {
  readonly lineNumber: number;
  readonly raw: string;
  readonly message: string;
}

export interface OpLogReadResult {
  readonly entries: ReadonlyArray<OpLogEntry>;
  readonly parseErrors: ReadonlyArray<OpLogParseError>;
  readonly totalLines: number;
  readonly logPath: string;
}

export interface AppendOpLogOptions {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly op: OpKind;
  readonly payload: Record<string, unknown>;
  readonly undoOf?: string;
  readonly redoOf?: string;
}

function logPathFor(projectRoot: string): string {
  return path.join(projectRoot, OP_LOG_DIR, OP_LOG_FILE);
}

export async function appendOpLogEntry(opts: AppendOpLogOptions): Promise<OpLogEntry> {
  const entry: OpLogEntry = {
    entryId: randomUUID(),
    atUtc: new Date().toISOString(),
    sessionId: opts.sessionId,
    op: opts.op,
    payload: opts.payload,
    ...(opts.undoOf !== undefined ? { undoOf: opts.undoOf } : {}),
    ...(opts.redoOf !== undefined ? { redoOf: opts.redoOf } : {}),
  };
  const dir = path.join(opts.projectRoot, OP_LOG_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await fsp.appendFile(logPathFor(opts.projectRoot), line, 'utf-8');
  return entry;
}

function parseLine(line: string, lineNumber: number): { entry?: OpLogEntry; error?: OpLogParseError } {
  if (line.length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    return {
      error: { lineNumber, raw: line, message: (e as Error).message },
    };
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof (raw as { entryId?: unknown }).entryId !== 'string' ||
    typeof (raw as { atUtc?: unknown }).atUtc !== 'string' ||
    typeof (raw as { sessionId?: unknown }).sessionId !== 'string' ||
    typeof (raw as { op?: unknown }).op !== 'string' ||
    typeof (raw as { payload?: unknown }).payload !== 'object'
  ) {
    return {
      error: { lineNumber, raw: line, message: 'entry missing required fields' },
    };
  }
  return { entry: raw as OpLogEntry };
}

export async function readOpLogTail(
  projectRoot: string,
  limit = 200,
): Promise<OpLogReadResult> {
  const logPath = logPathFor(projectRoot);
  let text: string;
  try {
    text = await fsp.readFile(logPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], parseErrors: [], totalLines: 0, logPath };
    }
    throw e;
  }
  // JSONL: split on \n, drop trailing empty line if present.
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;

  const startIndex = Math.max(0, lines.length - limit);
  const slice = lines.slice(startIndex);

  const entries: OpLogEntry[] = [];
  const parseErrors: OpLogParseError[] = [];
  slice.forEach((line, i) => {
    const result = parseLine(line, startIndex + i + 1);
    if (result.entry) entries.push(result.entry);
    if (result.error) parseErrors.push(result.error);
  });

  // Newest first for the typical UI consumption pattern.
  entries.reverse();
  return { entries, parseErrors, totalLines, logPath };
}
