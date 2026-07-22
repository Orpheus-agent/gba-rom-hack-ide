/**
 * Pure GBA cartridge-header parser.
 *
 * The 192-byte cartridge header at the start of every GBA ROM is defined by
 * Nintendo's GBA hardware spec (NOT by any Pokémon game). Layout:
 *
 *   0x00..0x03 (4)   ARM7 entry point
 *   0x04..0x9F (156) Nintendo logo bitmap (compressed; fixed bytes)
 *   0xA0..0xAB (12)  Game title (ASCII, often space/null-padded)
 *   0xAC..0xAF (4)   Game code (e.g. "BPRE" for Pokémon FireRed, but ANY GBA
 *                    cart has one)
 *   0xB0..0xB1 (2)   Maker code (e.g. "01" for Nintendo)
 *   0xB2       (1)   Fixed value 0x96 - Nintendo's header sanity check
 *   0xB3..0xB9 (7)   Reserved (all 0x00 in vanilla carts)
 *   0xBA       (1)   Software version (within the variant - usually 0)
 *   0xBB       (1)   Header complement (checksum-ish)
 *   0xBC       (1)   Software version (game version - e.g. v1.0 vs v1.1)
 *   0xBD       (1)   Header complement
 *   0xBE..0xBF (2)   Reserved
 *
 * This module is universal: it parses any GBA cart. The Pokémon-specific
 * "knownGame" lookup is a courtesy enrichment, NEVER a detection prerequisite
 * (PD 5: no FireRed/Emerald assumption as the sole path).
 *
 * The richer `parseGbaHeader()` returns either a fully-valid header (with the
 * 0x96 marker present and the game code in printable ASCII) or a structured
 * failure with the SPECIFIC byte-level reason - so the header-fingerprint
 * detector can return Detection.partial or Detection.not_detected with real
 * evidence rather than a bare null.
 */

/** Hardware-defined offsets (every GBA cartridge - Pokémon or not). */
export const GBA_HEADER_LENGTH = 0xc0;
export const HEADER_FIELD = Object.freeze({
  entryPointOffset: 0x00,
  entryPointLength: 4,
  nintendoLogoOffset: 0x04,
  nintendoLogoLength: 156,
  titleOffset: 0xa0,
  titleLength: 12,
  gameCodeOffset: 0xac,
  gameCodeLength: 4,
  makerCodeOffset: 0xb0,
  makerCodeLength: 2,
  fixedMarkerOffset: 0xb2,
  fixedMarkerValue: 0x96,
  softwareVersionOffset: 0xbc,
});

/**
 * Curated friendly-name lookup for game codes the engine has seen in the wild
 * across Pokémon Gen-3. **This is enrichment, not detection.** A cart whose
 * game code isn't in this table is still a fully valid GBA cart - `knownGame`
 * just becomes `null`. New entries are additive and ship in the signature DB
 * (D-0007) once that lands; the in-source table is a Phase-0 seed only.
 *
 * Hack ROMs typically keep the original game code (Pokémon Unbound → "BPRE",
 * Radical Red → "BPRE", etc.) because changing it breaks emulator save-file
 * compatibility, so a heavy hack still reports `knownGame: 'Pokémon FireRed'`
 * - that's the correct, honest read of the cart bytes.
 */
const KNOWN_GAMES: Readonly<Record<string, string>> = {
  BPRE: 'Pokémon FireRed',
  BPGE: 'Pokémon LeafGreen',
  BPEE: 'Pokémon Emerald',
  AXVE: 'Pokémon Ruby',
  AXPE: 'Pokémon Sapphire',
};

export interface GbaHeader {
  readonly internalTitle: string;
  readonly gameCode: string;
  readonly makerCode: string;
  readonly softwareVersion: number;
  /** Friendly label when `gameCode` matches a known Pokémon game code; null
   * otherwise. NEVER load-bearing for detection. */
  readonly knownGame: string | null;
  /** Always `true` for `GbaHeader` - the 0x96 marker validates. */
  readonly fixedMarkerValid: true;
}

