/**
 * JSON Schema for one entry in the engine's signature database.
 *
 * Per D-0007, the signature DB is in-repo JSON, schema-validated at load
 * time, hot-loadable, and pluggable - never compiled-in as the sole
 * detection path (PD 5). Every detector has a heuristic path; the
 * signature DB is enrichment.
 *
 * What can be stored here (PD 12 / D-0011):
 *   - Game codes (published Nintendo strings - fair to publish)
 *   - SHA-1 hashes of known ROM dumps (hashes carry no copyrighted content)
 *   - Size in bytes (a number, not a copyrighted artifact)
 *   - Build markers - byte patterns characteristic of specific BUILD systems
 *     (pret / agbcc / CFRU / etc.) at known offsets. These describe TOOL
 *     OUTPUT, not game content.
 *   - Friendly display names + provenance URLs (for the operator)
 *
 * What MUST NOT be stored here:
 *   - Copyrighted ROM bytes excerpts
 *   - Decompiled Game Freak C source
 *   - Music / sprite / palette data
 *
 * A signature entry can match by ANY of: gameCode, sha1, sizeBytes + the
 * buildMarkers all hitting. Match precedence is handled by the matcher.
 */

export const SIGNATURE_ENTRY_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['id', 'displayName', 'family', 'kind', 'sources', 'confidenceWhenMatched'],
  additionalProperties: false,
  properties: {
    /** Stable id (kebab-case). Must be globally unique across the DB. */
    id: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]*$',
      minLength: 3,
      maxLength: 64,
    },
    /** Human-readable name (e.g. "Pokémon FireRed v1.0 (USA)"). */
    displayName: { type: 'string', minLength: 1, maxLength: 256 },
    /**
     * Family identifier - groups related entries (e.g. "firered" covers
     * BPRE 1.0, 1.1, all FireRed-derived hacks). The family is what
     * Phase 1's family classification reports.
     */
    family: { type: 'string', minLength: 1, maxLength: 64 },
    /**
     * Classification kind. Drives the §12.5 corpus class mapping.
     *   - `vanilla` - original Nintendo cart bytes (or a verified dump)
     *   - `decomp` - pret/agbcc-style buildable source rebuild
     *   - `cfru` - Custom Firered Upgrade or sibling framework
     *   - `fork` - custom engine fork / heavy hack / unbound-class
     *   - `unknown` - recognized as something, but not these classes
     */
    kind: {
      type: 'string',
      enum: ['vanilla', 'decomp', 'cfru', 'fork', 'unknown'],
    },
    /** Cart game-code matches (1+ characters expected; format is 4 ASCII). */
    gameCodes: {
      type: 'array',
      items: {
        type: 'string',
        pattern: '^[A-Z0-9]{4}$',
      },
      uniqueItems: true,
      minItems: 1,
    },
    /** SHA-1 hashes (lowercase hex, 40 chars). */
    sha1: {
      type: 'array',
      items: {
        type: 'string',
        pattern: '^[0-9a-f]{40}$',
      },
      uniqueItems: true,
      minItems: 1,
    },
    /** Exact size in bytes that the ROM must be (when combined with marker). */
    sizeBytes: {
      type: 'array',
      items: { type: 'integer', minimum: 192, maximum: 33_554_432 },
      uniqueItems: true,
      minItems: 1,
    },
    /**
     * Build markers - specific byte patterns at specific offsets that the
     * detector verifies before claiming a match. ALL listed markers must
     * match. Each `magic` is uppercase hex (no separators).
     */
    buildMarkers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['offset', 'magic'],
        additionalProperties: false,
        properties: {
          offset: { type: 'integer', minimum: 0, maximum: 33_554_431 },
          magic: {
            type: 'string',
            // even number of uppercase hex digits, ≥ 2 bytes (4 hex chars)
            pattern: '^[0-9A-F]{4,256}$',
          },
          /** Optional human label for the marker (e.g. "agbcc compiler tag"). */
          label: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      minItems: 1,
    },
    /**
     * Provenance - where this signature came from (URLs to specs / docs /
     * commits). Helps the operator audit DB content.
     */
    sources: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 512 },
      minItems: 1,
    },
    /**
     * Confidence to publish when this entry matches. Must be in (0, 1].
     * Entries with weak shape-matches (e.g. game code only) use lower
     * values; entries with sha1+gameCode+buildMarker matches use higher.
     */
    confidenceWhenMatched: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1,
    },
    /** Optional free-form notes (parser ignores). */
    notes: { type: 'string', maxLength: 1024 },
    /**
     * Optional semantic names for the script-engine opcode dispatch
     * table - P6-T6 enrichment. Indexed by opcode byte value: the
     * string at index N is the human-readable name for opcode N
     * (e.g. `["nop", "nop1", "end", "return", "call", ...]`). Sparse
     * arrays are allowed - empty strings or undefined entries cause
     * the decompile renderer to fall back to `op_<index>` for that
     * opcode (PD 4: never fake a name we don't know).
     *
     * PD 12 boundary: names are CC0-licensed strings from public
     * decomp sources (pret/pokefirered, pret/pokeemerald) describing
     * the engine's PUBLIC opcode dispatch table - they are source-
     * code identifiers, NOT copyrighted ROM bytes.
     */
    opcodeNames: {
      type: 'array',
      items: { type: 'string', maxLength: 64 },
      maxItems: 1024,
    },
  },
  // Cross-condition: at least one of gameCodes / sha1 / (sizeBytes+buildMarkers)
  // must be present so the matcher has something to act on. We don't encode
  // this in JSON Schema (it's awkward); the loader enforces it.
} as const;

/**
 * One DB-file shape: a JSON document with a top-level `entries` array.
 * Keeping the wrapper means a single file can carry many related entries
 * AND we can later add file-level fields (version, license, contributor)
 * without breaking entry parsers.
 */
export const SIGNATURE_FILE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['schemaVersion', 'entries'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    /** Free-form name for the file (e.g. "gen3-vanilla"). */
    name: { type: 'string', minLength: 1, maxLength: 128 },
    /** SPDX-style license string for the SIGNATURE DATA itself (not the
     *  engine). Helps downstream operators know whether they can
     *  redistribute the DB. */
    license: { type: 'string', minLength: 1, maxLength: 64 },
    entries: {
      type: 'array',
      minItems: 1,
      items: SIGNATURE_ENTRY_SCHEMA,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// TypeScript shapes (kept in lockstep with the JSON Schema above)
// ---------------------------------------------------------------------------

export type SignatureKind = 'vanilla' | 'decomp' | 'cfru' | 'fork' | 'unknown';

export interface BuildMarker {
  readonly offset: number;
  readonly magic: string;
  readonly label?: string;
}

export interface SignatureEntry {
  readonly id: string;
  readonly displayName: string;
  readonly family: string;
  readonly kind: SignatureKind;
  readonly gameCodes?: ReadonlyArray<string>;
  readonly sha1?: ReadonlyArray<string>;
  readonly sizeBytes?: ReadonlyArray<number>;
  readonly buildMarkers?: ReadonlyArray<BuildMarker>;
  readonly sources: ReadonlyArray<string>;
  readonly confidenceWhenMatched: number;
  readonly notes?: string;
  /** P6-T6: optional opcode-name table, indexed by opcode-byte value.
   *  Empty / undefined entries fall back to `op_<index>` at render. */
  readonly opcodeNames?: ReadonlyArray<string>;
}

export interface SignatureFile {
  readonly schemaVersion: 1;
  readonly name?: string;
  readonly license?: string;
  readonly entries: ReadonlyArray<SignatureEntry>;
}
