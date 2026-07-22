/**
 * Phase G-RC5 (semantic-world plan §G.5) - Binary-ROM ObjectEvent
 * field write path.
 *
 * The decomp-only `patchEventFields` writes `data/maps/<dir>/map.json`,
 * which doesn't exist for bare-ROM workspaces. For binary ROMs we
 * patch the 24-byte `ObjectEventTemplate` struct in place using the
 * struct's absolute file offset stashed by the lifter as
 * `metadata.binaryFileOffset`.
 *
 * ObjectEventTemplate layout (Gen-3, 24 bytes), per pret/pokefirered
 * `include/global.fieldmap.h`:
 *
 *   +0x00 u8  localId                          (kept stable)
 *   +0x01 u8  graphicsId                       ← graphics_id
 *   +0x02 u8  kind                             (kept stable)
 *   +0x03 u8  padding
 *   +0x04 s16 x                                (handled by /move-event)
 *   +0x06 s16 y                                (handled by /move-event)
 *   +0x08 u8  elevation                        ← elevation
 *   +0x09 u8  movementType                     ← movement_type
 *   +0x0A u8  movementRangeXY (X high nibble,  ← movement_range_x +
 *             Y low nibble - packed into          movement_range_y
 *             one byte)
 *   +0x0B u8  padding2
 *   +0x0C u16 trainerType                      ← trainer_type
 *   +0x0E u16 trainerSight_or_berryTreeId      ← trainer_sight_...
 *   +0x10 u32 *script (ROM pointer)            ← script  (number)
 *   +0x14 u16 flagId                           ← flag    (number)
 *   +0x16 u16 padding3
 *
 * The route reuses the `.bak`-once pattern from
 * `editBinaryRomMapCells`: backup file created on first edit per
 * session (idempotent), in-memory atomic edit, flush to disk.
 */

import { promises as fsp } from 'node:fs';

export const OBJECT_EVENT_TEMPLATE_SIZE = 24;

/** GBA ROM mirror range - script pointers must fall in here or be 0. */
const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

/** Whitelist of editable fields. Mirrors the decomp PATCH route's
 *  whitelist in `patch-fields.ts` so the frontend can use one form
 *  for both decomp + binary edits. `movement_range_x` and `_y` are
 *  separate halves of the single packed `movementRangeXY` byte. */
export const BINARY_ROM_OBJECT_EVENT_EDITABLE_FIELDS: ReadonlyArray<string> = [
  'graphics_id',
  'elevation',
  'movement_type',
  'movement_range_x',
  'movement_range_y',
  'trainer_type',
  'trainer_sight_or_berry_tree_id',
  'script',
  'flag',
];

export class BinaryRomObjectEventWriteError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BinaryRomObjectEventWriteError';
  }
}

export interface BinaryRomObjectEventEdit {
  /** Absolute file offset of the 24-byte ObjectEventTemplate struct. */
  readonly structFileOffset: number;
  /** Whitelisted edits. Use null to leave a field unchanged; partial
   *  edits supported (only changed fields need to be present). */
  readonly fields: Readonly<Record<string, number | null | undefined>>;
}

export interface BinaryRomObjectEventWriteResult {
  /** True when this write created the `<rom>.bak` backup file (first
   *  edit of the session). False on subsequent writes. */
  readonly backupCreated: boolean;
  /** Number of struct bytes mutated across all edits. */
  readonly bytesChanged: number;
  /** Per-edit diff: previous + next field values for each whitelisted
   *  key. Mirrors the decomp PATCH route's shape so the undo system
   *  works the same way. */
  readonly results: ReadonlyArray<{
    readonly structFileOffset: number;
    readonly previous: Readonly<Record<string, number>>;
    readonly next: Readonly<Record<string, number>>;
  }>;
}

interface ObjectEventFields {
  readonly graphics_id: number;
  readonly elevation: number;
  readonly movement_type: number;
  readonly movement_range_x: number;
  readonly movement_range_y: number;
  readonly trainer_type: number;
  readonly trainer_sight_or_berry_tree_id: number;
  readonly script: number;
  readonly flag: number;
}

/** Read the current ObjectEvent fields from a buffer. Returns null
 *  when the offset is out of range. */
