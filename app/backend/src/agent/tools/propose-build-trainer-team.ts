/**
 * propose_build_trainer_team - Phase 3.18.
 *
 * High-level "build me a balanced trainer team for this difficulty"
 * helper. Returns a structured party spec the agent then passes to the
 * existing apply-layer tools (propose_add_trainer for new trainers,
 * propose_trainer_party for editing). This tool itself doesn't write
 * to ROM - its output is a recommendation.
 *
 * The agent supplies:
 *   - candidate species list (the "theme" - e.g. all Water-type for a
 *     Water gym leader, or a curated "elegant" set for a Norman-style
 *     class)
 *   - difficulty tier (easy / normal / hard / elite)
 *   - party size + level range
 *
 * The tool:
 *   1. Filters the candidate species against the difficulty-tier BST
 *      budget (base stat total min/max per tier).
 *   2. Picks partySize species with type-diversity preference.
 *   3. For each, picks a level + IVs per the tier + moves from the
 *      species' learnset up to that level.
 *   4. (Optional) runs simulateBattle against a benchmark team for an
 *      ELO-style win-rate estimate.
 *
 * BST budgets per difficulty:
 *   easy - 200..420
 *   normal - 380..510
 *   hard - 460..580
 *   elite - 540..720
 *
 * IV budgets:
 *   easy - 0
 *   normal - 15
 *   hard - 24
 *   elite - 31
 */

import { z } from 'zod';
import { resolveSymbolicId } from './propose-trainer-party.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { battle, species as speciesApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_BUILD_TRAINER_TEAM_TOOL_NAME = 'propose_build_trainer_team';

export const PROPOSE_BUILD_TRAINER_TEAM_DESCRIPTION =
  'Build a balanced trainer team given a difficulty tier, candidate\n' +
  'species pool, and level range. Returns a party spec the agent then\n' +
  'passes to propose_add_trainer (new trainer) or propose_trainer_party\n' +
  '(edit existing). This tool does NOT write to ROM.\n\n' +
  'Inputs:\n' +
  '  - `candidateSpeciesIds`: list of species ids to draw from (e.g.\n' +
  '    [7, 8, 9, 54, 55, 60, 61, 62, 116, 117] for a Water-themed\n' +
  '    gym).\n' +
  '  - `difficulty`: \'easy\'|\'normal\'|\'hard\'|\'elite\'.\n' +
  '  - `partySize`: 1..6.\n' +
  '  - `levelRange`: [min, max] in 1..100.\n' +
  '  - `signatureSpeciesId`: optional u16 - force-include this species\n' +
  '    in the team (e.g. the gym leader\'s ace).\n' +
  '  - `benchmarkTeam`: optional - when supplied, the tool runs a\n' +
  '    simulated battle vs this team and reports a win rate. Each\n' +
  '    entry has the same shape as the returned party members.';

const u16 = z.number().int().min(0).max(0xffff);
const level = z.number().int().min(1).max(100);

// Phase 4.3G - accept species/move ids as either numeric or symbolic
// names. The tool resolves strings against manifest.speciesNames /
// moveNames before running its build / sim logic.
const speciesIdOrName = z.union([u16, z.string().min(1).max(60)]);
const moveIdOrName = z.union([u16, z.string().min(1).max(60)]);

const benchmarkMemberSchema = z.object({
  speciesId: speciesIdOrName,
  level,
  moveIds: z.array(moveIdOrName).length(4),
});

export const proposeBuildTrainerTeamInputShape = {
  candidateSpeciesIds: z.array(speciesIdOrName).min(1).max(50),
  difficulty: z.enum(['easy', 'normal', 'hard', 'elite']),
  partySize: z.number().int().min(1).max(6),
  levelRange: z.tuple([level, level]),
  signatureSpeciesId: speciesIdOrName.optional(),
  benchmarkTeam: z.array(benchmarkMemberSchema).optional(),
} as const;

export interface BuiltPartyMember {
  readonly speciesId: number;
  readonly level: number;
  readonly iv: number;
  readonly moveIds: ReadonlyArray<number>;
  /** Base Stat Total (sum of HP/Atk/Def/Spd/SpA/SpD). */
  readonly bst: number;
  /** Primary type (for the party-balance summary). */
  readonly type1: number;
  readonly type2: number;
}

export interface ProposeBuildTrainerTeamResult {
  readonly ok: boolean;
  readonly party: ReadonlyArray<BuiltPartyMember>;
  readonly aggregateBst: number;
  readonly typeDiversityScore: number;
  /** When benchmarkTeam was supplied, the simulated win rate the
   *  built team has against it. 0..1. */
  readonly simulatedWinRate: number | null;
  readonly diagnostics: ReadonlyArray<string>;
  readonly message: string;
}

