/**
 * Phase 4.3F - Inline damage-sim quick test endpoint.
 *
 *   POST /api/projects/:id/sim-trainer-battle
 *   body: { trainerId: string, trials?: number }
 *   →    { winRate: 0..1, trialsRun, trainerName, partySummary, benchmark }
 *
 * Sims a battle between the trainer's party and a curated
 * "average level-N player team" benchmark. Reuses Phase 3.4's
 * battle.simulateBattle + the buildSimStub helper from
 * propose-build-trainer-team (exported in Phase 4.3F).
 *
 * The benchmark is a level-derived 3-mon team (water / fire / grass
 * starter trio at the trainer's level). When the trainer's party
 * level varies, we take the median level - that's the "what level
 * is the player likely to be when they hit this trainer" heuristic.
 *
 * Caveats: this is an APPROXIMATION. Moves are stubbed as 80-power
 * STAB hits (so the sim is favorable to single-type teams). The
 * benchmark is deterministic so two runs of the same trainer give
 * the same answer (modulo trial count). This isn't replacing
 * mGBA-WASM in-game play - it's a "is this team roughly fair?"
 * signal the user can read in <1s.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { promises as fsp } from 'node:fs';
import { battle, species as speciesApi } from '@rom-introspection/engine';
import { readManifest } from '../scan/manifest-io.js';
import { buildSimStub } from '../agent/tools/propose-build-trainer-team.js';
import { findFirstGbaFile } from '../scan/binary-rom.js';

interface ProjectSession {
  readonly id: string;
  readonly projectRoot: string;
}

interface RegisterSimTrainerBattleRouteArgs {
  readonly app: FastifyInstance;
  readonly sessionStore: { get(id: string): ProjectSession | null | undefined };
  readonly errorResponse: (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => unknown;
}

interface SimTrainerBattleRequest {
  readonly trainerId: string;
  readonly trials?: number;
}

interface SimTrainerBattleResponse {
  readonly winRate: number;
  readonly trialsRun: number;
  readonly trainerName: string;
  readonly partySummary: ReadonlyArray<{
    readonly speciesId: number;
    readonly speciesName: string | null;
    readonly level: number;
  }>;
  readonly benchmark: ReadonlyArray<{
    readonly speciesId: number;
    readonly speciesName: string | null;
    readonly level: number;
  }>;
  readonly verdict: string;
}

/** Curated "average player team" - a starter trio. Levels are
 *  taken from the trainer's median party level so the sim stays
 *  relevant across the whole game. */
const BENCHMARK_STARTERS: ReadonlyArray<{ speciesId: number; name: string }> = [
  { speciesId: 1, name: 'BULBASAUR' },   // GRASS
  { speciesId: 4, name: 'CHARMANDER' },  // FIRE
  { speciesId: 7, name: 'SQUIRTLE' },    // WATER
];

function median(arr: number[]): number {
  if (arr.length === 0) return 5;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 5;
}

