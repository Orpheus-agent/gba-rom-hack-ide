import { describe, expect, it } from 'vitest';
import {
  computeUndoState,
  computeUndoStateInternal,
} from './undo.js';
import type { OpLogEntry } from './op-log.js';

function entry(partial: Partial<OpLogEntry> & Pick<OpLogEntry, 'entryId' | 'op'>): OpLogEntry {
  return {
    atUtc: '2026-05-16T00:00:00Z',
    sessionId: 's',
    payload: {},
    ...partial,
  } as OpLogEntry;
}

// computeUndoStateInternal expects entries in the order returned by
// readOpLogTail: newest-first. The function reverses internally to walk
// chronologically.

describe('computeUndoState', () => {
  it('empty log: cannot undo or redo', () => {
    const s = computeUndoState([]);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.nextUndoTargetId).toBeNull();
    expect(s.nextRedoTargetId).toBeNull();
  });

  it('a single mutation can be undone', () => {
    const log: OpLogEntry[] = [entry({ entryId: 'a', op: 'move_event' })];
    const s = computeUndoState(log);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(s.nextUndoTargetId).toBe('a');
    expect(s.nextUndoOp).toBe('move_event');
  });

  it('a mutation followed by its undo can be redone but not undone again', () => {
    // newest-first: undo_of_a, a
    const log: OpLogEntry[] = [
      entry({ entryId: 'u1', op: 'undo', undoOf: 'a' }),
      entry({ entryId: 'a', op: 'move_event' }),
    ];
    const s = computeUndoState(log);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);
    expect(s.nextRedoTargetId).toBe('a');
  });

  it('mutation -> undo -> redo restores undo-able state', () => {
    const log: OpLogEntry[] = [
      entry({ entryId: 'r1', op: 'redo', redoOf: 'u1' }),
      entry({ entryId: 'u1', op: 'undo', undoOf: 'a' }),
      entry({ entryId: 'a', op: 'move_event' }),
    ];
    const s = computeUndoState(log);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(s.nextUndoTargetId).toBe('a');
  });

  it('a new mutation clobbers pending redo', () => {
    const log: OpLogEntry[] = [
      entry({ entryId: 'b', op: 'edit_dialogue' }),
      entry({ entryId: 'u1', op: 'undo', undoOf: 'a' }),
      entry({ entryId: 'a', op: 'move_event' }),
    ];
    const s = computeUndoState(log);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(s.nextUndoTargetId).toBe('b');
  });

  it('multiple mutations -> 2 undos -> 1 redo: targets are LIFO', () => {
    const log: OpLogEntry[] = [
      entry({ entryId: 'r1', op: 'redo', redoOf: 'u2' }),
      entry({ entryId: 'u2', op: 'undo', undoOf: 'b' }),
      entry({ entryId: 'u1', op: 'undo', undoOf: 'c' }),
      entry({ entryId: 'c', op: 'edit_dialogue' }),
      entry({ entryId: 'b', op: 'patch_event_fields' }),
      entry({ entryId: 'a', op: 'move_event' }),
    ];
    const s = computeUndoStateInternal(log);
    // Chronological order: a, b, c, undo_c, undo_b, redo_undo_b
    // After: a (still applied), b (re-applied by redo), c (undone, redoable)
    expect(s.applied).toEqual(['a', 'b']);
    expect(s.redoable.map((r) => r.originalId)).toEqual(['c']);
  });

  it('a mismatched undo (target not on applied stack) is silently ignored', () => {
    const log: OpLogEntry[] = [
      entry({ entryId: 'u1', op: 'undo', undoOf: 'ghost' }),
      entry({ entryId: 'a', op: 'move_event' }),
    ];
    const s = computeUndoState(log);
    // 'a' is still applied; the bogus undo doesn't crash the state derivation.
    expect(s.canUndo).toBe(true);
    expect(s.nextUndoTargetId).toBe('a');
  });
});
