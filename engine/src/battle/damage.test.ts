import { describe, it, expect } from 'vitest';
import {
  VANILLA_GEN3_TYPE_MATRIX,
  computeDamage,
  deriveGen3MoveSplit,
  prepareTypeMatrix,
  simulateBattle,
} from './damage.js';
import type { PokemonStatsSpec, MoveSpec } from './damage.js';

// Reference Pokémon for damage tests.
function fakeCharizard(level = 50): PokemonStatsSpec {
  return {
    hp: 78 + 60 + level,
    attack: 84,
    defense: 78,
    spAttack: 109,
    spDefense: 85,
    speed: 100,
    type1: 10, // Fire
    type2: 2, // Flying
    level,
  };
}

function fakeBlastoise(level = 50): PokemonStatsSpec {
  return {
    hp: 79 + 60 + level,
    attack: 83,
    defense: 100,
    spAttack: 85,
    spDefense: 105,
    speed: 78,
    type1: 11, // Water
    type2: 11, // single-typed for simplicity
    level,
  };
}

function fakePidgey(level = 5): PokemonStatsSpec {
  return {
    hp: 40 + 10 + level,
    attack: 45,
    defense: 40,
    spAttack: 35,
    spDefense: 35,
    speed: 56,
    type1: 0, // Normal
    type2: 2, // Flying
    level,
  };
}

const TACKLE: MoveSpec = { power: 40, type: 0, accuracy: 100, split: 'physical' };
const SURF: MoveSpec = { power: 95, type: 11, accuracy: 100, split: 'special' };
const FIRE_BLAST: MoveSpec = { power: 120, type: 10, accuracy: 85, split: 'special' };
const THUNDER: MoveSpec = { power: 120, type: 13, accuracy: 70, split: 'special' };
const STATUS_MOVE: MoveSpec = { power: 0, type: 0, accuracy: 100, split: 'status' };

describe('computeDamage', () => {
  it('returns 0 for status moves', () => {
    const d = computeDamage({
      attacker: fakeCharizard(),
      defender: fakeBlastoise(),
      move: STATUS_MOVE,
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 7,
      accuracyRoll: 50,
    });
    expect(d).toBe(0);
  });

  it('returns null when accuracyRoll exceeds accuracy', () => {
    const d = computeDamage({
      attacker: fakeCharizard(),
      defender: fakeBlastoise(),
      move: { power: 100, type: 10, accuracy: 50, split: 'special' },
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 7,
      accuracyRoll: 75, // miss (75 ≥ 50)
    });
    expect(d).toBeNull();
  });

  it('applies STAB (1.5×) when move type matches attacker type', () => {
    const noStab = computeDamage({
      attacker: { ...fakeCharizard(), type1: 0, type2: 2 }, // no Fire
      defender: fakeBlastoise(),
      move: { ...FIRE_BLAST, accuracy: 0 }, // never miss
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 15, // max roll for determinism
      accuracyRoll: 0,
    });
    const withStab = computeDamage({
      attacker: fakeCharizard(),
      defender: fakeBlastoise(),
      move: { ...FIRE_BLAST, accuracy: 0 },
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 15,
      accuracyRoll: 0,
    });
    expect(withStab).toBeGreaterThan(noStab!);
    // STAB is 1.5×; allow some floor() rounding slack.
    expect(withStab! / noStab!).toBeGreaterThan(1.4);
    expect(withStab! / noStab!).toBeLessThan(1.6);
  });

  it('applies super-effective (2×) damage', () => {
    const fireOnFire = computeDamage({
      attacker: fakeCharizard(),
      defender: fakeCharizard(), // Fire/Flying - resists Fire
      move: FIRE_BLAST,
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 15,
      accuracyRoll: 0,
    });
    const waterOnFire = computeDamage({
      attacker: fakeBlastoise(),
      defender: fakeCharizard(),
      move: { ...SURF, accuracy: 0 },
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 15,
      accuracyRoll: 0,
    });
    expect(waterOnFire!).toBeGreaterThan(fireOnFire!);
  });

  it('returns 0 for immune matchup (Electric vs Ground)', () => {
    const ground = { ...fakePidgey(), type1: 4, type2: 4 }; // Ground/Ground
    const d = computeDamage({
      attacker: fakePidgey(),
      defender: ground,
      move: { power: 90, type: 13, accuracy: 0, split: 'special' }, // Electric
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 15,
      accuracyRoll: 0,
    });
    expect(d).toBe(0);
  });

  it('crit doubles damage', () => {
    const normal = computeDamage({
      attacker: fakeCharizard(),
      defender: fakeBlastoise(),
      move: { ...FIRE_BLAST, accuracy: 0 },
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: false,
      randomRoll: 15,
      accuracyRoll: 0,
    });
    const crit = computeDamage({
      attacker: fakeCharizard(),
      defender: fakeBlastoise(),
      move: { ...FIRE_BLAST, accuracy: 0 },
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      isCrit: true,
      randomRoll: 15,
      accuracyRoll: 0,
    });
    expect(crit! / normal!).toBeGreaterThan(1.7);
    expect(crit! / normal!).toBeLessThan(2.3);
  });
});

