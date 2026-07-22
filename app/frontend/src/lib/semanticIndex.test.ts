import { describe, expect, it } from 'vitest';
import { buildSemanticIndex, searchSemanticIndex } from './semanticIndex';
import type {
  AbilityEntry,
  BattleMoveEntry,
  ItemEntry,
  ProjectManifest,
  SpeciesEntry,
  Trainer,
  TypeNameEntry,
} from '@rom-editor/shared';

function makeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-18T00:00:00Z',
    projectRoot: '/abs/test',
    identity: {
      kind: 'decomp',
      confidence: 1,
      displayName: 'test',
      baseGame: null,
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
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
    ...overrides,
  } as ProjectManifest;
}

const bulbasaur: SpeciesEntry = {
  id: 'species_1',
  speciesIndex: 1,
  baseHP: 45,
  baseAttack: 49,
  baseDefense: 49,
  baseSpeed: 45,
  baseSpAttack: 65,
  baseSpDefense: 65,
  type1: 12,
  type2: 3,
  catchRate: 45,
  expYield: 64,
  item1: 0,
  item2: 0,
  genderRatio: 31,
  eggCycles: 20,
  friendship: 70,
  growthRate: 3,
  eggGroup1: 1,
  eggGroup2: 7,
  ability1: 65,
  ability2: 65,
  safariZoneFleeRate: 0,
  sourceFileOffset: 0,
  name: 'BULBASAUR',
  type1Name: 'Grass',
  type2Name: 'Poison',
} as SpeciesEntry;

const tackle: BattleMoveEntry = {
  id: 'MOVE_TACKLE',
  moveIndex: 33,
  effect: 0,
  power: 40,
  type: 0,
  accuracy: 100,
  pp: 35,
  secondaryEffectChance: 0,
  target: 0,
  priority: 0,
  flags: 0,
  split: 1,
  sourceTableOffset: 0,
  name: 'TACKLE',
  typeName: 'Normal',
};

const thunderbolt: BattleMoveEntry = {
  ...tackle,
  id: 'MOVE_THUNDERBOLT',
  moveIndex: 85,
  power: 95,
  type: 13,
  name: 'THUNDERBOLT',
  typeName: 'Electric',
};

const sturdy: AbilityEntry = {
  id: 'ABILITY_STURDY',
  abilityIndex: 5,
  name: 'STURDY',
  sourceTableOffset: 0,
};

const fire: TypeNameEntry = {
  id: 'TYPE_FIRE',
  typeIndex: 10,
  name: 'Fire',
  sourceTableOffset: 0,
};

const masterBall: ItemEntry = {
  id: 'ITEM_MASTER_BALL',
  itemIndex: 1,
  name: 'MASTER BALL',
  sourceTableOffset: 0,
  price: 0,
  importance: 1,
  pocket: 2,
};

const brock: Trainer = {
  id: 'TRAINER_BROCK',
  className: 'GYM LEADER',
  party: [
    { speciesId: 'species_74', level: 12, moveIds: [], heldItemId: null },
    { speciesId: 'species_95', level: 14, moveIds: [], heldItemId: null },
  ],
  aiFlags: [],
  mapId: 'MAP_PEWTER_GYM',
} as unknown as Trainer;

describe('buildSemanticIndex', () => {
  it('returns empty for null manifest', () => {
    const idx = buildSemanticIndex(null);
    expect(idx.entryCount).toBe(0);
  });

  it('aggregates every supported entity kind', () => {
    const m = makeManifest({
      species: [bulbasaur],
      battleMoves: [tackle, thunderbolt],
      abilities: [sturdy],
      typeNames: [fire],
      items: [masterBall],
      trainers: [brock],
      maps: [
        {
          id: 'MAP_PEWTER_GYM',
          name: 'Pewter Gym',
          group: 'interior',
          dimensions: { width: 10, height: 10 },
          tilesetIds: [],
          warpIds: [],
          scriptIds: [],
          objectEventIds: [],
          encounterTableIds: [],
          musicId: null,
          metadata: {},
        },
      ],
    });
    const idx = buildSemanticIndex(m);
    // 1 species + 2 moves + 1 ability + 1 type + 1 item + 1 trainer + 1 map = 8
    expect(idx.entryCount).toBe(8);
    const kinds = idx.entries.map((e) => e.kind);
    expect(new Set(kinds)).toEqual(
      new Set(['species', 'move', 'ability', 'type', 'item', 'trainer', 'map']),
    );
  });
});

