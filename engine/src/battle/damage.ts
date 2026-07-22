/**
 * Gen-3 damage simulator (Phase 3.4).
 *
 * Implements the published Gen-3 damage formula:
 *
 *   damage = ((((2 × level × (isCrit ? 2 : 1)) / 5 + 2) × power × A / D) / 50 + 2) × modifier
 *
 * where:
 *   - A = attacker's effective Attack (physical) or Special Attack (special)
 *   - D = defender's effective Defense or SpDefense
 *   - modifier = STAB × typeEff × randomRoll
 *   - STAB = 1.5 if move.type matches one of attacker's types, else 1.0
 *   - typeEff = product of per-type effectiveness vs each defender type
 *     (no-effect = 0; not-very = 0.5; normal = 1; super = 2; double-super = 4)
 *   - randomRoll = one of 16 discrete values in [0.85, 1.00] (Gen-3 uses a
 *     fixed-point lookup; we model as `(85 + n) / 100` for n in [0..15])
 *
 * Caller-supplied `typeChart` argument is the same shape the existing
 * `scanTypeChart` returns; we walk it once and build a 18×18 lookup
 * matrix on first call (memoized via the `prepareTypeMatrix` helper).
 * For tests without a real chart we ship `VANILLA_GEN3_TYPE_MATRIX` - 
 * an inlined canonical table from pret/pokefirered.
 *
 * Out of scope (deliberately):
 *   - Held-item bonuses (Choice Band, Life Orb, type-boost berries)
 *   - Weather modifiers (rain/sun/sandstorm/hail boosts)
 *   - Ability-driven type changes (Levitate makes Ground immune)
 *   - Burn halves physical attack
 *   - Reflect/Light Screen halve damage
 *   - Multi-hit moves
 *
 * The simulator targets "is this trainer fight winnable?" estimation,
 * not exact damage replication. For that scale, ±10% of true damage
 * is plenty.
 */

import { TYPE_CHART_TYPE_MAX } from './type-chart.js';
import type { TypeMatchup } from './type-chart.js';

/** Gen-3 has 18 types (0..17). CFRU adds Fairy at slot 18. */
export const FAIRY_TYPE_ID = 18;
/** Total slot count for the canonical chart matrix (18 vanilla + 1 fairy). */
export const TYPE_MATRIX_SIZE = 19;

export interface MoveSpec {
  /** Base power (0 = non-damaging; 250 = nominal cap). */
  readonly power: number;
  /** Type ID (0..17 vanilla, 18 = Fairy in CFRU). */
  readonly type: number;
  /** Accuracy (0 = never miss; 100 = max). */
  readonly accuracy: number;
  /** Split: 'physical' / 'special' / 'status'. For Gen-3 vanilla,
   *  derived from the type (Fire/Water/Grass/Electric/Ice/Psychic/Dark/
   *  Dragon = special; Normal/Fighting/Poison/Ground/Flying/Bug/Rock/
   *  Ghost/Steel = physical). Status moves do no damage. */
  readonly split: 'physical' | 'special' | 'status';
}

export interface PokemonStatsSpec {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly spAttack: number;
  readonly spDefense: number;
  readonly speed: number;
  readonly type1: number;
  /** Use type1 again when single-typed. */
  readonly type2: number;
  readonly level: number;
  /** Current HP for in-battle simulation. Defaults to hp at construction. */
  readonly currentHp?: number;
}

/**
 * Compute one damage roll for a single move against a single defender.
 * Returns 0 for status moves and 0-power moves; returns null when the
 * move's accuracy roll fails (caller controls via the `accuracyRoll`
 * param: pass a uniform [0, 100) value to gate misses, or pass 0 to
 * force-hit, or pass 100 to force-miss).
 *
 * `randomRoll` is in [0, 16) - the 16 discrete Gen-3 random multipliers
 * 0.85..1.00; pass a deterministic value for reproducible tests.
 *
 * `typeMatrix` is the 19×19 effectiveness multiplier matrix; pass
 * `VANILLA_GEN3_TYPE_MATRIX` for the canonical chart.
 */
