/**
 * BPS patch format - Modernize-and-Ship slice 1.
 *
 * BPS (Beat Patch System) by byuu is a binary delta format that
 * supports source files up to 4 GiB (vs IPS's 16 MiB cap) and uses
 * four action types - SourceRead, TargetRead, SourceCopy, TargetCopy - 
 * to keep patch size small even when data has moved. We bundle a BPS
 * patch in `app/backend/src/assets/modernize/cfru.bps` to upgrade
 * vanilla FireRed to CFRU.
 *
 * File layout:
 *   - 4 bytes magic: "BPS1"
 *   - varint: source size
 *   - varint: target size
 *   - varint: metadata size
 *   - metadata bytes (UTF-8 string, typically empty)
 *   - stream of action records (varint-encoded)
 *   - 4 bytes LE: source CRC32
 *   - 4 bytes LE: target CRC32
 *   - 4 bytes LE: patch CRC32 (over all preceding bytes)
 *
 * Actions: header = (length-1) * 4 + kind
 *   0 SourceRead - copy `length` bytes from source[outputOffset..]
 *   1 TargetRead - copy `length` bytes verbatim from patch stream
 *   2 SourceCopy - signed varint delta on sourceRelativeOffset,
 *                     then copy `length` bytes from there
 *   3 TargetCopy - signed varint delta on targetRelativeOffset,
 *                     then copy `length` bytes from there
 *                     (may overlap - RLE-style byte-by-byte)
 *
 * Variable-length integer (BPS-specific, NOT standard LEB128):
 *   decode:  data = 0, shift = 1
 *            loop:  x = read_byte
 *                   data += (x & 0x7F) * shift
 *                   if (x & 0x80) break
 *                   shift <<= 7
 *                   data += shift
 *
 *   This encodes 0 in one byte (0x80), encodes 1 in one byte (0x81),
 *   ... encodes 127 in one byte (0xFF), encodes 128 in two bytes
 *   (0x00 0x80), and so on. The implicit +shift on continuation
 *   compresses small numbers without wasting code space.
 *
 * PD 11: ROM editing is patch-first, never destructive. This module
 * is the format-level substrate; the modernize service (`app/backend/
 * src/agent/modernize.ts`) is the consumer.
 */

/** BPS format magic - must be exactly these 4 bytes at offset 0. */
export const BPS_MAGIC = new Uint8Array([0x42, 0x50, 0x53, 0x31]); // "BPS1"
/** Size in bytes of the BPS trailer (3 × u32 LE CRC32). */
export const BPS_TRAILER_SIZE = 12;

/** Action kind bit values (low 2 bits of the action header varint). */
export const BPS_ACTION_SOURCE_READ = 0;
export const BPS_ACTION_TARGET_READ = 1;
export const BPS_ACTION_SOURCE_COPY = 2;
export const BPS_ACTION_TARGET_COPY = 3;

/** A typed BPS action. Discriminated on `kind`. */
export type BpsAction =
  | { readonly kind: 'source_read'; readonly length: number }
  | { readonly kind: 'target_read'; readonly data: Uint8Array }
  | {
      readonly kind: 'source_copy';
      readonly length: number;
      readonly sourceRelativeDelta: number;
    }
  | {
      readonly kind: 'target_copy';
      readonly length: number;
      readonly targetRelativeDelta: number;
    };

export class BpsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BpsFormatError';
  }
}

/** Decoded BPS file structure (header + actions + checksums). */
export interface BpsDecodeResult {
  readonly sourceSize: number;
  readonly targetSize: number;
  readonly metadata: string;
  readonly actions: ReadonlyArray<BpsAction>;
  readonly checksums: {
    readonly sourceCrc32: number;
    readonly targetCrc32: number;
    readonly patchCrc32: number;
  };
}

