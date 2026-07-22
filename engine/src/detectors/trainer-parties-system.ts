/**
 * Trainer parties detector - iter 107 / UW-3-T26.
 *
 * Chains off the gTrainers table (iter-67 trainer_system) by following
 * each trainer's `partyPointer` and parsing `partySize` party-member
 * structs (4 struct variants based on partyFlags bits per
 * party-member.ts). Surfaces the per-trainer Pokémon roster - the
 * highest-value missing substrate prior to this iter: every trainer's
 * party (species, level, IVs, held item, custom moves).
 *
 * PD 5: structural-only - re-runs `scanTrainerTable` internally to find
 * the trainer table (no shared detector state); per-member validation
 * via parseTrainerPartyMember rejects out-of-range species/level/IV/
 * moves. PD 16 hack-aware: hacks expanding species count (Radical Red,
 * Unbound) detect identically because the species cap is 2000.
 *
 * Per UW-D-0015 invariant: this detector co-ships with its lifter
 * registered in `app/backend/src/scan/binary-rom-registry.ts` - 
 * `liftTrainerParties` enriches existing ctx.trainers entries with
 * parsed party data (iter-95 trainer lifter writes empty `party` array;
 * iter-107 lifter populates it).
 *
 * Phase 9 (runs after trainer_system at phase 8 - non-required ordering;
 * detector re-scans internally so independent of other detectors).
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  parseTrainerPartyArray,
  partyMemberStructSize,
  scanTrainerTable,
  type TrainerPartyMemberParsed,
} from '../trainers/index.js';

export const TRAINER_PARTIES_SYSTEM_DETECTOR_ID = 'trainer_parties_system';

/** GBA ROM mirror base - for ptr→file-offset conversion. */
const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

export interface TrainerPartyParsed {
  /** Trainer index in the gTrainers table this party belongs to. */
  readonly trainerIndex: number;
  /** Trainer's partyFlags byte (selects the member struct variant). */
  readonly partyFlags: number;
  /** Declared partySize from the trainer struct (1..6). */
  readonly declaredPartySize: number;
  /** Absolute file offset where the party-member array starts. */
  readonly arrayFileOffset: number;
  /** Successfully parsed members (length <= declaredPartySize if a
   *  member failed validation; engine then bails on that party). */
  readonly members: ReadonlyArray<TrainerPartyMemberParsed>;
  /** Total byte length of the party array (declaredPartySize × struct
   *  size). Used for coverage registration. */
  readonly arrayByteLength: number;
}

export interface TrainerPartiesSystemReport {
  /** Internally-rediscovered trainer-table start offset (matches the
   *  trainer_system detector's tableStart). */
  readonly trainerTableStart: number;
  /** Number of trainers found in the rescan. */
  readonly trainerCount: number;
  /** Number of trainers whose party was successfully parsed (members
   *  array length == declaredPartySize). */
  readonly fullyParsedPartyCount: number;
  /** Number of trainers whose party array couldn't be reached or whose
   *  first member failed validation. */
  readonly skippedPartyCount: number;
  /** Total parsed party members across all trainers (sum of
   *  parties[*].members.length). */
  readonly totalMemberCount: number;
  /** Per-trainer party data; entries are sorted by trainerIndex. */
  readonly parties: ReadonlyArray<TrainerPartyParsed>;
}

