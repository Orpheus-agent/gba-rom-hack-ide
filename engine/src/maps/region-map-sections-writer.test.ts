import { describe, it, expect } from 'vitest';
import {
  encodeRegionMapSection,
  liftRegionMapSections,
  RegionMapSectionEncodeError,
} from './region-map-sections-writer.js';
import type { RegionMapSection } from '../world/region-map-sections.js';

describe('encodeRegionMapSection', () => {
  it('encodes a 12-byte Emerald-style entry', () => {
    const bytes = encodeRegionMapSection(
      { x: 5, y: 6, width: 2, height: 1, nameOffset: 0x100000 },
      '12byte',
    );
    expect(bytes.length).toBe(12);
    expect(bytes[0x00]).toBe(5);
    expect(bytes[0x01]).toBe(6);
    expect(bytes[0x02]).toBe(2);
    expect(bytes[0x03]).toBe(1);
    // namePointer 0x08100000 LE
    expect(bytes[0x04]).toBe(0x00);
    expect(bytes[0x05]).toBe(0x00);
    expect(bytes[0x06]).toBe(0x10);
    expect(bytes[0x07]).toBe(0x08);
    // padding zeros
    expect(bytes[0x08]).toBe(0);
    expect(bytes[0x09]).toBe(0);
    expect(bytes[0x0a]).toBe(0);
    expect(bytes[0x0b]).toBe(0);
  });

  it('encodes an 8-byte FRLG-style entry', () => {
    const bytes = encodeRegionMapSection(
      { x: 5, y: 6, width: 2, height: 1, nameOffset: 0x100000 },
      '8byte',
    );
    expect(bytes.length).toBe(8);
    // namePointer first, then x/y/w/h
    expect(bytes[0x00]).toBe(0x00);
    expect(bytes[0x01]).toBe(0x00);
    expect(bytes[0x02]).toBe(0x10);
    expect(bytes[0x03]).toBe(0x08);
    expect(bytes[0x04]).toBe(5);
    expect(bytes[0x05]).toBe(6);
    expect(bytes[0x06]).toBe(2);
    expect(bytes[0x07]).toBe(1);
  });

  it('encodes a NULL name pointer for sentinel slots', () => {
    const bytes = encodeRegionMapSection(
      { x: 0, y: 0, width: 0, height: 0, nameOffset: null },
      '12byte',
    );
    expect(bytes[0x04]).toBe(0);
    expect(bytes[0x05]).toBe(0);
    expect(bytes[0x06]).toBe(0);
    expect(bytes[0x07]).toBe(0);
  });

  it('rejects out-of-range x', () => {
    expect(() =>
      encodeRegionMapSection({ x: 300, y: 0, width: 0, height: 0, nameOffset: null }, '12byte'),
    ).toThrow(RegionMapSectionEncodeError);
  });
});

describe('liftRegionMapSections', () => {
  it('lifts scanner sections into manifest entries', () => {
    const sections: RegionMapSection[] = [
      {
        sectionIndex: 0,
        x: 5,
        y: 6,
        width: 2,
        height: 1,
        nameRomPointer: 0x08100000,
        name: 'PALLET TOWN',
        fileOffset: 0x200000,
      },
      {
        sectionIndex: 1,
        x: 6,
        y: 6,
        width: 4,
        height: 1,
        nameRomPointer: 0x08100100,
        name: 'ROUTE 1',
        fileOffset: 0x200008,
      },
    ];
    const lifted = liftRegionMapSections(sections);
    expect(lifted).toHaveLength(2);
    expect(lifted[0]!.id).toBe('region_map_section_0');
    expect(lifted[0]!.name).toBe('PALLET TOWN');
    expect(lifted[1]!.id).toBe('region_map_section_1');
    expect(lifted[1]!.x).toBe(6);
    expect(lifted[1]!.width).toBe(4);
  });
});