function readFields(buf: Buffer, off: number): ObjectEventFields | null {
  if (off < 0 || off + OBJECT_EVENT_TEMPLATE_SIZE > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const rangeByte = view.getUint8(off + 0x0a);
  return {
    graphics_id: view.getUint8(off + 0x01),
    elevation: view.getUint8(off + 0x08),
    movement_type: view.getUint8(off + 0x09),
    // High nibble of byte +0x0A is X range; low nibble is Y range.
    movement_range_x: (rangeByte >> 4) & 0x0f,
    movement_range_y: rangeByte & 0x0f,
    trainer_type: view.getUint16(off + 0x0c, true),
    trainer_sight_or_berry_tree_id: view.getUint16(off + 0x0e, true),
    script: view.getUint32(off + 0x10, true),
    flag: view.getUint16(off + 0x14, true),
  };
}

/** Validate one field value before writing. */
function validateFieldValue(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new BinaryRomObjectEventWriteError(
      'invalid_value',
      `Field '${field}' must be a non-negative integer; got ${String(value)}`,
    );
  }
  switch (field) {
    case 'graphics_id':
    case 'elevation':
    case 'movement_type':
      if (value > 0xff) {
        throw new BinaryRomObjectEventWriteError(
          'out_of_range',
          `Field '${field}' is a u8 (0..255); got ${String(value)}`,
        );
      }
      return;
    case 'movement_range_x':
    case 'movement_range_y':
      if (value > 0x0f) {
        throw new BinaryRomObjectEventWriteError(
          'out_of_range',
          `Field '${field}' is a 4-bit nibble (0..15); got ${String(value)}`,
        );
      }
      return;
    case 'trainer_type':
    case 'trainer_sight_or_berry_tree_id':
    case 'flag':
      if (value > 0xffff) {
        throw new BinaryRomObjectEventWriteError(
          'out_of_range',
          `Field '${field}' is a u16 (0..65535); got ${String(value)}`,
        );
      }
      return;
    case 'script':
      // 0 means "no script". Non-zero must be a ROM-space pointer.
      if (value === 0) return;
      if (value < GBA_ROM_BASE || value >= GBA_ROM_END_EXCLUSIVE) {
        throw new BinaryRomObjectEventWriteError(
          'out_of_range',
          `Field 'script' must be 0 or a ROM pointer in [0x08000000, 0x0A000000); got 0x${value.toString(16)}`,
        );
      }
      return;
    default:
      throw new BinaryRomObjectEventWriteError(
        'unknown_field',
        `Field '${field}' is not editable. Allowed: ${BINARY_ROM_OBJECT_EVENT_EDITABLE_FIELDS.join(', ')}`,
      );
  }
}

/** Apply one edit to the in-memory buffer. Returns the previous-field
 *  + next-field diff and the byte-count changed. Throws on validation
 *  failures or out-of-range struct offsets. */