export const trainerPartiesSystemDetector: RomDetector<TrainerPartiesSystemReport> = {
  id: TRAINER_PARTIES_SYSTEM_DETECTOR_ID,
  name: 'Trainer Parties System (Gen-3 per-trainer party-member parser)',
  phase: 9,
  detect(rom: RomImage, coverage: CoverageMap): Detection<TrainerPartiesSystemReport> {
    const trainerTable = scanTrainerTable(rom.bytes);
    if (trainerTable === null) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `cannot scan trainer parties - no gTrainers table found in this ROM (trainer_system also reports not_detected)`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 gTrainers table found - trainer party parsing depends on the trainer table; non-Gen-3 or rewritten battle engine.',
      });
    }

    const parties: TrainerPartyParsed[] = [];
    let fullyParsed = 0;
    let skipped = 0;
    let totalMemberCount = 0;

    for (let i = 0; i < trainerTable.trainers.length; i++) {
      const t = trainerTable.trainers[i]!;
      // Skip null pointers (occasionally trainers have no party - rare).
      if (t.partyPointer === 0 || t.partySize === 0) {
        skipped++;
        continue;
      }
      // Convert ROM pointer to file offset.
      if (t.partyPointer < GBA_ROM_BASE || t.partyPointer >= GBA_ROM_END_EXCLUSIVE) {
        skipped++;
        continue;
      }
      const arrayFileOffset = t.partyPointer - GBA_ROM_BASE;
      const structSize = partyMemberStructSize(t.partyFlags);
      const arrayByteLength = structSize * t.partySize;
      if (arrayFileOffset + arrayByteLength > rom.bytes.length) {
        skipped++;
        continue;
      }
      const result = parseTrainerPartyArray(
        rom.bytes,
        arrayFileOffset,
        t.partyFlags,
        t.partySize,
      );
      if (result.failureAtIndex === 0) {
        // Couldn't parse even the first member - skip this trainer.
        skipped++;
        continue;
      }
      parties.push({
        trainerIndex: i,
        partyFlags: t.partyFlags,
        declaredPartySize: t.partySize,
        arrayFileOffset,
        members: result.members,
        arrayByteLength,
      });
      totalMemberCount += result.members.length;
      if (result.members.length === t.partySize) fullyParsed++;
      // Coverage: register the party-array region.
      try {
        coverage.addClassified({
          start: arrayFileOffset,
          end: arrayFileOffset + arrayByteLength,
          probableClass: 'table',
          score: 0.88,
          provenance: `${TRAINER_PARTIES_SYSTEM_DETECTOR_ID}#party_array_${String(i)}`,
          note: `Trainer #${String(i)} party array (${String(result.members.length)} members × ${String(structSize)} bytes)`,
        });
      } catch {
        // Overlap with another detector - skip coverage registration.
      }
    }

    if (parties.length === 0) {
      return makeNotDetected({
        confidence: 0.7,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `Found gTrainers at 0x${trainerTable.tableStart.toString(16)} (${String(trainerTable.trainers.length)} trainers) but no trainer's party could be parsed - every party array either out-of-bounds OR first member failed validation`,
            weight: 1.0,
            detail: {
              trainerTableStart: trainerTable.tableStart,
              trainerCount: trainerTable.trainers.length,
              skippedPartyCount: skipped,
            },
          }),
        ],
        reason:
          'gTrainers detected but all partyPointer follow-throughs failed - partyPointer field may not have been updated by a hack that relocated parties without updating the parent struct',
      });
    }

    // Confidence: scales with how many parties we successfully parsed
    // out of the trainer count. Vanilla FRLG: 743 trainers, all parsed.
    const fullyParsedFraction = trainerTable.trainers.length > 0
      ? fullyParsed / trainerTable.trainers.length
      : 0;
    const confidence =
      fullyParsedFraction >= 0.9 ? 0.97 : fullyParsedFraction >= 0.5 ? 0.9 : 0.82;

    return makeDetected({
      confidence,
      data: Object.freeze({
        trainerTableStart: trainerTable.tableStart,
        trainerCount: trainerTable.trainers.length,
        fullyParsedPartyCount: fullyParsed,
        skippedPartyCount: skipped,
        totalMemberCount,
        parties: Object.freeze(parties),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Parsed ${String(fullyParsed)}/${String(trainerTable.trainers.length)} trainer parties at 0x${trainerTable.tableStart.toString(16)} - total ${String(totalMemberCount)} party members across ${String(parties.length)} parties (${String(skipped)} skipped due to out-of-bounds or invalid first member)`,
          weight: 1.0,
          detail: {
            trainerCount: trainerTable.trainers.length,
            fullyParsedPartyCount: fullyParsed,
            skippedPartyCount: skipped,
            totalMemberCount,
            sampleSpeciesIds: parties.slice(0, 5).map((p) => p.members.map((m) => m.species)),
          },
        }),
      ],
    });
  },
};