const BST_BUDGETS: Readonly<Record<string, [number, number]>> = Object.freeze({
  easy: [200, 420],
  normal: [380, 510],
  hard: [460, 580],
  elite: [540, 720],
});

const IV_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  easy: 0, normal: 15, hard: 24, elite: 31,
});

function ivAsU16(iv: number): number {
  // Gen-3 IVs are 5 bits each (0..31) packed into a 16-bit field as
  // a single byte-equivalent - the engine reads this byte and copies
  // it to all six stat IVs (the standard trainer-IV trick). 0xFF = 31.
  return (iv & 0x1f) | ((iv & 0x1f) << 8);
}

function emptyResult(message: string): ProposeBuildTrainerTeamResult {
  return {
    ok: false,
    party: [],
    aggregateBst: 0,
    typeDiversityScore: 0,
    simulatedWinRate: null,
    diagnostics: [],
    message,
  };
}

async function findRomFile(root: string): Promise<{ bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return { bytes: await fsp.readFile(path.join(root, e.name)) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Phase 4.3G - public wrapper that accepts symbolic-string inputs
 *  for species/move ids, resolves them against manifest name tables,
 *  then delegates to the numeric-only implementation. */
export async function proposeBuildTrainerTeam(
  ctx: ToolContext,
  rawArgs: {
    candidateSpeciesIds: (number | string)[];
    difficulty: 'easy' | 'normal' | 'hard' | 'elite';
    partySize: number;
    levelRange: [number, number];
    signatureSpeciesId?: number | string;
    benchmarkTeam?: Array<{ speciesId: number | string; level: number; moveIds: (number | string)[] }>;
  },
): Promise<ProposeBuildTrainerTeamResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) return emptyResult('No manifest. Open + scan a project first.');

  const speciesTable = (manifest.speciesNames ?? []).map((n) => ({ name: n.name, id: n.speciesIndex }));
  const moveTable = (manifest.moveNames ?? []).map((n) => ({ name: n.name, id: n.moveIndex }));

  const resolveSpecies = (input: number | string): number | null =>
    resolveSymbolicId(input, speciesTable, 'SPECIES_');
  const resolveMove = (input: number | string): number | null =>
    resolveSymbolicId(input, moveTable, 'MOVE_');

  const resolvedCandidates: number[] = [];
  for (const c of rawArgs.candidateSpeciesIds) {
    const id = resolveSpecies(c);
    if (id !== null) resolvedCandidates.push(id);
  }
  const resolvedSignature: number | undefined =
    rawArgs.signatureSpeciesId === undefined
      ? undefined
      : (resolveSpecies(rawArgs.signatureSpeciesId) ?? undefined);
  const resolvedBenchmark: Array<{ speciesId: number; level: number; moveIds: number[] }> | undefined =
    rawArgs.benchmarkTeam === undefined
      ? undefined
      : rawArgs.benchmarkTeam.map((m) => {
          const sp = resolveSpecies(m.speciesId);
          const moves: number[] = [];
          for (const mv of m.moveIds) {
            const id = resolveMove(mv);
            if (id !== null) moves.push(id);
          }
          while (moves.length < 4) moves.push(0);
          return { speciesId: sp ?? 0, level: m.level, moveIds: moves.slice(0, 4) };
        });

  return proposeBuildTrainerTeamInternal(ctx, {
    candidateSpeciesIds: resolvedCandidates,
    difficulty: rawArgs.difficulty,
    partySize: rawArgs.partySize,
    levelRange: rawArgs.levelRange,
    ...(resolvedSignature !== undefined ? { signatureSpeciesId: resolvedSignature } : {}),
    ...(resolvedBenchmark !== undefined ? { benchmarkTeam: resolvedBenchmark } : {}),
  });
}

/** Numeric-only impl. Was the entire body of proposeBuildTrainerTeam
 *  before Phase 4.3G; renamed so the new wrapper can do symbol
 *  resolution + delegate. */
