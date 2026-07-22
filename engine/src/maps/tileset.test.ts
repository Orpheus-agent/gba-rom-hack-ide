import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { TILESET_STRUCT_SIZE_BYTES, parseTileset } from './tileset.js';

interface PlantTilesetArgs {
  bufferSize?: number;
  offset?: number;
  isCompressed?: 0 | 1 | number; // allow invalid for test
  isSecondary?: 0 | 1 | number;
  padding1?: number;
  padding2?: number;
  /** File offsets each slot points at. null = NULL pointer. */
  tilesAt?: number | null;
  palettesAt?: number | null;
  metatilesAt?: number | null;
  slot10At?: number | null;
  slot14At?: number | null;
  /** When set, overrides the encoded tiles pointer with raw 32-bit. */
  rawTilesPointer?: number;
}

function plant(args: PlantTilesetArgs): { buf: Buffer; offset: number } {
  const offset = args.offset ?? 0x100;
  const buf = Buffer.alloc(args.bufferSize ?? 0x4000);
  buf[offset + 0x00] = args.isCompressed ?? 0;
  buf[offset + 0x01] = args.isSecondary ?? 0;
  buf[offset + 0x02] = args.padding1 ?? 0;
  buf[offset + 0x03] = args.padding2 ?? 0;
  const enc = (at: number | null | undefined): number => {
    if (at === null || at === undefined) return 0;
    return (GBA_ROM_BASE_ADDRESS + at) >>> 0;
  };
  // Defaults applied only when the field is undefined; null means
  // NULL ptr explicitly (encoded as raw 0).
  const tilesAt = args.tilesAt === undefined ? 0x800 : args.tilesAt;
  const palettesAt = args.palettesAt === undefined ? 0x900 : args.palettesAt;
  buf.writeUInt32LE(
    args.rawTilesPointer !== undefined ? args.rawTilesPointer : enc(tilesAt),
    offset + 0x04,
  );
  buf.writeUInt32LE(enc(palettesAt), offset + 0x08);
  buf.writeUInt32LE(enc(args.metatilesAt), offset + 0x0c);
  buf.writeUInt32LE(enc(args.slot10At), offset + 0x10);
  buf.writeUInt32LE(enc(args.slot14At), offset + 0x14);
  return { buf, offset };
}

describe('parseTileset - happy paths', () => {
  it('parses a primary uncompressed tileset with tiles + palettes', () => {
    const { buf, offset } = plant({ tilesAt: 0x800, palettesAt: 0x900 });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tileset.isCompressed).toBe(false);
      expect(r.tileset.isSecondary).toBe(false);
      expect(r.tileset.tilesOffset).toBe(0x800);
      expect(r.tileset.palettesOffset).toBe(0x900);
      expect(r.tileset.metatilesOffset).toBeNull();
      expect(r.tileset.slot10Offset).toBeNull();
      expect(r.tileset.slot14Offset).toBeNull();
      expect(r.tileset.fileOffset).toBe(offset);
    }
  });

  it('parses a compressed secondary tileset with all 5 pointers', () => {
    const { buf, offset } = plant({
      isCompressed: 1,
      isSecondary: 1,
      tilesAt: 0x800,
      palettesAt: 0x900,
      metatilesAt: 0xa00,
      slot10At: 0xb00,
      slot14At: 0xc00,
    });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tileset.isCompressed).toBe(true);
      expect(r.tileset.isSecondary).toBe(true);
      expect(r.tileset.metatilesOffset).toBe(0xa00);
      expect(r.tileset.slot10Offset).toBe(0xb00);
      expect(r.tileset.slot14Offset).toBe(0xc00);
    }
  });

  it('returned tileset is frozen', () => {
    const { buf, offset } = plant({});
    const r = parseTileset(buf, offset);
    if (r.ok) expect(Object.isFrozen(r.tileset)).toBe(true);
  });
});

describe('parseTileset - failure modes', () => {
  it('fails too_short when offset + 24 exceeds buffer', () => {
    const r = parseTileset(new Uint8Array(20), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_is_compressed when byte ∉ {0,1}', () => {
    const { buf, offset } = plant({ isCompressed: 2 });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_is_compressed');
  });

  it('fails implausible_is_secondary when byte ∉ {0,1}', () => {
    const { buf, offset } = plant({ isSecondary: 3 });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_is_secondary');
  });

  it('fails nonzero_padding when either padding byte is set', () => {
    const { buf, offset } = plant({ padding1: 0xff });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails invalid_pointer when a pointer is non-ROM (EWRAM)', () => {
    const { buf, offset } = plant({ rawTilesPointer: 0x02001234 });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_pointer');
      if (r.failure.kind === 'invalid_pointer') {
        expect(r.failure.slot).toBe('tiles');
      }
    }
  });

  it('fails all_data_pointers_null when both tiles + palettes are NULL', () => {
    const { buf, offset } = plant({ tilesAt: null, palettesAt: null });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('all_data_pointers_null');
  });

  it('allows tiles=NULL when palettes is set', () => {
    const { buf, offset } = plant({ tilesAt: null, palettesAt: 0x900 });
    const r = parseTileset(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tileset.tilesOffset).toBeNull();
      expect(r.tileset.palettesOffset).toBe(0x900);
    }
  });
});

describe('TILESET_STRUCT_SIZE_BYTES', () => {
  it('equals 24', () => {
    expect(TILESET_STRUCT_SIZE_BYTES).toBe(24);
  });
});
