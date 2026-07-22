/**
 * Phase O.24 - Gen-3 movement action byte → readable name map.
 *
 * Used by the script-steps inspector's applymovement viewer to render
 * the variable-length movement byte sequence as a human-readable list
 * instead of "(15 steps)". Names + direction glyphs come from
 * pret/pokefirered/include/constants/event_object_movement.h.
 *
 * Coverage: the most common ~96 actions (face / walk / run / jump /
 * pause / animation triggers). Bytes outside this map render as the
 * raw hex value so the operator can still spot them.
 */

export interface MovementActionInfo {
  /** Readable label, e.g. "Walk fast right". */
  readonly label: string;
  /** Direction glyph for compact display: ↓ ↑ ← → · ↕ */
  readonly glyph: string;
}

/** End-of-sequence sentinel byte (MOVEMENT_END_BYTE = 0xFE). */
export const MOVEMENT_END_BYTE = 0xfe;

const MOVEMENT_ACTIONS: Readonly<Record<number, MovementActionInfo>> = {
  0x00: { label: 'Face down', glyph: '↓' },
  0x01: { label: 'Face up', glyph: '↑' },
  0x02: { label: 'Face left', glyph: '←' },
  0x03: { label: 'Face right', glyph: '→' },
  0x04: { label: 'Walk slow down', glyph: '↓' },
  0x05: { label: 'Walk slow up', glyph: '↑' },
  0x06: { label: 'Walk slow left', glyph: '←' },
  0x07: { label: 'Walk slow right', glyph: '→' },
  0x08: { label: 'Walk normal down', glyph: '↓' },
  0x09: { label: 'Walk normal up', glyph: '↑' },
  0x0a: { label: 'Walk normal left', glyph: '←' },
  0x0b: { label: 'Walk normal right', glyph: '→' },
  0x0c: { label: 'Jump 2 down', glyph: '↓' },
  0x0d: { label: 'Jump 2 up', glyph: '↑' },
  0x0e: { label: 'Jump 2 left', glyph: '←' },
  0x0f: { label: 'Jump 2 right', glyph: '→' },
  0x10: { label: 'Delay 1', glyph: '·' },
  0x11: { label: 'Delay 2', glyph: '·' },
  0x12: { label: 'Delay 4', glyph: '·' },
  0x13: { label: 'Delay 8', glyph: '·' },
  0x14: { label: 'Delay 16', glyph: '·' },
  0x15: { label: 'Walk fast down', glyph: '↓' },
  0x16: { label: 'Walk fast up', glyph: '↑' },
  0x17: { label: 'Walk fast left', glyph: '←' },
  0x18: { label: 'Walk fast right', glyph: '→' },
  0x19: { label: 'Walk in place down', glyph: '·' },
  0x1a: { label: 'Walk in place up', glyph: '·' },
  0x1b: { label: 'Walk in place left', glyph: '·' },
  0x1c: { label: 'Walk in place right', glyph: '·' },
  0x1d: { label: 'Walk in place fast down', glyph: '·' },
  0x1e: { label: 'Walk in place fast up', glyph: '·' },
  0x1f: { label: 'Walk in place fast left', glyph: '·' },
  0x20: { label: 'Walk in place fast right', glyph: '·' },
  0x21: { label: 'Walk in place fastest down', glyph: '·' },
  0x22: { label: 'Walk in place fastest up', glyph: '·' },
  0x23: { label: 'Walk in place fastest left', glyph: '·' },
  0x24: { label: 'Walk in place fastest right', glyph: '·' },
  0x25: { label: 'Ride water current down', glyph: '↓' },
  0x26: { label: 'Ride water current up', glyph: '↑' },
  0x27: { label: 'Ride water current left', glyph: '←' },
  0x28: { label: 'Ride water current right', glyph: '→' },
  0x29: { label: 'Walk fastest down', glyph: '↓' },
  0x2a: { label: 'Walk fastest up', glyph: '↑' },
  0x2b: { label: 'Walk fastest left', glyph: '←' },
  0x2c: { label: 'Walk fastest right', glyph: '→' },
  0x2d: { label: 'Slide down', glyph: '↓' },
  0x2e: { label: 'Slide up', glyph: '↑' },
  0x2f: { label: 'Slide left', glyph: '←' },
  0x30: { label: 'Slide right', glyph: '→' },
  0x31: { label: 'Player run down', glyph: '↓' },
  0x32: { label: 'Player run up', glyph: '↑' },
  0x33: { label: 'Player run left', glyph: '←' },
  0x34: { label: 'Player run right', glyph: '→' },
  0x35: { label: 'Start anim in direction', glyph: '·' },
  0x36: { label: 'Jump special down', glyph: '↓' },
  0x37: { label: 'Jump special up', glyph: '↑' },
  0x38: { label: 'Jump special left', glyph: '←' },
  0x39: { label: 'Jump special right', glyph: '→' },
  0x3a: { label: 'Face player', glyph: '·' },
  0x3b: { label: 'Face away player', glyph: '·' },
  0x3c: { label: 'Lock facing direction', glyph: '·' },
  0x3d: { label: 'Unlock facing direction', glyph: '·' },
  0x3e: { label: 'Jump down', glyph: '↓' },
  0x3f: { label: 'Jump up', glyph: '↑' },
  0x40: { label: 'Jump left', glyph: '←' },
  0x41: { label: 'Jump right', glyph: '→' },
  0x42: { label: 'Jump in place down', glyph: '·' },
  0x43: { label: 'Jump in place up', glyph: '·' },
  0x44: { label: 'Jump in place left', glyph: '·' },
  0x45: { label: 'Jump in place right', glyph: '·' },
  0x46: { label: 'Jump in place down up', glyph: '↕' },
  0x47: { label: 'Jump in place up down', glyph: '↕' },
  0x48: { label: 'Jump in place left right', glyph: '↔' },
  0x49: { label: 'Jump in place right left', glyph: '↔' },
  0x4a: { label: 'Face original direction', glyph: '·' },
  0x4b: { label: 'Nurse joy heal animation', glyph: '·' },
  0x4c: { label: 'Exclamation mark icon', glyph: '!' },
  0x4d: { label: 'Question mark icon', glyph: '?' },
  0x4e: { label: 'Heart icon', glyph: '♥' },
  0x54: { label: 'Hide reflection', glyph: '·' },
  0x55: { label: 'Show reflection', glyph: '·' },
  0x56: { label: 'Walk down (start affine)', glyph: '↓' },
  0x57: { label: 'Walk up (start affine)', glyph: '↑' },
  0x58: { label: 'Walk left (start affine)', glyph: '←' },
  0x59: { label: 'Walk right (start affine)', glyph: '→' },
  0x60: { label: 'Pause', glyph: '·' },
  0xfe: { label: 'End', glyph: '⏹' },
};

export function describeMovementAction(byte: number): MovementActionInfo {
  return MOVEMENT_ACTIONS[byte] ?? {
    label: `Action 0x${byte.toString(16).padStart(2, '0')}`,
    glyph: '?',
  };
}

export function isMovementEnd(byte: number): boolean {
  return byte === MOVEMENT_END_BYTE;
}

/** Phase O.26 - flat list of every known movement action (used for the
 *  dropdown editor in <ApplyMovementStepEditor>). Excludes the END
 *  sentinel since it'd be a "truncate the sequence" operation rather
 *  than an action edit. Sorted by byte value. */
export function listMovementActionOptions(): ReadonlyArray<{
  readonly byte: number;
  readonly label: string;
  readonly glyph: string;
}> {
  const out: Array<{ byte: number; label: string; glyph: string }> = [];
  for (const [k, info] of Object.entries(MOVEMENT_ACTIONS)) {
    const byte = Number(k);
    if (byte === MOVEMENT_END_BYTE) continue;
    out.push({ byte, label: info.label, glyph: info.glyph });
  }
  out.sort((a, b) => a.byte - b.byte);
  return out;
}
