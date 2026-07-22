/**
 * Gen-3 heal-locations scanner - Phase O.42.
 *
 * Detects the universal `sHealLocations[]` (FRLG/Emerald) /
 * `gHealLocations[]` (Ruby/Sapphire) table that maps each SPAWN_* id
 * to a (map group, map num, x, y) tuple. These are the destinations
 * the game warps the player to on white-out + after using Fly /
 * Teleport, plus mom's house initial spawn.
 *
 * Per pret/pokefirered `include/global.fieldmap.h` + `src/data/
 * heal_locations.h`:
 *
 *   struct HealLocation {
 *     u8  group;    // 0x00 - MAP_GROUP(...) byte
 *     u8  mapNum;   // 0x01 - MAP_NUM(...) byte
 *     s16 x;        // 0x02..0x03 - destination tile x
 *     s16 y;        // 0x04..0x05 - destination tile y
 *   };  // 6 bytes per entry (natural u16 alignment, no trailing pad)
 *
 * Vanilla counts:
 *   - FRLG: 13 entries (Pallet Town, Viridian, Pewter, …, Indigo Plateau).
 *   - Emerald: 18 entries.
 *   - Ruby/Sapphire: 16 entries.
 *
 * Detection signature (per entry):
 *   - group ∈ [0, 50]   (vanilla FRLG max group ≈ 38; heavy hacks ~50)
 *   - mapNum ∈ [0, 200] (vanilla FRLG max mapNum ≈ 200; cap is the
 *     pre-Phase-J map_system cap, kept consistent)
 *   - x ∈ [0, 511]      (no vanilla map exceeds 256 tiles; 511 tolerates
 *     hack expansion)
 *   - y ∈ [0, 511]
 *
 * Per-table validation: ≥ MIN_ENTRIES consecutive valid entries AND
 * at least 50% of accepted entries have a non-zero mapNum (filters
 * out zero-fill regions like `.bss` sections).
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart.
 * PD 16: hack-aware - Unbound/Radical Red expand the table with custom
 *   spawn points; the parser handles arbitrary counts up to a
 *   defensive cap.
 */

/** Bytes per HealLocation entry. */
export const HEAL_LOCATION_SIZE_BYTES = 6;

/** Minimum consecutive valid entries required to accept a candidate. */
export const HEAL_LOCATIONS_MIN_ENTRIES = 8;

/** Defensive cap on entries walked per candidate. Vanilla 13-18; heavy
 *  hacks rarely exceed 64. */
export const HEAL_LOCATIONS_MAX_ENTRIES = 128;

/** Per-entry value bounds. */
const GROUP_MAX = 50;
const MAP_NUM_MAX = 200;
const COORD_MIN = 0;
const COORD_MAX = 511;

/** Minimum fraction of accepted entries that must have mapNum != 0.
 *  All-zero rows are sentinel / unused slots; an entire run of them
 *  is `.bss`, not heal locations. */
const MIN_NONZERO_FRACTION = 0.5;

/** Skip GBA cartridge header (first 192 bytes). */
const SCAN_BODY_OFFSET = 0xc0;

export interface HealLocation {
  /** SPAWN_* index - slot 0 corresponds to SPAWN_PALLET_TOWN in FRLG. */
  readonly slotIndex: number;
  /** Map group byte. */
  readonly group: number;
  /** Map num byte. */
  readonly mapNum: number;
  /** Destination tile x. */
  readonly x: number;
  /** Destination tile y. */
  readonly y: number;
  /** Absolute file offset of this 6-byte entry. */
  readonly fileOffset: number;
}

export interface HealLocationsTable {
  /** Absolute file offset of the first entry. */
  readonly tableStart: number;
  /** Exclusive end. */
  readonly tableEndExclusive: number;
  /** Number of entries walked + accepted. */
  readonly entryCount: number;
  /** Per-entry parsed data. */
  readonly entries: ReadonlyArray<HealLocation>;
}

function readS16LE(bytes: Uint8Array, offset: number): number {
  const v = bytes[offset]! | (bytes[offset + 1]! << 8);
  return v < 0x8000 ? v : v - 0x10000;
}

/** Try to parse one 6-byte HealLocation at the given offset. */
function tryParseEntry(
  bytes: Uint8Array,
  offset: number,
  slotIndex: number,
): HealLocation | null {
  if (offset + HEAL_LOCATION_SIZE_BYTES > bytes.length) return null;
  const group = bytes[offset + 0x00]!;
  if (group > GROUP_MAX) return null;
  const mapNum = bytes[offset + 0x01]!;
  if (mapNum > MAP_NUM_MAX) return null;
  const x = readS16LE(bytes, offset + 0x02);
  if (x < COORD_MIN || x > COORD_MAX) return null;
  const y = readS16LE(bytes, offset + 0x04);
  if (y < COORD_MIN || y > COORD_MAX) return null;
  return { slotIndex, group, mapNum, x, y, fileOffset: offset };
}

export interface ScanHealLocationsOptions {
  readonly minEntries?: number;
  readonly maxEntries?: number;
}

/**
 * Find the longest valid `sHealLocations[]` in `bytes`. Returns the
 * accepted table on success or `null` when no run clears the
 * min-entries threshold.
 *
 * Algorithm: walk 2-byte-aligned offsets (matching s16 alignment); at
 * each offset, greedily parse consecutive 6-byte entries until
 * validation fails. Accept the longest run whose nonzero-mapNum
 * fraction clears MIN_NONZERO_FRACTION + length clears the min cap.
 */
export function scanHealLocations(
  bytes: Uint8Array,
  opts?: ScanHealLocationsOptions,
): HealLocationsTable | null {
  const minEntries = opts?.minEntries ?? HEAL_LOCATIONS_MIN_ENTRIES;
  const maxEntries = opts?.maxEntries ?? HEAL_LOCATIONS_MAX_ENTRIES;
  if (bytes.length < SCAN_BODY_OFFSET + minEntries * HEAL_LOCATION_SIZE_BYTES) {
    return null;
  }
  let best: HealLocationsTable | null = null;
  // 2-byte alignment - s16 fields require this.
  for (
    let cursor = SCAN_BODY_OFFSET;
    cursor + minEntries * HEAL_LOCATION_SIZE_BYTES <= bytes.length;
    cursor += 2
  ) {
    const entries: HealLocation[] = [];
    let nonzero = 0;
    for (let i = 0; i < maxEntries; i++) {
      const offset = cursor + i * HEAL_LOCATION_SIZE_BYTES;
      const entry = tryParseEntry(bytes, offset, i);
      if (entry === null) break;
      entries.push(entry);
      if (entry.mapNum !== 0) nonzero++;
    }
    if (entries.length < minEntries) continue;
    if (nonzero / entries.length < MIN_NONZERO_FRACTION) continue;
    if (!best || entries.length > best.entryCount) {
      best = {
        tableStart: cursor,
        tableEndExclusive: cursor + entries.length * HEAL_LOCATION_SIZE_BYTES,
        entryCount: entries.length,
        entries,
      };
    }
  }
  return best;
}
