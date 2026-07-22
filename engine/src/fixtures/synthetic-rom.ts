/**
 * Synthetic ROM fixtures - clearly labeled, never copyrighted.
 *
 * Built per the §13.3 route-around for B-0001: when the operator-supplied
 * corpus is missing a class, synthetic structural fixtures stand in for the
 * input to the universal detector pipeline. The DETECTORS are real; only
 * the input is synthetic - and every synthetic ROM carries `synthetic: true`
 * on its RomImage so reports, tests, and the coverage ledger can mark them
 * as such.
 *
 * Importantly: PD 12 forbids embedding copyrighted asset data. These
 * fixtures use ONLY publicly-spec'd bytes (Nintendo cartridge header layout)
 * plus zero-fill or arbitrary test patterns. No game data, no music, no
 * sprites, no scripts.
 */

import { HEADER_FIELD } from '../rom/header.js';
import { loadRomFromBytes, type RomImage } from '../rom/loader.js';

/**
 * Build a minimal-but-valid GBA cartridge header from caller-specified
 * metadata. Writes ONLY the header region (0x00..0xC0); everything else is
 * zero-fill. Useful for plumbing tests that need a structurally-valid header
 * but don't care about game-specific data.
 */
export function buildGbaHeaderBytes(args: {
  title: string;
  gameCode: string;
  makerCode: string;
  softwareVersion: number;
  /** When false, deliberately corrupts the 0x96 marker to test the
   *  not_detected path. */
  validFixedMarker?: boolean;
}): Buffer {
  if (args.title.length > HEADER_FIELD.titleLength) {
    throw new Error(`title too long (max ${String(HEADER_FIELD.titleLength)}): ${args.title}`);
  }
  if (args.gameCode.length !== HEADER_FIELD.gameCodeLength) {
    throw new Error(
      `gameCode must be exactly ${String(HEADER_FIELD.gameCodeLength)} chars: ${args.gameCode}`,
    );
  }
  if (args.makerCode.length !== HEADER_FIELD.makerCodeLength) {
    throw new Error(
      `makerCode must be exactly ${String(HEADER_FIELD.makerCodeLength)} chars: ${args.makerCode}`,
    );
  }

  const header = Buffer.alloc(0xc0);
  // 0x00..0x03: ARM7 entry point - opaque per-cart; leave as zero.
  // 0x04..0x9F: Nintendo logo bitmap - fixed bytes Nintendo uses to authorize
  //              the cart. We do NOT include the real logo bytes in this
  //              synthetic fixture (they're Nintendo IP); the cartridge's
  //              REAL CRC-based BIOS check would reject this fixture in
  //              hardware, but our universal detection contract doesn't
  //              require hardware-bootable ROMs.
  // Leave 0x04..0x9F as zero - structurally legal for our parser.

  // 0xA0..0xAB: title - ASCII, null-padded to 12 bytes.
  header.write(args.title, HEADER_FIELD.titleOffset, 'ascii');

  // 0xAC..0xAF: game code (4 ASCII bytes).
  header.write(args.gameCode, HEADER_FIELD.gameCodeOffset, 'ascii');

  // 0xB0..0xB1: maker code (2 ASCII bytes).
  header.write(args.makerCode, HEADER_FIELD.makerCodeOffset, 'ascii');

  // 0xB2: fixed marker - 0x96 unless caller asked to corrupt it.
  header[HEADER_FIELD.fixedMarkerOffset] = (args.validFixedMarker ?? true) ? 0x96 : 0x00;

  // 0xBC: software version.
  header[HEADER_FIELD.softwareVersionOffset] = args.softwareVersion;

  return header;
}

/**
 * Build a synthetic 16 MiB ROM with a valid GBA header. Used as the Phase 0
 * smoke-test stand-in when /corpus/ is empty (B-0001 route-around). Marked
 * `synthetic: true` so reports clearly distinguish it.
 *
 * Default title/code uses obviously-synthetic strings ("TESTFIXTURE", "ZZZZ")
 * so a grep of any report immediately reveals which results came from real
 * operator ROMs vs which came from this fixture.
 */
export function buildSyntheticRom(opts?: {
  title?: string;
  gameCode?: string;
  makerCode?: string;
  softwareVersion?: number;
  romSize?: number;
  validFixedMarker?: boolean;
  bodyFill?: number;
}): RomImage {
  const title = opts?.title ?? 'TESTFIXTURE';
  const gameCode = opts?.gameCode ?? 'ZZZZ';
  const makerCode = opts?.makerCode ?? 'ZZ';
  const softwareVersion = opts?.softwareVersion ?? 0;
  const romSize = opts?.romSize ?? 16 * 1024 * 1024;
  const bodyFill = opts?.bodyFill ?? 0;

  const buf = Buffer.alloc(romSize, bodyFill);
  const header = buildGbaHeaderBytes({
    title,
    gameCode,
    makerCode,
    softwareVersion,
    ...(opts?.validFixedMarker !== undefined ? { validFixedMarker: opts.validFixedMarker } : {}),
  });
  header.copy(buf, 0, 0, header.length);

  return loadRomFromBytes({
    bytes: buf,
    sourcePath: `synthetic://${gameCode}-${title}`,
    corpusClass: null,
    synthetic: true,
  });
}
