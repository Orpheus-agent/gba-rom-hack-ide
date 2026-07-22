import { describe, expect, it } from 'vitest';
import { RelationshipGraphBuilder } from '../graph/graph.js';
import {
  ALL_NAMED_CONCEPTS,
  eventsAfterBadgeConcept,
  starterSelectionConcept,
  victoryRoadWarpsConcept,
  weatherChangeConcept,
} from './concepts.js';

function makeGraph(): RelationshipGraphBuilder {
  return new RelationshipGraphBuilder();
}

describe('starterSelectionConcept', () => {
  it('returns 0 matches when seed has no starterFlagIds (legitimate empty answer per PD 1)', () => {
    const graph = makeGraph().build();
    const r = starterSelectionConcept.run(graph, {});
    expect(r.ok).toBe(true);
    expect(r.matchedNodes.length).toBe(0);
    expect(r.summary).toContain('no starterFlagIds');
  });

  it('aggregates writers across multiple starter flag ids', () => {
    const b = makeGraph();
    b.addNode({ id: 'variable:0x4001', kind: 'variable', provenance: 't' });
    b.addNode({ id: 'variable:0x4002', kind: 'variable', provenance: 't' });
    b.addNode({ id: 'script:A', kind: 'script', provenance: 't' });
    b.addNode({ id: 'script:B', kind: 'script', provenance: 't' });
    b.addEdge({
      id: 'sets_flag:A->v4001',
      from: 'script:A',
      to: 'variable:0x4001',
      kind: 'sets_flag',
      confidence: 0.9,
      provenance: 't',
    });
    b.addEdge({
      id: 'sets_flag:B->v4002',
      from: 'script:B',
      to: 'variable:0x4002',
      kind: 'sets_flag',
      confidence: 0.9,
      provenance: 't',
    });
    const r = starterSelectionConcept.run(b.build(), {
      starterFlagIds: [0x4001, 0x4002],
    });
    expect(r.ok).toBe(true);
    expect(r.matchedNodes.length).toBe(2);
    expect(r.subResults.length).toBe(2);
  });
});

describe('eventsAfterBadgeConcept', () => {
  it('aggregates readers across all badge flag ids', () => {
    const b = makeGraph();
    b.addNode({ id: 'variable:0x4001', kind: 'variable', provenance: 't' });
    b.addNode({ id: 'script:Gate1', kind: 'script', provenance: 't' });
    b.addEdge({
      id: 'reads_flag:Gate1->v4001',
      from: 'script:Gate1',
      to: 'variable:0x4001',
      kind: 'reads_flag',
      confidence: 0.9,
      provenance: 't',
    });
    const r = eventsAfterBadgeConcept.run(b.build(), { badgeFlagIds: [0x4001] });
    expect(r.matchedNodes.length).toBe(1);
    expect(r.matchedNodes[0]).toBe('script:Gate1');
  });
});

describe('victoryRoadWarpsConcept', () => {
  it('returns empty + explanation when no VR map node ids seeded', () => {
    const r = victoryRoadWarpsConcept.run(makeGraph().build(), {});
    expect(r.ok).toBe(true);
    expect(r.matchedNodes.length).toBe(0);
    expect(r.summary).toContain('no victoryRoadMapNodeIds');
  });

  it('finds maps warping to seeded VR map ids', () => {
    const b = makeGraph();
    b.addNode({ id: 'map:Origin', kind: 'map', provenance: 't' });
    b.addNode({ id: 'map:VR', kind: 'map', provenance: 't' });
    b.addNode({ id: 'warp:W1', kind: 'warp', provenance: 't' });
    b.addEdge({
      id: 'has_event:Origin->W1',
      from: 'map:Origin',
      to: 'warp:W1',
      kind: 'has_event',
      confidence: 0.9,
      provenance: 't',
    });
    b.addEdge({
      id: 'warp_to:W1->VR',
      from: 'warp:W1',
      to: 'map:VR',
      kind: 'warp_to',
      confidence: 0.9,
      provenance: 't',
    });
    const r = victoryRoadWarpsConcept.run(b.build(), {
      victoryRoadMapNodeIds: ['map:VR'],
    });
    expect(r.matchedNodes).toContain('map:Origin');
  });
});

describe('weatherChangeConcept', () => {
  it('returns empty + future-implementation note when no opcode names seeded', () => {
    const r = weatherChangeConcept.run(makeGraph().build(), {});
    expect(r.ok).toBe(true);
    expect(r.matchedNodes.length).toBe(0);
    expect(r.summary).toContain('no weatherChangeOpcodeNames');
  });

  it('returns ok=true with routing note when seeds present but bytecode-scan not yet implemented', () => {
    const r = weatherChangeConcept.run(makeGraph().build(), {
      weatherChangeOpcodeNames: ['setweather', 'doweather'],
    });
    expect(r.ok).toBe(true);
    expect(r.matchedNodes.length).toBe(0);
    expect(r.summary).toContain('future P11-T3');
  });
});

describe('ALL_NAMED_CONCEPTS registry', () => {
  it('exports 4 concepts with unique ids', () => {
    expect(ALL_NAMED_CONCEPTS.length).toBe(4);
    const ids = ALL_NAMED_CONCEPTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('every concept has stable id + label + run()', () => {
    for (const c of ALL_NAMED_CONCEPTS) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(typeof c.label).toBe('string');
      expect(typeof c.run).toBe('function');
    }
  });
});
