import { describe, expect, it } from 'vitest';
import {
  GraphInvariantError,
  GraphMissingNodeError,
  RelationshipGraphBuilder,
} from './index.js';

describe('RelationshipGraphBuilder - node insertion', () => {
  it('adds a single node and returns it', () => {
    const b = new RelationshipGraphBuilder();
    const n = b.addNode({
      id: 'rom_region:0x100',
      kind: 'rom_region',
      provenance: 'test',
    });
    expect(n.id).toBe('rom_region:0x100');
    expect(b.nodeCount).toBe(1);
  });

  it('is idempotent on duplicate id (returns first)', () => {
    const b = new RelationshipGraphBuilder();
    const a = b.addNode({ id: 'x', kind: 'flag', provenance: 'a' });
    const dup = b.addNode({ id: 'x', kind: 'flag', provenance: 'b' });
    expect(b.nodeCount).toBe(1);
    expect(dup).toBe(a); // returns the SAME frozen instance
    expect(dup.provenance).toBe('a');
  });

  it('rejects empty id', () => {
    const b = new RelationshipGraphBuilder();
    expect(() => b.addNode({ id: '', kind: 'flag', provenance: 'p' })).toThrow(
      GraphInvariantError,
    );
  });

  it('rejects empty provenance', () => {
    const b = new RelationshipGraphBuilder();
    expect(() => b.addNode({ id: 'x', kind: 'flag', provenance: '' })).toThrow(
      GraphInvariantError,
    );
  });

  it('freezes the returned node', () => {
    const b = new RelationshipGraphBuilder();
    const n = b.addNode({ id: 'x', kind: 'flag', provenance: 'p', detail: { foo: 1 } });
    expect(Object.isFrozen(n)).toBe(true);
    if (n.detail) expect(Object.isFrozen(n.detail)).toBe(true);
  });
});

describe('RelationshipGraphBuilder - updateNodeDetail (P7-T2 post-hoc enrichment)', () => {
  it('merges new detail fields into existing node detail', () => {
    const b = new RelationshipGraphBuilder();
    b.addNode({ id: 'v1', kind: 'variable', provenance: 'p', detail: { varId: 0x4001 } });
    const updated = b.updateNodeDetail('v1', { role: 'FLAG_BIT_PROGRESSION_GATE' });
    expect(updated.detail?.varId).toBe(0x4001);
    expect(updated.detail?.role).toBe('FLAG_BIT_PROGRESSION_GATE');
  });

  it('preserves existing detail fields and overrides on conflict', () => {
    const b = new RelationshipGraphBuilder();
    b.addNode({ id: 'v1', kind: 'variable', provenance: 'p', detail: { a: 1, b: 2 } });
    const updated = b.updateNodeDetail('v1', { b: 99, c: 3 });
    expect(updated.detail?.a).toBe(1);
    expect(updated.detail?.b).toBe(99);
    expect(updated.detail?.c).toBe(3);
  });

  it('throws when node does not exist', () => {
    const b = new RelationshipGraphBuilder();
    expect(() => b.updateNodeDetail('missing', { role: 'x' })).toThrow();
  });

  it('updated detail is frozen', () => {
    const b = new RelationshipGraphBuilder();
    b.addNode({ id: 'v1', kind: 'variable', provenance: 'p' });
    const updated = b.updateNodeDetail('v1', { role: 'FLAG_BIT_WRITE_ONLY' });
    expect(Object.isFrozen(updated.detail)).toBe(true);
  });
});

describe('RelationshipGraphBuilder - edge insertion', () => {
  function buildPair() {
    const b = new RelationshipGraphBuilder();
    b.addNode({ id: 'a', kind: 'rom_region', provenance: 'p' });
    b.addNode({ id: 'b', kind: 'rom_region', provenance: 'p' });
    return b;
  }

  it('adds an edge between registered nodes', () => {
    const b = buildPair();
    const e = b.addEdge({
      id: 'points_to:a->b',
      from: 'a',
      to: 'b',
      kind: 'points_to',
      confidence: 0.9,
      provenance: 'p',
    });
    expect(e.kind).toBe('points_to');
    expect(b.edgeCount).toBe(1);
  });

  it('rejects edge with missing from-node', () => {
    const b = buildPair();
    expect(() =>
      b.addEdge({
        id: 'e1',
        from: 'missing',
        to: 'b',
        kind: 'points_to',
        confidence: 0.9,
        provenance: 'p',
      }),
    ).toThrow(GraphMissingNodeError);
  });

  it('rejects edge with missing to-node', () => {
    const b = buildPair();
    expect(() =>
      b.addEdge({
        id: 'e2',
        from: 'a',
        to: 'missing',
        kind: 'points_to',
        confidence: 0.9,
        provenance: 'p',
      }),
    ).toThrow(GraphMissingNodeError);
  });

  it('rejects out-of-range confidence', () => {
    const b = buildPair();
    expect(() =>
      b.addEdge({ id: 'e', from: 'a', to: 'b', kind: 'points_to', confidence: 1.5, provenance: 'p' }),
    ).toThrow(GraphInvariantError);
    expect(() =>
      b.addEdge({ id: 'e', from: 'a', to: 'b', kind: 'points_to', confidence: -0.1, provenance: 'p' }),
    ).toThrow(GraphInvariantError);
  });

  it('rejects empty provenance', () => {
    const b = buildPair();
    expect(() =>
      b.addEdge({ id: 'e', from: 'a', to: 'b', kind: 'points_to', confidence: 0.9, provenance: '' }),
    ).toThrow(GraphInvariantError);
  });

  it('freezes returned edge + nested detail', () => {
    const b = buildPair();
    const e = b.addEdge({
      id: 'e',
      from: 'a',
      to: 'b',
      kind: 'points_to',
      confidence: 0.5,
      provenance: 'p',
      detail: { foo: 'bar' },
    });
    expect(Object.isFrozen(e)).toBe(true);
    if (e.detail) expect(Object.isFrozen(e.detail)).toBe(true);
  });
});

