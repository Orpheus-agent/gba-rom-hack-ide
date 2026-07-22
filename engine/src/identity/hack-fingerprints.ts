/**
 * Per-ROM hack identity fingerprints - RT-1.3.
 *
 * Vanilla GBA Pokémon games (FRLG / Emerald / Ruby / Sapphire) have
 * distinct cartridge headers (`internalTitle` + `gameCode`) and the
 * existing `rom.readGbaHeader` decoder produces a `knownGame` name
 * directly from those bytes - "Pokémon FireRed", etc.
 *
 * Hacks, however, almost always keep the vanilla header. The 3 corpus
 * ROMs (FireRed (USA), Pokémon Unbound v2.1.1.1, Radical Red 4.10) all
 * have the SAME header (POKEMON FIRE / BPRE / 01 / v0), so a header
 * read alone returns "Pokémon FireRed" for every one of them. The
 * editor previously fell back to "Bare ROM workspace" for any ROM it
 * couldn't pin to a known patch project.
 *
 * The only universal discriminator is the file's SHA-1 hash. This
 * module maps known hack SHA-1s to a structured fingerprint:
 *   - `displayName` - the name the editor / agent uses everywhere
 *     ("Pokémon Unbound v2.1.1.1" instead of "Bare ROM workspace")
 *   - `baseGame` - the underlying canonical game (FRLG / Emerald / ...)
 *   - `family` - coarse grouping for hack-shared layout assumptions
 *     ("vanilla" / "frlg-hack" / "cfru-hack" / "rh-hideout")
 *   - `notes` - provenance / version info
 *
 * Adding a new hack is a one-line addition to FINGERPRINTS_BY_SHA1.
 * Compute the SHA-1 with `Get-FileHash -Algorithm SHA1` on Windows or
 * `shasum -a 1` on Unix.
 *
 * The lookup is intentionally minimal - it does NOT carry table
 * offsets or per-hack layout overrides. Those belong in the detector
 * code (RT-1.4-1.7 / RT-1.8-1.10) and SHOULD remain structural. The
 * fingerprint is purely about identity for the UI + agent system
 * prompts ("you're working on Unbound, not vanilla FireRed").
 */

export interface HackFingerprint {
  /** Human-facing name shown in IdentityCard / AgentPanel / titlebar. */
  readonly displayName: string;
  /** The canonical base game this ROM derives from. Mirrors the
   *  shape of `RomCartridgeHeader.knownGame`. */
  readonly baseGame:
    | 'Pokémon FireRed'
    | 'Pokémon LeafGreen'
    | 'Pokémon Ruby'
    | 'Pokémon Sapphire'
    | 'Pokémon Emerald';
  /** Coarse grouping. Used by the agent + detectors to know what
   *  hack-family overrides apply. */
  readonly family: 'vanilla' | 'frlg-hack' | 'emerald-hack' | 'rse-hack';
  /** Short provenance / version note. Surfaced in the IdentityCard's
   *  tooltip + the agent's system prompt. */
  readonly notes?: string;
}

/**
 * Known ROM SHA-1 → hack fingerprint. Keys are lowercase 40-char hex.
 * Add new entries here when a new hack is encountered in the wild.
 */
