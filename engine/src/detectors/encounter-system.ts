/**
 * Phase-8 detector: encounter system depth (P8-T3).
 *
 * Per §15 Phase 8, the encounter system covers grass/surf/fish/cave/
 * swarm/dynamic/conditional/time/weather/seasonal/randomizer/custom
 * engines and reconstructs editable semantic encounter graphs. P5-T6
 * already detected the `gWildMonHeaders` table at the structural-shape
 * level (20-byte WildPokemonHeader records terminated by sentinel,
 * each with 4 typed pointer slots: landMons / waterMons / rockSmash /
 * fishing). P8-T3 dereferences those pointers into the per-kind
 * `WildPokemonInfo` structs + slot arrays so each detected encounter
 * table carries real per-Pokémon species + level data rather than
 * just "kinds populated."
 *
 * The output graph gains:
 *   - `encounters_species` edges from each `encounter_table:N` →
 *     `species:S` for every wild slot's species id (deduplicated per
 *     (encounter_table, species) pair so multi-slot occurrences don't
 *     create N parallel edges).
 *   - rich `detail` on each encounter-table node listing per-kind
 *     slot counts + level ranges + species lists.
 *
 * Coverage contribution: every byte of every parsed WildPokemonInfo
 * struct (8 bytes) AND every parsed slot array (N × 4 bytes per
 * encounter kind) is registered as `table` class at confidence 0.9.
 *
 * PD 5: structural-only - the dereference chain follows pointers
 * surfaced by P5-T6's structural detection of the encounter-table
 * headers; no baked offsets, works on any Gen-3 cart whose wild-
 * encounter layout matches the published struct.
 *
 * PD 8: WildPokemonInfo + slot arrays were previously unaccounted
 * (P5-T6 only registers the 20-byte headers); P8-T3 closes those
 * regions explicitly.
 *
 * PD 1 / §15 P8 acceptance: this detector advances the "encounter
 * ... return real reconstructed data, not zeros" mandate - after
 * P8-T1 surfaced species (gBaseStats) and P8-T2 surfaced trainers
 * (gTrainers), P8-T3 surfaces the per-slot species + level data
 * that connects encounter_tables BACK into species:N via typed
 * `encounters_species` edges, completing one of the three §15 P8
 * "beyond species" systems.
 */

import { makeDetected, makeEvidence, makeNotDetected, makePartial } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  scanWildEncountersTable,
  type EncounterKind,
} from '../maps/index.js';
import {
  VANILLA_FISHING_SLOT_COUNT,
  VANILLA_LAND_SLOT_COUNT,
  VANILLA_ROCK_SMASH_SLOT_COUNT,
  VANILLA_WATER_SLOT_COUNT,
  WILD_POKEMON_INFO_STRUCT_SIZE_BYTES,
  WILD_POKEMON_SLOT_SIZE_BYTES,
  parseWildPokemonInfo,
  type WildPokemonInfo,
} from '../encounters/index.js';

export const ENCOUNTER_SYSTEM_DETECTOR_ID = 'encounter_system';

/** Maps each EncounterKind to its vanilla slot count. PD 5: this is a
 *  default the detector uses when the caller doesn't override; the
 *  parser itself accepts arbitrary slot counts so heavy hacks with
 *  expanded encounter tables still detect. */
const VANILLA_SLOT_COUNTS: Readonly<Record<EncounterKind, number>> = Object.freeze({
  land: VANILLA_LAND_SLOT_COUNT,
  water: VANILLA_WATER_SLOT_COUNT,
  rockSmash: VANILLA_ROCK_SMASH_SLOT_COUNT,
  fishing: VANILLA_FISHING_SLOT_COUNT,
});

export interface EncounterTableEntryReport {
  readonly mapGroup: number;
  readonly mapNum: number;
  /** ROM file offset of the WildPokemonHeader for this table entry. */
  readonly headerFileOffset: number;
  /** Per-kind parsed WildPokemonInfo. Each kind is null when the
   *  header's pointer for that kind was NULL or failed to parse. */
  readonly kinds: Readonly<Record<EncounterKind, WildPokemonInfo | null>>;
}

export interface EncounterSystemReport {
  /** Number of encounter-table entries from `gWildMonHeaders`. */
  readonly tableCount: number;
  /** Per-entry parsed kinds with their slot arrays. */
  readonly entries: ReadonlyArray<EncounterTableEntryReport>;
  /** Total number of slots successfully parsed across all entries/kinds. */
  readonly totalSlotCount: number;
  /** Total number of WildPokemonInfo structs successfully parsed. */
  readonly totalInfoStructCount: number;
  /** Distinct species ids referenced by any slot. */
  readonly referencedSpeciesIds: ReadonlyArray<number>;
}

const KINDS: ReadonlyArray<EncounterKind> = Object.freeze([
  'land',
  'water',
  'rockSmash',
  'fishing',
]);