export function computeDamage(args: {
  readonly attacker: PokemonStatsSpec;
  readonly defender: PokemonStatsSpec;
  readonly move: MoveSpec;
  readonly typeMatrix: ReadonlyArray<ReadonlyArray<number>>;
  readonly isCrit: boolean;
  readonly randomRoll: number; // 0..15
  readonly accuracyRoll: number; // 0..99
}): number | null {
  const { attacker, defender, move, typeMatrix, isCrit } = args;
  if (move.split === 'status' || move.power === 0) return 0;
  // Accuracy: 0 in the engine = "always hits"
  if (move.accuracy > 0 && args.accuracyRoll >= move.accuracy) return null;

  const level = attacker.level;
  const power = move.power;
  const A = move.split === 'physical' ? attacker.attack : attacker.spAttack;
  const D = move.split === 'physical' ? defender.defense : defender.spDefense;
  if (D <= 0) return power * 4; // defensive sanity guard; never crash

  const critFactor = isCrit ? 2 : 1;
  // ((2 * level * crit) / 5 + 2)
  const a = Math.floor((2 * level * critFactor) / 5) + 2;
  // * power * A / D
  const b = Math.floor((a * power * A) / D);
  // / 50 + 2
  const base = Math.floor(b / 50) + 2;

  const stab = move.type === attacker.type1 || move.type === attacker.type2 ? 1.5 : 1.0;
  const typeEff =
    typeMatrix[move.type]![defender.type1]! *
    (defender.type1 === defender.type2 ? 1 : typeMatrix[move.type]![defender.type2]!);
  if (typeEff === 0) return 0;
  // Random in [0.85, 1.00] in 16 steps.
  const rollFraction = (85 + Math.max(0, Math.min(15, args.randomRoll))) / 100;
  const modifier = stab * typeEff * rollFraction;
  return Math.max(1, Math.floor(base * modifier));
}

/**
 * Estimate the win rate of `teamA` against `teamB` over N simulated
 * battles. Both teams iterate from member 0; each turn both pick the
 * MAX-damage move against the active opposing Pokémon (no switching,
 * no items). When a member faints, the team's next member becomes
 * active. Team that loses all members loses the battle.
 *
 * `randomFn`: pseudo-random function returning [0, 1) - pass a seeded
 * PRNG for deterministic tests. Defaults to `Math.random`.
 */
export function simulateBattle(args: {
  readonly teamA: ReadonlyArray<{ stats: PokemonStatsSpec; moves: ReadonlyArray<MoveSpec> }>;
  readonly teamB: ReadonlyArray<{ stats: PokemonStatsSpec; moves: ReadonlyArray<MoveSpec> }>;
  readonly typeMatrix: ReadonlyArray<ReadonlyArray<number>>;
  readonly trials?: number;
  readonly randomFn?: () => number;
  readonly maxTurns?: number;
}): { winRateA: number; trialsRun: number } {
  const trials = args.trials ?? 100;
  const maxTurns = args.maxTurns ?? 100;
  const random = args.randomFn ?? Math.random;
  let winsA = 0;
  for (let trial = 0; trial < trials; trial++) {
    // Reset both teams to full HP.
    const hpA = args.teamA.map((m) => m.stats.hp);
    const hpB = args.teamB.map((m) => m.stats.hp);
    let activeA = 0;
    let activeB = 0;
    let turn = 0;
    while (activeA < hpA.length && activeB < hpB.length && turn < maxTurns) {
      const monA = args.teamA[activeA]!;
      const monB = args.teamB[activeB]!;
      // Order: higher speed acts first; ties broken by side A.
      const aFirst = monA.stats.speed >= monB.stats.speed;
      const doA = (): void => {
        const move = pickBestMove(monA.moves, monA.stats, monB.stats, args.typeMatrix);
        if (!move) return;
        const isCrit = random() < 1 / 16;
        const randomRoll = Math.floor(random() * 16);
        const accuracyRoll = random() * 100;
        const dmg = computeDamage({
          attacker: monA.stats,
          defender: monB.stats,
          move,
          typeMatrix: args.typeMatrix,
          isCrit,
          randomRoll,
          accuracyRoll,
        });
        if (dmg !== null) {
          hpB[activeB] = Math.max(0, hpB[activeB]! - dmg);
          if (hpB[activeB] === 0) activeB++;
        }
      };
      const doB = (): void => {
        if (activeB >= hpB.length) return;
        const target = args.teamB[activeB]!;
        const move = pickBestMove(target.moves, target.stats, monA.stats, args.typeMatrix);
        if (!move) return;
        const isCrit = random() < 1 / 16;
        const randomRoll = Math.floor(random() * 16);
        const accuracyRoll = random() * 100;
        const dmg = computeDamage({
          attacker: target.stats,
          defender: monA.stats,
          move,
          typeMatrix: args.typeMatrix,
          isCrit,
          randomRoll,
          accuracyRoll,
        });
        if (dmg !== null) {
          hpA[activeA] = Math.max(0, hpA[activeA]! - dmg);
          if (hpA[activeA] === 0) activeA++;
        }
      };
      if (aFirst) {
        doA();
        if (activeA < hpA.length) doB();
      } else {
        doB();
        if (activeB < hpB.length) doA();
      }
      turn++;
    }
    if (activeB >= hpB.length && activeA < hpA.length) winsA++;
  }
  return { winRateA: winsA / trials, trialsRun: trials };
}