function applyOneEdit(
  buf: Buffer,
  edit: BinaryRomObjectEventEdit,
): {
  previous: ObjectEventFields;
  next: ObjectEventFields;
  bytesChanged: number;
} {
  const before = readFields(buf, edit.structFileOffset);
  if (before === null) {
    throw new BinaryRomObjectEventWriteError(
      'out_of_range',
      `Struct offset 0x${edit.structFileOffset.toString(16)} + 24 exceeds ROM size ${String(buf.length)}`,
    );
  }
  // Filter out null/undefined entries (those are "leave alone").
  const entries = Object.entries(edit.fields).filter(
    (e): e is [string, number] => typeof e[1] === 'number',
  );
  if (entries.length === 0) {
    throw new BinaryRomObjectEventWriteError(
      'no_fields',
      'No fields provided to edit (all values were null/undefined).',
    );
  }
  for (const [key, value] of entries) {
    if (!BINARY_ROM_OBJECT_EVENT_EDITABLE_FIELDS.includes(key)) {
      throw new BinaryRomObjectEventWriteError(
        'unknown_field',
        `Field '${key}' is not editable. Allowed: ${BINARY_ROM_OBJECT_EVENT_EDITABLE_FIELDS.join(', ')}`,
      );
    }
    validateFieldValue(key, value);
  }
  // Mutate the in-memory buffer.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const off = edit.structFileOffset;
  // Track the next-state by starting from the before snapshot.
  const next: ObjectEventFields = {
    ...before,
    ...(entries.reduce<Partial<ObjectEventFields>>((acc, [k, v]) => {
      (acc as Record<string, number>)[k] = v;
      return acc;
    }, {})),
  } as ObjectEventFields;
  // Write each field that actually changed.
  let bytesChanged = 0;
  if (next.graphics_id !== before.graphics_id) {
    view.setUint8(off + 0x01, next.graphics_id);
    bytesChanged += 1;
  }
  if (next.elevation !== before.elevation) {
    view.setUint8(off + 0x08, next.elevation);
    bytesChanged += 1;
  }
  if (next.movement_type !== before.movement_type) {
    view.setUint8(off + 0x09, next.movement_type);
    bytesChanged += 1;
  }
  // Range X + Y share byte 0x0A; rebuild from current next.* values.
  const newRangeByte =
    ((next.movement_range_x & 0x0f) << 4) | (next.movement_range_y & 0x0f);
  const oldRangeByte =
    ((before.movement_range_x & 0x0f) << 4) | (before.movement_range_y & 0x0f);
  if (newRangeByte !== oldRangeByte) {
    view.setUint8(off + 0x0a, newRangeByte);
    bytesChanged += 1;
  }
  if (next.trainer_type !== before.trainer_type) {
    view.setUint16(off + 0x0c, next.trainer_type, true);
    bytesChanged += 2;
  }
  if (next.trainer_sight_or_berry_tree_id !== before.trainer_sight_or_berry_tree_id) {
    view.setUint16(off + 0x0e, next.trainer_sight_or_berry_tree_id, true);
    bytesChanged += 2;
  }
  if (next.script !== before.script) {
    view.setUint32(off + 0x10, next.script >>> 0, true);
    bytesChanged += 4;
  }
  if (next.flag !== before.flag) {
    view.setUint16(off + 0x14, next.flag, true);
    bytesChanged += 2;
  }
  return { previous: before, next, bytesChanged };
}

/**
 * Apply a batch of ObjectEventTemplate field edits to the ROM at
 * `romPath`. Reuses the `.bak`-once-per-session pattern from
 * `editBinaryRomMapCells`: copy the original ROM to `<romPath>.bak`
 * on first edit, then mutate the live ROM. All edits are validated
 * BEFORE any disk write - partial failure cannot leave the ROM in a
 * half-written state.
 */
export async function applyBinaryRomObjectEventEdits(
  romPath: string,
  edits: ReadonlyArray<BinaryRomObjectEventEdit>,
): Promise<BinaryRomObjectEventWriteResult> {
  if (edits.length === 0) {
    throw new BinaryRomObjectEventWriteError(
      'no_edits',
      'No edits provided.',
    );
  }
  let romBytes: Buffer;
  try {
    romBytes = await fsp.readFile(romPath);
  } catch (e) {
    throw new BinaryRomObjectEventWriteError(
      'rom_read_failed',
      `Failed to read ROM at ${romPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const out = Buffer.from(romBytes);

  // Apply all edits to the in-memory copy. Pre-validate first so we
  // don't write a partial change set on failure.
  const results: Array<{
    structFileOffset: number;
    previous: Readonly<Record<string, number>>;
    next: Readonly<Record<string, number>>;
  }> = [];
  let totalBytesChanged = 0;
  for (const edit of edits) {
    const r = applyOneEdit(out, edit);
    results.push({
      structFileOffset: edit.structFileOffset,
      previous: { ...r.previous },
      next: { ...r.next },
    });
    totalBytesChanged += r.bytesChanged;
  }

  // Create the backup if it doesn't exist.
  const backupPath = `${romPath}.bak`;
  let backupCreated = false;
  try {
    await fsp.access(backupPath);
  } catch {
    try {
      await fsp.copyFile(romPath, backupPath);
      backupCreated = true;
    } catch (e) {
      throw new BinaryRomObjectEventWriteError(
        'backup_failed',
        `Failed to create backup ${backupPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Flush to disk.
  try {
    await fsp.writeFile(romPath, out);
  } catch (e) {
    throw new BinaryRomObjectEventWriteError(
      'rom_write_failed',
      `Failed to write ROM at ${romPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    backupCreated,
    bytesChanged: totalBytesChanged,
    results: Object.freeze(results),
  };
}
