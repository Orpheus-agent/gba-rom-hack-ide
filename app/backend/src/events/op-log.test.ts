import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendOpLogEntry, readOpLogTail } from './op-log.js';

describe('op-log', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-oplog-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('readOpLogTail returns empty when no log exists', async () => {
    const r = await readOpLogTail(projectRoot);
    expect(r.entries).toEqual([]);
    expect(r.parseErrors).toEqual([]);
    expect(r.totalLines).toBe(0);
    expect(r.logPath).toBe(path.join(projectRoot, '.editor', 'op-log.jsonl'));
  });

  it('appendOpLogEntry creates the .editor dir + log file with a parseable JSONL line', async () => {
    const entry = await appendOpLogEntry({
      projectRoot,
      sessionId: 'sess-1',
      op: 'move_event',
      payload: { entityId: 'obj_alice', from: { x: 0, y: 0 }, to: { x: 4, y: 2 } },
    });
    expect(entry.entryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.atUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.op).toBe('move_event');

    const onDisk = readFileSync(path.join(projectRoot, '.editor', 'op-log.jsonl'), 'utf-8');
    expect(onDisk).toContain('move_event');
    expect(onDisk.endsWith('\n')).toBe(true);
    expect(JSON.parse(onDisk.trim()).entryId).toBe(entry.entryId);
  });

  it('round-trip: append 3 entries, read tail returns them newest-first', async () => {
    const a = await appendOpLogEntry({ projectRoot, sessionId: 's', op: 'edit_dialogue', payload: { label: 'A' } });
    const b = await appendOpLogEntry({ projectRoot, sessionId: 's', op: 'replace_asset', payload: { id: 'B' } });
    const c = await appendOpLogEntry({ projectRoot, sessionId: 's', op: 'stage_template', payload: { id: 'C' } });

    const r = await readOpLogTail(projectRoot);
    expect(r.totalLines).toBe(3);
    expect(r.entries).toHaveLength(3);
    // Newest first.
    expect(r.entries[0]!.entryId).toBe(c.entryId);
    expect(r.entries[1]!.entryId).toBe(b.entryId);
    expect(r.entries[2]!.entryId).toBe(a.entryId);
  });

  it('readOpLogTail respects the limit and reads only the tail', async () => {
    for (let i = 0; i < 12; i++) {
      await appendOpLogEntry({
        projectRoot,
        sessionId: 's',
        op: 'patch_event_fields',
        payload: { i },
      });
    }
    const r = await readOpLogTail(projectRoot, 5);
    expect(r.totalLines).toBe(12);
    expect(r.entries).toHaveLength(5);
    // Tail of the log → indices 7..11; newest first → 11, 10, 9, 8, 7.
    expect((r.entries[0]!.payload as { i: number }).i).toBe(11);
    expect((r.entries[4]!.payload as { i: number }).i).toBe(7);
  });

  it('surfaces malformed lines via parseErrors without dropping good entries', async () => {
    const a = await appendOpLogEntry({ projectRoot, sessionId: 's', op: 'move_event', payload: { ok: true } });
    // Manually corrupt a line in the middle.
    const logPath = path.join(projectRoot, '.editor', 'op-log.jsonl');
    writeFileSync(logPath, readFileSync(logPath, 'utf-8') + '{not valid\n', 'utf-8');
    const b = await appendOpLogEntry({ projectRoot, sessionId: 's', op: 'import_asset', payload: { ok: true } });

    const r = await readOpLogTail(projectRoot);
    expect(r.totalLines).toBe(3);
    expect(r.entries.map((e) => e.entryId).sort()).toEqual([a.entryId, b.entryId].sort());
    expect(r.parseErrors).toHaveLength(1);
    expect(r.parseErrors[0]!.lineNumber).toBe(2);
  });

  it('every appended entry has a unique entryId', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const e = await appendOpLogEntry({ projectRoot, sessionId: 's', op: 'move_event', payload: { i } });
      expect(seen.has(e.entryId)).toBe(false);
      seen.add(e.entryId);
    }
  });

  it('supports a pre-existing .editor directory (idempotent mkdir)', async () => {
    mkdirSync(path.join(projectRoot, '.editor'), { recursive: true });
    const e = await appendOpLogEntry({ projectRoot, sessionId: 's', op: 'move_event', payload: {} });
    expect(e.entryId).toBeDefined();
    const r = await readOpLogTail(projectRoot);
    expect(r.entries).toHaveLength(1);
  });
});
