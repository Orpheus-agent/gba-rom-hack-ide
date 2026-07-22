/**
 * Ability name table detector - Phase UW-2 / Category 4 substrate (iter
 * 71 / UW-2-T5).
 *
 * Detects the Gen-3 `gAbilityNames` table - a packed array of 13-byte
 * slots holding decoded ability names ("STENCH", "DRIZZLE", "SPEED
 * BOOST", etc.). Uses signature scan via `findAbilityNamesTable` so it
 * works on ROMs that relocated the table from vanilla offsets (heavy
 * hacks like Unbound, CFRU forks, custom builds).
 *
 * Per PD 5: no FireRed/Emerald baked offsets; signature scan is the
 * universal path. Searches for the canonical STENCH (ability ID 1) +
 * DRIZZLE (ability ID 2) byte sequences at the documented 13-byte stride.
 *
 * Per PD 1: returns `not_detected` with reason when no plausible table
 * is found (ROM too small, no STENCH signature, or signature found but
 * placeholder slot validation / shape validator fails). Never empty-
 * success.
 *
 * Per PD 13: this detector is the canonical engine-side path; future
 * editor-side ability inspection consumes this detector's output.
 *
 * Advances:
 *   - Category 4 (Moves / items / abilities / battle mechanics) - fourth
 *     concrete combat-data table (after moves iter 68 + type chart iter
 *     69 + items iter 70). With abilities the engine covers most of the
 *     vanilla combat-data surface; remaining Cat 4 work focuses on
 *     trainer-AI + damage-formula + status-effect tables.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  ABILITY_NAME_SLOT_BYTES,
  ABILITY_NAMES_MIN_VALID_SLOTS,
  findAbilityNamesTable,
  readAbilityNamesAt,
  validateAbilityNames,
} from '../abilities/index.js';

export const ABILITIES_SYSTEM_DETECTOR_ID = 'abilities_system';

/** Defensive cap on declared ability count when probing forward from the
 *  detected table start. Vanilla has 78; a hack can claim more but the
 *  detector caps the validation sample. */
const ABILITY_NAMES_PROBE_COUNT = 256;

export interface AbilitiesSystemReport {
  /** File offset of the gAbilityNames table (placeholder slot 0). */
  readonly tableOffset: number;
  /** Best-effort count of slots that decode as plausible ability names
   *  (placeholder + real entries). May undercount a hack's true ability
   *  list if later entries fall back to garbage. */
  readonly validAbilityCount: number;
  /** First 16 decoded names for at-a-glance audit (placeholder at
   *  index 0; ability #1 STENCH at index 1). */
  readonly sampleNames: ReadonlyArray<string>;
}

export const abilitiesSystemDetector: RomDetector<AbilitiesSystemReport> = {
  id: ABILITIES_SYSTEM_DETECTOR_ID,
  name: 'Abilities System (Gen-3 gAbilityNames signature scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<AbilitiesSystemReport> {
    if (rom.byteLength < ABILITY_NAMES_MIN_VALID_SLOTS * ABILITY_NAME_SLOT_BYTES) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host ≥${String(ABILITY_NAMES_MIN_VALID_SLOTS)} 13-byte ability name slots`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 gAbilityNames table',
      });
    }

    const tableOffset = findAbilityNamesTable(rom.bytes);
    if (tableOffset === null) {
      return makeNotDetected({
        confidence: 0.9,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for the gAbilityNames signature (STENCH at slot+13, DRIZZLE at slot+26, dash-placeholder shape at slot 0) - no match`,
            weight: 1.0,
            detail: { romByteLength: rom.byteLength },
          }),
        ],
        reason:
          'No Gen-3 gAbilityNames table found - ROM may be non-Pokémon, may have replaced the STENCH/DRIZZLE ordering, or may have removed those abilities (rare in Gen-3 hacks)',
      });
    }

    const probed = readAbilityNamesAt(rom.bytes, tableOffset, ABILITY_NAMES_PROBE_COUNT);
    if (!validateAbilityNames(probed)) {
      return makeNotDetected({
        confidence: 0.75,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `gAbilityNames signature matched at offset 0x${tableOffset.toString(16)} but validation rejected the table (most entries don't decode as ability-name-shaped strings)`,
            weight: 1.0,
            detail: { tableOffset, probedCount: probed.length },
          }),
        ],
        reason:
          'gAbilityNames signature matched but the decoded table fails the ability-name shape validator - likely a coincidental signature match rather than a real table',
      });
    }

    // Walk forward counting consecutive valid abilities. Stop after 5
    // consecutive bad entries.
    let validAbilityCount = 0;
    let consecutiveBad = 0;
    for (let i = 0; i < probed.length; i++) {
      const name = probed[i]!;
      const isPlaceholder = i === 0 && /^-+$/.test(name);
      const looksReal =
        isPlaceholder ||
        (name.length >= 2 &&
          name.length <= 12 &&
          (/[A-Z]{3,}/.test(name) || /[A-Z]+ [A-Z]+/.test(name)) &&
          !name.includes('??'));
      if (looksReal) {
        validAbilityCount = i + 1;
        consecutiveBad = 0;
      } else {
        consecutiveBad++;
        if (consecutiveBad >= 5) break;
      }
    }

    const tableByteLength = validAbilityCount * ABILITY_NAME_SLOT_BYTES;
    try {
      coverage.addClassified({
        start: tableOffset,
        end: tableOffset + tableByteLength,
        probableClass: 'table',
        score: 0.9,
        provenance: `${ABILITIES_SYSTEM_DETECTOR_ID}#gAbilityNames`,
        note: `Gen-3 gAbilityNames (${String(validAbilityCount)} slots × ${String(ABILITY_NAME_SLOT_BYTES)} bytes)`,
      });
    } catch {
      // Overlap with another detector - skip coverage registration but
      // still return the detection.
    }

    // Confidence scales with validAbilityCount. Vanilla = 78. Heavy
    // hacks (Radical Red etc.) may exceed 200.
    const confidence =
      validAbilityCount >= 70 ? 0.95 : validAbilityCount >= 50 ? 0.9 : 0.8;

    return makeDetected({
      confidence,
      data: Object.freeze({
        tableOffset,
        validAbilityCount,
        // RT-1.4: return ALL validated names. Pre-RT-1.4 the lifter
        // saw only 16 of vanilla's 78 abilities.
        sampleNames: Object.freeze(probed.slice(0, validAbilityCount)),
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gAbilityNames at offset 0x${tableOffset.toString(16)} (${String(validAbilityCount)} valid slots, ${String(tableByteLength)} bytes)`,
          weight: 1.0,
          detail: {
            tableOffset,
            validAbilityCount,
            tableByteLength,
            sampleAbilityNames: probed.slice(1, 6),
          },
        }),
      ],
    });
  },
};
