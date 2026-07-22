import { describe, expect, it } from 'vitest';
import {
  TRAINER_AI_FLAGS_MAX,
  TRAINER_CLASS_MAX,
  TRAINER_NAME_BYTES,
  TRAINER_NAME_PRINTABLE_MAX,
  TRAINER_NAME_TERMINATOR,
  TRAINER_PARTY_FLAGS_MAX,
  TRAINER_PARTY_SIZE_MAX,
  TRAINER_PARTY_SIZE_MIN,
  TRAINER_STRUCT_SIZE_BYTES,
  parseTrainer,
} from './trainer.js';

interface PlantArgs {
  bufferSize?: number;
  offset?: number;
  partyFlags?: number;
  trainerClass?: number;
  encounterMusicGender?: number;
  trainerPic?: number;
  /** ASCII text; encoded as code points up to 0x7F, then 0xFF terminator + 0x00 pad. */
  trainerName?: string;
  /** Override the 12 raw name bytes (skips ASCII encoding entirely). */
  trainerNameRaw?: ReadonlyArray<number>;
  items?: [number, number, number, number];
  doubleBattle?: number;
  pad19?: number;
  pad1A?: number;
  pad1B?: number;
  aiFlags?: number;
  partySize?: number;
  pad21?: number;
  pad22?: number;
  pad23?: number;
  /** Raw u32 - caller controls whether it's a valid ROM pointer. */
  partyPointer?: number;
}

function plant(args: PlantArgs): { buf: Buffer; offset: number } {
  const offset = args.offset ?? 0x100;
  const buf = Buffer.alloc(args.bufferSize ?? 0x1000);
  buf[offset + 0x00] = args.partyFlags ?? 0;
  buf[offset + 0x01] = args.trainerClass ?? 1;
  buf[offset + 0x02] = args.encounterMusicGender ?? 5;
  buf[offset + 0x03] = args.trainerPic ?? 0;
  // Name
  if (args.trainerNameRaw !== undefined) {
    for (let k = 0; k < TRAINER_NAME_BYTES; k++) {
      buf[offset + 0x04 + k] = args.trainerNameRaw[k] ?? 0;
    }
  } else {
    const name = args.trainerName ?? 'RED';
    for (let k = 0; k < TRAINER_NAME_BYTES; k++) {
      if (k < name.length) {
        buf[offset + 0x04 + k] = name.charCodeAt(k);
      } else if (k === name.length) {
        buf[offset + 0x04 + k] = TRAINER_NAME_TERMINATOR;
      } else {
        buf[offset + 0x04 + k] = 0;
      }
    }
  }
  // items[4] u16 LE
  const items = args.items ?? [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    buf.writeUInt16LE(items[k] & 0xffff, offset + 0x10 + k * 2);
  }
  buf[offset + 0x18] = args.doubleBattle ?? 0;
  buf[offset + 0x19] = args.pad19 ?? 0;
  buf[offset + 0x1a] = args.pad1A ?? 0;
  buf[offset + 0x1b] = args.pad1B ?? 0;
  buf.writeUInt32LE((args.aiFlags ?? 1) >>> 0, offset + 0x1c);
  buf[offset + 0x20] = args.partySize ?? 3;
  buf[offset + 0x21] = args.pad21 ?? 0;
  buf[offset + 0x22] = args.pad22 ?? 0;
  buf[offset + 0x23] = args.pad23 ?? 0;
  // Default to a valid in-ROM pointer (0x08600000).
  buf.writeUInt32LE((args.partyPointer ?? 0x08600000) >>> 0, offset + 0x24);
  return { buf, offset };
}