// ─── CRC32 (IEEE 802.3 polynomial 0xEDB88320) ──────────────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** IEEE 802.3 CRC32 (used by BPS for source/target/patch checksums). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Variable-length integer (BPS scheme) ──────────────────────────

interface VarintReadResult {
  readonly value: number;
  readonly nextCursor: number;
}

function readVarint(bytes: Uint8Array, cursor: number): VarintReadResult {
  let data = 0;
  let shift = 1;
  let i = cursor;
  // BPS varint can encode up to u64, but we constrain to safe-integer
  // range (2^53 - 1). GBA ROMs cap at 32 MiB so this is far beyond what
  // we'll ever see in practice - the bound exists only to catch
  // pathologically corrupted patches.
  while (true) {
    if (i >= bytes.length) {
      throw new BpsFormatError(`truncated varint at cursor ${String(cursor)}`);
    }
    const x = bytes[i++]!;
    data += (x & 0x7f) * shift;
    if (!Number.isSafeInteger(data)) {
      throw new BpsFormatError(`varint at cursor ${String(cursor)} exceeds safe integer range`);
    }
    if ((x & 0x80) !== 0) break;
    shift *= 128;
    data += shift;
    if (!Number.isSafeInteger(data)) {
      throw new BpsFormatError(`varint at cursor ${String(cursor)} exceeds safe integer range`);
    }
  }
  return { value: data, nextCursor: i };
}

function writeVarint(value: number, out: number[]): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BpsFormatError(`cannot encode non-integer/negative varint: ${String(value)}`);
  }
  let data = value;
  while (true) {
    const x = data & 0x7f;
    data = Math.floor(data / 128);
    if (data === 0) {
      out.push(0x80 | x);
      return;
    }
    out.push(x);
    data -= 1;
  }
}

function readSignedVarint(bytes: Uint8Array, cursor: number): VarintReadResult {
  const { value: raw, nextCursor } = readVarint(bytes, cursor);
  const magnitude = Math.floor(raw / 2);
  const signed = (raw & 1) !== 0 ? -magnitude : magnitude;
  return { value: signed, nextCursor };
}