async function proposeBuildTrainerTeamInternal(
  ctx: ToolContext,
  args: {
    candidateSpeciesIds: number[];
    difficulty: 'easy' | 'normal' | 'hard' | 'elite';
    partySize: number;
    levelRange: [number, number];
    signatureSpeciesId?: number;
    benchmarkTeam?: Array<{ speciesId: number; level: number; moveIds: number[] }>;
  },
): Promise<ProposeBuildTrainerTeamResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) return emptyResult('No manifest. Open + scan a project first.');
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  const [minLevel, maxLevel] = args.levelRange;
  if (minLevel > maxLevel) return emptyResult('levelRange min > max');

  // Locate species base-stats table via the scanner. We need a parsed
  // base-stats array indexed by speciesId.
  const romBytes = new Uint8Array(rom.bytes);
  const baseStatsTable = speciesApi.scanBaseStatsTable(romBytes);
  if (!baseStatsTable) {
    return emptyResult('Could not locate the gBaseStats table in the ROM.');
  }
  const learnsetTable = speciesApi.scanLearnsetPointerTable(romBytes);
  if (!learnsetTable) {
    return emptyResult('Could not locate the gLevelUpMoves pointer table.');
  }

  const diagnostics: string[] = [];
  const [bstMin, bstMax] = BST_BUDGETS[args.difficulty]!;
  const iv = IV_BUDGETS[args.difficulty]!;

  // Score each candidate species: filter by BST range; prefer types
  // we haven't picked yet.
  const eligible: Array<{ id: number; bst: number; type1: number; type2: number }> = [];
  for (const id of args.candidateSpeciesIds) {
    if (id <= 0 || id >= baseStatsTable.records.length) {
      diagnostics.push(`species ${String(id)} out of range; skipping.`);
      continue;
    }
    const entry = baseStatsTable.records[id];
    if (!entry) {
      diagnostics.push(`species ${String(id)} has no parsed base stats; skipping.`);
      continue;
    }
    const bst =
      entry.baseHP +
      entry.baseAttack +
      entry.baseDefense +
      entry.baseSpeed +
      entry.baseSpAttack +
      entry.baseSpDefense;
    if (bst < bstMin || bst > bstMax) {
      diagnostics.push(`species ${String(id)} BST ${String(bst)} outside [${String(bstMin)}, ${String(bstMax)}]; skipping.`);
      continue;
    }
    eligible.push({ id, bst, type1: entry.type1, type2: entry.type2 });
  }
  if (eligible.length === 0) return emptyResult('No candidate species fit the difficulty\'s BST budget.');

  // Pick partySize with type diversity preference.
  const chosen: Array<{ id: number; bst: number; type1: number; type2: number }> = [];
  // Signature species goes first if specified.
  if (args.signatureSpeciesId !== undefined) {
    const sig = eligible.find((e) => e.id === args.signatureSpeciesId);
    if (sig) {
      chosen.push(sig);
    } else {
      diagnostics.push(`signatureSpeciesId ${String(args.signatureSpeciesId)} doesn't fit the BST budget; ignored.`);
    }
  }
  while (chosen.length < args.partySize && chosen.length < eligible.length) {
    // Pick highest-BST candidate whose types are LEAST represented in
    // chosen so far.
    let best: { id: number; bst: number; type1: number; type2: number } | null = null;
    let bestScore = -Infinity;
    for (const cand of eligible) {
      if (chosen.some((c) => c.id === cand.id)) continue;
      const dup1 = chosen.filter((c) => c.type1 === cand.type1 || c.type2 === cand.type1).length;
      const dup2 = chosen.filter((c) => c.type1 === cand.type2 || c.type2 === cand.type2).length;
      // Lower duplicate count is better; tie-break on BST.
      const score = cand.bst - (dup1 + dup2) * 50;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best === null) break;
    chosen.push(best);
  }

  // Build the party with levels + moves.
  const party: BuiltPartyMember[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i]!;
    // Level: distribute from minLevel..maxLevel with an ace bias at the
    // signature slot (slot 0 if signature; otherwise highest at last).
    const aceIdx = args.signatureSpeciesId === c.id ? 0 : chosen.length - 1;
    const levelFraction = chosen.length <= 1 ? 1 : i / (chosen.length - 1);
    let lvl: number;
    if (i === aceIdx) {
      lvl = maxLevel;
    } else {
      lvl = Math.round(minLevel + (maxLevel - minLevel - 2) * levelFraction);
    }
    lvl = Math.max(minLevel, Math.min(maxLevel, lvl));

    // Moves: top 4 from learnset ≤ lvl. The scanner already parses
    // each pointer's learnset; we just walk its entries.
    const learnsetEntry = learnsetTable.entries[c.id];
    const moveIds: number[] = [];
    if (learnsetEntry && learnsetEntry.learnset.entries.length > 0) {
      const learnable = [...learnsetEntry.learnset.entries]
        .filter((e) => e.level <= lvl && e.move > 0)
        .sort((a, b) => b.level - a.level);
      for (const e of learnable.slice(0, 4)) moveIds.push(e.move);
      while (moveIds.length < 4) moveIds.push(0);
    } else {
      moveIds.push(0, 0, 0, 0);
    }

    party.push({
      speciesId: c.id,
      level: lvl,
      iv: ivAsU16(iv),
      moveIds,
      bst: c.bst,
      type1: c.type1,
      type2: c.type2,
    });
  }

  const aggregateBst = party.reduce((s, p) => s + p.bst, 0);
  // Diversity: number of distinct types across the team. Score 0..1.
  const typeSet = new Set<number>();
  for (const p of party) {
    typeSet.add(p.type1);
    if (p.type2 !== p.type1) typeSet.add(p.type2);
  }
  const typeDiversityScore = typeSet.size / Math.max(1, party.length * 2);

  // Optional benchmark simulation.
  let simulatedWinRate: number | null = null;
  if (args.benchmarkTeam && args.benchmarkTeam.length > 0) {
    // We don't have move data wired in (would need scanBattleMovesTable
    // + parse); for first cut, model each move as 80-power same-type
    // attack. This gives a rough win-rate; refining the move catalog
    // is a follow-up.
    const teamA = party.map((p) => buildSimStub(p, baseStatsTable.records));
    const teamB = args.benchmarkTeam.map((p) =>
      buildSimStub(
        { ...p, iv: ivAsU16(31), bst: 500, type1: 0, type2: 0 },
        baseStatsTable.records,
      ),
    );
    const result = battle.simulateBattle({
      teamA,
      teamB,
      typeMatrix: battle.VANILLA_GEN3_TYPE_MATRIX,
      trials: 40,
    });
    simulatedWinRate = result.winRateA;
  }

  return {
    ok: true,
    party: Object.freeze(party),
    aggregateBst,
    typeDiversityScore,
    simulatedWinRate,
    diagnostics: Object.freeze(diagnostics),
    message:
      `Built ${String(party.length)}-member team at difficulty ${args.difficulty}: ` +
      `BST sum ${String(aggregateBst)}, ${String(typeSet.size)} distinct types` +
      (simulatedWinRate !== null ? `, simulated win-rate vs benchmark ${(simulatedWinRate * 100).toFixed(1)}%` : '') +
      `. Pass result.party[] to propose_add_trainer or propose_trainer_party.`,
  };
}