describe('RelationshipGraph - snapshot + query API', () => {
  function tinyGraph() {
    const b = new RelationshipGraphBuilder();
    b.addNode({ id: 'a', kind: 'rom_region', provenance: 'p' });
    b.addNode({ id: 'b', kind: 'rom_region', provenance: 'p' });
    b.addNode({ id: 'c', kind: 'flag', provenance: 'p' });
    b.addEdge({ id: 'e1', from: 'a', to: 'b', kind: 'points_to', confidence: 0.9, provenance: 'p' });
    b.addEdge({ id: 'e2', from: 'a', to: 'c', kind: 'sets_flag', confidence: 0.8, provenance: 'p' });
    b.addEdge({ id: 'e3', from: 'b', to: 'c', kind: 'reads_flag', confidence: 0.7, provenance: 'p' });
    return b.build();
  }

  it('reports node + edge counts', () => {
    const g = tinyGraph();
    expect(g.nodeCount).toBe(3);
    expect(g.edgeCount).toBe(3);
  });

  it('hasNode + getNode', () => {
    const g = tinyGraph();
    expect(g.hasNode('a')).toBe(true);
    expect(g.hasNode('missing')).toBe(false);
    expect(g.getNode('a')?.kind).toBe('rom_region');
    expect(g.getNode('missing')).toBeNull();
  });

  it('nodesByKind filters by NodeKind', () => {
    const g = tinyGraph();
    expect(g.nodesByKind('rom_region').map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(g.nodesByKind('flag').map((n) => n.id)).toEqual(['c']);
  });

  it('edgesByKind filters by EdgeKind', () => {
    const g = tinyGraph();
    expect(g.edgesByKind('points_to')).toHaveLength(1);
    expect(g.edgesByKind('sets_flag')).toHaveLength(1);
    expect(g.edgesByKind('warp_to')).toHaveLength(0);
  });

  it('outgoing + incoming traversals are correct', () => {
    const g = tinyGraph();
    const outA = g.outgoing('a').map((e) => e.id).sort();
    expect(outA).toEqual(['e1', 'e2']);
    const inC = g.incoming('c').map((e) => e.id).sort();
    expect(inC).toEqual(['e2', 'e3']);
    expect(g.outgoing('c')).toHaveLength(0);
    expect(g.incoming('a')).toHaveLength(0);
  });

  it('reachable BFS expands across all edges by default', () => {
    const g = tinyGraph();
    expect(Array.from(g.reachable({ startId: 'a' })).sort()).toEqual(['a', 'b', 'c']);
  });

  it('reachable BFS honors edgeKinds filter', () => {
    const g = tinyGraph();
    const reach = g.reachable({ startId: 'a', edgeKinds: ['points_to'] });
    expect(Array.from(reach).sort()).toEqual(['a', 'b']);
  });

  it('reachable BFS returns empty for unknown start', () => {
    const g = tinyGraph();
    expect(g.reachable({ startId: 'missing' }).size).toBe(0);
  });

  it('snapshot reports per-kind counts', () => {
    const g = tinyGraph();
    const s = g.snapshot();
    expect(s.nodeCount).toBe(3);
    expect(s.edgeCount).toBe(3);
    expect(s.nodeCountsByKind.rom_region).toBe(2);
    expect(s.nodeCountsByKind.flag).toBe(1);
    expect(s.edgeCountsByKind.points_to).toBe(1);
  });

  it('bidirectional adjacency: large graph maintains both indices', () => {
    const b = new RelationshipGraphBuilder();
    for (let i = 0; i < 100; i++) {
      b.addNode({ id: `n${i}`, kind: 'rom_region', provenance: 'p' });
    }
    for (let i = 0; i < 99; i++) {
      b.addEdge({
        id: `e${i}`,
        from: `n${i}`,
        to: `n${i + 1}`,
        kind: 'points_to',
        confidence: 0.5,
        provenance: 'p',
      });
    }
    const g = b.build();
    expect(g.outgoing('n0')).toHaveLength(1);
    expect(g.incoming('n99')).toHaveLength(1);
    expect(g.outgoing('n50')).toHaveLength(1);
    expect(g.incoming('n50')).toHaveLength(1);
  });

  it('snapshot adjacency arrays are frozen', () => {
    const g = tinyGraph();
    expect(Object.isFrozen(g.outgoing('a'))).toBe(true);
    expect(Object.isFrozen(g.incoming('c'))).toBe(true);
  });
});
