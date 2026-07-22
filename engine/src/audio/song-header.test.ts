import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  SONG_HEADER_FIXED_PREFIX_BYTES,
  SONG_HEADER_MAX_BLOCK_COUNT,
  SONG_HEADER_MAX_TRACK_COUNT,
  parseSongHeader,
} from './song-header.js';

interface PlantHeaderArgs {
  bufferSize?: number;
  offset?: number;
  trackCount?: number;
  blockCount?: number;
  priority?: number;
  reverb?: number;
  /** File offset that the voice-group pointer should reference. */
  voiceGroupAt?: number;
  /** File offsets the track pointers should reference. Must have
   *  length === trackCount when set, else autopopulated. */
  trackAt?: ReadonlyArray<number>;
  /** When set, overrides the encoded voice-group pointer with this raw
   *  32-bit value. */
  rawVoiceGroupPointer?: number;
}

function plantHeader(args: PlantHeaderArgs): { buf: Buffer; offset: number } {
  const offset = args.offset ?? 0x100;
  const buf = Buffer.alloc(args.bufferSize ?? 0x4000);
  const trackCount = args.trackCount ?? 1;
  buf[offset + 0x00] = trackCount;
  buf[offset + 0x01] = args.blockCount ?? 0;
  buf[offset + 0x02] = args.priority ?? 0x80;
  buf[offset + 0x03] = args.reverb ?? 0;
  const encodePtr = (at: number): number => (GBA_ROM_BASE_ADDRESS + at) >>> 0;
  buf.writeUInt32LE(
    args.rawVoiceGroupPointer !== undefined
      ? args.rawVoiceGroupPointer
      : encodePtr(args.voiceGroupAt ?? 0x800),
    offset + 0x04,
  );
  const trackAt = args.trackAt ?? Array.from({ length: trackCount }, (_, i) => 0x900 + i * 0x40);
  for (let i = 0; i < trackCount; i++) {
    buf.writeUInt32LE(encodePtr(trackAt[i]!), offset + 0x08 + i * 4);
  }
  return { buf, offset };
}

describe('parseSongHeader - happy paths', () => {
  it('parses a 1-track song header (12 bytes total)', () => {
    const { buf, offset } = plantHeader({ trackCount: 1 });
    const r = parseSongHeader(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.trackCount).toBe(1);
      expect(r.header.byteLength).toBe(12);
      expect(r.header.voiceGroupOffset).toBe(0x800);
      expect(r.header.trackOffsets).toHaveLength(1);
      expect(r.header.trackOffsets[0]).toBe(0x900);
      expect(r.header.fileOffset).toBe(offset);
    }
  });

  it('parses a 10-track song header (48 bytes total)', () => {
    const { buf, offset } = plantHeader({
      bufferSize: 0x10000,
      trackCount: 10,
      blockCount: 4,
      priority: 0x40,
      reverb: 0x60,
    });
    const r = parseSongHeader(buf, offset);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.trackCount).toBe(10);
      expect(r.header.byteLength).toBe(48);
      expect(r.header.blockCount).toBe(4);
      expect(r.header.priority).toBe(0x40);
      expect(r.header.reverb).toBe(0x60);
      expect(r.header.trackOffsets).toHaveLength(10);
    }
  });

  it('returned header is frozen', () => {
    const { buf, offset } = plantHeader({ trackCount: 1 });
    const r = parseSongHeader(buf, offset);
    if (r.ok) {
      expect(Object.isFrozen(r.header)).toBe(true);
      expect(Object.isFrozen(r.header.trackOffsets)).toBe(true);
    }
  });
});

describe('parseSongHeader - failure modes', () => {
  it('fails too_short when buffer < 8 bytes from offset', () => {
    const r = parseSongHeader(new Uint8Array(6), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails implausible_track_count when trackCount = 0', () => {
    const { buf, offset } = plantHeader({ trackCount: 0 });
    const r = parseSongHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_track_count');
  });

  it('fails implausible_track_count when trackCount > max', () => {
    const buf = Buffer.alloc(0x4000);
    buf[0x100] = SONG_HEADER_MAX_TRACK_COUNT + 1;
    const r = parseSongHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_track_count');
  });

  it('fails implausible_block_count when blockCount > max', () => {
    const buf = Buffer.alloc(0x4000);
    buf[0x100] = 1; // trackCount
    buf[0x101] = SONG_HEADER_MAX_BLOCK_COUNT + 1;
    const r = parseSongHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_block_count');
  });

  it('fails too_short when trackCount overruns the buffer', () => {
    // trackCount=8 → needs 8 + 8*4 = 40 bytes, only 16 available
    const buf = Buffer.alloc(16);
    buf[0] = 8;
    const r = parseSongHeader(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails invalid_voice_group_pointer when voice ptr is non-ROM (EWRAM)', () => {
    const { buf, offset } = plantHeader({
      trackCount: 1,
      rawVoiceGroupPointer: 0x02001234,
    });
    const r = parseSongHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_voice_group_pointer');
  });

  it('fails invalid_voice_group_pointer when voice ptr is NULL', () => {
    const { buf, offset } = plantHeader({
      trackCount: 1,
      rawVoiceGroupPointer: 0,
    });
    const r = parseSongHeader(buf, offset);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_voice_group_pointer');
  });

  it('fails invalid_track_pointer when a track ptr is non-ROM', () => {
    const buf = Buffer.alloc(0x4000);
    buf[0x100] = 2; // trackCount
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x800) >>> 0, 0x100 + 0x04); // voice ptr
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x900) >>> 0, 0x100 + 0x08); // valid track 0
    buf.writeUInt32LE(0x02000000, 0x100 + 0x0c); // invalid track 1 (EWRAM)
    const r = parseSongHeader(buf, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('invalid_track_pointer');
      if (r.failure.kind === 'invalid_track_pointer') {
        expect(r.failure.trackIndex).toBe(1);
      }
    }
  });
});

describe('SONG_HEADER_FIXED_PREFIX_BYTES', () => {
  it('equals 8', () => {
    expect(SONG_HEADER_FIXED_PREFIX_BYTES).toBe(8);
  });
});