describe('deriveGen3MoveSplit', () => {
  it('routes Fire/Water/Grass/Electric/Ice/Psychic/Dragon/Dark to special', () => {
    expect(deriveGen3MoveSplit(10, 50)).toBe('special'); // Fire
    expect(deriveGen3MoveSplit(11, 50)).toBe('special'); // Water
    expect(deriveGen3MoveSplit(17, 50)).toBe('special'); // Dark
  });
  it('routes Normal/Fighting/etc. to physical', () => {
    expect(deriveGen3MoveSplit(0, 50)).toBe('physical'); // Normal
    expect(deriveGen3MoveSplit(1, 50)).toBe('physical'); // Fighting
    expect(deriveGen3MoveSplit(8, 50)).toBe('physical'); // Steel
  });
  it('routes 0-power moves to status', () => {
    expect(deriveGen3MoveSplit(10, 0)).toBe('status');
  });
});

describe('prepareTypeMatrix', () => {
  it('builds an identity matrix when no matchups supplied', () => {
    const m = prepareTypeMatrix([]);
    expect(m).toHaveLength(19);
    for (let i = 0; i < 18; i++) for (let j = 0; j < 18; j++) expect(m[i]![j]).toBe(1);
  });
  it('honors a single super-effective matchup', () => {
    const m = prepareTypeMatrix([{ kind: 'matchup', attackerType: 10, defenderType: 12, effectiveness: 20 }]);
    expect(m[10]![12]).toBe(2);
  });
});

describe('simulateBattle', () => {
  it('high-level Charizard reliably beats a level-5 Pidgey', () => {
    let n = 0;
    const random = (): number => {
      n = (n * 1103515245 + 12345) >>> 0;
      return (n >>> 16) / 0x10000;
    };
    const result = simulateBattle({
      teamA: [{ stats: fakeCharizard(50), moves: [FIRE_BLAST, { power: 80, type: 0, accuracy: 100, split: 'physical' }] }],
      teamB: [{ stats: fakePidgey(5), moves: [TACKLE] }],
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      trials: 50,
      randomFn: random,
    });
    expect(result.winRateA).toBeGreaterThan(0.95);
  });

  it('similar level rivals produce mixed win rates near 50/50', () => {
    let n = 0xdeadbeef;
    const random = (): number => {
      n = (n * 1103515245 + 12345) >>> 0;
      return (n >>> 16) / 0x10000;
    };
    const result = simulateBattle({
      teamA: [{ stats: fakeCharizard(50), moves: [FIRE_BLAST] }],
      teamB: [{ stats: fakeCharizard(50), moves: [FIRE_BLAST] }],
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      trials: 30,
      randomFn: random,
    });
    // Mirror match - should be roughly 40-60% (ties broken by side A).
    expect(result.winRateA).toBeGreaterThan(0.2);
    expect(result.winRateA).toBeLessThan(0.8);
  });

  it('counter-typed team beats vulnerable team most of the time', () => {
    let n = 0x1234;
    const random = (): number => {
      n = (n * 1103515245 + 12345) >>> 0;
      return (n >>> 16) / 0x10000;
    };
    const result = simulateBattle({
      teamA: [{ stats: fakeBlastoise(50), moves: [SURF, { power: 90, type: 11, accuracy: 100, split: 'special' }] }],
      teamB: [{ stats: fakeCharizard(50), moves: [{ power: 80, type: 10, accuracy: 100, split: 'special' }] }],
      typeMatrix: VANILLA_GEN3_TYPE_MATRIX,
      trials: 50,
      randomFn: random,
    });
    // Blastoise resists Fire (+STAB Water hits Charizard 2×); should win comfortably.
    expect(result.winRateA).toBeGreaterThan(0.7);
  });
});