function writeSignedVarint(value: number, out: number[]): void {
  if (!Number.isInteger(value)) {
    throw new BpsFormatError(`cannot encode non-integer signed varint: ${String(value)}`);
  }
  const magnitude = Math.abs(value);
  const raw = magnitude * 2 + (value < 0 ? 1 : 0);
  writeVarint(raw, out);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function writeU32LE(value: number, out: number[]): void {
  out.push(value & 0xff);
  out.push((value >>> 8) & 0xff);
  out.push((value >>> 16) & 0xff);
  out.push((value >>> 24) & 0xff);
}

// ─── decodeBps ─────────────────────────────────────────────────────

/** Decode a BPS patch byte stream into header, actions, and checksums.
 *  Does not apply the patch or validate source/target - call applyBps
 *  for that. Throws BpsFormatError on any structural issue. */
export function decodeBps(bytes: Uint8Array): BpsDecodeResult {
  if (bytes.length < BPS_MAGIC.length + BPS_TRAILER_SIZE) {
    throw new BpsFormatError(
      `patch too short (${String(bytes.length)} bytes) to contain magic + trailer`,
    );
  }
  for (let i = 0; i < BPS_MAGIC.length; i++) {
    if (bytes[i] !== BPS_MAGIC[i]) {
      throw new BpsFormatError(`patch missing "BPS1" magic at offset 0`);
    }
  }
  let cursor = BPS_MAGIC.length;
  const { value: sourceSize, nextCursor: c1 } = readVarint(bytes, cursor);
  cursor = c1;
  const { value: targetSize, nextCursor: c2 } = readVarint(bytes, cursor);
  cursor = c2;
  const { value: metadataSize, nextCursor: c3 } = readVarint(bytes, cursor);
  cursor = c3;
  const actionStreamEnd = bytes.length - BPS_TRAILER_SIZE;
  if (cursor + metadataSize > actionStreamEnd) {
    throw new BpsFormatError(
      `metadata length ${String(metadataSize)} would overrun action stream`,
    );
  }
  const metadataBytes = bytes.subarray(cursor, cursor + metadataSize);
  cursor += metadataSize;
  let metadata: string;
  try {
    metadata = new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes);
  } catch {
    throw new BpsFormatError(`metadata is not valid UTF-8`);
  }
  const actions: BpsAction[] = [];
  while (cursor < actionStreamEnd) {
    const { value: header, nextCursor: c4 } = readVarint(bytes, cursor);
    cursor = c4;
    const kind = header & 0x3;
    const length = Math.floor(header / 4) + 1;
    if (length < 1) {
      throw new BpsFormatError(`action length must be >= 1 (got ${String(length)})`);
    }
    if (kind === BPS_ACTION_SOURCE_READ) {
      actions.push(Object.freeze({ kind: 'source_read' as const, length }));
    } else if (kind === BPS_ACTION_TARGET_READ) {
      if (cursor + length > actionStreamEnd) {
        throw new BpsFormatError(
          `target_read of ${String(length)} bytes at cursor ${String(cursor)} overruns action stream`,
        );
      }
      const data = bytes.slice(cursor, cursor + length);
      cursor += length;
      actions.push(Object.freeze({ kind: 'target_read' as const, data }));
    } else if (kind === BPS_ACTION_SOURCE_COPY) {
      const { value: delta, nextCursor: c5 } = readSignedVarint(bytes, cursor);
      cursor = c5;
      actions.push(
        Object.freeze({
          kind: 'source_copy' as const,
          length,
          sourceRelativeDelta: delta,
        }),
      );
    } else {
      // BPS_ACTION_TARGET_COPY
      const { value: delta, nextCursor: c5 } = readSignedVarint(bytes, cursor);
      cursor = c5;
      actions.push(
        Object.freeze({
          kind: 'target_copy' as const,
          length,
          targetRelativeDelta: delta,
        }),
      );
    }
  }
  if (cursor !== actionStreamEnd) {
    throw new BpsFormatError(
      `action stream ended at cursor ${String(cursor)}, expected ${String(actionStreamEnd)}`,
    );
  }
  const sourceCrc32 = readU32LE(bytes, actionStreamEnd);
  const targetCrc32 = readU32LE(bytes, actionStreamEnd + 4);
  const patchCrc32 = readU32LE(bytes, actionStreamEnd + 8);
  return Object.freeze({
    sourceSize,
    targetSize,
    metadata,
    actions: Object.freeze(actions),
    checksums: Object.freeze({ sourceCrc32, targetCrc32, patchCrc32 }),
  });
}

// ─── encodeBps ─────────────────────────────────────────────────────

/** Encode a list of BpsActions plus the source/target byte buffers
 *  (needed for CRC32 computation) into a complete BPS patch. */
