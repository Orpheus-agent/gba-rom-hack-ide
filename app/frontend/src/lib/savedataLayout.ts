/**
 * WP-B v2.2 - Per-family SaveBlock layout constants.
 *
 * Every offset in this file is sourced from pret's include/global.h
 * (the authoritative C struct definitions for the respective games):
 *   - FRLG: https://github.com/pret/pokefirered/blob/master/include/global.h
 *   - Emerald: https://github.com/pret/pokeemerald/blob/master/include/global.h
 *
 * SaveBlock pointers (the IWRAM u32 addresses where the live SaveBlock
 * EWRAM bases are stored at runtime) are sourced from PokéCommunity's
 * RAM-offset references + Data Crystal's RAM maps for the respective
 * games. These addresses are STABLE for vanilla ROMs (BPRE 1.0/1.1
 * share the same FRLG addresses); CFRU + pokeemerald-expansion forks
 * may shift them slightly and are out of scope for v2.
 *
 * Per-family complication: FRLG and Emerald put different fields in
 * different SaveBlocks. Example: FRLG's encryptionKey lives in
 * SaveBlock2[0xF20]; Emerald's lives in SaveBlock2[0x0AC]. The two
 * games' SaveBlock1 layouts differ even more - money is at SB1[0x290]
 * in FRLG, SB1[0x490] in Emerald. We model this with per-family
 * layout records.
 *
 * Live WRAM is plaintext in Gen 3 - only the on-flash save file is
 * XOR-encrypted with a per-section checksum. The exception: money
 * + coins in SB1 are XOR'd with the SB2 encryptionKey IN MEMORY too,
 * so writing money correctly requires reading the key first + XORing.
 */

export type SupportedFamily = 'firered-vanilla' | 'emerald-vanilla';

/** Which SaveBlock a particular field lives in. */
export type SaveBlock = 'sb1' | 'sb2';

/** IWRAM addresses of the u32 pointers that hold the live SaveBlock
 *  EWRAM addresses. Read these → dereference → get SaveBlock base. */
export interface SaveBlockPointers {
  readonly sb1: number;
  readonly sb2: number;
}

export const SAVEBLOCK_POINTERS: Readonly<Record<SupportedFamily, SaveBlockPointers>> = {
  // Source: Data Crystal Pokémon FireRed/LeafGreen RAM map,
  // PokéCommunity FireRed RAM offset thread. Same for BPRE 1.0 + 1.1.
  'firered-vanilla': { sb1: 0x03005008, sb2: 0x0300500c },
  // Source: BPEE linker script references on GitHub
  // (e.g. DizzyEggg/Pokemon-Emerald-Overworld-Form-Change/BPEE.ld).
  'emerald-vanilla': { sb1: 0x03005d8c, sb2: 0x03005d90 },
};

/** Layout of fields within the per-family SaveBlocks. Every offset is
 *  the byte offset within the named SaveBlock (NOT the GBA address - 
 *  the SaveBlock base is determined at runtime via dereferencing
 *  SAVEBLOCK_POINTERS). */
export interface SaveBlockFieldLayout {
  /** Where the player's character name lives (8 bytes, 7 chars + 0xFF
   *  terminator, Gen-3 char encoding). */
  readonly playerName: { readonly block: SaveBlock; readonly offset: number; readonly size: 8 };
  /** Player gender byte (0=male, 1=female). */
  readonly playerGender: { readonly block: SaveBlock; readonly offset: number; readonly size: 1 };
  /** Money u32. XOR-encrypted IN MEMORY with the SaveBlock2 encryptionKey.
   *  Read raw → XOR with key → get plaintext. Write inverse. */
  readonly money: { readonly block: SaveBlock; readonly offset: number; readonly size: 4 };
  /** Coins u16 (also XOR-encrypted with encryptionKey). */
  readonly coins: { readonly block: SaveBlock; readonly offset: number; readonly size: 2 };
  /** The XOR key for money + coins. Always in SaveBlock2. */
  readonly encryptionKey: { readonly block: 'sb2'; readonly offset: number; readonly size: 4 };
  /** Event-flag bit array. Flag N → byte N/8, bit N%8. */
  readonly flagsArray: { readonly block: SaveBlock; readonly offset: number; readonly size: number };
  /** Event-variable u16 array. Var (N + VARS_START) → 2 bytes at
   *  offset 2 * (N - VARS_START_OFFSET) within this region. The
   *  pret VAR_* constants are stored relative to 0x4000; this array
   *  starts at VAR_TEMP_0 = 0x4000 (decomp `VARS_START`). */
  readonly varsArray: { readonly block: SaveBlock; readonly offset: number; readonly size: number };
  /** Player party: 6 contiguous Pokemon slots. Each slot is 100 bytes
   *  per pret/include/pokemon.h struct Pokemon (80 box-Pokemon bytes +
   *  20 party-only fields like HP/status/level). */
  readonly playerParty: { readonly block: SaveBlock; readonly offset: number; readonly slotSize: 100; readonly slotCount: 6 };
}

/** Vanilla FRLG layout. Source: pret/pokefirered/include/global.h
 *  (commit master, verified 2026-05-26). */
