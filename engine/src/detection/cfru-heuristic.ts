/**
 * CFRU heuristic detection - Modernize-and-Ship slice 2.
 *
 * The editor's patch detector first tries an exact SHA-1 fingerprint
 * lookup against known hacks (Radical Red, Unbound, our bundled CFRU
 * build, etc.). When that misses but the ROM still looks FRLG-shaped,
 * this heuristic answers: "is this a vanilla FRLG with SOME flavor of
 * CFRU installed (a user-built variant, an out-of-date bundle, a
 * downstream fork like Inflamed Red)?"
 *
 * The heuristic is conservative - false negatives are preferred over
 * false positives. A false positive labels a non-CFRU ROM as
 * "FireRed (Modernized) - custom build" which would confuse the
 * editor; a false negative just falls through to the existing
 * "Pokémon FireRed" label, which is still correct.
 *
 * Algorithm:
 *   1. ROM header at offset 0xAC must read "BPRE" (FRLG USA game code).
 *      CFRU keeps the vanilla header - if this fails, it isn't FRLG.
 *   2. ROM size must exceed vanilla's 16 MiB. CFRU's build expands the
 *      ROM to (typically) 32 MiB to make room for the inserted code at
 *      `OFFSET_TO_PUT` (default 0x900000). A non-expanded ROM cannot
 *      have CFRU installed at the canonical offset.
 *   3. Probe the standard CFRU insert window [0x800000, 0xA00000) at
 *      0x100-byte steps for a 16-byte window that's "code-shaped":
 *      mostly non-0xFF (not free space) and mostly non-0x00 (not zero
 *      padding). First hit is the inferred build offset.
 *
 * No SHA-1 of the prefix is needed because CFRU's `bytereplacement`
 * file applies surgical patches in the vanilla regions - a strict
 * prefix-hash equality check would miss every real CFRU ROM. The
 * header + expansion + insert-region check is the strongest signal
 * we can get without committing to a specific build variant.
 */

/** Result of the CFRU heuristic detection.
 *
 *  When `matched` is true, `buildOffset` is the address where CFRU's
 *  inserted code was first detected (typically 0x900000 for default
 *  builds, but user-customized OFFSET_TO_PUT values land elsewhere
 *  inside the probe window). The evidence list is in plain English
 *  for direct surfacing to the user via the patch detector's
 *  `evidence` field on ProjectIdentity. */
export interface CfruHeuristicResult {
  readonly matched: boolean;
  readonly buildOffset: number | null;
  readonly evidence: ReadonlyArray<string>;
}

/** FRLG USA game code at ROM offset 0xAC. */
const FRLG_GAME_CODE = new Uint8Array([0x42, 0x50, 0x52, 0x45]); // "BPRE"
const FRLG_GAME_CODE_OFFSET = 0xac;

/** Vanilla FRLG ROM size in bytes (16 MiB). A modernized ROM exceeds this. */
export const VANILLA_FRLG_ROM_SIZE = 16 * 1024 * 1024;

/** Lower bound of the probe window for CFRU's inserted code region. */
export const CFRU_PROBE_WINDOW_START = 0x800000;
/** Upper bound (exclusive) of the probe window. */
export const CFRU_PROBE_WINDOW_END = 0xa00000;
/** Step size when scanning the probe window for code-shaped bytes. */
export const CFRU_PROBE_STEP = 0x100;
/** Minimum length of a "code-shaped" sample inside the probe window. */
export const CFRU_PROBE_SAMPLE_LENGTH = 16;
/** Minimum count of non-0xFF bytes in a sample to consider it code. */
const CFRU_PROBE_MIN_NON_FF = 12;
/** Minimum count of non-0x00 bytes in a sample to consider it code. */
const CFRU_PROBE_MIN_NON_ZERO = 12;

function headerIsFrlg(romBytes: Uint8Array): boolean {
  if (romBytes.length < FRLG_GAME_CODE_OFFSET + FRLG_GAME_CODE.length) return false;
  for (let i = 0; i < FRLG_GAME_CODE.length; i++) {
    if (romBytes[FRLG_GAME_CODE_OFFSET + i] !== FRLG_GAME_CODE[i]) return false;
  }
  return true;
}

function probeForInsertedCode(romBytes: Uint8Array): number | null {
  const start = Math.min(CFRU_PROBE_WINDOW_START, romBytes.length);
  const end = Math.min(CFRU_PROBE_WINDOW_END, romBytes.length);
  for (let off = start; off + CFRU_PROBE_SAMPLE_LENGTH <= end; off += CFRU_PROBE_STEP) {
    let nonFf = 0;
    let nonZero = 0;
    for (let i = 0; i < CFRU_PROBE_SAMPLE_LENGTH; i++) {
      const b = romBytes[off + i]!;
      if (b !== 0xff) nonFf++;
      if (b !== 0x00) nonZero++;
    }
    if (nonFf >= CFRU_PROBE_MIN_NON_FF && nonZero >= CFRU_PROBE_MIN_NON_ZERO) {
      return off;
    }
  }
  return null;
}

/** Detect whether a ROM looks like FRLG with some flavor of CFRU
 *  installed. Returns `matched: true` with the inferred build offset
 *  when all three checks pass; otherwise returns `matched: false`
 *  with the reason captured in `evidence`. */
export function detectCfruHeuristic(romBytes: Uint8Array): CfruHeuristicResult {
  const evidence: string[] = [];
  if (!headerIsFrlg(romBytes)) {
    return Object.freeze({
      matched: false,
      buildOffset: null,
      evidence: Object.freeze([
        `rom header at 0x${FRLG_GAME_CODE_OFFSET.toString(16).toUpperCase()} is not "BPRE" (not FireRed USA)`,
      ]),
    });
  }
  evidence.push(`rom header at 0xAC is "BPRE" (FireRed USA)`);
  if (romBytes.length <= VANILLA_FRLG_ROM_SIZE) {
    return Object.freeze({
      matched: false,
      buildOffset: null,
      evidence: Object.freeze([
        ...evidence,
        `rom size ${String(romBytes.length)} bytes is at or below vanilla 16 MiB - not expanded`,
      ]),
    });
  }
  evidence.push(
    `rom expanded to ${Math.round((romBytes.length / 1024 / 1024) * 10) / 10} MiB (beyond vanilla 16 MiB)`,
  );
  const buildOffset = probeForInsertedCode(romBytes);
  if (buildOffset === null) {
    return Object.freeze({
      matched: false,
      buildOffset: null,
      evidence: Object.freeze([
        ...evidence,
        `no inserted code detected in [0x${CFRU_PROBE_WINDOW_START.toString(16)}, 0x${CFRU_PROBE_WINDOW_END.toString(16)})`,
      ]),
    });
  }
  evidence.push(`inserted code detected starting at 0x${buildOffset.toString(16)}`);
  return Object.freeze({
    matched: true,
    buildOffset,
    evidence: Object.freeze(evidence),
  });
}
