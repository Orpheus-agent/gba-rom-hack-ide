import { describe, it, expect } from 'vitest';
import { PatchStore } from './patch-store.js';

describe('PatchStore', () => {
  it('creates pending proposals with a fresh id + UTC timestamp', () => {
    const store = new PatchStore();
    const p = store.create({
      projectId: 'p1',
      description: 'rename Route 1',
      edits: [{ kind: 'replace_in_file', filePath: 'a/b.inc', before: 'Route 1', after: 'Electric Avenue' }],
    });
    expect(p.id).toMatch(/^patch_[0-9a-f-]{36}$/);
    expect(p.status).toBe('pending');
    expect(p.projectId).toBe('p1');
    expect(p.createdAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.get(p.id)?.id).toBe(p.id);
  });

  it('listByProject is ordered by createdAt + scoped to one project', async () => {
    const store = new PatchStore();
    const a1 = store.create({ projectId: 'p1', description: 'a', edits: [{ kind: 'replace_in_file', filePath: 'x', before: 'a', after: 'b' }] });
    await new Promise((r) => setTimeout(r, 5));
    const a2 = store.create({ projectId: 'p1', description: 'b', edits: [{ kind: 'replace_in_file', filePath: 'x', before: 'c', after: 'd' }] });
    store.create({ projectId: 'p2', description: 'other', edits: [{ kind: 'replace_in_file', filePath: 'y', before: 'e', after: 'f' }] });
    const ps = store.listByProject('p1');
    expect(ps.map((p) => p.id)).toEqual([a1.id, a2.id]);
  });

  it('setStatus transitions pending → applied + records timestamp', () => {
    const store = new PatchStore();
    const p = store.create({ projectId: 'p', description: 'd', edits: [{ kind: 'replace_in_file', filePath: 'x', before: 'a', after: 'b' }] });
    const after = store.setStatus(p.id, 'applied');
    expect(after?.status).toBe('applied');
    expect(after?.appliedAtUtc).toMatch(/^\d{4}/);
  });

  it('setStatus on a terminal proposal is a no-op (idempotent reject after reject)', () => {
    const store = new PatchStore();
    const p = store.create({ projectId: 'p', description: 'd', edits: [{ kind: 'replace_in_file', filePath: 'x', before: 'a', after: 'b' }] });
    const rejected = store.setStatus(p.id, 'rejected');
    expect(rejected?.status).toBe('rejected');
    // Re-rejecting returns the existing terminal proposal unchanged.
    const again = store.setStatus(p.id, 'applied');
    expect(again?.status).toBe('rejected');
  });

  it('clearProject removes only the named project\'s proposals', () => {
    const store = new PatchStore();
    store.create({ projectId: 'p1', description: 'a', edits: [{ kind: 'replace_in_file', filePath: 'x', before: 'a', after: 'b' }] });
    store.create({ projectId: 'p2', description: 'b', edits: [{ kind: 'replace_in_file', filePath: 'x', before: 'c', after: 'd' }] });
    store.clearProject('p1');
    expect(store.listByProject('p1')).toHaveLength(0);
    expect(store.listByProject('p2')).toHaveLength(1);
    expect(store.size()).toBe(1);
  });
});
