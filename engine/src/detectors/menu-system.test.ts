import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { loadRomFromBytes } from '../rom/index.js';
import { encodeString } from '../text/codec.js';
import { MENU_SYSTEM_DETECTOR_ID, menuSystemDetector } from './menu-system.js';

function plantPrompts(buf: Uint8Array, offsetStart: number, prompts: ReadonlyArray<string>): void {
  let cursor = offsetStart;
  for (const p of prompts) {
    const bytes = encodeString(p);
    buf.set(bytes, cursor);
    cursor += bytes.length + 16; // gap between prompts
  }
}

describe('menuSystemDetector', () => {
  it('exports the universal RomDetector contract', () => {
    expect(menuSystemDetector.id).toBe(MENU_SYSTEM_DETECTOR_ID);
    expect(typeof menuSystemDetector.name).toBe('string');
    expect(menuSystemDetector.phase).toBe(8);
    expect(typeof menuSystemDetector.detect).toBe('function');
  });

  it('returns not_detected on ROM too small', () => {
    const bytes = new Uint8Array(220); // < 0xC0+64=256
    bytes[0xb2] = 0x96;
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://tiny', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = menuSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') expect(r.reason).toContain('too small');
  });

  it('returns not_detected when fewer than 3 prompts found', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
    // Plant only 2 prompts - below the min-matches threshold of 3.
    plantPrompts(bytes, 0x800, ['CONTINUE', 'EXIT']);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://few-prompts', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = menuSystemDetector.detect(rom, cov);
    expect(r.status).toBe('not_detected');
    if (r.status === 'not_detected') {
      expect(r.reason).toContain('Fewer than 3');
    }
  });

  it('detects when ≥3 canonical prompts are planted + registers coverage', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    plantPrompts(bytes, 0x800, ['CONTINUE', 'NEW GAME', 'OPTION', 'EXIT']);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://menu', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = menuSystemDetector.detect(rom, cov);
    expect(r.status).toBe('detected');
    if (r.status === 'detected') {
      expect(r.data.matchedPromptCount).toBeGreaterThanOrEqual(4);
      expect(r.data.primaryPrompt).toBe('CONTINUE');
      expect(r.data.primaryOffset).toBe(0x800);
      const matchTexts = r.data.matches.map((m) => m.text);
      expect(matchTexts).toContain('CONTINUE');
      expect(matchTexts).toContain('NEW GAME');
      expect(matchTexts).toContain('OPTION');
      expect(matchTexts).toContain('EXIT');
    }
    const report = cov.report();
    const menuRegions = report.regions.filter((rgn) =>
      rgn.provenance?.includes(MENU_SYSTEM_DETECTOR_ID),
    );
    expect(menuRegions.length).toBe(1);
    expect(menuRegions[0]?.start).toBe(0x800);
  });

  it('confidence scales with the number of distinct prompts found', () => {
    // 3 prompts → 0.88
    const buf1 = new Uint8Array(16 * 1024);
    buf1[0xb2] = 0x96;
    plantPrompts(buf1, 0x800, ['CONTINUE', 'NEW GAME', 'OPTION']);
    const rom1 = loadRomFromBytes({ bytes: buf1, sourcePath: 'test://3', synthetic: true });
    const cov1 = new CoverageMap(buf1.length);
    const r1 = menuSystemDetector.detect(rom1, cov1);
    if (r1.status === 'detected') expect(r1.confidence).toBeCloseTo(0.88, 5);

    // 6 prompts → 0.95
    const buf2 = new Uint8Array(16 * 1024);
    buf2[0xb2] = 0x96;
    plantPrompts(buf2, 0x800, [
      'CONTINUE',
      'NEW GAME',
      'OPTION',
      'PLAYER',
      'EXIT',
      'SETTING',
    ]);
    const rom2 = loadRomFromBytes({ bytes: buf2, sourcePath: 'test://6', synthetic: true });
    const cov2 = new CoverageMap(buf2.length);
    const r2 = menuSystemDetector.detect(rom2, cov2);
    if (r2.status === 'detected') expect(r2.confidence).toBeCloseTo(0.95, 5);
  });

  it('result.data is frozen including the matches array', () => {
    const bytes = new Uint8Array(16 * 1024);
    bytes[0xb2] = 0x96;
    plantPrompts(bytes, 0x800, ['CONTINUE', 'NEW GAME', 'OPTION', 'EXIT']);
    const rom = loadRomFromBytes({ bytes, sourcePath: 'test://frozen', synthetic: true });
    const cov = new CoverageMap(bytes.length);
    const r = menuSystemDetector.detect(rom, cov);
    if (r.status === 'detected') {
      expect(Object.isFrozen(r.data)).toBe(true);
      expect(Object.isFrozen(r.data.matches)).toBe(true);
    }
  });
});
