import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  EntityId,
  MoveEventKind,
  ProjectManifest,
} from '@rom-editor/shared';
import type { OpKind, OpLogEntry } from './op-log.js';
import { moveEvent } from './move.js';
import { patchEventFields } from './patch-fields.js';
import { editDialogueText } from './dialogue.js';
import { patchMechanicConfig, writeMechanicConfig } from './mechanic-config.js';
import { applyEdits } from '../agent/patch-applier.js';
import { ModernizeError, modernizeRom } from '../agent/modernize.js';
import { createHash } from 'node:crypto';
import type { MechanicConfigDoc, MechanicId } from '@rom-editor/shared';

// Undo/redo engine per D-0020. Reads the op-log, derives a "what's undo-able"
// view from the entry sequence (mutation entries appended → applied stack;
// undo entries → pop; redo entries → push back; any new mutation clears the
// pending-redo set), and applies reverse / forward ops by dispatching on
// the original entry's OpKind + payload.

export class UndoError extends Error {
  constructor(
    public readonly code:
      | 'nothing_to_undo'
      | 'nothing_to_redo'
      | 'unsupported_op'
      | 'missing_previous_state'
      | 'mutation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'UndoError';
  }
}

export interface UndoState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly nextUndoTargetId: string | null;
  readonly nextUndoOp: OpKind | null;
  readonly nextRedoTargetId: string | null;
  readonly nextRedoOp: OpKind | null;
}

interface RedoableSlot {
  readonly originalId: string;
  readonly undoEntryId: string;
}

interface InternalState {
  readonly entriesById: ReadonlyMap<string, OpLogEntry>;
  readonly applied: ReadonlyArray<string>;
  readonly redoable: ReadonlyArray<RedoableSlot>;
}

function isMutation(op: OpKind): boolean {
  return op !== 'undo' && op !== 'redo';
}

export function computeUndoStateInternal(entries: ReadonlyArray<OpLogEntry>): InternalState {
  const byId = new Map<string, OpLogEntry>();
  const applied: string[] = [];
  let redoable: RedoableSlot[] = [];
  // Note: entries from readOpLogTail are newest-first; the algorithm here
  // wants chronological order so we walk from oldest to newest.
  const chronological = [...entries].reverse();
  for (const e of chronological) {
    byId.set(e.entryId, e);
    if (e.op === 'undo') {
      const target = e.undoOf;
      if (!target) continue;
      const idx = applied.lastIndexOf(target);
      if (idx >= 0) {
        applied.splice(idx, 1);
        redoable.push({ originalId: target, undoEntryId: e.entryId });
      }
    } else if (e.op === 'redo') {
      const undoEntryId = e.redoOf;
      if (!undoEntryId) continue;
      const idx = redoable.findIndex((r) => r.undoEntryId === undoEntryId);
      if (idx >= 0) {
        const slot = redoable[idx]!;
        applied.push(slot.originalId);
        redoable.splice(idx, 1);
      }
    } else if (isMutation(e.op)) {
      applied.push(e.entryId);
      redoable = []; // new mutation invalidates the pending-redo set
    }
  }
  return { entriesById: byId, applied, redoable };
}

export function computeUndoState(entries: ReadonlyArray<OpLogEntry>): UndoState {
  const s = computeUndoStateInternal(entries);
  const nextUndoId = s.applied[s.applied.length - 1] ?? null;
  const nextRedoSlot = s.redoable[s.redoable.length - 1] ?? null;
  return {
    canUndo: s.applied.length > 0,
    canRedo: s.redoable.length > 0,
    nextUndoTargetId: nextUndoId,
    nextUndoOp: nextUndoId ? (s.entriesById.get(nextUndoId)?.op ?? null) : null,
    nextRedoTargetId: nextRedoSlot?.originalId ?? null,
    nextRedoOp: nextRedoSlot ? (s.entriesById.get(nextRedoSlot.originalId)?.op ?? null) : null,
  };
}

// --- Reverse / forward dispatchers -----------------------------------------

