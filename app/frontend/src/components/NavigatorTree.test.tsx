import { describe, expect, it } from 'vitest';
import type { MapNode, ProjectManifest } from '@rom-editor/shared';
import {
  buildStoryOrderSections,
  naturalCompare,
  prettifyMapSection,
} from './NavigatorTree';

// #2 Story-order navigation - unit tests for the pure grouping helpers that
// turn the flat, alphabetically-sorted map list into the game's areas in
// natural play order.

function mapNode(
  id: string,
  name: string,
  group: MapNode['group'],
  mapsec: string,
): MapNode {
  return {
    id,
    name,
    group,
    dimensions: { width: 10, height: 10 },
    tilesetIds: [],
    warpIds: [],
    scriptIds: [],
    objectEventIds: [],
    encounterTableIds: [],
    musicId: null,
    metadata: mapsec ? { region_map_section: mapsec } : {},
  };
}

function makeManifest(
  maps: MapNode[],
  mapSectionOrder?: string[],
): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-30T00:00:00.000Z',
    projectRoot: '/tmp/test',
    identity: {
      kind: 'decomp',
      confidence: 1,
      displayName: 'pokefirered',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps,
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
    ...(mapSectionOrder ? { mapSectionOrder } : {}),
  };
}

describe('naturalCompare', () => {
  it('orders embedded numbers numerically, not lexicographically', () => {
    const sorted = ['Route 10', 'Route 2', 'Route 1'].sort(naturalCompare);
    expect(sorted).toEqual(['Route 1', 'Route 2', 'Route 10']);
  });
});

describe('prettifyMapSection', () => {
  it('converts MAPSEC constants to friendly area names', () => {
    expect(prettifyMapSection('MAPSEC_PALLET_TOWN')).toBe('Pallet Town');
    expect(prettifyMapSection('MAPSEC_ROUTE_1')).toBe('Route 1');
  });
  it('maps placeless / empty sections to a friendly bucket', () => {
    expect(prettifyMapSection('MAPSEC_NONE')).toBe('Unsorted');
    expect(prettifyMapSection('')).toBe('Unsorted');
  });
});

describe('buildStoryOrderSections', () => {
  it('returns empty when the manifest carries no section order (binary path)', () => {
    const m = makeManifest([mapNode('A', 'A', 'town', 'MAPSEC_PALLET_TOWN')]);
    expect(buildStoryOrderSections(m)).toEqual([]);
  });

  it('orders areas by the enum order and sinks placeless buckets last', () => {
    const m = makeManifest(
      [
        mapNode('Viridian', 'Viridian City', 'town', 'MAPSEC_VIRIDIAN_CITY'),
        mapNode('Pallet', 'Pallet Town', 'town', 'MAPSEC_PALLET_TOWN'),
        mapNode('Dyn', 'Dynamic Map', 'special', 'MAPSEC_DYNAMIC'),
        mapNode('Celadon', 'Celadon City', 'town', 'MAPSEC_CELADON_CITY'),
      ],
      [
        'MAPSEC_PALLET_TOWN',
        'MAPSEC_CELADON_CITY',
        'MAPSEC_VIRIDIAN_CITY',
        'MAPSEC_DYNAMIC',
      ],
    );
    const labels = buildStoryOrderSections(m).map((s) => s.label);
    expect(labels).toEqual(['Pallet Town', 'Celadon City', 'Viridian City', 'Dynamic']);
  });

  it('within an area, puts the overworld map before its interiors, then natural-sorts', () => {
    const m = makeManifest(
      [
        mapNode('Dept10F', 'Celadon Dept Store 10F', 'interior', 'MAPSEC_CELADON_CITY'),
        mapNode('Dept2F', 'Celadon Dept Store 2F', 'interior', 'MAPSEC_CELADON_CITY'),
        mapNode('CeladonCity', 'Celadon City', 'town', 'MAPSEC_CELADON_CITY'),
      ],
      ['MAPSEC_CELADON_CITY'],
    );
    const sections = buildStoryOrderSections(m);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.maps.map((mm) => mm.id)).toEqual([
      'CeladonCity',
      'Dept2F',
      'Dept10F',
    ]);
  });
});