export const encounterSystemDetector: RomDetector<EncounterSystemReport> = {
  id: ENCOUNTER_SYSTEM_DETECTOR_ID,
  name: 'Encounter System (Gen-3 WildPokemonInfo + slot deep-dive)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<EncounterSystemReport> {
    // Re-scan for the wild-encounters table - independently of map-
    // system's prior scan so the detector contract holds (each detector
    // is self-contained; cross-detector sharing happens at graph-build
    // time, not inside the detect() boundary).
    const wildEncountersTable = scanWildEncountersTable(rom.bytes);
    if (wildEncountersTable === null || wildEncountersTable.headers.length === 0) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `no gWildMonHeaders table found via structural scan (P5-T6 path) - encounter-system depth (P8-T3) requires a header table to dereference`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No gWildMonHeaders table found - either the ROM lacks wild encounters, the encounter engine uses a non-flat layout, or the table is too small to clear the min-headers threshold',
      });
    }

    const entries: EncounterTableEntryReport[] = [];
    const referencedSpeciesSet = new Set<number>();
    let totalSlotCount = 0;
    let totalInfoStructCount = 0;
    let failedDerefCount = 0;

    for (const h of wildEncountersTable.headers) {
      const kindOffsets: Readonly<Record<EncounterKind, number | null>> = {
        land: h.landMonsOffset,
        water: h.waterMonsOffset,
        rockSmash: h.rockSmashMonsOffset,
        fishing: h.fishingMonsOffset,
      };
      const kindsResult: Record<EncounterKind, WildPokemonInfo | null> = {
        land: null,
        water: null,
        rockSmash: null,
        fishing: null,
      };
      for (const kind of KINDS) {
        const infoOffset = kindOffsets[kind];
        if (infoOffset === null) continue;
        const slotCount = VANILLA_SLOT_COUNTS[kind];
        const r = parseWildPokemonInfo(rom.bytes, infoOffset, { slotCount });
        if (!r.ok) {
          failedDerefCount++;
          continue;
        }
        kindsResult[kind] = r.info;
        totalInfoStructCount++;
        totalSlotCount += r.info.slotCount;
        for (const slot of r.info.slots) {
          referencedSpeciesSet.add(slot.species);
        }

        // Register coverage: the WildPokemonInfo struct itself, AND
        // the slots array (if non-null).
        try {
          coverage.addClassified({
            start: infoOffset,
            end: infoOffset + WILD_POKEMON_INFO_STRUCT_SIZE_BYTES,
            probableClass: 'table',
            score: 0.9,
            provenance: `${ENCOUNTER_SYSTEM_DETECTOR_ID}#WildPokemonInfo`,
            note: `WildPokemonInfo for ${kind} encounters (map ${String(h.mapGroup)}.${String(h.mapNum)}) - ${String(r.info.slotCount)} slots`,
          });
        } catch {
          // Overlap with another detector - skip.
        }
        if (r.info.slotsOffset !== null && r.info.slotCount > 0) {
          try {
            coverage.addClassified({
              start: r.info.slotsOffset,
              end: r.info.slotsOffset + r.info.slotCount * WILD_POKEMON_SLOT_SIZE_BYTES,
              probableClass: 'table',
              score: 0.9,
              provenance: `${ENCOUNTER_SYSTEM_DETECTOR_ID}#WildPokemon[]`,
              note: `${String(r.info.slotCount)} ${kind} wild Pokémon slots (map ${String(h.mapGroup)}.${String(h.mapNum)})`,
            });
          } catch {
            // Overlap - skip.
          }
        }
      }
      entries.push(
        Object.freeze({
          mapGroup: h.mapGroup,
          mapNum: h.mapNum,
          headerFileOffset: h.fileOffset,
          kinds: Object.freeze(kindsResult),
        }),
      );
    }

    if (totalInfoStructCount === 0) {
      return makePartial({
        confidence: 0.7,
        data: Object.freeze({
          tableCount: wildEncountersTable.headers.length,
          entries: Object.freeze(entries),
          totalSlotCount: 0,
          totalInfoStructCount: 0,
          referencedSpeciesIds: Object.freeze([]),
        }),
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `${String(wildEncountersTable.headers.length)} encounter-table headers found by P5-T6, but every kind-pointer either was NULL or failed to dereference as WildPokemonInfo (${String(failedDerefCount)} failed derefs)`,
            weight: 1.0,
            detail: {
              tableCount: wildEncountersTable.headers.length,
              failedDerefCount,
            },
          }),
        ],
        partialReason:
          'Encounter table headers detected but no WildPokemonInfo could be dereferenced - likely a custom/non-vanilla encounter engine layout. P5-T6 header detection still valid; deep-dive blocked.',
      });
    }

    // Confidence: many real slot lookups + a healthy ratio of derefs.
    // Vanilla FireRed has ~150 encounter-table rows × up to 4 kinds =
    // ~600 info structs; ≥100 derefs is essentially certainly real.
    const confidence =
      totalInfoStructCount >= 100
        ? 0.95
        : totalInfoStructCount >= 20
          ? 0.9
          : 0.85;

    const referencedSpeciesIds = Object.freeze(
      Array.from(referencedSpeciesSet).sort((a, b) => a - b),
    );

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableCount: wildEncountersTable.headers.length,
        entries: Object.freeze(entries),
        totalSlotCount,
        totalInfoStructCount,
        referencedSpeciesIds,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Dereferenced ${String(totalInfoStructCount)} WildPokemonInfo structs across ${String(wildEncountersTable.headers.length)} encounter-table headers - parsed ${String(totalSlotCount)} wild Pokémon slots referencing ${String(referencedSpeciesIds.length)} distinct species`,
          weight: 1.0,
          detail: {
            tableCount: wildEncountersTable.headers.length,
            totalInfoStructCount,
            totalSlotCount,
            distinctSpeciesCount: referencedSpeciesIds.length,
            failedDerefCount,
          },
        }),
      ],
    });
  },
};