describe('parseTrainer - happy paths', () => {
  it('parses a vanilla-shape trainer (RED, class 1, partySize 3)', () => {
    const { buf, offset } = plant({});
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trainer.partyFlags).toBe(0);
      expect(r.trainer.trainerClass).toBe(1);
      expect(r.trainer.encounterMusic).toBe(5);
      expect(r.trainer.isFemale).toBe(false);
      expect(r.trainer.partySize).toBe(3);
      expect(r.trainer.aiFlags).toBe(1);
      expect(r.trainer.trainerNameLength).toBe(3);
      expect(r.trainer.fileOffset).toBe(offset);
    }
  });

  it('flags female trainer when bit 0x80 of encounterMusic_gender is set', () => {
    const { buf, offset } = plant({ encounterMusicGender: 0x85, trainerName: 'MISTY' });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trainer.encounterMusic).toBe(5);
      expect(r.trainer.isFemale).toBe(true);
    }
  });

  it('accepts trainer with held-items partyFlags bit + items array', () => {
    const { buf, offset } = plant({ partyFlags: 2, items: [0x12, 0x13, 0, 0] });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trainer.partyFlags).toBe(2);
      expect(r.trainer.items[0]).toBe(0x12);
      expect(r.trainer.items[1]).toBe(0x13);
    }
  });

  it('accepts doubleBattle=1', () => {
    const { buf, offset } = plant({ doubleBattle: 1 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trainer.doubleBattle).toBe(true);
  });

  it('accepts partyPointer == 0 (NULL party)', () => {
    const { buf, offset } = plant({ partyPointer: 0 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trainer.partyPointer).toBe(0);
  });

  it('accepts max-length 12-char name (no terminator within field)', () => {
    const { buf, offset } = plant({ trainerName: 'ABCDEFGHIJKL' });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trainer.trainerNameLength).toBe(12);
  });

  it('accepts partySize=1 (min) and partySize=6 (max)', () => {
    const a = parseTrainer(plant({ partySize: 1 }).buf, 0x100);
    const b = parseTrainer(plant({ partySize: 6 }).buf, 0x100);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('parses 0x9FFFFFF (highest valid 32 MiB ROM pointer)', () => {
    const { buf, offset } = plant({ partyPointer: 0x09ffffff });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(true);
  });

  it('result is frozen', () => {
    const { buf, offset } = plant({});
    const r = parseTrainer(buf, offset);
    if (r.ok) {
      expect(Object.isFrozen(r.trainer)).toBe(true);
      expect(Object.isFrozen(r.trainer.items)).toBe(true);
      // trainerNameBytes is a Uint8Array - typed arrays can't be Object.freeze'd
      // (TypeError "Cannot freeze array buffer views with elements"). The outer
      // object freeze prevents reassignment of the field, which is what we need.
    }
  });
});

describe('parseTrainer - failure modes', () => {
  it('fails too_short when buffer < 40 bytes', () => {
    const r = parseTrainer(new Uint8Array(30), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails nonzero_padding when pad19 != 0', () => {
    const { buf, offset } = plant({ pad19: 0xff });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails nonzero_padding when pad1A != 0', () => {
    const { buf, offset } = plant({ pad1A: 0x42 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails nonzero_padding when pad1B != 0', () => {
    const { buf, offset } = plant({ pad1B: 0x01 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails nonzero_padding when pad21 != 0', () => {
    const { buf, offset } = plant({ pad21: 0xff });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('nonzero_padding');
  });

  it('fails nonzero_padding when any of pad22/pad23 != 0', () => {
    const a = parseTrainer(plant({ pad22: 0xab }).buf, 0x100);
    const b = parseTrainer(plant({ pad23: 0xcd }).buf, 0x100);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it('fails implausible_party_flags when partyFlags > 3', () => {
    const { buf, offset } = plant({ partyFlags: 10 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_party_flags');
  });

  it('fails implausible_double_battle when doubleBattle > 1', () => {
    const { buf, offset } = plant({ doubleBattle: 5 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_double_battle');
  });

  it('fails implausible_party_size when partySize == 0', () => {
    const { buf, offset } = plant({ partySize: 0 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_party_size');
  });

  it('fails implausible_party_size when partySize > 6', () => {
    const { buf, offset } = plant({ partySize: 12 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_party_size');
  });

  it('fails implausible_trainer_class when trainerClass > MAX', () => {
    const { buf, offset } = plant({ trainerClass: 250 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_trainer_class');
  });

  it('fails implausible_ai_flags when aiFlags > 0xFFFF', () => {
    const { buf, offset } = plant({ aiFlags: 0xff_0000 });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_ai_flags');
  });

  it('fails invalid_party_pointer when ptr is outside ROM space and != 0', () => {
    const { buf, offset } = plant({ partyPointer: 0x03000123 }); // IWRAM, not ROM
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_party_pointer');
  });

  it('fails invalid_trainer_name (control_byte) when a name byte > 0xEF', () => {
    const { buf, offset } = plant({
      trainerNameRaw: [0xfa, 0xfb, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_trainer_name');
      if (r.failure.kind === 'invalid_trainer_name') {
        expect(r.failure.reason).toBe('control_byte');
      }
    }
  });

  it('fails invalid_trainer_name (all_zero) when no printable byte before terminator', () => {
    const { buf, offset } = plant({
      trainerNameRaw: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_trainer_name');
      if (r.failure.kind === 'invalid_trainer_name') {
        expect(r.failure.reason).toBe('all_zero');
      }
    }
  });

  it('fails invalid_trainer_name (all_terminator) when name is all 0xFF', () => {
    const { buf, offset } = plant({
      trainerNameRaw: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    });
    const r = parseTrainer(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_trainer_name');
      if (r.failure.kind === 'invalid_trainer_name') {
        expect(r.failure.reason).toBe('all_terminator');
      }
    }
  });
});

describe('TRAINER constants', () => {
  it('struct size = 40', () => {
    expect(TRAINER_STRUCT_SIZE_BYTES).toBe(40);
  });
  it('name field = 12 bytes', () => {
    expect(TRAINER_NAME_BYTES).toBe(12);
  });
  it('class cap = 200, partyFlags cap = 3, partySize 1..6, aiFlags cap 0xFFFF', () => {
    expect(TRAINER_CLASS_MAX).toBe(200);
    expect(TRAINER_PARTY_FLAGS_MAX).toBe(3);
    expect(TRAINER_PARTY_SIZE_MIN).toBe(1);
    expect(TRAINER_PARTY_SIZE_MAX).toBe(6);
    expect(TRAINER_AI_FLAGS_MAX).toBe(0xffff);
  });
  it('name printable max = 0xEF, terminator = 0xFF', () => {
    expect(TRAINER_NAME_PRINTABLE_MAX).toBe(0xef);
    expect(TRAINER_NAME_TERMINATOR).toBe(0xff);
  });
});
