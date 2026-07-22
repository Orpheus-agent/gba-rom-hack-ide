/**
 * Nintendo DS cartridge header parser (read-only, pure).
 *
 * Layout reference: GBATEK - https://problemkaputt.de/gbatek.htm#dscartridgeheader
 * We parse only the fields needed to walk the filesystem (NitroFS) and locate
 * the ARM binaries / overlays. No I/O, no Pokémon-specific assumptions.
 */

function u16(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)) & 0xffff;
}
function u32(b: Uint8Array, o: number): number {
  return (
    ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0
  );
}
function ascii(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = b[o + i] ?? 0;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export interface NdsHeader {
  /** 12-byte internal game title, e.g. "POKEMON B". */
  readonly gameTitle: string;
  /** 4-byte game code, e.g. "IRBO" (Pokémon Black, USA). */
  readonly gameCode: string;
  /** 2-byte maker code, e.g. "01" (Nintendo). */
  readonly makerCode: string;
  readonly arm9RomOffset: number;
  readonly arm9Size: number;
  readonly arm7RomOffset: number;
  readonly arm7Size: number;
  /** File Name Table (directory tree) location. */
  readonly fntOffset: number;
  readonly fntSize: number;
  /** File Allocation Table (start/end of every file) location. */
  readonly fatOffset: number;
  readonly fatSize: number;
  /** ARM9/ARM7 overlay tables (each entry maps an overlay to a FAT file id). */
  readonly arm9OverlayOffset: number;
  readonly arm9OverlaySize: number;
  readonly arm7OverlayOffset: number;
  readonly arm7OverlaySize: number;
  /** Number of files the FAT describes (fatSize / 8). */
  readonly fileCount: number;
  readonly totalUsedRomSize: number;
  readonly headerSize: number;
}

export type NdsHeaderResult =
  | { ok: true; header: NdsHeader }
  | { ok: false; reason: string };

/** Parse the 0x200-byte cartridge header from the start of a DS ROM image. */
export function parseNdsHeader(rom: Uint8Array): NdsHeaderResult {
  if (rom.length < 0x200) {
    return { ok: false, reason: `ROM too small for a DS header (${String(rom.length)} bytes)` };
  }
  const fatOffset = u32(rom, 0x48);
  const fatSize = u32(rom, 0x4c);
  const fntOffset = u32(rom, 0x40);
  const fntSize = u32(rom, 0x44);
  if (fatOffset === 0 || fatSize === 0 || fatSize % 8 !== 0) {
    return { ok: false, reason: `Implausible FAT (offset=${String(fatOffset)}, size=${String(fatSize)})` };
  }
  return {
    ok: true,
    header: {
      gameTitle: ascii(rom, 0x00, 12),
      gameCode: ascii(rom, 0x0c, 4),
      makerCode: ascii(rom, 0x10, 2),
      arm9RomOffset: u32(rom, 0x20),
      arm9Size: u32(rom, 0x2c),
      arm7RomOffset: u32(rom, 0x30),
      arm7Size: u32(rom, 0x3c),
      fntOffset,
      fntSize,
      fatOffset,
      fatSize,
      arm9OverlayOffset: u32(rom, 0x50),
      arm9OverlaySize: u32(rom, 0x54),
      arm7OverlayOffset: u32(rom, 0x58),
      arm7OverlaySize: u32(rom, 0x5c),
      fileCount: fatSize >>> 3,
      totalUsedRomSize: u32(rom, 0x80),
      headerSize: u16(rom, 0x84),
    },
  };
}