function pickBestMove(
  moves: ReadonlyArray<MoveSpec>,
  attacker: PokemonStatsSpec,
  defender: PokemonStatsSpec,
  typeMatrix: ReadonlyArray<ReadonlyArray<number>>,
): MoveSpec | null {
  let best: MoveSpec | null = null;
  let bestExpected = -1;
  for (const m of moves) {
    if (m.split === 'status' || m.power === 0) continue;
    const dmg = computeDamage({
      attacker,
      defender,
      move: m,
      typeMatrix,
      isCrit: false,
      randomRoll: 7, // median
      accuracyRoll: 50,
    });
    if (dmg === null) continue;
    // Expected damage = damage × accuracy/100.
    const expected = dmg * (m.accuracy === 0 ? 1 : m.accuracy / 100);
    if (expected > bestExpected) {
      bestExpected = expected;
      best = m;
    }
  }
  return best;
}

/** Build a 19×19 effectiveness matrix from the scanner's TypeMatchup
 *  list. Missing entries default to 1.0 (neutral). Effectiveness bytes
 *  are × 10 in ROM; we divide. Foresight separator splits "pre-
 *  foresight" matchups (always applied) from "post-foresight"
 *  matchups (only applied when foresight is active); for simulation
 *  we apply both as if foresight were on (over-counts ghost
 *  vulnerability slightly - acceptable for win-rate estimates). */
export function prepareTypeMatrix(
  matchups: ReadonlyArray<TypeMatchup>,
): number[][] {
  const matrix: number[][] = [];
  for (let i = 0; i < TYPE_MATRIX_SIZE; i++) {
    matrix.push(new Array<number>(TYPE_MATRIX_SIZE).fill(1));
  }
  for (const m of matchups) {
    if (m.kind !== 'matchup') continue;
    if (m.attackerType > TYPE_CHART_TYPE_MAX + 1 || m.defenderType > TYPE_CHART_TYPE_MAX + 1) {
      continue;
    }
    matrix[m.attackerType]![m.defenderType] = m.effectiveness / 10;
  }
  return matrix;
}

/**
 * Canonical Gen-3 type effectiveness matrix (from pret/pokefirered's
 * `sTypeEffectivenessTable`). Lets tests run without scanning a ROM.
 *
 * Indices 0..17 = Normal, Fighting, Flying, Poison, Ground, Rock, Bug,
 * Ghost, Steel, ???, Fire, Water, Grass, Electric, Psychic, Ice, Dragon,
 * Dark. Index 18 = Fairy (CFRU/Gen 6+) - treated as neutral vs vanilla
 * types by default (CFRU's table extends; this matrix matches vanilla).
 */
