/**
 * Canonical GBA cartridge-header reference for the Gen-3 Pokémon family.
 *
 * Records the Nintendo-published TITLE / SIZE / VERSION for each vanilla
 * cart so the engine can detect divergence - a ROM that claims `BPRE` in
 * its game-code field but reports a 32 MiB body has been expanded past
 * the vanilla 16 MiB; one that uses title "POKEMON UNBOND" instead of
 * "POKEMON FIRE" is a hack, etc.
 *
 * This is FACTUAL hardware-spec data (the game codes, the published title
 * strings) - PD 12 boundary respected (no copyrighted bytes, no
 * decompiled source, no asset payload). The information is identical in
 * shape to the existing rom/header.ts KNOWN_GAMES map, just richer.
 *
 * Adding a new game code is a one-line edit and triggers no schema or
 * detector changes (pillar 5: universal & future-proof). For hacks that
 * keep their parent's game code (the common case: Unbound keeps BPRE,
 * Radical Red keeps BPRE), the canonical lookup correctly returns the
 * FireRed reference - the fork-heuristic detector's divergence checks
 * then surface the hack via title / size / version anomaly.
 */

export interface CanonicalGen3Header {
  /** Game code (e.g. "BPRE"). */
  readonly gameCode: string;
  /** Nintendo's published friendly name. */
  readonly displayName: string;
  /** The exact internal-title string Nintendo writes at 0xA0..0xAB. */
  readonly internalTitle: string;
  /** Maker code (always "01" for first-party Nintendo Pokémon carts). */
  readonly makerCode: string;
  /** Canonical cartridge sizes seen in vanilla releases - usually exactly
   *  one entry; carts with multiple revisions can list both. */
  readonly canonicalSizesBytes: ReadonlyArray<number>;
  /** Canonical software versions seen across vanilla revisions. v1.0 = 0,
   *  v1.1 = 1, etc. */
  readonly canonicalSoftwareVersions: ReadonlyArray<number>;
}

/**
 * The 5 public Gen-3 Pokémon GBA carts. Game codes + titles are stable
 * across regional variants; sizes are 16 MiB for the Ruby/Sapphire/
 * FireRed/LeafGreen carts and 16 MiB for Emerald too.
 */
export const CANONICAL_GEN3_HEADERS: ReadonlyArray<CanonicalGen3Header> = Object.freeze([
  {
    gameCode: 'BPRE',
    displayName: 'Pokémon FireRed',
    internalTitle: 'POKEMON FIRE',
    makerCode: '01',
    canonicalSizesBytes: [16 * 1024 * 1024],
    canonicalSoftwareVersions: [0, 1],
  },
  {
    gameCode: 'BPGE',
    displayName: 'Pokémon LeafGreen',
    internalTitle: 'POKEMON LEAF',
    makerCode: '01',
    canonicalSizesBytes: [16 * 1024 * 1024],
    canonicalSoftwareVersions: [0, 1],
  },
  {
    gameCode: 'BPEE',
    displayName: 'Pokémon Emerald',
    internalTitle: 'POKEMON EMER',
    makerCode: '01',
    canonicalSizesBytes: [16 * 1024 * 1024],
    canonicalSoftwareVersions: [0],
  },
  {
    gameCode: 'AXVE',
    displayName: 'Pokémon Ruby',
    internalTitle: 'POKEMON RUBY',
    makerCode: '01',
    canonicalSizesBytes: [16 * 1024 * 1024],
    canonicalSoftwareVersions: [0, 1, 2],
  },
  {
    gameCode: 'AXPE',
    displayName: 'Pokémon Sapphire',
    internalTitle: 'POKEMON SAPP',
    makerCode: '01',
    canonicalSizesBytes: [16 * 1024 * 1024],
    canonicalSoftwareVersions: [0, 1, 2],
  },
]);

const BY_GAME_CODE = new Map<string, CanonicalGen3Header>();
for (const c of CANONICAL_GEN3_HEADERS) BY_GAME_CODE.set(c.gameCode, c);

/** Lookup canonical metadata by game code; null when the code is not in
 *  the seed table (e.g. a non-Pokémon GBA cart, or a fork that has
 *  rewritten its game code). */
export function canonicalForGameCode(gameCode: string): CanonicalGen3Header | null {
  return BY_GAME_CODE.get(gameCode) ?? null;
}