function parseSyntheticSpeciesIndex(id: string): number | null {
  const m = /^species_(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

function verdictFromWinRate(winRate: number): string {
  if (winRate >= 0.85) return 'Trivially easy for the player - consider raising the trainer.';
  if (winRate >= 0.65) return 'Easy fight - player likely to win 2–3 out of 4 tries.';
  if (winRate >= 0.45) return 'Balanced - about a coin flip vs an average player team.';
  if (winRate >= 0.25) return 'Hard fight - player loses most attempts; expect retries.';
  return 'Brutal - average player team gets steamrolled. Confirm this is intentional (boss / Elite Four).';
}

export function registerSimTrainerBattleRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterSimTrainerBattleRouteArgs): void {
  app.post<{ Params: { id: string }; Body: SimTrainerBattleRequest }>(
    '/api/projects/:id/sim-trainer-battle',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const body = req.body;
      if (!body || typeof body.trainerId !== 'string') {
        return errorResponse(reply, 400, 'internal_error', 'expected { trainerId, trials? }');
      }
      const trials = Math.min(Math.max(body.trials ?? 100, 10), 500);

      const manifest = await readManifest(session.projectRoot);
      if (!manifest) {
        return errorResponse(reply, 400, 'internal_error', 'No manifest. Scan the project first.');
      }
      const trainer = manifest.trainers.find((t) => t.id === body.trainerId);
      if (!trainer) {
        return errorResponse(reply, 404, 'path_not_found', `Trainer "${body.trainerId}" not in manifest.trainers.`);
      }

      const romPath = await findFirstGbaFile(session.projectRoot);
      if (!romPath) {
        return errorResponse(reply, 400, 'path_not_found', `No .gba ROM in ${session.projectRoot}.`);
      }
      const romBytes = new Uint8Array(await fsp.readFile(romPath));

      // Read the engine's BaseStats table directly so we have stats
      // for every species, including those not lifted to manifest.species
      // (older scans, partial lifters).
      const baseStatsTable = speciesApi.scanBaseStatsTable(romBytes);
      if (!baseStatsTable) {
        return errorResponse(reply, 500, 'internal_error', "Couldn't locate base stats table.");
      }
      const baseStatsEntries: ReadonlyArray<speciesApi.BaseStats | null> =
        baseStatsTable.records;

      // Build team A from the trainer's party.
      const teamA: Array<{ stats: battle.PokemonStatsSpec; moves: battle.MoveSpec[] }> = [];
      const partySummary: Array<{ speciesId: number; speciesName: string | null; level: number }> = [];
      for (const member of trainer.party ?? []) {
        const idx = parseSyntheticSpeciesIndex(member.speciesId);
        if (idx === null) continue;
        const entry = baseStatsEntries[idx];
        if (!entry) continue;
        const stub = buildSimStub(
          { speciesId: idx, level: member.level, iv: 0, bst: 0 },
          baseStatsEntries,
        );
        teamA.push(stub);
        const name =
          manifest.speciesNames?.find((s) => s.speciesIndex === idx)?.name ?? null;
        partySummary.push({ speciesId: idx, speciesName: name, level: member.level });
      }
      if (teamA.length === 0) {
        return errorResponse(reply, 400, 'internal_error', 'Trainer has no usable party members for simulation.');
      }

      // Benchmark team: 3 starters at the trainer's median party level.
      const benchLevel = Math.max(5, Math.min(100, median(teamA.map((m) => m.stats.level))));
      const teamB: Array<{ stats: battle.PokemonStatsSpec; moves: battle.MoveSpec[] }> = [];
      const benchmark: Array<{ speciesId: number; speciesName: string | null; level: number }> = [];
      for (const b of BENCHMARK_STARTERS) {
        const stub = buildSimStub(
          { speciesId: b.speciesId, level: benchLevel, iv: 0, bst: 0 },
          baseStatsEntries,
        );
        teamB.push(stub);
        const name =
          manifest.speciesNames?.find((s) => s.speciesIndex === b.speciesId)?.name ?? b.name;
        benchmark.push({ speciesId: b.speciesId, speciesName: name, level: benchLevel });
      }

      // Phase 9I - progressive results via Server-Sent Events.
      // Run the sim in 4 chunks (10/40/50/100 = cumulative
      // 10/50/100/200 trials) and emit `progress` events between
      // chunks so the frontend's win-rate bar updates in <100ms
      // for the first reading and refines as more trials complete.
      // The terminal event has `isFinal: true` so consumers can
      // stop listening + render the final verdict.
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders?.();

      const buckets = [10, 40, 50, 100]; // sums to 200
      const targetTotal = buckets.reduce((s, n) => s + n, 0);
      const cappedTarget = Math.min(trials, targetTotal);
      let totalTrials = 0;
      let totalWins = 0;
      for (const bucket of buckets) {
        if (totalTrials >= cappedTarget) break;
        const remaining = cappedTarget - totalTrials;
        const chunkSize = Math.min(bucket, remaining);
        const chunkResult = battle.simulateBattle({
          teamA: teamB,
          teamB: teamA,
          typeMatrix: battle.VANILLA_GEN3_TYPE_MATRIX,
          trials: chunkSize,
        });
        // simulateBattle returns winRate over its own trials; we
        // accumulate the win count to compute a rolling rate over
        // every trial seen so far.
        totalWins += Math.round(chunkResult.winRateA * chunkResult.trialsRun);
        totalTrials += chunkResult.trialsRun;
        const rollingWinRate = totalWins / Math.max(1, totalTrials);
        const partial: SimTrainerBattleResponse & { isFinal: boolean } = {
          winRate: rollingWinRate,
          trialsRun: totalTrials,
          trainerName: trainer.name,
          partySummary,
          benchmark,
          verdict: verdictFromWinRate(rollingWinRate),
          isFinal: totalTrials >= cappedTarget,
        };
        reply.raw.write(
          'event: progress\ndata: ' + JSON.stringify(partial) + '\n\n',
        );
      }
      reply.raw.end();
      // Returning `reply` here is the conventional way to tell
      // Fastify "we wrote directly to the raw socket, don't
      // re-process the body".
      return reply;
    },
  );
}
