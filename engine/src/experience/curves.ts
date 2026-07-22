/**
 * Gen-3 `gExperienceTables[6][101]` scanner - iter 100 / UW-3-T19.
 *
 * Detects the universal experience-curve table that every Gen-3 cart
 * embeds for level-up progression. Per pret/pokefirered
 * `src/data/pokemon/experience_tables.h`:
 *
 *   const u32 gExperienceTables[NUM_GROWTH_RATES][MAX_LEVEL + 1];
 *
 * Where `NUM_GROWTH_RATES = 6` (Erratic / Fast / Medium-Fast /
 * Medium-Slow / Slow / Fluctuating) and `MAX_LEVEL = 100` so each
 * sub-array holds 101 u32 LE entries. Total table size:
 * 6 × 101 × 4 = 2424 bytes of monotone u32 values.
 *
 * Detection signature per sub-array (101 u32 entries, 404 bytes each):
 *   - Entry [0] == 0 (level 0 placeholder - every growth rate)
 *   - Entry [1] == 0 (XP to reach level 1 - you start at level 1)
 *   - Entries [2..100] strictly monotone increasing
 *   - All entries ≤ 2,000,000 (max curve is Fluctuating at level 100 =
 *     1,640,000; cap at 2M gives slack for hacks)
 *   - Entry [100] ≥ 600,000 (smallest curve is Erratic at 600k)
 *
 * Detection signature for the FULL table:
 *   - 6 consecutive valid sub-arrays at +404 byte strides
 *
 * Combined false-positive rate across 606 u32 values with the strict
 * monotone + leading-zero-pair + magnitude constraints: < 1 in 10^15.
 * A run of 6 valid curves at stride 404 is essentially guaranteed real.
 *
 * Growth-rate identification: vanilla orders the rows
 *   [0] = MEDIUM_FAST  (1,000,000 at lvl 100)
 *   [1] = ERRATIC      (600,000)
 *   [2] = FLUCTUATING  (1,640,000)
 *   [3] = MEDIUM_SLOW  (1,059,860)
 *   [4] = FAST         (800,000)
 *   [5] = SLOW         (1,250,000)
 * Hacks may permute rows but the magnitudes uniquely identify each
 * curve, so we infer the growth-rate name from entry [100] rather than
 * baking the row order.
 *
 * PD 5: structural only - no baked offsets; works on any Gen-3 cart that
 * retains the 6-curve experience-table convention (every known vanilla
 * + every fork that didn't gut the level-up system, i.e. all of them).
 *
 * PD 1: returns `null` (caller wraps as `not_detected` with reason)
 * when no full 6-curve run is found at the documented stride.
 */

/** Number of distinct growth rates in Gen-3 (Erratic / Fast / Medium-
 *  Fast / Medium-Slow / Slow / Fluctuating). */
export const EXPERIENCE_CURVE_COUNT = 6;

/** Number of u32 entries per curve (level 0 padding + levels 1..100). */
export const EXPERIENCE_CURVE_ENTRIES_PER_CURVE = 101;

/** Bytes per single curve sub-array (101 × u32). */
export const EXPERIENCE_CURVE_BYTES_PER_CURVE = EXPERIENCE_CURVE_ENTRIES_PER_CURVE * 4;

/** Total table size: 6 × 101 × 4 = 2424 bytes. */
export const EXPERIENCE_CURVE_TABLE_BYTES =
  EXPERIENCE_CURVE_COUNT * EXPERIENCE_CURVE_BYTES_PER_CURVE;

/** Cap on any single XP value to reject corrupt regions. Vanilla max is
 *  Fluctuating at level 100 = 1,640,000; 2M gives slack for hacks that
 *  tweak curves upward. */
export const EXPERIENCE_CURVE_XP_MAX = 2_000_000;

/** Minimum XP for entry [100] across all 6 vanilla curves (Erratic).
 *  Reject sub-arrays where the level-100 entry is below this since they
 *  can't be a real growth curve. */
export const EXPERIENCE_CURVE_LEVEL_100_MIN = 600_000;

/** Cap scan stride to 4-byte alignment (u32 boundary). */
const SCAN_STRIDE_BYTES = 4;

/** Skip the GBA cartridge header (first 192 bytes) - never an XP table
 *  per the platform's hardware spec. */
const SCAN_BODY_OFFSET = 0xc0;

/** Canonical growth-rate names, ordered by vanilla pret index. Looking
 *  up the name by the LEVEL_100 magnitude is more universal than baking
 *  in vanilla row order. */
export interface ExperienceCurveProfile {
  readonly name: string;
  readonly xpAtLevel100: number;
}

export const EXPERIENCE_CURVE_PROFILES: ReadonlyArray<ExperienceCurveProfile> =
  Object.freeze([
    { name: 'MEDIUM_FAST', xpAtLevel100: 1_000_000 },
    { name: 'ERRATIC', xpAtLevel100: 600_000 },
    { name: 'FLUCTUATING', xpAtLevel100: 1_640_000 },
    { name: 'MEDIUM_SLOW', xpAtLevel100: 1_059_860 },
    { name: 'FAST', xpAtLevel100: 800_000 },
    { name: 'SLOW', xpAtLevel100: 1_250_000 },
  ]);

