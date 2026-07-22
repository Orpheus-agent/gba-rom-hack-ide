import { describe, expect, it } from 'vitest';
import { RelationshipGraphBuilder } from '../graph/graph.js';
import { deriveUnlockChains } from './unlock-chains.js';

function buildGraphWithFlagAccesses(args: {
  variables: ReadonlyArray<{ id: string; varId: number }>;
  writers: ReadonlyArray<string>;
  readers: ReadonlyArray<string>;
  /** Edges to add: each entry says (sourceNodeId, kind, variableNodeId). */
  edges: ReadonlyArray<{ from: string; kind: 'sets_flag' | 'reads_flag' | 'gates_on'; to: string }>;
}) {
  const b = new RelationshipGraphBuilder();
  // Ensure all node ids exist
  const allNodes = new Set<string>();
  for (const w of args.writers) allNodes.add(w);
  for (const r of args.readers) allNodes.add(r);
  for (const n of allNodes) {
    // Use a generic kind for source nodes; the derive function doesn't care
    b.addNode({ id: n, kind: 'rom_region', provenance: 'test' });
  }
  for (const v of args.variables) {
    b.addNode({
      id: v.id,
      kind: 'variable',
      provenance: 'test',
      detail: { varId: v.varId },
    });
  }
  let edgeCounter = 0;
  for (const e of args.edges) {
    b.addEdge({
      id: `${e.kind}:${e.from}->${e.to}.${String(edgeCounter++)}`,
      from: e.from,
      to: e.to,
      kind: e.kind,
      confidence: 0.9,
      provenance: 'test',
    });
  }
  return b.build();
}

describe('deriveUnlockChains', () => {
  it('returns empty for a graph with no variables', () => {
    const b = new RelationshipGraphBuilder();
    expect(deriveUnlockChains(b.build())).toEqual([]);
  });

  it('returns empty when variable has only writes (no readers)', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [{ id: 'variable:0x4001', varId: 0x4001 }],
      writers: ['rom_region:script_a'],
      readers: [],
      edges: [{ from: 'rom_region:script_a', kind: 'sets_flag', to: 'variable:0x4001' }],
    });
    expect(deriveUnlockChains(g)).toEqual([]);
  });

  it('returns empty when variable has only reads (no writers)', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [{ id: 'variable:0x4001', varId: 0x4001 }],
      writers: [],
      readers: ['rom_region:script_a'],
      edges: [{ from: 'rom_region:script_a', kind: 'reads_flag', to: 'variable:0x4001' }],
    });
    expect(deriveUnlockChains(g)).toEqual([]);
  });

  it('emits one chain for single writer + single reader', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [{ id: 'variable:0x4001', varId: 0x4001 }],
      writers: ['rom_region:writer_a'],
      readers: ['rom_region:reader_b'],
      edges: [
        { from: 'rom_region:writer_a', kind: 'sets_flag', to: 'variable:0x4001' },
        { from: 'rom_region:reader_b', kind: 'reads_flag', to: 'variable:0x4001' },
      ],
    });
    const chains = deriveUnlockChains(g);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.writerNodeId).toBe('rom_region:writer_a');
    expect(chains[0]?.readerNodeId).toBe('rom_region:reader_b');
    expect(chains[0]?.viaVariableNodeId).toBe('variable:0x4001');
    expect(chains[0]?.viaVariableId).toBe(0x4001);
    expect(chains[0]?.readerEdgeKind).toBe('reads_flag');
  });

  it('emits N×M chains for multi-writer × multi-reader', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [{ id: 'variable:0x4001', varId: 0x4001 }],
      writers: ['rom_region:w1', 'rom_region:w2'],
      readers: ['rom_region:r1', 'rom_region:r2', 'rom_region:r3'],
      edges: [
        { from: 'rom_region:w1', kind: 'sets_flag', to: 'variable:0x4001' },
        { from: 'rom_region:w2', kind: 'sets_flag', to: 'variable:0x4001' },
        { from: 'rom_region:r1', kind: 'reads_flag', to: 'variable:0x4001' },
        { from: 'rom_region:r2', kind: 'reads_flag', to: 'variable:0x4001' },
        { from: 'rom_region:r3', kind: 'gates_on', to: 'variable:0x4001' },
      ],
    });
    const chains = deriveUnlockChains(g);
    expect(chains).toHaveLength(6); // 2 writers × 3 readers
  });

  it('excludes self-loops (writer === reader)', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [{ id: 'variable:0x4001', varId: 0x4001 }],
      writers: ['rom_region:script_a'],
      readers: ['rom_region:script_a', 'rom_region:script_b'],
      edges: [
        { from: 'rom_region:script_a', kind: 'sets_flag', to: 'variable:0x4001' },
        { from: 'rom_region:script_a', kind: 'reads_flag', to: 'variable:0x4001' }, // self-loop
        { from: 'rom_region:script_b', kind: 'reads_flag', to: 'variable:0x4001' },
      ],
    });
    const chains = deriveUnlockChains(g);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.readerNodeId).toBe('rom_region:script_b');
  });

  it('prefers reads_flag over gates_on when same source has both', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [{ id: 'variable:0x4001', varId: 0x4001 }],
      writers: ['rom_region:w'],
      readers: ['rom_region:r'],
      edges: [
        { from: 'rom_region:w', kind: 'sets_flag', to: 'variable:0x4001' },
        { from: 'rom_region:r', kind: 'gates_on', to: 'variable:0x4001' },
        { from: 'rom_region:r', kind: 'reads_flag', to: 'variable:0x4001' }, // wins
      ],
    });
    const chains = deriveUnlockChains(g);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.readerEdgeKind).toBe('reads_flag');
  });

  it('aggregates across multiple variables independently', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [
        { id: 'variable:0x4001', varId: 0x4001 },
        { id: 'variable:0x4002', varId: 0x4002 },
      ],
      writers: ['rom_region:wA', 'rom_region:wB'],
      readers: ['rom_region:rX'],
      edges: [
        // wA writes 0x4001, rX reads 0x4001 → chain
        { from: 'rom_region:wA', kind: 'sets_flag', to: 'variable:0x4001' },
        { from: 'rom_region:rX', kind: 'reads_flag', to: 'variable:0x4001' },
        // wB writes 0x4002, rX reads 0x4002 → chain
        { from: 'rom_region:wB', kind: 'sets_flag', to: 'variable:0x4002' },
        { from: 'rom_region:rX', kind: 'reads_flag', to: 'variable:0x4002' },
      ],
    });
    const chains = deriveUnlockChains(g);
    expect(chains).toHaveLength(2);
    expect(chains[0]?.viaVariableId).toBe(0x4001);
    expect(chains[1]?.viaVariableId).toBe(0x4002);
  });

  it('returns frozen chains', () => {
    const g = buildGraphWithFlagAccesses({
      variables: [{ id: 'variable:0x4001', varId: 0x4001 }],
      writers: ['w'],
      readers: ['r'],
      edges: [
        { from: 'w', kind: 'sets_flag', to: 'variable:0x4001' },
        { from: 'r', kind: 'reads_flag', to: 'variable:0x4001' },
      ],
    });
    const chains = deriveUnlockChains(g);
    expect(Object.isFrozen(chains)).toBe(true);
    expect(Object.isFrozen(chains[0])).toBe(true);
  });
});