export function encodeBps(
  actions: ReadonlyArray<BpsAction>,
  source: Uint8Array,
  target: Uint8Array,
  metadata = '',
): Uint8Array {
  // Validate action lengths up front so we don't waste work.
  for (const a of actions) {
    if (a.kind === 'target_read') {
      if (a.data.length < 1) {
        throw new BpsFormatError(`target_read action must have at least 1 byte of data`);
      }
    } else if (a.length < 1) {
      throw new BpsFormatError(`${a.kind} action length must be >= 1 (got ${String(a.length)})`);
    }
  }
  const out: number[] = [];
  // Magic
  for (const b of BPS_MAGIC) out.push(b);
  // Sizes + metadata
  writeVarint(source.length, out);
  writeVarint(target.length, out);
  const metadataBytes = new TextEncoder().encode(metadata);
  writeVarint(metadataBytes.length, out);
  for (const b of metadataBytes) out.push(b);
  // Actions
  for (const a of actions) {
    if (a.kind === 'source_read') {
      writeVarint((a.length - 1) * 4 + BPS_ACTION_SOURCE_READ, out);
    } else if (a.kind === 'target_read') {
      writeVarint((a.data.length - 1) * 4 + BPS_ACTION_TARGET_READ, out);
      for (const b of a.data) out.push(b);
    } else if (a.kind === 'source_copy') {
      writeVarint((a.length - 1) * 4 + BPS_ACTION_SOURCE_COPY, out);
      writeSignedVarint(a.sourceRelativeDelta, out);
    } else {
      writeVarint((a.length - 1) * 4 + BPS_ACTION_TARGET_COPY, out);
      writeSignedVarint(a.targetRelativeDelta, out);
    }
  }
  // Source + target CRCs
  const sourceCrc = crc32(source);
  const targetCrc = crc32(target);
  writeU32LE(sourceCrc, out);
  writeU32LE(targetCrc, out);
  // Patch CRC over everything written so far
  const patchBytes = new Uint8Array(out);
  const patchCrc = crc32(patchBytes);
  writeU32LE(patchCrc, out);
  return new Uint8Array(out);
}

// ─── applyBps ──────────────────────────────────────────────────────

/** Apply a BPS patch to a source buffer, returning a NEW target buffer.
 *  Verifies source size + CRC32, patch CRC32, action stream integrity,
 *  and target CRC32 after apply. Throws BpsFormatError on any
 *  mismatch - the patch is either invalid or the source isn't the
 *  expected base. */
export function applyBps(source: Uint8Array, patch: Uint8Array): Uint8Array {
  const decoded = decodeBps(patch);
  if (source.length !== decoded.sourceSize) {
    throw new BpsFormatError(
      `source size mismatch: patch expects ${String(decoded.sourceSize)} bytes, got ${String(source.length)}`,
    );
  }
  const sourceCrc = crc32(source);
  if (sourceCrc !== decoded.checksums.sourceCrc32) {
    throw new BpsFormatError(
      `source CRC mismatch: patch expects 0x${decoded.checksums.sourceCrc32
        .toString(16)
        .padStart(8, '0')}, source has 0x${sourceCrc.toString(16).padStart(8, '0')}`,
    );
  }
  // Patch CRC: everything except the trailing 4 bytes (the patch CRC itself).
  const patchCrcComputed = crc32(patch.subarray(0, patch.length - 4));
  if (patchCrcComputed !== decoded.checksums.patchCrc32) {
    throw new BpsFormatError(
      `patch CRC mismatch (file is corrupted): expected 0x${decoded.checksums.patchCrc32
        .toString(16)
        .padStart(8, '0')}, computed 0x${patchCrcComputed.toString(16).padStart(8, '0')}`,
    );
  }
  const target = new Uint8Array(decoded.targetSize);
  let outputOffset = 0;
  let sourceRelativeOffset = 0;
  let targetRelativeOffset = 0;
  for (const a of decoded.actions) {
    if (a.kind === 'source_read') {
      if (outputOffset + a.length > target.length) {
        throw new BpsFormatError(
          `source_read at outputOffset 0x${outputOffset.toString(16)} length ${String(a.length)} overruns target`,
        );
      }
      if (outputOffset + a.length > source.length) {
        throw new BpsFormatError(
          `source_read at outputOffset 0x${outputOffset.toString(16)} reads past source end`,
        );
      }
      target.set(source.subarray(outputOffset, outputOffset + a.length), outputOffset);
      outputOffset += a.length;
    } else if (a.kind === 'target_read') {
      if (outputOffset + a.data.length > target.length) {
        throw new BpsFormatError(
          `target_read at outputOffset 0x${outputOffset.toString(16)} overruns target`,
        );
      }
      target.set(a.data, outputOffset);
      outputOffset += a.data.length;
    } else if (a.kind === 'source_copy') {
      sourceRelativeOffset += a.sourceRelativeDelta;
      if (
        sourceRelativeOffset < 0 ||
        sourceRelativeOffset + a.length > source.length
      ) {
        throw new BpsFormatError(
          `source_copy refers outside source (offset ${String(sourceRelativeOffset)} length ${String(a.length)})`,
        );
      }
      if (outputOffset + a.length > target.length) {
        throw new BpsFormatError(
          `source_copy at outputOffset 0x${outputOffset.toString(16)} overruns target`,
        );
      }
      target.set(
        source.subarray(sourceRelativeOffset, sourceRelativeOffset + a.length),
        outputOffset,
      );
      outputOffset += a.length;
      sourceRelativeOffset += a.length;
    } else {
      // target_copy - may overlap (RLE-style); copy byte-by-byte so already
      // written output bytes feed back into the source of the copy.
      targetRelativeOffset += a.targetRelativeDelta;
      if (targetRelativeOffset < 0 || targetRelativeOffset >= target.length) {
        throw new BpsFormatError(
          `target_copy start offset ${String(targetRelativeOffset)} out of range`,
        );
      }
      if (outputOffset + a.length > target.length) {
        throw new BpsFormatError(
          `target_copy at outputOffset 0x${outputOffset.toString(16)} overruns target`,
        );
      }
      for (let i = 0; i < a.length; i++) {
        target[outputOffset + i] = target[targetRelativeOffset + i]!;
      }
      outputOffset += a.length;
      targetRelativeOffset += a.length;
    }
  }
  if (outputOffset !== target.length) {
    throw new BpsFormatError(
      `actions produced ${String(outputOffset)} bytes, expected ${String(target.length)}`,
    );
  }
  const targetCrc = crc32(target);
  if (targetCrc !== decoded.checksums.targetCrc32) {
    throw new BpsFormatError(
      `target CRC mismatch after apply (patch internally inconsistent): expected 0x${decoded.checksums.targetCrc32
        .toString(16)
        .padStart(8, '0')}, got 0x${targetCrc.toString(16).padStart(8, '0')}`,
    );
  }
  return target;
}