/** Match the given level-100 XP value to a canonical growth-rate name,
 *  or return `null` if no profile matches within ±0.5% tolerance.
 *  Tolerance handles hacks that tweak by a few hundred XP without losing
 *  identification. */
export function classifyGrowthRate(xpAtLevel100: number): string | null {
  for (const p of EXPERIENCE_CURVE_PROFILES) {
    const delta = Math.abs(p.xpAtLevel100 - xpAtLevel100);
    const tolerance = Math.max(500, p.xpAtLevel100 * 0.005);
    if (delta <= tolerance) return p.name;
  }
  return null;
}

export interface ExperienceCurve {
  /** Curve index within the discovered table (0..5). */
  readonly curveIndex: number;
  /** Absolute file offset of this curve's u32[101] sub-array. */
  readonly subTableOffset: number;
  /** XP to reach level 100 (the largest entry in this curve). */
  readonly xpAtLevel100: number;
  /** Inferred canonical growth-rate name (MEDIUM_FAST / ERRATIC / etc.)
   *  or `null` if the curve's level-100 magnitude doesn't match any
   *  known profile (rare; only happens on heavy hacks that rewrote the
   *  curves entirely). */
  readonly growthRateName: string | null;
  /** All 101 u32 entries [level 0..100] in table-order. */
  readonly xpPerLevel: ReadonlyArray<number>;
}

export interface ExperienceTable {
  /** First-byte offset of the full 6-curve table. */
  readonly tableStart: number;
  /** Exclusive end (= tableStart + 2424). */
  readonly tableEndExclusive: number;
  /** Exactly EXPERIENCE_CURVE_COUNT (6) entries when detected. */
  readonly curves: ReadonlyArray<ExperienceCurve>;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

/** Attempt to parse a single 404-byte curve at `bytes[offset..]`.
 *  Returns the parsed entries on success or `null` if the structure
 *  doesn't match the per-curve signature. */
function tryParseCurve(bytes: Uint8Array, offset: number): ReadonlyArray<number> | null {
  if (offset + EXPERIENCE_CURVE_BYTES_PER_CURVE > bytes.length) return null;
  const entries: number[] = [];
  let prev = 0;
  for (let i = 0; i < EXPERIENCE_CURVE_ENTRIES_PER_CURVE; i++) {
    const v = readU32LE(bytes, offset + i * 4);
    if (v > EXPERIENCE_CURVE_XP_MAX) return null;
    if (i === 0 || i === 1) {
      // Levels 0 + 1 are both 0 in every Gen-3 growth curve.
      if (v !== 0) return null;
    } else {
      // Strictly monotone from entry [2] onward.
      if (v <= prev) return null;
    }
    entries.push(v);
    prev = v;
  }
  // Reject curves that don't reach the minimum vanilla level-100 XP.
  if (entries[EXPERIENCE_CURVE_ENTRIES_PER_CURVE - 1]! < EXPERIENCE_CURVE_LEVEL_100_MIN) {
    return null;
  }
  return entries;
}

/**
 * Scan `bytes` for the `gExperienceTables[6][101]` table. Returns the
 * full ExperienceTable on success or `null` when no 6-curve run is
 * found at the documented 404-byte stride.
 *
 * Algorithm: walk u32-aligned offsets; at each offset try to parse 6
 * consecutive curves. First success wins (the table is unique in
 * vanilla and the 6-row signature is too strict to false-positive).
 */
export function scanExperienceTable(bytes: Uint8Array): ExperienceTable | null {
  if (bytes.length < EXPERIENCE_CURVE_TABLE_BYTES + SCAN_BODY_OFFSET) {
    return null;
  }
  const lastStart = bytes.length - EXPERIENCE_CURVE_TABLE_BYTES;
  for (let p = SCAN_BODY_OFFSET; p <= lastStart; p += SCAN_STRIDE_BYTES) {
    // Fast pre-check: first 8 bytes must be all-zero (level 0 + level
    // 1 entries of curve 0). Saves ~99% of full-curve parse work.
    if (
      bytes[p]! !== 0 ||
      bytes[p + 1]! !== 0 ||
      bytes[p + 2]! !== 0 ||
      bytes[p + 3]! !== 0 ||
      bytes[p + 4]! !== 0 ||
      bytes[p + 5]! !== 0 ||
      bytes[p + 6]! !== 0 ||
      bytes[p + 7]! !== 0
    ) {
      continue;
    }
    const curves: ExperienceCurve[] = [];
    let allValid = true;
    for (let c = 0; c < EXPERIENCE_CURVE_COUNT; c++) {
      const subOffset = p + c * EXPERIENCE_CURVE_BYTES_PER_CURVE;
      const entries = tryParseCurve(bytes, subOffset);
      if (entries === null) {
        allValid = false;
        break;
      }
      const xpAtLevel100 = entries[EXPERIENCE_CURVE_ENTRIES_PER_CURVE - 1]!;
      curves.push({
        curveIndex: c,
        subTableOffset: subOffset,
        xpAtLevel100,
        growthRateName: classifyGrowthRate(xpAtLevel100),
        xpPerLevel: Object.freeze(entries.slice()),
      });
    }
    if (!allValid || curves.length !== EXPERIENCE_CURVE_COUNT) continue;
    return {
      tableStart: p,
      tableEndExclusive: p + EXPERIENCE_CURVE_TABLE_BYTES,
      curves: Object.freeze(curves),
    };
  }
  return null;
}
