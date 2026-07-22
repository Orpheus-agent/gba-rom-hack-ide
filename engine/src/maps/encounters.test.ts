import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  WILD_ENCOUNTERS_SENTINEL_MAP_GROUP,
  WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES,
  parseWildPokemonHeader,
} from './encounters.js';

interface PlantHeaderArgs {
  bufferSize?: number;
  offset?: number;
  mapGroup?: number;
  mapNum?: number;
  padding?: number;
  /** File offsets (relative to ROM start) for each encounter-kind pointer.
   *  Use `null` to leave a NULL pointer (encoded as raw 0). */
  landMonsAt?: number | null;
  waterMonsAt?: number | null;
  rockSmashMonsAt?: number | null;
  fishingMonsAt?: number | null;
  /** When set, overrides the encoded land pointer with this raw 32-bit value. */
  rawLandPointer?: number;
}

function plantHeader(args: PlantHeaderArgs): { buf: Buffer; offset: number } {
  const offset = args.offset ?? 0x100;
  const buf = Buffer.alloc(args.bufferSize ?? 0x4000);
  buf[offset + 0x00] = args.mapGroup ?? 1;
  buf[offset + 0x01] = args.mapNum ?? 2;
  buf.writeUInt16LE(args.padding ?? 0, offset + 0x02);

  const encodePtr = (at: number | null | undefined): number => {
    if (at === null || at === undefined) return 0;
    return (GBA_ROM_BASE_ADDRESS + at) >>> 0;
  };
  // Default for landMons is 0x800 only when `landMonsAt` is `undefined` - 
  // an explicit `null` means "encode NULL pointer (raw 0)".
  const landMonsAt: number | null =
    args.landMonsAt === undefined ? 0x800 : args.landMonsAt;
  buf.writeUInt32LE(
    args.rawLandPointer !== undefined ? args.rawLandPointer : encodePtr(landMonsAt),
    offset + 0x04,
  );
  buf.writeUInt32LE(encodePtr(args.waterMonsAt), offset + 0x08);
  buf.writeUInt32LE(encodePtr(args.rockSmashMonsAt), offset + 0x0c);
  buf.writeUInt32LE(encodePtr(args.fishingMonsAt), offset + 0x10);
  return { buf, offset };
}

describe('parseWildPokemonHeader - happy paths', () => {
  it('parses a header with only land mons set', () => {
    const { buf, offset } = plantHeader({ mapGroup: 0, mapNum: 5, landMonsAt: 0x800 });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.mapGroup).toBe(0);
      expect(r.header.mapNum).toBe(5);
      expect(r.header.landMonsOffset).toBe(0x800);
      expect(r.header.waterMonsOffset).toBeNull();
      expect(r.header.rockSmashMonsOffset).toBeNull();
      expect(r.header.fishingMonsOffset).toBeNull();
      expect(r.header.fileOffset).toBe(offset);
    }
  });

  it('parses a header with all four encounter kinds set', () => {
    const { buf, offset } = plantHeader({
      landMonsAt: 0x800,
      waterMonsAt: 0x900,
      rockSmashMonsAt: 0xa00,
      fishingMonsAt: 0xb00,
    });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.landMonsOffset).toBe(0x800);
      expect(r.header.waterMonsOffset).toBe(0x900);
      expect(r.header.rockSmashMonsOffset).toBe(0xa00);
      expect(r.header.fishingMonsOffset).toBe(0xb00);
    }
  });

  it('returned header is frozen', () => {
    const { buf, offset } = plantHeader({ landMonsAt: 0x800 });
    const r = parseWildPokemonHeader(buf, offset);
    if (r.ok) expect(Object.isFrozen(r.header)).toBe(true);
  });
});

describe('parseWildPokemonHeader - sentinel & failure modes', () => {
  it('returns sentinel failure when mapGroup === 0xFF', () => {
    const { buf, offset } = plantHeader({
      mapGroup: WILD_ENCOUNTERS_SENTINEL_MAP_GROUP,
      landMonsAt: 0x800,
    });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('sentinel');
  });

  it('fails too_short when offset + 20 exceeds buffer length', () => {
    const buf = new Uint8Array(10);
    const r = parseWildPokemonHeader(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_map_indices when mapGroup > 200', () => {
    const { buf, offset } = plantHeader({ mapGroup: 250, landMonsAt: 0x800 });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_map_indices');
  });

  it('fails nonzero_padding when offset 0x02 is not 0', () => {
    const { buf, offset } = plantHeader({ padding: 0x1234, landMonsAt: 0x800 });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails all_pointers_null when every encounter pointer is 0', () => {
    const { buf, offset } = plantHeader({
      landMonsAt: null,
      waterMonsAt: null,
      rockSmashMonsAt: null,
      fishingMonsAt: null,
    });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('all_pointers_null');
  });

  it('fails invalid_pointer when high byte is not 0x08/0x09', () => {
    const { buf, offset } = plantHeader({
      rawLandPointer: 0x02001234, // EWRAM, not ROM
    });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_pointer');
  });

  it('fails invalid_pointer when ROM pointer falls past EOF', () => {
    const { buf, offset } = plantHeader({
      bufferSize: 0x1000,
      rawLandPointer: (GBA_ROM_BASE_ADDRESS + 0x10_000) >>> 0,
    });
    const r = parseWildPokemonHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_pointer');
  });
});

describe('WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES', () => {
  it('equals 20', () => {
    expect(WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES).toBe(20);
  });
});
