import { describe, expect, it } from 'vitest';
import { RelationshipGraphBuilder } from '../graph/graph.js';
import { runSemanticQuery } from './runner.js';

function makeGraph(): RelationshipGraphBuilder {
  return new RelationshipGraphBuilder();
}

describe('runSemanticQuery - structural queries', () => {
  it('find_scripts_writing_flag returns scripts with incoming sets_flag edges', () => {
    const b = makeGraph();
    b.addNode({ id: 'variable:0x4001', kind: 'variable', provenance: 'test' });
    b.addNode({ id: 'script:A', kind: 'script', provenance: 'test' });
    b.addNode({ id: 'script:B', kind: 'script', provenance: 'test' });
    b.addEdge({
      id: 'sets_flag:script:A->variable:0x4001',
      from: 'script:A',
      to: 'variable:0x4001',
      kind: 'sets_flag',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_scripts_writing_flag', flagId: 0x4001 });
    expect(r.ok).toBe(true);
    expect(r.matchedNodes.length).toBe(1);
    expect(r.matchedNodes[0]?.id).toBe('script:A');
    expect(r.matchedEdges.length).toBe(1);
  });

  it('find_scripts_writing_flag empty result is ok=true (legitimate "no matches")', () => {
    const b = makeGraph();
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_scripts_writing_flag', flagId: 0x9999 });
    expect(r.ok).toBe(true);
    expect(r.matchedNodes.length).toBe(0);
    expect(r.summary).toContain('0 script');
  });

  it('find_scripts_reading_flag returns scripts with reads_flag OR gates_on edges', () => {
    const b = makeGraph();
    b.addNode({ id: 'variable:0x4001', kind: 'variable', provenance: 'test' });
    b.addNode({ id: 'script:A', kind: 'script', provenance: 'test' });
    b.addNode({ id: 'event:B', kind: 'event', provenance: 'test' });
    b.addEdge({
      id: 'reads_flag:script:A->variable:0x4001',
      from: 'script:A',
      to: 'variable:0x4001',
      kind: 'reads_flag',
      confidence: 0.9,
      provenance: 'test',
    });
    b.addEdge({
      id: 'gates_on:event:B->variable:0x4001',
      from: 'event:B',
      to: 'variable:0x4001',
      kind: 'gates_on',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_scripts_reading_flag', flagId: 0x4001 });
    expect(r.matchedNodes.length).toBe(2);
    expect(r.matchedNodes.map((n) => n.id)).toEqual(['event:B', 'script:A']);
  });

  it('find_events_in_map walks has_event edges from the map', () => {
    const b = makeGraph();
    b.addNode({ id: 'map:0x100', kind: 'map', provenance: 'test' });
    b.addNode({ id: 'npc:1', kind: 'npc', provenance: 'test' });
    b.addNode({ id: 'warp:1', kind: 'warp', provenance: 'test' });
    b.addEdge({
      id: 'has_event:map:0x100->npc:1',
      from: 'map:0x100',
      to: 'npc:1',
      kind: 'has_event',
      confidence: 0.9,
      provenance: 'test',
    });
    b.addEdge({
      id: 'has_event:map:0x100->warp:1',
      from: 'map:0x100',
      to: 'warp:1',
      kind: 'has_event',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_events_in_map', mapNodeId: 'map:0x100' });
    expect(r.matchedNodes.length).toBe(2);
  });

  it('find_encounter_tables_containing_species via encounters_species', () => {
    const b = makeGraph();
    b.addNode({ id: 'species:5', kind: 'species', provenance: 'test' });
    b.addNode({ id: 'encounter_table:T1', kind: 'encounter_table', provenance: 'test' });
    b.addNode({ id: 'encounter_table:T2', kind: 'encounter_table', provenance: 'test' });
    b.addEdge({
      id: 'encounters_species:T1->species:5',
      from: 'encounter_table:T1',
      to: 'species:5',
      kind: 'encounters_species',
      confidence: 0.9,
      provenance: 'test',
    });
    b.addEdge({
      id: 'encounters_species:T2->species:5',
      from: 'encounter_table:T2',
      to: 'species:5',
      kind: 'encounters_species',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_encounter_tables_containing_species', speciesIndex: 5 });
    expect(r.matchedNodes.length).toBe(2);
  });

  it('find_evolution_chain walks evolves_into BOTH directions', () => {
    const b = makeGraph();
    for (let i = 0; i < 4; i++) {
      b.addNode({ id: `species:${i}`, kind: 'species', provenance: 'test' });
    }
    // chain: 0 → 1 → 2  (species:3 is unrelated)
    b.addEdge({
      id: 'evolves_into:species:0->species:1',
      from: 'species:0',
      to: 'species:1',
      kind: 'evolves_into',
      confidence: 0.9,
      provenance: 'test',
    });
    b.addEdge({
      id: 'evolves_into:species:1->species:2',
      from: 'species:1',
      to: 'species:2',
      kind: 'evolves_into',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    // Starting from the middle, should find ALL THREE (species:0, 1, 2)
    const r = runSemanticQuery(graph, { kind: 'find_evolution_chain', speciesIndex: 1 });
    const ids = r.matchedNodes.map((n) => n.id);
    expect(ids).toContain('species:0');
    expect(ids).toContain('species:1');
    expect(ids).toContain('species:2');
    expect(ids).not.toContain('species:3');
    expect(r.matchedEdges.length).toBe(2);
  });

  it('find_music_tracks_used_by_map via plays_music', () => {
    const b = makeGraph();
    b.addNode({ id: 'map:0x200', kind: 'map', provenance: 'test' });
    b.addNode({ id: 'music_track:song_1', kind: 'music_track', provenance: 'test' });
    b.addEdge({
      id: 'plays_music:map:0x200->music_track:song_1',
      from: 'map:0x200',
      to: 'music_track:song_1',
      kind: 'plays_music',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_music_tracks_used_by_map', mapNodeId: 'map:0x200' });
    expect(r.matchedNodes.length).toBe(1);
    expect(r.matchedNodes[0]?.id).toBe('music_track:song_1');
  });

  it('find_assets_used_by via uses_asset', () => {
    const b = makeGraph();
    b.addNode({ id: 'music_track:song_1', kind: 'music_track', provenance: 'test' });
    b.addNode({ id: 'asset:voiceGroup:0x100', kind: 'asset', provenance: 'test' });
    b.addNode({ id: 'asset:voiceGroup:0x200', kind: 'asset', provenance: 'test' });
    b.addEdge({
      id: 'uses_asset:song_1->vg1',
      from: 'music_track:song_1',
      to: 'asset:voiceGroup:0x100',
      kind: 'uses_asset',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_assets_used_by', consumerNodeId: 'music_track:song_1' });
    expect(r.matchedNodes.length).toBe(1);
    expect(r.matchedNodes[0]?.id).toBe('asset:voiceGroup:0x100');
  });

  it('find_unlocks_dependents follows unlocks edges transitively', () => {
    const b = makeGraph();
    for (let i = 0; i < 4; i++) {
      b.addNode({ id: `script:S${i}`, kind: 'script', provenance: 'test' });
    }
    // S0 → S1 → S2; S3 unrelated
    b.addEdge({
      id: 'unlocks:S0->S1',
      from: 'script:S0',
      to: 'script:S1',
      kind: 'unlocks',
      confidence: 0.9,
      provenance: 'test',
    });
    b.addEdge({
      id: 'unlocks:S1->S2',
      from: 'script:S1',
      to: 'script:S2',
      kind: 'unlocks',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_unlocks_dependents', writerScriptNodeId: 'script:S0' });
    const ids = r.matchedNodes.map((n) => n.id);
    expect(ids).toContain('script:S1');
    expect(ids).toContain('script:S2');
    expect(ids).not.toContain('script:S0'); // exclude self
    expect(ids).not.toContain('script:S3'); // unrelated
  });

  it('find_nodes_by_kind returns all nodes of a kind', () => {
    const b = makeGraph();
    b.addNode({ id: 'species:1', kind: 'species', provenance: 'test' });
    b.addNode({ id: 'species:2', kind: 'species', provenance: 'test' });
    b.addNode({ id: 'trainer:1', kind: 'trainer', provenance: 'test' });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_nodes_by_kind', nodeKind: 'species' });
    expect(r.matchedNodes.length).toBe(2);
  });

  it('find_edges_by_kind returns all edges of a kind', () => {
    const b = makeGraph();
    b.addNode({ id: 'species:1', kind: 'species', provenance: 'test' });
    b.addNode({ id: 'species:2', kind: 'species', provenance: 'test' });
    b.addEdge({
      id: 'evolves_into:species:1->species:2',
      from: 'species:1',
      to: 'species:2',
      kind: 'evolves_into',
      confidence: 0.9,
      provenance: 'test',
    });
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_edges_by_kind', edgeKind: 'evolves_into' });
    expect(r.matchedEdges.length).toBe(1);
  });

  it('result is frozen', () => {
    const b = makeGraph();
    const graph = b.build();
    const r = runSemanticQuery(graph, { kind: 'find_nodes_by_kind', nodeKind: 'species' });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.matchedNodes)).toBe(true);
    expect(Object.isFrozen(r.matchedEdges)).toBe(true);
  });
});