/**
 * Specific failure modes the parser can encounter. Each carries enough detail
 * for a Detection result to surface concrete evidence + a precise reason.
 */
export type GbaHeaderParseFailure =
  | { readonly kind: 'too_short'; readonly bytesAvailable: number; readonly bytesRequired: number }
  | { readonly kind: 'fixed_marker_invalid'; readonly observedByte: number; readonly expectedByte: 0x96 }
  | { readonly kind: 'game_code_unreadable'; readonly bytesAtOffset: ReadonlyArray<number> };

export type GbaHeaderParseResult =
  | { readonly ok: true; readonly header: GbaHeader }
  | { readonly ok: false; readonly failure: GbaHeaderParseFailure };

/**
 * Strict parser - returns a structured success/failure. Use this from
 * detectors so they can surface a `not_detected` with a real `reason`.
 */
export function parseGbaHeader(bytes: Uint8Array): GbaHeaderParseResult {
  if (bytes.length < GBA_HEADER_LENGTH) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: bytes.length,
        bytesRequired: GBA_HEADER_LENGTH,
      },
    };
  }

  const markerByte = bytes[HEADER_FIELD.fixedMarkerOffset];
  if (markerByte !== HEADER_FIELD.fixedMarkerValue) {
    return {
      ok: false,
      failure: {
        kind: 'fixed_marker_invalid',
        observedByte: markerByte ?? -1,
        expectedByte: HEADER_FIELD.fixedMarkerValue,
      },
    };
  }

  const internalTitle = readAscii(bytes, HEADER_FIELD.titleOffset, HEADER_FIELD.titleLength);
  const gameCode = readAscii(bytes, HEADER_FIELD.gameCodeOffset, HEADER_FIELD.gameCodeLength);
  const makerCode = readAscii(bytes, HEADER_FIELD.makerCodeOffset, HEADER_FIELD.makerCodeLength);
  const softwareVersion = bytes[HEADER_FIELD.softwareVersionOffset] ?? 0;

  if (gameCode.length !== HEADER_FIELD.gameCodeLength) {
    const slice = bytes.subarray(
      HEADER_FIELD.gameCodeOffset,
      HEADER_FIELD.gameCodeOffset + HEADER_FIELD.gameCodeLength,
    );
    return {
      ok: false,
      failure: {
        kind: 'game_code_unreadable',
        bytesAtOffset: Array.from(slice),
      },
    };
  }

  return {
    ok: true,
    header: Object.freeze({
      internalTitle,
      gameCode,
      makerCode,
      softwareVersion,
      knownGame: KNOWN_GAMES[gameCode] ?? null,
      fixedMarkerValid: true,
    }),
  };
}

/**
 * Convenience: read the header or return null. Mirrors the editor's existing
 * `readGbaHeader()` shape so the editor can adopt this module incrementally
 * without changing callers. Prefer `parseGbaHeader` in new code.
 */
export function readGbaHeader(bytes: Uint8Array): GbaHeader | null {
  const r = parseGbaHeader(bytes);
  return r.ok ? r.header : null;
}

/** Human-readable one-line description of a header. */
export function describeGbaHeader(h: GbaHeader): string {
  const known = h.knownGame !== null ? `${h.knownGame} - ` : '';
  const title = h.internalTitle.length > 0 ? h.internalTitle : '(no title)';
  return `${known}${h.gameCode} (${title}) v${String(h.softwareVersion)}`;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  let end = slice.length;
  // Strip trailing NUL + ASCII space padding (pokeemerald-class ROMs use both).
  while (end > 0) {
    const c = slice[end - 1] ?? 0;
    if (c === 0x00 || c === 0x20) end--;
    else break;
  }
  // Reject buffers with any non-printable bytes in the meaningful prefix.
  for (let i = 0; i < end; i++) {
    const c = slice[i] ?? 0;
    if (c < 0x20 || c > 0x7e) return '';
  }
  let s = '';
  for (let i = 0; i < end; i++) {
    s += String.fromCharCode(slice[i] ?? 0);
  }
  return s;
}