interface ApplyContext {
  readonly projectRoot: string;
  readonly manifest: ProjectManifest;
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function mapDirByMapId(manifest: ProjectManifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of manifest.maps) {
    const src = m.metadata['sourceDir'];
    if (typeof src === 'string') {
      const dir = src.replace(/^data\/maps\//, '').replace(/^data\\maps\\/, '');
      out.set(m.id, dir);
    }
  }
  return out;
}

function boundsByMapId(manifest: ProjectManifest): Map<string, { width: number; height: number }> {
  const out = new Map<string, { width: number; height: number }>();
  for (const m of manifest.maps) {
    if (m.dimensions.width > 0 && m.dimensions.height > 0) {
      out.set(m.id, { width: m.dimensions.width, height: m.dimensions.height });
    }
  }
  return out;
}

// Apply the REVERSE of an original mutation entry.
export async function applyReverse(
  entry: OpLogEntry,
  ctx: ApplyContext,
): Promise<void> {
  const p = entry.payload;
  switch (entry.op) {
    case 'move_event': {
      const kind = (p['entityKind'] as MoveEventKind) ?? null;
      const entityId = p['entityId'] as EntityId | undefined;
      const prev = p['previous'] as { x: number; y: number } | undefined;
      if (!kind || !entityId || !prev) {
        throw new UndoError('missing_previous_state', 'move_event entry missing reverse fields');
      }
      await moveEvent(kind, entityId, prev.x, prev.y, {
        projectRoot: ctx.projectRoot,
        mapDirByMapId: mapDirByMapId(ctx.manifest),
        bounds: boundsByMapId(ctx.manifest),
      });
      return;
    }
    case 'patch_event_fields': {
      const kind = (p['entityKind'] as MoveEventKind) ?? null;
      const entityId = p['entityId'] as EntityId | undefined;
      const prev = p['previous'] as Record<string, unknown> | undefined;
      if (!kind || !entityId || !prev) {
        throw new UndoError('missing_previous_state', 'patch_event_fields entry missing reverse fields');
      }
      await patchEventFields(kind, entityId, prev, {
        projectRoot: ctx.projectRoot,
        mapDirByMapId: mapDirByMapId(ctx.manifest),
      });
      return;
    }
    case 'edit_dialogue': {
      const label = p['label'] as string | undefined;
      const previousLines = p['previousLines'] as string[] | undefined;
      if (!label || !Array.isArray(previousLines)) {
        throw new UndoError('missing_previous_state', 'edit_dialogue entry missing previousLines');
      }
      await editDialogueText(label, previousLines.join('\n'), { projectRoot: ctx.projectRoot });
      return;
    }
    case 'replace_asset': {
      const rel = p['relativePath'] as string | undefined;
      const prevB64 = p['previousBytesBase64'] as string | null | undefined;
      if (!rel || !prevB64) {
        throw new UndoError(
          'missing_previous_state',
          'replace_asset entry missing previousBytesBase64 (mutation predates undo support)',
        );
      }
      const buf = Buffer.from(prevB64, 'base64');
      const abs = path.join(ctx.projectRoot, rel);
      const tmp = `${abs}.undo.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, abs);
      return;
    }
    case 'import_asset': {
      const rel = p['relativePath'] as string | undefined;
      if (!rel) throw new UndoError('missing_previous_state', 'import_asset entry missing relativePath');
      await unlinkIfExists(path.join(ctx.projectRoot, rel));
      return;
    }
    case 'stage_template': {
      const rel = p['stagedPath'] as string | undefined;
      if (!rel) throw new UndoError('missing_previous_state', 'stage_template entry missing stagedPath');
      await unlinkIfExists(path.join(ctx.projectRoot, rel));
      return;
    }
    case 'patch_mechanic_config': {
      const prevDoc = p['previousDoc'] as Record<string, unknown> | undefined;
      if (!prevDoc) {
        throw new UndoError(
          'missing_previous_state',
          'patch_mechanic_config entry missing previousDoc',
        );
      }
      await writeMechanicConfig(ctx.projectRoot, prevDoc as unknown as MechanicConfigDoc);
      return;
    }
    case 'agent_patch_apply': {
      const reverseEdits = p['reverseEdits'] as ReadonlyArray<AgentPatchEdit> | undefined;
      if (!reverseEdits || !Array.isArray(reverseEdits)) {
        throw new UndoError(
          'missing_previous_state',
          'agent_patch_apply entry missing reverseEdits',
        );
      }
      try {
        await applyEdits(ctx.projectRoot, reverseEdits);
      } catch (e) {
        throw new UndoError('mutation_failed', `Failed to reverse agent patch: ${(e as Error).message}`);
      }
      return;
    }
    case 'modernize_rom': {
      // Modernize-and-Ship slice 4 - restore the project's ROM from
      // the on-disk `<rom>.pre-modernize.bak` backup file written when
      // modernize was first applied. The backup must still exist AND
      // its SHA-1 must match what was recorded in the op-log entry's
      // payload, otherwise something has tampered with the backup
      // and the safest action is to refuse rather than write garbage.
      const backupPath = p['previousRomBackupPath'] as string | undefined;
      const expectedPreviousSha1 = p['previousSha1'] as string | undefined;
      if (!backupPath || !expectedPreviousSha1) {
        throw new UndoError(
          'missing_previous_state',
          'modernize_rom entry missing previousRomBackupPath or previousSha1',
        );
      }
      let backupBytes: Buffer;
      try {
        backupBytes = await fsp.readFile(backupPath);
      } catch (e) {
        throw new UndoError(
          'missing_previous_state',
          `Pre-modernize backup not found at ${backupPath}: ${(e as Error).message}`,
        );
      }
      const actualSha1 = createHash('sha1').update(backupBytes).digest('hex');
      if (actualSha1 !== expectedPreviousSha1) {
        throw new UndoError(
          'mutation_failed',
          `Pre-modernize backup hash mismatch (expected ${expectedPreviousSha1}, got ${actualSha1}); ` +
            `the backup file may have been replaced - refusing to restore`,
        );
      }
      // Find the project's .gba and atomic-write the backup bytes back.
      let romPath: string | null = null;
      try {
        const entries = await fsp.readdir(ctx.projectRoot, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
            romPath = path.join(ctx.projectRoot, e.name);
            break;
          }
        }
      } catch {
        // fall through to romPath === null
      }
      if (!romPath) {
        throw new UndoError(
          'missing_previous_state',
          `No .gba file found in project '${ctx.projectRoot}' to undo modernize against`,
        );
      }
      const tmpPath = `${romPath}.undo.tmp`;
      try {
        await fsp.writeFile(tmpPath, backupBytes);
        await fsp.rename(tmpPath, romPath);
      } catch (e) {
        try {
          await fsp.unlink(tmpPath);
        } catch {
          /* ignore */
        }
        throw new UndoError('mutation_failed', `Failed to restore pre-modernize ROM: ${(e as Error).message}`);
      }
      return;
    }
    case 'undo':
    case 'redo':
      throw new UndoError('unsupported_op', `Cannot reverse a meta-op '${entry.op}'`);
  }
}

// Re-apply the ORIGINAL mutation (i.e. redo). The entry passed in is the
// original mutation entry, NOT the undo entry.
export async function applyForward(
  entry: OpLogEntry,
  ctx: ApplyContext,
): Promise<void> {
  const p = entry.payload;
  switch (entry.op) {
    case 'move_event': {
      const kind = (p['entityKind'] as MoveEventKind) ?? null;
      const entityId = p['entityId'] as EntityId | undefined;
      const next = p['next'] as { x: number; y: number } | undefined;
      if (!kind || !entityId || !next) {
        throw new UndoError('missing_previous_state', 'move_event entry missing forward fields');
      }
      await moveEvent(kind, entityId, next.x, next.y, {
        projectRoot: ctx.projectRoot,
        mapDirByMapId: mapDirByMapId(ctx.manifest),
        bounds: boundsByMapId(ctx.manifest),
      });
      return;
    }
    case 'patch_event_fields': {
      const kind = (p['entityKind'] as MoveEventKind) ?? null;
      const entityId = p['entityId'] as EntityId | undefined;
      const next = p['next'] as Record<string, unknown> | undefined;
      if (!kind || !entityId || !next) {
        throw new UndoError('missing_previous_state', 'patch_event_fields entry missing forward fields');
      }
      await patchEventFields(kind, entityId, next, {
        projectRoot: ctx.projectRoot,
        mapDirByMapId: mapDirByMapId(ctx.manifest),
      });
      return;
    }
    case 'edit_dialogue': {
      const label = p['label'] as string | undefined;
      const nextText = p['nextText'] as string | undefined;
      if (!label || nextText === undefined) {
        throw new UndoError('missing_previous_state', 'edit_dialogue entry missing nextText');
      }
      await editDialogueText(label, nextText, { projectRoot: ctx.projectRoot });
      return;
    }
    case 'replace_asset': {
      const rel = p['relativePath'] as string | undefined;
      const nextB64 = p['nextBytesBase64'] as string | undefined;
      if (!rel || !nextB64) {
        throw new UndoError('missing_previous_state', 'replace_asset entry missing nextBytesBase64');
      }
      const buf = Buffer.from(nextB64, 'base64');
      const abs = path.join(ctx.projectRoot, rel);
      const tmp = `${abs}.redo.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, abs);
      return;
    }
    case 'import_asset': {
      const rel = p['relativePath'] as string | undefined;
      const b64 = p['pngBase64'] as string | undefined;
      if (!rel || !b64) {
        throw new UndoError('missing_previous_state', 'import_asset entry missing pngBase64 for redo');
      }
      const buf = Buffer.from(b64, 'base64');
      const abs = path.join(ctx.projectRoot, rel);
      const tmp = `${abs}.redo.tmp`;
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, abs);
      return;
    }
    case 'stage_template': {
      const rel = p['stagedPath'] as string | undefined;
      const mat = p['materialization'] as Record<string, unknown> | undefined;
      const templateId = p['templateId'] as string | undefined;
      const params = p['params'] as Record<string, string> | undefined;
      if (!rel || !mat || !templateId || !params) {
        throw new UndoError('missing_previous_state', 'stage_template entry missing materialization');
      }
      const abs = path.join(ctx.projectRoot, rel);
      const tmp = `${abs}.redo.tmp`;
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const payload = {
        templateId,
        params,
        materialization: mat,
        stagedAtUtc: new Date().toISOString(),
      };
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2));
      await fsp.rename(tmp, abs);
      return;
    }
    case 'patch_mechanic_config': {
      const mechanicId = p['mechanicId'] as string | undefined;
      const patch = p['patch'] as Record<string, unknown> | undefined;
      if (!mechanicId || !patch) {
        throw new UndoError('missing_previous_state', 'patch_mechanic_config entry missing patch');
      }
      await patchMechanicConfig(ctx.projectRoot, mechanicId as MechanicId, patch);
      return;
    }
    case 'agent_patch_apply': {
      const edits = p['edits'] as ReadonlyArray<AgentPatchEdit> | undefined;
      if (!edits || !Array.isArray(edits)) {
        throw new UndoError('missing_previous_state', 'agent_patch_apply entry missing edits');
      }
      try {
        await applyEdits(ctx.projectRoot, edits);
      } catch (e) {
        throw new UndoError('mutation_failed', `Failed to re-apply agent patch: ${(e as Error).message}`);
      }
      return;
    }
    case 'modernize_rom': {
      // Modernize-and-Ship slice 4 - re-apply the bundled CFRU patch.
      // The op-log payload doesn't carry the patch bytes (they live in
      // the bundled asset directory), so redo just re-invokes the
      // modernize service. Deterministic: the same vanilla ROM + same
      // bundle produces the same target bytes.
      try {
        await modernizeRom({
          projectRoot: ctx.projectRoot,
          sessionId: entry.sessionId,
        });
      } catch (e) {
        if (e instanceof ModernizeError) {
          throw new UndoError(
            'mutation_failed',
            `Failed to re-apply modernize: ${e.code} - ${e.message}`,
          );
        }
        throw new UndoError('mutation_failed', `Failed to re-apply modernize: ${(e as Error).message}`);
      }
      return;
    }
    case 'undo':
    case 'redo':
      throw new UndoError('unsupported_op', `Cannot re-apply a meta-op '${entry.op}'`);
  }
}
