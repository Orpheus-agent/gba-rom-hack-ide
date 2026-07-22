import { describe, expect, it } from 'vitest';
import { RelationshipGraphBuilder } from './graph.js';
import { toCytoscapeJson } from './cytoscape.js';

function buildSmallGraph() {
  const b = new RelationshipGraphBuilder();
  b.addNode({ id: 'a', kind: 'rom_region', label: 'Region A', provenance: 'p', detail: { offset: 0x100 } });
  b.addNode({ id: 'b', kind: 'flag', provenance: 'p' });
  b.addEdge({
    id: 'e1',
    from: 'a',
    to: 'b',
    kind: 'sets_flag',
    confidence: 0.8,
    provenance: 'p',
    detail: { script: 'main' },
  });
  return b.build();
}

describe('toCytoscapeJson', () => {
  it('emits the cytoscape-elements-v1 envelope', () => {
    const json = toCytoscapeJson(buildSmallGraph());
    expect(json.format).toBe('cytoscape-elements-v1');
    expect(json.elements.nodes).toHaveLength(2);
    expect(json.elements.edges).toHaveLength(1);
  });

  it('maps each node to {data: ...} with id/kind/label/provenance', () => {
    const json = toCytoscapeJson(buildSmallGraph());
    const a = json.elements.nodes.find((n) => n.data.id === 'a');
    expect(a?.data.kind).toBe('rom_region');
    expect(a?.data.label).toBe('Region A');
    expect(a?.data.provenance).toBe('p');
    expect(a?.data.detail?.offset).toBe(0x100);
  });

  it('uses node id as fallback label when label is undefined', () => {
    const json = toCytoscapeJson(buildSmallGraph());
    const b = json.elements.nodes.find((n) => n.data.id === 'b');
    expect(b?.data.label).toBe('b');
  });

  it('maps each edge to {data: ...} with source/target/kind/confidence/provenance', () => {
    const json = toCytoscapeJson(buildSmallGraph());
    const e = json.elements.edges[0];
    expect(e?.data.source).toBe('a');
    expect(e?.data.target).toBe('b');
    expect(e?.data.kind).toBe('sets_flag');
    expect(e?.data.confidence).toBe(0.8);
    expect(e?.data.detail?.script).toBe('main');
  });

  it('handles empty graph cleanly', () => {
    const empty = new RelationshipGraphBuilder().build();
    const json = toCytoscapeJson(empty);
    expect(json.elements.nodes).toEqual([]);
    expect(json.elements.edges).toEqual([]);
  });
});
