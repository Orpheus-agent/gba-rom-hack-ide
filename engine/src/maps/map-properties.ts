/**
 * Semantic name tables for Gen-3 mapHeader byte fields.
 *
 * The Gen-3 MapHeader struct (28 bytes) embeds several enum/bitfield
 * fields whose byte values have stable, well-documented meanings
 * across the vanilla Gen-3 family + decomp builds + the typical hacks
 * that don't rewrite the engine. This module provides:
 *
 *   - `MAP_TYPE_NAMES`        (mapHeader.mapType,   offset 0x17)
 *   - `MAP_WEATHER_NAMES`     (mapHeader.weather,   offset 0x16)
 *   - `MAP_BATTLE_TYPE_NAMES` (mapHeader.battleType, offset 0x1B)
 *   - `MAP_FLAGS_BITS`        (mapHeader.flags,     offset 0x1A - bitfield)
 *
 * PD 5: every name table includes an `UNKNOWN_<value>` fallback so an
 * unknown byte produces a typed name rather than masking the value.
 * Heavy hacks routinely extend the weather/battleType enums with new
 * values - those return as `UNKNOWN_42`-style names so the workspace
 * surfaces the divergence rather than silently mapping to `NONE`.
 *
 * The `caveOrType` byte (offset 0x15) is a smaller enum that mostly
 * controls the brightness-overlay / flash-radius behavior. Common
 * names: NONE, CAVE, INDOOR_LIGHTING, DARK_ROOM, FLASH_USABLE, etc.
 * Vanilla rarely uses values > 5, so we keep a compact table + a
 * generic UNKNOWN fallback.
 */

/** Gen-3 mapType enum (pret/pokeemerald + pokefirered share these names). */
export const MAP_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'NONE',
  1: 'TOWN',
  2: 'CITY',
  3: 'ROUTE',
  4: 'UNDERGROUND',
  5: 'UNDERWATER',
  6: 'OCEAN_ROUTE',
  7: 'UNKNOWN_TYPE_7',
  8: 'INDOOR',
  9: 'SECRET_BASE',
});

/** Gen-3 weather enum (Emerald has the most values; FRLG uses a subset). */
export const MAP_WEATHER_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'NONE',
  1: 'SUNNY_CLOUDS',
  2: 'SUNNY',
  3: 'RAIN',
  4: 'SNOW',
  5: 'RAIN_THUNDERSTORM',
  6: 'FOG_HORIZONTAL',
  7: 'VOLCANIC_ASH',
  8: 'SANDSTORM',
  9: 'FOG_DIAGONAL',
  10: 'UNDERWATER',
  11: 'SHADE',
  12: 'DROUGHT',
  13: 'DOWNPOUR',
  14: 'UNDERWATER_BUBBLES',
  15: 'ABNORMAL',
});

/** Gen-3 battleType enum (encounter-music + battle scene selector). */
export const MAP_BATTLE_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'NORMAL',
  1: 'GYM',
  2: 'LEADER',
  3: 'TRAINER',
  4: 'FIRST_BATTLE',
  5: 'LINK',
  6: 'OAK_TUTORIAL',
  7: 'CHAMPION',
  8: 'SAFARI',
  9: 'POKE_DUDE',
  10: 'OLD_MAN_TUTORIAL',
  11: 'KYOGRE',
  12: 'GROUDON',
  13: 'RAYQUAZA',
  14: 'WALLY_TUTORIAL',
});

/** Gen-3 `caveOrType` enum (also called `escapeRopeType`/`mapBatteryType`
 *  in some sources; controls brightness overlay & flash behavior). */
export const MAP_CAVE_OR_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'NONE',
  1: 'CAVE',
  2: 'INDOOR_LIGHTING',
  3: 'DARK_ROOM',
  4: 'FLASH_USABLE',
  5: 'UNUSED_5',
});

/** Bit positions within the mapHeader.flags byte (offset 0x1A).
 *  Position → name. Bit 0 is the least-significant bit. */
export const MAP_FLAGS_BITS: Readonly<Record<number, string>> = Object.freeze({
  0: 'ALLOW_CYCLING',
  1: 'ALLOW_ESCAPING',
  2: 'ALLOW_RUNNING',
  3: 'SHOW_MAP_NAME',
  // bits 4-7 are unused in vanilla Gen-3; hacks rarely use them
  // - fall through to UNKNOWN_BIT_N from nameFlagsBits().
});

/** Resolve a byte value via a name table, returning `UNKNOWN_<value>`
 *  if the table has no entry for it. */
export function nameFromTable(
  table: Readonly<Record<number, string>>,
  value: number,
): string {
  return table[value] ?? `UNKNOWN_${String(value)}`;
}

/** Decode a flags byte into the names of every SET bit. Returns an
 *  empty array when the byte is 0. Unknown bits (positions 4..7 by
 *  default in vanilla) come back as `UNKNOWN_BIT_<n>`. */
export function nameFlagsBits(flags: number): string[] {
  const names: string[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if ((flags & (1 << bit)) === 0) continue;
    names.push(MAP_FLAGS_BITS[bit] ?? `UNKNOWN_BIT_${String(bit)}`);
  }
  return names;
}

/**
 * Aggregate histograms across a list of (semantically-distinct) map
 * properties. Counts each named value (or named bit) once per map.
 * The flagsBits histogram is the count of MAPS that have that bit
 * set - NOT the count of total set bits.
 */
export interface MapPropertiesHistogram {
  readonly mapType: Readonly<Record<string, number>>;
  readonly weather: Readonly<Record<string, number>>;
  readonly caveOrType: Readonly<Record<string, number>>;
  readonly battleType: Readonly<Record<string, number>>;
  readonly flagsBits: Readonly<Record<string, number>>;
  /** Total number of maps aggregated (denominator for fraction queries). */
  readonly mapCount: number;
}

export interface MapPropertiesInput {
  readonly mapType: number;
  readonly weather: number;
  readonly caveOrType: number;
  readonly battleType: number;
  readonly flags: number;
}

export function aggregateMapProperties(
  maps: ReadonlyArray<MapPropertiesInput>,
): MapPropertiesHistogram {
  const mapType: Record<string, number> = {};
  const weather: Record<string, number> = {};
  const caveOrType: Record<string, number> = {};
  const battleType: Record<string, number> = {};
  const flagsBits: Record<string, number> = {};
  for (const m of maps) {
    bump(mapType, nameFromTable(MAP_TYPE_NAMES, m.mapType));
    bump(weather, nameFromTable(MAP_WEATHER_NAMES, m.weather));
    bump(caveOrType, nameFromTable(MAP_CAVE_OR_TYPE_NAMES, m.caveOrType));
    bump(battleType, nameFromTable(MAP_BATTLE_TYPE_NAMES, m.battleType));
    for (const bitName of nameFlagsBits(m.flags)) bump(flagsBits, bitName);
  }
  return Object.freeze({
    mapType: Object.freeze(mapType),
    weather: Object.freeze(weather),
    caveOrType: Object.freeze(caveOrType),
    battleType: Object.freeze(battleType),
    flagsBits: Object.freeze(flagsBits),
    mapCount: maps.length,
  });
}

function bump(table: Record<string, number>, key: string): void {
  table[key] = (table[key] ?? 0) + 1;
}
