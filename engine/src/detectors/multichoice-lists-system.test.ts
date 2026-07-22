import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString, STRING_TERMINATOR } from '../text/codec.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  MULTICHOICE_LISTS_SYSTEM_DETECTOR_ID,
  multichoiceListsSystemDetector,
} from './multichoice-lists-system.js';

function writeU32LE(b: Uint8Array, offset: number, v: number): void {
  b[offset] = v & 0xff;
  b[offset + 1] = (v >> 8) & 0xff;
  b[offset + 2] = (v >> 16) & 0xff;
  b[offset + 3] = (v >> 24) & 0xff;
}

function plantString(buf: Uint8Array, offset: number, text: string): void {
  const encoded = encodeString(text);
  for (let i = 0; i < encoded.length; i++) buf[offset + i] = encoded[i]!;
  buf[offset + encoded.length] = STRING_TERMINATOR;
}

interface SyntheticListSpec {
  readonly choices: ReadonlyArray<string>;
}

/** Build a synthetic ROM containing a gMultichoiceLists table at `tableOff`
 *  with the given list specs. Lists' MenuAction arrays land at fixed
 *  offsets after the table; the choice text strings land in a string pool
 *  after the actions. Returns the planted ROM. */
function buildRomWithMultichoiceLists(
  tableOff: number,
  lists: ReadonlyArray<SyntheticListSpec>,
  romSize: number,
): Uint8Array {
  const bytes = new Uint8Array(romSize);
  // Fill 0..0xc0 with cartridge-header-ish data so detectors don't bail.
  bytes[0xb2] = 0x96;
  // Plant MenuAction arrays starting at actionsBase, text strings after.
  const actionsBase = tableOff + lists.length * 8 + 16; // some padding
  let stringCursor = actionsBase + lists.reduce((n, l) => n + l.choices.length * 8, 0) + 16;
  let listCursor = actionsBase;
  for (let i = 0; i < lists.length; i++) {
    const spec = lists[i]!;
    const listFileOff = listCursor;
    // Each choice: { u32 textPtr, u32 funcPtr=0 }.
    for (const choice of spec.choices) {
      plantString(bytes, stringCursor, choice);
      writeU32LE(bytes, listCursor, (GBA_ROM_BASE_ADDRESS + stringCursor) >>> 0);
      writeU32LE(bytes, listCursor + 4, 0); // funcPtr ignored
      listCursor += 8;
      stringCursor += choice.length + 1;
    }
    // Plant table entry: { u32 listPtr, u8 count, u8[3] pad=0 }.
    const entryOff = tableOff + i * 8;
    writeU32LE(bytes, entryOff, (GBA_ROM_BASE_ADDRESS + listFileOff) >>> 0);
    bytes[entryOff + 4] = spec.choices.length;
    bytes[entryOff + 5] = 0;
    bytes[entryOff + 6] = 0;
    bytes[entryOff + 7] = 0;
  }
  return bytes;
}

describe('multichoice-lists-system detector', () => {
  it('detects a planted gMultichoiceLists table', () => {
    const lists: SyntheticListSpec[] = [];
    for (let i = 0; i < 12; i++) {
      lists.push({ choices: [`YES${String(i)}`, `NO${String(i)}`, `MAYBE${String(i)}`] });
    }
    const bytes = buildRomWithMultichoiceLists(0x1000, lists, 64 * 1024);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://multichoice', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = multichoiceListsSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.tableStart).toBe(0x1000);
      expect(r.data.entryCount).toBe(12);
      // First sample list has 3 choices.
      expect(r.data.sampleLists[0]?.count).toBe(3);
      expect(r.data.sampleLists[0]?.choices[0]?.text).toBe('YES0');
      expect(r.data.sampleLists[0]?.choices[1]?.text).toBe('NO0');
      expect(r.data.sampleLists[0]?.choices[2]?.text).toBe('MAYBE0');
      // Each choice gets a file offset for editing.
      expect(r.data.sampleLists[0]?.choices[0]?.textFileOffset).toBeGreaterThan(0);
      expect(r.data.sampleLists[0]?.entryFileOffset).toBe(0x1000);
      expect(r.data.sampleLists[1]?.entryFileOffset).toBe(0x1008);
      // Confidence rises with entry count.
      expect(r.confidence).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('coverage map gets a classified region for the table', () => {
    const lists: SyntheticListSpec[] = [];
    for (let i = 0; i < 12; i++) lists.push({ choices: ['YES', 'NO'] });
    const bytes = buildRomWithMultichoiceLists(0x1000, lists, 64 * 1024);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://multichoice2', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    multichoiceListsSystemDetector.detect(rom, cov);
    const report = cov.report();
    const regions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(MULTICHOICE_LISTS_SYSTEM_DETECTOR_ID),
    );
    expect(regions.length).toBe(1);
    expect(regions[0]?.start).toBe(0x1000);
  });

  it('emits not_detected for a ROM with no plausible table', () => {
    const bytes = new Uint8Array(64 * 1024);
    bytes[0xb2] = 0x96;
    // Fill with non-zero, non-pointer junk so no run can anchor.
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = ((i * 13) & 0xff) || 0x42;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://no-multichoice', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = multichoiceListsSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
  });

  it('emits not_detected for a too-small ROM', () => {
    const bytes = new Uint8Array(256);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = multichoiceListsSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
  });
});
