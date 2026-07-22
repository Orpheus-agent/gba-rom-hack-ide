import { describe, it, expect } from 'vitest';
import {
  GBA_HEADER_LENGTH,
  HEADER_FIELD,
  describeGbaHeader,
  parseGbaHeader,
  readGbaHeader,
} from './header.js';
import { buildGbaHeaderBytes } from '../fixtures/synthetic-rom.js';

describe('parseGbaHeader', () => {
  it('returns ok=true for a structurally valid header', () => {
    const bytes = buildGbaHeaderBytes({
      title: 'POKEMON FIRE',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
    });
    const r = parseGbaHeader(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.gameCode).toBe('BPRE');
      expect(r.header.internalTitle).toBe('POKEMON FIRE');
      expect(r.header.makerCode).toBe('01');
      expect(r.header.softwareVersion).toBe(0);
      expect(r.header.knownGame).toBe('Pokémon FireRed');
      expect(r.header.fixedMarkerValid).toBe(true);
    }
  });

  it('returns ok=false with kind=too_short when buffer is < 192 bytes', () => {
    const bytes = Buffer.alloc(0xa0);
    const r = parseGbaHeader(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('too_short');
      if (r.failure.kind === 'too_short') {
        expect(r.failure.bytesAvailable).toBe(0xa0);
        expect(r.failure.bytesRequired).toBe(GBA_HEADER_LENGTH);
      }
    }
  });

  it('returns ok=false with kind=fixed_marker_invalid when 0xB2 ≠ 0x96', () => {
    const bytes = buildGbaHeaderBytes({
      title: 'CORRUPT',
      gameCode: 'BPRE',
      makerCode: '01',
      softwareVersion: 0,
      validFixedMarker: false,
    });
    const r = parseGbaHeader(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('fixed_marker_invalid');
      if (r.failure.kind === 'fixed_marker_invalid') {
        expect(r.failure.observedByte).toBe(0x00);
        expect(r.failure.expectedByte).toBe(0x96);
      }
    }
  });

  it('returns ok=false with kind=game_code_unreadable when game-code bytes are non-printable', () => {
    const bytes = Buffer.alloc(GBA_HEADER_LENGTH);
    bytes[HEADER_FIELD.fixedMarkerOffset] = 0x96;
    // Write deliberately non-printable game code (high bit set).
    bytes[HEADER_FIELD.gameCodeOffset] = 0xff;
    bytes[HEADER_FIELD.gameCodeOffset + 1] = 0xfe;
    bytes[HEADER_FIELD.gameCodeOffset + 2] = 0xfd;
    bytes[HEADER_FIELD.gameCodeOffset + 3] = 0xfc;
    const r = parseGbaHeader(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('game_code_unreadable');
      if (r.failure.kind === 'game_code_unreadable') {
        expect(r.failure.bytesAtOffset).toEqual([0xff, 0xfe, 0xfd, 0xfc]);
      }
    }
  });

  it('strips trailing null + space padding from title', () => {
    const bytes = buildGbaHeaderBytes({
      title: 'AB', // padded with NULs by buildGbaHeaderBytes
      gameCode: 'ZZZZ',
      makerCode: 'ZZ',
      softwareVersion: 0,
    });
    const r = parseGbaHeader(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.internalTitle).toBe('AB');
    }
  });

  it('returns knownGame=null for an unknown game code', () => {
    const bytes = buildGbaHeaderBytes({
      title: 'CUSTOM',
      gameCode: 'XYZW',
      makerCode: '99',
      softwareVersion: 1,
    });
    const r = parseGbaHeader(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header.knownGame).toBeNull();
    }
  });

  it('readGbaHeader returns null when parseGbaHeader fails', () => {
    expect(readGbaHeader(Buffer.alloc(0x10))).toBeNull();
  });

  it('readGbaHeader returns the header when parseGbaHeader succeeds', () => {
    const bytes = buildGbaHeaderBytes({
      title: 'TITLE',
      gameCode: 'AXVE',
      makerCode: '01',
      softwareVersion: 0,
    });
    const h = readGbaHeader(bytes);
    expect(h).not.toBeNull();
    expect(h?.knownGame).toBe('Pokémon Ruby');
  });

  it('describeGbaHeader formats known game name + code + title + version', () => {
    const bytes = buildGbaHeaderBytes({
      title: 'POKEMON EMER',
      gameCode: 'BPEE',
      makerCode: '01',
      softwareVersion: 2,
    });
    const h = readGbaHeader(bytes)!;
    expect(describeGbaHeader(h)).toBe('Pokémon Emerald - BPEE (POKEMON EMER) v2');
  });

  it('describeGbaHeader omits known-game prefix when unknown', () => {
    const bytes = buildGbaHeaderBytes({
      title: 'CUSTOM',
      gameCode: 'XYZW',
      makerCode: '99',
      softwareVersion: 1,
    });
    const h = readGbaHeader(bytes)!;
    expect(describeGbaHeader(h)).toBe('XYZW (CUSTOM) v1');
  });

  it('describeGbaHeader uses "(no title)" when title is empty', () => {
    const bytes = buildGbaHeaderBytes({
      title: '',
      gameCode: 'XYZW',
      makerCode: '99',
      softwareVersion: 0,
    });
    const h = readGbaHeader(bytes)!;
    expect(describeGbaHeader(h)).toBe('XYZW ((no title)) v0');
  });
});