export const VANILLA_GEN3_TYPE_MATRIX: ReadonlyArray<ReadonlyArray<number>> = (() => {
  const M = Array.from({ length: TYPE_MATRIX_SIZE }, () =>
    new Array<number>(TYPE_MATRIX_SIZE).fill(1),
  );
  // Non-neutral matchups from pret/pokefirered.
  // [attackerType, defenderType, multiplier]
  const entries: ReadonlyArray<readonly [number, number, number]> = [
    // Normal
    [0, 5, 0.5], [0, 7, 0], [0, 8, 0.5],
    // Fighting
    [1, 0, 2], [1, 2, 0.5], [1, 5, 2], [1, 6, 0.5], [1, 7, 0],
    [1, 8, 2], [1, 14, 0.5], [1, 15, 2], [1, 17, 2],
    // Flying
    [2, 1, 2], [2, 6, 2], [2, 5, 0.5], [2, 8, 0.5], [2, 12, 2], [2, 13, 0.5],
    // Poison
    [3, 12, 2], [3, 3, 0.5], [3, 4, 0.5], [3, 5, 0.5], [3, 7, 0.5], [3, 8, 0],
    // Ground
    [4, 10, 2], [4, 13, 2], [4, 12, 0.5], [4, 6, 0.5], [4, 5, 2], [4, 8, 2], [4, 2, 0],
    // Rock
    [5, 2, 2], [5, 6, 2], [5, 10, 2], [5, 15, 2], [5, 1, 0.5], [5, 4, 0.5], [5, 8, 0.5],
    // Bug
    [6, 12, 2], [6, 14, 2], [6, 17, 2], [6, 1, 0.5], [6, 2, 0.5], [6, 7, 0.5],
    [6, 3, 0.5], [6, 10, 0.5], [6, 8, 0.5],
    // Ghost
    [7, 0, 0], [7, 7, 2], [7, 17, 0.5], [7, 14, 2],
    // Steel
    [8, 5, 2], [8, 15, 2], [8, 10, 0.5], [8, 11, 0.5], [8, 13, 0.5], [8, 8, 0.5],
    // Fire
    [10, 6, 2], [10, 12, 2], [10, 15, 2], [10, 8, 2], [10, 10, 0.5],
    [10, 11, 0.5], [10, 5, 0.5], [10, 16, 0.5],
    // Water
    [11, 10, 2], [11, 4, 2], [11, 5, 2], [11, 11, 0.5], [11, 12, 0.5], [11, 16, 0.5],
    // Grass
    [12, 11, 2], [12, 4, 2], [12, 5, 2], [12, 10, 0.5], [12, 12, 0.5],
    [12, 3, 0.5], [12, 2, 0.5], [12, 6, 0.5], [12, 16, 0.5], [12, 8, 0.5],
    // Electric
    [13, 11, 2], [13, 2, 2], [13, 12, 0.5], [13, 13, 0.5], [13, 4, 0], [13, 16, 0.5],
    // Psychic
    [14, 1, 2], [14, 3, 2], [14, 8, 0.5], [14, 14, 0.5], [14, 17, 0],
    // Ice
    [15, 2, 2], [15, 4, 2], [15, 12, 2], [15, 16, 2], [15, 10, 0.5],
    [15, 11, 0.5], [15, 15, 0.5], [15, 8, 0.5],
    // Dragon
    [16, 16, 2], [16, 8, 0.5],
    // Dark
    [17, 7, 2], [17, 14, 2], [17, 1, 0.5], [17, 17, 0.5], [17, 8, 0.5],
  ];
  for (const [a, d, m] of entries) M[a]![d] = m;
  return M.map((row) => Object.freeze(row));
})();

/** Derive Gen-3 vanilla move split (physical/special) from the move's
 *  type. In Gen-3 FRLG, move category was type-based; Gen-4+ moved it
 *  to a per-move flag. */
export function deriveGen3MoveSplit(type: number, power: number): 'physical' | 'special' | 'status' {
  if (power === 0) return 'status';
  // Physical: Normal, Fighting, Flying, Poison, Ground, Rock, Bug, Ghost, Steel.
  const PHYSICAL_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  return PHYSICAL_TYPES.has(type) ? 'physical' : 'special';
}