export const SAVEBLOCK_LAYOUT_FRLG: SaveBlockFieldLayout = {
  playerName:   { block: 'sb2', offset: 0x0000, size: 8 },
  playerGender: { block: 'sb2', offset: 0x0008, size: 1 },
  money:        { block: 'sb1', offset: 0x0290, size: 4 },
  coins:        { block: 'sb1', offset: 0x0294, size: 2 },
  encryptionKey:{ block: 'sb2', offset: 0x0f20, size: 4 },
  flagsArray:   { block: 'sb1', offset: 0x0ee0, size: 288 }, // NUM_FLAG_BYTES = 288 → 2304 flags
  varsArray:    { block: 'sb1', offset: 0x1000, size: 512 }, // VARS_COUNT = 256 → 512 bytes
  playerParty:  { block: 'sb1', offset: 0x0038, slotSize: 100, slotCount: 6 },
};

/** Vanilla Emerald layout. Source: pret/pokeemerald/include/global.h
 *  (commit master, verified 2026-05-26). Differs significantly from
 *  FRLG - money/flags/vars/party all live at different SaveBlock1
 *  offsets, and encryptionKey is at SaveBlock2[0x0AC] (not [0xF20]). */
export const SAVEBLOCK_LAYOUT_EMERALD: SaveBlockFieldLayout = {
  playerName:   { block: 'sb2', offset: 0x0000, size: 8 },
  playerGender: { block: 'sb2', offset: 0x0008, size: 1 },
  money:        { block: 'sb1', offset: 0x0490, size: 4 },
  coins:        { block: 'sb1', offset: 0x0494, size: 2 },
  encryptionKey:{ block: 'sb2', offset: 0x00ac, size: 4 },
  flagsArray:   { block: 'sb1', offset: 0x1270, size: 300 }, // NUM_FLAG_BYTES = 300
  varsArray:    { block: 'sb1', offset: 0x139c, size: 512 }, // VARS_COUNT = 256
  playerParty:  { block: 'sb1', offset: 0x0238, slotSize: 100, slotCount: 6 },
};

/** Dispatch to the layout record for the given family. */
export function getSaveBlockLayout(family: SupportedFamily): SaveBlockFieldLayout {
  switch (family) {
    case 'firered-vanilla':
      return SAVEBLOCK_LAYOUT_FRLG;
    case 'emerald-vanilla':
      return SAVEBLOCK_LAYOUT_EMERALD;
  }
}

/** ────────────────────────────────────────────────────────────────
 *  Gen-3 flag-ID dictionary excerpts.
 *
 *  Flag IDs live in two ranges (per pret include/constants/flags.h):
 *    - SPECIAL_FLAGS_START (0x4000) - temp/special; persist only
 *      until next reset.
 *    - TEMP_FLAGS_START (0x4020) - temp story-arc bits.
 *    - "Trainer flags" 0x500-0x82F - set after defeating each trainer.
 *    - "Hidden item flags" 0x830-0x8FF - set after finding each
 *      hidden item.
 *    - "System flags" 0x860-0x95F - gym badges, key items, story
 *      gates. The 8 gym badges live at 0x820..0x827 in FRLG and
 *      0x867..0x86E in Emerald.
 *
 *  We don't enumerate every flag here - the project's per-family
 *  symbol DB (lib/symbols/data/<family>.json) already has the
 *  full FLAG_* → numeric-id map sourced from pret's flags.h.
 *  These constants below are just the 8 badge IDs since they're
 *  used by the dedicated "Set badges" debug action.
 *  ──────────────────────────────────────────────────────────────── */
export const BADGE_FLAG_IDS: Readonly<Record<SupportedFamily, ReadonlyArray<number>>> = {
  // FRLG: FLAG_BADGE01_GET..FLAG_BADGE08_GET = 0x820..0x827
  // Source: pret/pokefirered/include/constants/flags.h
  'firered-vanilla': [0x820, 0x821, 0x822, 0x823, 0x824, 0x825, 0x826, 0x827],
  // Emerald: FLAG_BADGE01_GET..FLAG_BADGE08_GET = 0x867..0x86E
  // Source: pret/pokeemerald/include/constants/flags.h
  'emerald-vanilla': [0x867, 0x868, 0x869, 0x86a, 0x86b, 0x86c, 0x86d, 0x86e],
};

/** Vars are addressed relative to VARS_START. The decomp uses
 *  VARS_START = 0x4000 universally - both FRLG and Emerald.
 *  So `varsArray[2 * (varId - 0x4000)]` is the byte offset within
 *  the vars region for the requested variable. */
export const VARS_START_BASE = 0x4000;

/** Total count of variables in the vars array per family. Used to
 *  bounds-check varId before writing. */
export const VARS_COUNT_BY_FAMILY: Readonly<Record<SupportedFamily, number>> = {
  'firered-vanilla': 256, // VARS_COUNT in pret/pokefirered
  'emerald-vanilla': 256, // VARS_COUNT in pret/pokeemerald
};

/** Flags are addressed by raw flag id (no offset like vars). */
export const FLAGS_COUNT_BY_FAMILY: Readonly<Record<SupportedFamily, number>> = {
  'firered-vanilla': 288 * 8, // 2304 flags
  'emerald-vanilla': 300 * 8, // 2400 flags
};
