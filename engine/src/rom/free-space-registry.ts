/**
 * Cross-tool free-space registry (Phase 3.2).
 *
 * `findFreeRomSpace()` (engine/src/rom/free-space.ts) is the per-call
 * primitive: it scans the ROM for a fill-byte run and returns an
 * offset. Each call is independent. When the agent runs a series of
 * tools in one session - propose_create_map then propose_import_sprite
 * then propose_add_trainer - each tool scans the SAME ROM bytes and
 * (because nothing's been WRITTEN yet - we're staging edits not
 * applying them) all of them prefer the SAME tail-end offset. The
 * second tool's "fresh" offset overlaps with the first tool's. The
 * agent reviews the proposals individually; if all are applied in
 * sequence the writes step on each other.
 *
 * The registry fixes this by tracking IN-FLIGHT claims across an
 * autonomous run. Each tool that allocates calls
 * `registry.claim(sizeBytes, purposeTag)` instead of findFreeRomSpace
 * directly; the registry walks the ROM via findFreeRomSpace AND
 * skips ranges it has already handed out in this session OR (when
 * loaded from disk) in a previous session that wrote claims to
 * `<projectRoot>/.editor/free-space.json`.
 *
 * Persistence: claims serialize to JSON so a multi-session overnight
 * pass survives backend restarts. The registry doesn't write to the
 * ROM; it just remembers which offsets it promised to which tool.
 *
 * Deterministic: given the same ROM bytes + the same prior claims +
 * the same requested sizes in the same order, the registry returns
 * the same offsets every time. Important for reproducible game builds.
 */

import { findFreeRomSpace } from './free-space.js';

export interface FreeSpaceClaim {
  /** File offset of the start of the claimed region. */
  readonly offset: number;
  /** Length in bytes. */
  readonly size: number;
  /** Free-form tag from the caller ("map_layout_route_2" / etc.) used
   *  for diagnostics + the JSON disk format. */
  readonly purposeTag: string;
  /** Order in which the claim was issued (0-based). */
  readonly sequence: number;
}

export interface FreeSpaceRegistrySnapshot {
  readonly schemaVersion: 1;
  readonly claims: ReadonlyArray<FreeSpaceClaim>;
}

export class FreeSpaceExhaustedError extends Error {
  readonly requested: number;
  constructor(requested: number, totalClaimedBytes: number) {
    super(
      `FreeSpaceExhaustedError: no run of ≥ ${String(requested)} fill bytes found ` +
        `(after honoring ${String(totalClaimedBytes)} previously-claimed bytes)`,
    );
    this.name = 'FreeSpaceExhaustedError';
    this.requested = requested;
  }
}

/**
 * Tracks free-space claims across a series of tool calls. Persists to
 * a JSON snapshot the user (or the editor) can drop on disk under
 * `.editor/free-space.json`.
 *
 * Usage:
 *   const reg = new FreeSpaceRegistry(romBytes);
 *   reg.restore(snapshotJson);
 *   const off1 = reg.claim(0x1000, 'map_route_1_layout');
 *   const off2 = reg.claim(0x800, 'map_route_1_blocks');
 *   await fs.writeFile('.editor/free-space.json', JSON.stringify(reg.persist()));
 */
export class FreeSpaceRegistry {
  private readonly rom: Uint8Array;
  /** A working copy of rom bytes with claimed ranges marked as non-
   *  fill so findFreeRomSpace skips them. We mark with 0xAA - chosen
   *  to be neither 0xFF nor 0x00, the two fill bytes findFreeRomSpace
   *  considers usable. */
  private readonly working: Uint8Array;
  private readonly claims: FreeSpaceClaim[] = [];

  constructor(romBytes: Uint8Array) {
    this.rom = romBytes;
    // Copy so we don't mutate the caller's buffer.
    this.working = new Uint8Array(romBytes);
  }

  /** Restore claims from a prior session's snapshot. Marks the corres-
   *  ponding ranges as already-claimed in the working buffer. Returns
   *  the number of claims restored.
   *
   *  Snapshots from a DIFFERENT ROM (different SHA-1) are NOT detected
   *  here - the caller must validate the snapshot belongs with this
   *  ROM (typically via the project's manifest binding). */
  restore(snapshot: FreeSpaceRegistrySnapshot): number {
    if (snapshot.schemaVersion !== 1) {
      throw new Error(`unsupported snapshot schema version ${String(snapshot.schemaVersion)}`);
    }
    for (const c of snapshot.claims) {
      if (c.offset < 0 || c.offset + c.size > this.rom.length) {
        // Skip claims that don't fit this ROM (probably stale snapshot).
        continue;
      }
      for (let i = 0; i < c.size; i++) this.working[c.offset + i] = 0xaa;
      this.claims.push(c);
    }
    return snapshot.claims.length;
  }

  /** Claim `sizeBytes` of free space. Returns the file offset where the
   *  caller can WRITE those bytes (the registry doesn't touch ROM
   *  contents - it just promises that subsequent claims won't overlap). */
  claim(sizeBytes: number, purposeTag: string): number {
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new Error(`sizeBytes must be a positive integer; got ${String(sizeBytes)}`);
    }
    const result = findFreeRomSpace(this.working, sizeBytes);
    if (result === null) {
      const total = this.claims.reduce((sum, c) => sum + c.size, 0);
      throw new FreeSpaceExhaustedError(sizeBytes, total);
    }
    // Mark the working buffer so the next claim() doesn't return an
    // overlapping range.
    for (let i = 0; i < sizeBytes; i++) {
      this.working[result.offset + i] = 0xaa;
    }
    const claim: FreeSpaceClaim = Object.freeze({
      offset: result.offset,
      size: sizeBytes,
      purposeTag,
      sequence: this.claims.length,
    });
    this.claims.push(claim);
    return result.offset;
  }

  /** Release a previously-claimed range. Restores the working buffer's
   *  bytes to whatever the original ROM had there, and removes the
   *  claim from the list. Used when a tool's proposal is rejected /
   *  rolled back. Returns true if the claim was found + released. */
  release(offset: number): boolean {
    const idx = this.claims.findIndex((c) => c.offset === offset);
    if (idx < 0) return false;
    const claim = this.claims[idx]!;
    for (let i = 0; i < claim.size; i++) {
      this.working[claim.offset + i] = this.rom[claim.offset + i]!;
    }
    this.claims.splice(idx, 1);
    return true;
  }

  /** All current claims, ordered by sequence. */
  list(): ReadonlyArray<FreeSpaceClaim> {
    return Object.freeze([...this.claims]);
  }

  /** Total bytes claimed so far. */
  totalClaimedBytes(): number {
    return this.claims.reduce((sum, c) => sum + c.size, 0);
  }

  /** Serialize for disk persistence. Stable JSON shape; safe to write
   *  with `JSON.stringify(...)` to .editor/free-space.json. */
  persist(): FreeSpaceRegistrySnapshot {
    return Object.freeze({
      schemaVersion: 1,
      claims: Object.freeze([...this.claims]),
    });
  }
}
