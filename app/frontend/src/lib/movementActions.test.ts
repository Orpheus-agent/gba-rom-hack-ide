import { describe, expect, it } from 'vitest';
import {
  describeMovementAction,
  isMovementEnd,
  MOVEMENT_END_BYTE,
} from './movementActions';

describe('movementActions', () => {
  it('describes common face directions', () => {
    expect(describeMovementAction(0x00).label).toBe('Face down');
    expect(describeMovementAction(0x00).glyph).toBe('↓');
    expect(describeMovementAction(0x01).label).toBe('Face up');
    expect(describeMovementAction(0x02).label).toBe('Face left');
    expect(describeMovementAction(0x03).label).toBe('Face right');
  });

  it('describes walk-normal actions', () => {
    expect(describeMovementAction(0x08).label).toBe('Walk normal down');
    expect(describeMovementAction(0x09).label).toBe('Walk normal up');
    expect(describeMovementAction(0x0a).label).toBe('Walk normal left');
    expect(describeMovementAction(0x0b).label).toBe('Walk normal right');
  });

  it('describes the end-of-sequence sentinel', () => {
    expect(MOVEMENT_END_BYTE).toBe(0xfe);
    expect(isMovementEnd(0xfe)).toBe(true);
    expect(isMovementEnd(0x00)).toBe(false);
    const info = describeMovementAction(0xfe);
    expect(info.label).toBe('End');
    expect(info.glyph).toBe('⏹');
  });

  it('falls back to raw hex for unknown bytes', () => {
    const info = describeMovementAction(0xab);
    expect(info.label).toBe('Action 0xab');
    expect(info.glyph).toBe('?');
  });

  it('describes pause and delay actions', () => {
    expect(describeMovementAction(0x60).label).toBe('Pause');
    expect(describeMovementAction(0x10).label).toBe('Delay 1');
    expect(describeMovementAction(0x14).label).toBe('Delay 16');
  });

  it('describes player run actions with directional glyphs', () => {
    expect(describeMovementAction(0x31).label).toBe('Player run down');
    expect(describeMovementAction(0x31).glyph).toBe('↓');
    expect(describeMovementAction(0x34).label).toBe('Player run right');
    expect(describeMovementAction(0x34).glyph).toBe('→');
  });
});