// ─── produceBpsActions ─────────────────────────────────────────────

/** Produce a sequence of BpsActions that transforms `source` → `target`.
 *
 *  Algorithm: walk `target` byte by byte. When source[i] === target[i],
 *  extend a SourceRead run. Otherwise extend a TargetRead run. No
 *  SourceCopy / TargetCopy in this implementation - adequate for the
 *  vanilla-FRLG → CFRU case where the diff is "first ~9 MiB identical,
 *  then new code appended" (yielding exactly 2 actions). A future
 *  smarter producer can add LCP-matching against source+target
 *  dictionaries; the format stays the same.
 */
export function produceBpsActions(
  source: Uint8Array,
  target: Uint8Array,
): ReadonlyArray<BpsAction> {
  const actions: BpsAction[] = [];
  if (target.length === 0) {
    return Object.freeze(actions);
  }
  const minSize = Math.min(source.length, target.length);
  let i = 0;
  while (i < target.length) {
    if (i < minSize && source[i] === target[i]) {
      // Find end of source-matching run.
      let runEnd = i + 1;
      while (runEnd < minSize && source[runEnd] === target[runEnd]) {
        runEnd++;
      }
      actions.push(Object.freeze({ kind: 'source_read' as const, length: runEnd - i }));
      i = runEnd;
    } else {
      // Find end of differing run (either reach target end OR find a
      // position where source[j] === target[j] again).
      let runEnd = i + 1;
      while (
        runEnd < target.length &&
        !(runEnd < minSize && source[runEnd] === target[runEnd])
      ) {
        runEnd++;
      }
      actions.push(
        Object.freeze({
          kind: 'target_read' as const,
          data: target.slice(i, runEnd),
        }),
      );
      i = runEnd;
    }
  }
  return Object.freeze(actions);
}
