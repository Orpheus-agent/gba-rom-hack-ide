/**
 * Gen-3 save-data format layout - Phase UW-2 / Category 10 substrate
 * (iter 76 / UW-2-T10).
 *
 * Pokémon Gen-3 ROMs persist player state to a 64KB flash chip (FRLG /
 * Emerald) or 8KB SRAM (early carts) via a 14-sector × 4KB ring-buffer
 * layout per pret/pokefirered + pret/pokeemerald `src/save.c`:
 *
 *   struct SaveSector {
 *     u8 data[SECTOR_DATA_SIZE];   // 0xFF8 bytes
 *     // Footer:
 *     u16 id;                      // sector ID within the save file
 *     u16 checksum;
 *     u32 signature;               // SECTOR_FOOTER_MAGIC = 0x08012025
 *     u32 counter;                 // increments per save
 *   };  // 4096 bytes total
 *
 * The sector signature `0x08012025` is a constant magic value compared
 * by the save-validation routine against the in-RAM section header.
 * Because it's a literal constant, the LE byte sequence `0x25 0x20
 * 0x01 0x08` appears verbatim in the ROM's `.rodata` (or `.text`
 * embedded constant pool) for every Gen-3 Pokémon ROM that retains
 * pret's save infrastructure. Detecting this byte sequence is a
 * strong universal signal that the ROM uses the Gen-3 save format.
 *
 * Distinct from `engine/src/detectors/save-system.ts` (iter 67) which
 * identifies the SDK backend family (FLASH/SRAM/EEPROM via the
 * Nintendo SDK identifier strings). This module identifies the SAVE
 * FORMAT - the 14-sector × 4KB layout that sits on top of whichever
 * backend the SDK identifier names.
 *
 * Per PD 5: structural - the magic value is the same across every
 * Gen-3 Pokémon ROM and every known fork (CFRU + Unbound + Radical
 * Red all retain pret's save infrastructure since they're FRLG-derived).
 *
 * PD 12: not_detected returns a typed reason when the magic isn't
 * found.
 */

/** Size in bytes of one save sector (data + footer). Vanilla Gen-3. */
export const SAVE_SECTOR_SIZE_BYTES = 0x1000; // 4096 = 4 KiB

/** Size in bytes of the data portion of one sector. */
export const SAVE_SECTOR_DATA_SIZE_BYTES = 0xff8; // 4088

/** Size in bytes of the per-sector footer. */
export const SAVE_SECTOR_FOOTER_SIZE_BYTES = 0x10; // 16

/** Number of sectors in one save file (vanilla Gen-3). */
export const SAVE_SECTOR_COUNT = 14;

/** Total bytes occupied by one save file. */
export const SAVE_DATA_TOTAL_SIZE_BYTES = SAVE_SECTOR_COUNT * SAVE_SECTOR_SIZE_BYTES;

/** The sector-footer magic value used by pret's save-validation code. */
export const SAVE_SECTOR_FOOTER_MAGIC = 0x08012025;

/** Cartridge-header skip (well-known not to contain the magic). */
const CARTRIDGE_HEADER_END = 0xc0;

/**
 * Find the first occurrence of the SECTOR_FOOTER_MAGIC byte sequence in
 * `romBytes`, starting past the cartridge header. Returns the absolute
 * byte offset or `null` if the magic isn't found.
 *
 * The magic is `0x08012025` stored little-endian, so the byte sequence
 * to find is `0x25 0x20 0x01 0x08`.
 */
export function findSaveSectorFooterMagic(romBytes: Uint8Array): number | null {
  const target = Uint8Array.of(0x25, 0x20, 0x01, 0x08);
  const search = Buffer.isBuffer(romBytes) ? romBytes : Buffer.from(romBytes);
  const found = search.indexOf(Buffer.from(target), CARTRIDGE_HEADER_END);
  return found < 0 ? null : found;
}

/**
 * Find ALL occurrences of the SECTOR_FOOTER_MAGIC byte sequence in
 * `romBytes`. Used for PD 12 completeness - the magic typically
 * appears 1-3 times in a vanilla ROM (once in the validation code,
 * possibly in a constant pool, possibly inline in initialized .data).
 *
 * Returns an array of absolute offsets, in ascending order. Empty
 * array if not found.
 */
export function findAllSaveSectorFooterMagic(
  romBytes: Uint8Array,
): ReadonlyArray<number> {
  const target = Uint8Array.of(0x25, 0x20, 0x01, 0x08);
  const search = Buffer.isBuffer(romBytes) ? romBytes : Buffer.from(romBytes);
  const offsets: number[] = [];
  let from = CARTRIDGE_HEADER_END;
  while (from < romBytes.length) {
    const found = search.indexOf(Buffer.from(target), from);
    if (found < 0) break;
    offsets.push(found);
    from = found + 1;
  }
  return offsets;
}