/** Synthesize a sim-ready stats spec from a built party member +
 *  the base-stats table lookup. Approximates move list as 80-power
 *  STAB attacks for the simulator's purpose.
 *
 *  Exported so Phase 4.3F (sim-trainer-battle endpoint) can reuse
 *  the same approximation. */
export function buildSimStub(
  p: { speciesId: number; level: number; iv: number; bst: number; type1?: number; type2?: number },
  baseStatsEntries: ReadonlyArray<speciesApi.BaseStats | null>,
): { stats: battle.PokemonStatsSpec; moves: battle.MoveSpec[] } {
  const entry = baseStatsEntries[p.speciesId];
  const ivVal = (p.iv & 0xff) >> 3; // approximate
  const baseHP = entry?.baseHP ?? 50;
  const baseAtk = entry?.baseAttack ?? 50;
  const baseDef = entry?.baseDefense ?? 50;
  const baseSpa = entry?.baseSpAttack ?? 50;
  const baseSpd = entry?.baseSpDefense ?? 50;
  const baseSpe = entry?.baseSpeed ?? 50;
  // Stat formula (level-scaled, no EVs for first cut):
  // HP = floor(((2 × base + IV) × level) / 100) + level + 10
  // Other = floor(((2 × base + IV) × level) / 100) + 5
  const lvl = p.level;
  const hp = Math.floor(((2 * baseHP + ivVal) * lvl) / 100) + lvl + 10;
  const stat = (b: number): number => Math.floor(((2 * b + ivVal) * lvl) / 100) + 5;
  const type1 = entry?.type1 ?? 0;
  const type2 = entry?.type2 ?? type1;
  const stats: battle.PokemonStatsSpec = {
    hp,
    attack: stat(baseAtk),
    defense: stat(baseDef),
    spAttack: stat(baseSpa),
    spDefense: stat(baseSpd),
    speed: stat(baseSpe),
    type1,
    type2,
    level: lvl,
  };
  const split: 'physical' | 'special' = battle.deriveGen3MoveSplit(type1, 80) === 'special' ? 'special' : 'physical';
  return {
    stats,
    moves: [{ power: 80, type: type1, accuracy: 100, split }],
  };
}