describe('searchSemanticIndex', () => {
  const manifest = makeManifest({
    species: [bulbasaur],
    battleMoves: [tackle, thunderbolt],
    abilities: [sturdy],
    typeNames: [fire],
    items: [masterBall],
    trainers: [brock],
  });
  const idx = buildSemanticIndex(manifest);

  it('returns empty for empty query', () => {
    expect(searchSemanticIndex(idx, '')).toEqual([]);
    expect(searchSemanticIndex(idx, '   ')).toEqual([]);
  });

  it('finds species by exact name', () => {
    const res = searchSemanticIndex(idx, 'BULBASAUR');
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.entry.id).toBe('species_1');
    expect(res[0]?.entry.kind).toBe('species');
    expect(res[0]?.score).toBeGreaterThanOrEqual(100);
  });

  it('finds moves by partial name', () => {
    const res = searchSemanticIndex(idx, 'thunder');
    expect(res[0]?.entry.id).toBe('MOVE_THUNDERBOLT');
  });

  it('finds trainer by class', () => {
    const res = searchSemanticIndex(idx, 'gym');
    const trainerHit = res.find((r) => r.entry.kind === 'trainer');
    expect(trainerHit).toBeTruthy();
  });

  it('finds type by name', () => {
    const res = searchSemanticIndex(idx, 'fire');
    const typeHit = res.find((r) => r.entry.kind === 'type');
    expect(typeHit).toBeTruthy();
    expect(typeHit?.entry.id).toBe('TYPE_FIRE');
  });

  it('multi-token query requires all tokens to match', () => {
    const res = searchSemanticIndex(idx, 'thunder electric');
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.entry.id).toBe('MOVE_THUNDERBOLT');
  });

  it('multi-token query that cannot all match returns nothing', () => {
    const res = searchSemanticIndex(idx, 'thunder lampent');
    expect(res).toEqual([]);
  });

  it('limit truncates result count', () => {
    const res = searchSemanticIndex(idx, 'a', 2);
    expect(res.length).toBeLessThanOrEqual(2);
  });

  it('scores exact matches above contains matches', () => {
    const res = searchSemanticIndex(idx, 'master ball');
    expect(res[0]?.entry.id).toBe('ITEM_MASTER_BALL');
  });

  // Phase X.2 - query DSL tests
  describe('query DSL (kind: / type:)', () => {
    it('kind:trainer restricts to trainers', () => {
      const res = searchSemanticIndex(idx, 'kind:trainer');
      expect(res.length).toBe(1);
      expect(res[0]?.entry.kind).toBe('trainer');
    });

    it('kind:move filters out non-moves', () => {
      const res = searchSemanticIndex(idx, 'kind:move');
      expect(res.length).toBe(2);
      expect(res.every((r) => r.entry.kind === 'move')).toBe(true);
    });

    it('kind:move + plain token combines both', () => {
      const res = searchSemanticIndex(idx, 'kind:move thunder');
      expect(res.length).toBe(1);
      expect(res[0]?.entry.id).toBe('MOVE_THUNDERBOLT');
    });

    it('type:electric finds Electric-type moves via tag', () => {
      const res = searchSemanticIndex(idx, 'type:electric');
      expect(res.find((r) => r.entry.id === 'MOVE_THUNDERBOLT')).toBeTruthy();
    });

    it('kind:item with no plain tokens returns all items', () => {
      const res = searchSemanticIndex(idx, 'kind:item');
      expect(res.length).toBe(1);
      expect(res[0]?.entry.kind).toBe('item');
    });

    it('multiple kind: tokens OR together', () => {
      const res = searchSemanticIndex(idx, 'kind:type kind:ability');
      const kinds = new Set(res.map((r) => r.entry.kind));
      expect(kinds).toEqual(new Set(['type', 'ability']));
    });

    it('kind: with empty value is treated as plain text', () => {
      const res = searchSemanticIndex(idx, 'kind:');
      // Plain token 'kind:' against names/tags → matches nothing.
      expect(res.length).toBe(0);
    });
  });
});