export const FINGERPRINTS_BY_SHA1: ReadonlyMap<string, HackFingerprint> =
  new Map<string, HackFingerprint>([
    // ===== Vanilla Gen-3 carts =====
    // FireRed (USA) v1.0 - the canonical baseline for FRLG hacks.
    [
      '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc',
      {
        displayName: 'Pokémon FireRed (USA)',
        baseGame: 'Pokémon FireRed',
        family: 'vanilla',
        notes: 'Vanilla BPRE 1.0 USA release. Reference target for all FRLG hacks.',
      },
    ],
    // FireRed (USA) v1.1 - the post-release revision.
    [
      'dd5945db9b930750cb39d00c84da8571feebf417',
      {
        displayName: 'Pokémon FireRed (USA, Rev 1)',
        baseGame: 'Pokémon FireRed',
        family: 'vanilla',
        notes: 'BPRE 1.1 USA revision.',
      },
    ],
    // LeafGreen (USA) v1.0.
    [
      '7862c67bdecbe21d1d69ce082ce34327e1c6ed5e',
      {
        displayName: 'Pokémon LeafGreen (USA)',
        baseGame: 'Pokémon LeafGreen',
        family: 'vanilla',
        notes: 'Vanilla BPGE 1.0 USA release.',
      },
    ],
    // Emerald (USA).
    [
      'f3ae088181bf583e55daf962a92bb46f4f1d07b7',
      {
        displayName: 'Pokémon Emerald (USA)',
        baseGame: 'Pokémon Emerald',
        family: 'vanilla',
        notes: 'Vanilla BPEE USA release.',
      },
    ],
    // Ruby (USA) v1.0.
    [
      'f28b6ffc97847e94a6c21a63cacf633ee5c8df1e',
      {
        displayName: 'Pokémon Ruby (USA)',
        baseGame: 'Pokémon Ruby',
        family: 'vanilla',
        notes: 'Vanilla AXVE 1.0 USA release.',
      },
    ],
    // Sapphire (USA) v1.0.
    [
      '3ccbbd45f8553c36463f13b938e833f652b793e4',
      {
        displayName: 'Pokémon Sapphire (USA)',
        baseGame: 'Pokémon Sapphire',
        family: 'vanilla',
        notes: 'Vanilla AXPE 1.0 USA release.',
      },
    ],

    // ===== Known FRLG hacks (corpus + popular hacks) =====
    // Pokémon Unbound v2.1.1.1 - the corpus's "heavy hack" sample.
    [
      'b4776b82a4c7915d0fadeaa27e013523f99dfd94',
      {
        displayName: 'Pokémon Unbound v2.1.1.1',
        baseGame: 'Pokémon FireRed',
        family: 'frlg-hack',
        notes:
          'Heavy-hack on a custom expansion framework. Expanded region map, custom mechanics, modified script opcodes, non-vanilla pointer layouts.',
      },
    ],
    // Pokémon Radical Red v4.10 - the corpus's "species reference" sample.
    [
      '964f951a0fdaf209e4ea1344883ef0d557bb3a80',
      {
        displayName: 'Pokémon Radical Red v4.10',
        baseGame: 'Pokémon FireRed',
        family: 'frlg-hack',
        notes:
          'Mechanics-overhauled hack on CFRU (Complete Fire Red Upgrade). 800+ species via expanded BaseStats, custom abilities, recoded battle engine.',
      },
    ],

    // ===== Other popular FRLG hacks (best-effort SHA-1s; verify on
    // first encounter and PR a correction if these don't match). =====
    // These are placeholders for next-time community alignment - the
    // engine doesn't depend on them being right beyond "if it matches,
    // surface this name." Mismatches fall through cleanly to the GBA
    // header path.
    //
    // (Intentionally minimal - adding more requires a verified SHA-1
    // from a community source. The engine should NOT guess about
    // hacks it hasn't been told about.)

    // ===== Modernize-and-Ship bundle =====
    // The bundled CFRU patch in app/backend/src/assets/modernize/cfru.bps
    // applied to the canonical vanilla FireRed (USA, rev 0) produces a
    // ROM with the SHA-1 below. Regenerated by
    // scripts/build-cfru-bundle.mjs whenever the bundle is rebuilt
    // against a new CFRU revision.
    [
      '2198839d94a80f013fe8b59ca4b0b6d9a9e3b48d',
      {
        displayName: 'FireRed (Modernized)',
        baseGame: 'Pokémon FireRed',
        family: 'frlg-hack',
        notes: 'CFRU built at commit unknown, OFFSET_TO_PUT=0x900000.',
      },
    ],

    // ===== DPE Bundle (Phase 3.41 / Phase 5) =====
    // The CFRU + Dynamic Pokémon Expansion bundle adds Gen 8+ species
    // beyond CFRU's URSHIFU_RAPID_GIGA cap. Built via
    // scripts/build-cfru-bundle-with-dpe.mjs: vanilla → DPE pass →
    // CFRU pass, with the engine BPS encoder producing the final
    // delta. Re-running the build with a different CFRU or DPE
    // revision will produce a different SHA - add additional entries
    // below the existing one (so the editor recognizes both builds)
    // rather than overwriting it.
    [
      '281f297929d5d07901fcd41dd24ad71cc761c779',
      {
        displayName: 'FireRed (Modernized + Gen 9 species)',
        baseGame: 'Pokémon FireRed',
        family: 'frlg-hack',
        notes:
          'CFRU + Dynamic Pokémon Expansion bundle. Built locally on 2026-05-27 via scripts/build-cfru-bundle-with-dpe.mjs.',
      },
    ],
  ]);

/**
 * Look up a ROM by its SHA-1 hex digest. Returns a fingerprint when
 * the hash is known, else null (caller falls back to GBA-header-only
 * identity).
 *
 * The hash MUST be lowercase 40-char hex. Callers compute this once
 * per ROM (via node:crypto's `createHash('sha1')`).
 */
export function lookupHackFingerprint(sha1: string): HackFingerprint | null {
  const key = sha1.toLowerCase();
  return FINGERPRINTS_BY_SHA1.get(key) ?? null;
}
