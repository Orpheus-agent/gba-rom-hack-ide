import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectProject, decompDetector, patchDetector } from './index.js';

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'rom-editor-detect-'));
}

function buildDecompShape(root: string, opts: { baseGame?: string; minimal?: boolean } = {}): void {
  writeFileSync(path.join(root, 'Makefile'), 'all:\n\techo build\n');
  if (opts.minimal) return;
  mkdirSync(path.join(root, 'include'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'data'));
  mkdirSync(path.join(root, 'sound'));
  mkdirSync(path.join(root, 'asm'));
  mkdirSync(path.join(root, 'tools', 'agbcc'), { recursive: true });
  if (opts.baseGame) {
    writeFileSync(path.join(root, `${opts.baseGame}.ld`), '/* linker script */\n');
  }
}

function buildPatchShape(
  root: string,
  opts: { patches?: number; rom?: boolean; inSubdir?: boolean } = { patches: 1 },
): void {
  const patches = opts.patches ?? 1;
  if (opts.inSubdir) {
    mkdirSync(path.join(root, 'patches'));
    for (let i = 0; i < patches; i++) {
      writeFileSync(path.join(root, 'patches', `mod${i}.ips`), 'patch bytes');
    }
  } else {
    for (let i = 0; i < patches; i++) {
      writeFileSync(path.join(root, `mod${i}.ips`), 'patch bytes');
    }
  }
  if (opts.rom) {
    writeFileSync(path.join(root, 'base.gba'), 'rom bytes');
  }
}

describe('decompDetector', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns high confidence for a pokeemerald-shaped decomp', async () => {
    buildDecompShape(dir, { baseGame: 'pokeemerald' });
    const r = await decompDetector.detect(dir);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.baseGame).toBe('pokeemerald');
    expect(r.displayName).toBe('pokeemerald (decomp)');
    expect(r.evidence).toContain('Makefile');
    expect(r.evidence).toContain('src/');
    expect(r.evidence).toContain('pokeemerald.ld');
  });

  it('detects pokefirered lineage by linker script', async () => {
    buildDecompShape(dir, { baseGame: 'pokefirered' });
    const r = await decompDetector.detect(dir);
    expect(r.baseGame).toBe('pokefirered');
    expect(r.displayName).toBe('pokefirered (decomp)');
  });

  it('detects pokeruby lineage by linker script', async () => {
    buildDecompShape(dir, { baseGame: 'pokeruby' });
    const r = await decompDetector.detect(dir);
    expect(r.baseGame).toBe('pokeruby');
  });

  it('returns 0 confidence for a totally empty directory', async () => {
    const r = await decompDetector.detect(dir);
    expect(r.confidence).toBe(0);
    expect(r.evidence).toHaveLength(0);
  });

  it('returns low confidence + a warning for a Makefile-only directory', async () => {
    buildDecompShape(dir, { minimal: true });
    const r = await decompDetector.detect(dir);
    expect(r.confidence).toBeLessThan(0.4);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('patchDetector', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects patch files at the root', async () => {
    buildPatchShape(dir, { patches: 2 });
    const r = await patchDetector.detect(dir);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.displayName).toMatch(/2 patch files/);
    expect(r.evidence.filter((e) => e.endsWith('.ips'))).toHaveLength(2);
    expect(r.warnings.some((w) => /no \.gba base ROM/i.test(w))).toBe(true);
  });

  it('reaches max confidence with patches + base ROM', async () => {
    buildPatchShape(dir, { patches: 1, rom: true });
    const r = await patchDetector.detect(dir);
    expect(r.confidence).toBe(1);
    expect(r.displayName).toMatch(/base ROM/);
    expect(r.warnings).toHaveLength(0);
  });

  it('detects patches in a patches/ subdirectory', async () => {
    buildPatchShape(dir, { patches: 1, inSubdir: true });
    const r = await patchDetector.detect(dir);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.evidence[0]).toMatch(/^patches\//);
  });

  it('classifies a bare .gba as a patch project workspace at confidence >= 0.4', async () => {
    // Stub bytes - too short to parse as a GBA header, but the file existing
    // is enough to score 0.4 (the bare-ROM threshold).
    writeFileSync(path.join(dir, 'base.gba'), 'rom');
    const r = await patchDetector.detect(dir);
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
    expect(r.warnings.some((w) => /bare-ROM/i.test(w))).toBe(true);
    expect(r.displayName).toMatch(/Bare ROM/);
  });

  it('surfaces ROM header info in evidence + baseGame for a vanilla FireRed header', async () => {
    // Build a 256-byte buffer with a valid GBA header: BPRE / POKEMON FIRE.
    const buf = Buffer.alloc(0x200, 0);
    buf.write('POKEMON FIRE', 0xa0, 'ascii');
    buf.write('BPRE', 0xac, 'ascii');
    buf.write('01', 0xb0, 'ascii');
    buf[0xb2] = 0x96; // mandatory fixed marker
    buf[0xbc] = 1;
    writeFileSync(path.join(dir, 'firered.gba'), buf);
    const r = await patchDetector.detect(dir);
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
    expect(r.baseGame).toBe('Pokémon FireRed');
    expect(r.evidence.some((e) => /ROM header.*BPRE/.test(e))).toBe(true);
  });

  it('warns when a .gba file is present but its header is unparseable', async () => {
    // 256 bytes but the 0x96 fixed marker is wrong - not a real GBA ROM.
    const buf = Buffer.alloc(0x200, 0);
    buf.write('PROBABLY NOT', 0xa0, 'ascii');
    buf.write('XXXX', 0xac, 'ascii');
    buf[0xb2] = 0x00; // intentionally wrong
    writeFileSync(path.join(dir, 'corrupt.gba'), buf);
    const r = await patchDetector.detect(dir);
    expect(r.warnings.some((w) => /don't parse as a GBA cartridge header/i.test(w))).toBe(true);
    expect(r.baseGame).toBeNull();
  });

  it('returns 0 confidence for an empty directory', async () => {
    const r = await patchDetector.detect(dir);
    expect(r.confidence).toBe(0);
  });

  // Phase 6.2 - op-log → identity trust signal. When the project's
  // op-log records a modernize_rom entry whose newSha1 matches the
  // currently-loaded ROM, the detector promotes identity with
  // `modernizedBy` + `overlaySafe = true` so the vanilla-truth
  // overlay (Phase 6.5) can assert real labels with confidence.
  describe('Phase 6.2 - modernize op-log trust signal', () => {
    function writeRomWithFireRedHeader(romPath: string): string {
      // Build a 2 KB buffer with a valid GBA header for BPRE / FireRed.
      // The detector reads + SHA-1s the WHOLE file (line 185), so a
      // bigger buffer means a more realistic SHA-1 (and lets the
      // hackFingerprint lookup safely miss without matching anything
      // else by accident).
      const buf = Buffer.alloc(0x800, 0);
      buf.write('POKEMON FIRE', 0xa0, 'ascii');
      buf.write('BPRE', 0xac, 'ascii');
      buf.write('01', 0xb0, 'ascii');
      buf[0xb2] = 0x96; // mandatory fixed marker
      buf[0xbc] = 1;
      // Sprinkle some non-zero content so the SHA-1 isn't trivially
      // shared across tests (each test sets a few unique bytes).
      writeFileSync(romPath, buf);
      return createHash('sha1').update(buf).digest('hex');
    }

    function seedOpLog(projectRoot: string, payload: Record<string, unknown>): void {
      mkdirSync(path.join(projectRoot, '.editor'), { recursive: true });
      const entry = {
        entryId: 'test-entry-id',
        atUtc: '2026-05-27T00:00:00.000Z',
        sessionId: 'test-session',
        op: 'modernize_rom',
        payload,
      };
      writeFileSync(
        path.join(projectRoot, '.editor', 'op-log.jsonl'),
        JSON.stringify(entry) + '\n',
      );
    }

    it('sets modernizedBy=CFRU+DPE + overlaySafe=true when op-log has matching dpe entry', async () => {
      const romPath = path.join(dir, 'modernized.gba');
      const romSha1 = writeRomWithFireRedHeader(romPath);
      // Mark this fixture distinct so we don't collide with the cfru
      // test's hash.
      const buf = Buffer.alloc(0x800, 0);
      buf.write('POKEMON FIRE', 0xa0, 'ascii');
      buf.write('BPRE', 0xac, 'ascii');
      buf.write('01', 0xb0, 'ascii');
      buf[0xb2] = 0x96;
      buf[0xbc] = 1;
      buf[0x100] = 0xab; // tag this rom as the dpe fixture
      writeFileSync(romPath, buf);
      const taggedSha1 = createHash('sha1').update(buf).digest('hex');
      void romSha1; // unused; the second write overrode the hash

      seedOpLog(dir, {
        previousSha1: 'aaaa' + '00'.repeat(18),
        newSha1: taggedSha1,
        bundleId: 'dpe',
        cfruVersion: 'CFRU+DPE (test)',
      });

      const r = await patchDetector.detect(dir);
      expect(r.modernizedBy).toBe('CFRU+DPE');
      expect(r.overlaySafe).toBe(true);
    });

    it('sets modernizedBy=CFRU when op-log carries bundleId=cfru', async () => {
      const romPath = path.join(dir, 'modernized.gba');
      const buf = Buffer.alloc(0x800, 0);
      buf.write('POKEMON FIRE', 0xa0, 'ascii');
      buf.write('BPRE', 0xac, 'ascii');
      buf.write('01', 0xb0, 'ascii');
      buf[0xb2] = 0x96;
      buf[0xbc] = 1;
      buf[0x100] = 0xcd; // distinct fixture
      writeFileSync(romPath, buf);
      const sha1 = createHash('sha1').update(buf).digest('hex');

      seedOpLog(dir, {
        previousSha1: 'aaaa' + '00'.repeat(18),
        newSha1: sha1,
        bundleId: 'cfru',
      });

      const r = await patchDetector.detect(dir);
      expect(r.modernizedBy).toBe('CFRU');
      expect(r.overlaySafe).toBe(true);
    });

    it('falls back to CFRU when an older op-log entry has no bundleId field', async () => {
      // Pre-Phase-6.2 entries omitted bundleId. The trust signal
      // helper falls back to 'cfru' so legacy modernized ROMs still
      // get the overlay (the cfru chain is the conservative default,
      // overlay-safe either way).
      const romPath = path.join(dir, 'modernized.gba');
      const buf = Buffer.alloc(0x800, 0);
      buf.write('POKEMON FIRE', 0xa0, 'ascii');
      buf.write('BPRE', 0xac, 'ascii');
      buf.write('01', 0xb0, 'ascii');
      buf[0xb2] = 0x96;
      buf[0xbc] = 1;
      buf[0x100] = 0xef;
      writeFileSync(romPath, buf);
      const sha1 = createHash('sha1').update(buf).digest('hex');

      seedOpLog(dir, {
        previousSha1: 'aaaa' + '00'.repeat(18),
        newSha1: sha1,
        // bundleId intentionally omitted
      });

      const r = await patchDetector.detect(dir);
      expect(r.modernizedBy).toBe('CFRU');
      expect(r.overlaySafe).toBe(true);
    });

    it('leaves modernizedBy/overlaySafe absent when op-log has no matching entry', async () => {
      const romPath = path.join(dir, 'random.gba');
      const buf = Buffer.alloc(0x800, 0);
      buf.write('POKEMON FIRE', 0xa0, 'ascii');
      buf.write('BPRE', 0xac, 'ascii');
      buf.write('01', 0xb0, 'ascii');
      buf[0xb2] = 0x96;
      buf[0xbc] = 1;
      buf[0x100] = 0x12;
      writeFileSync(romPath, buf);

      // Op-log entry whose newSha1 is NOT the current ROM's hash.
      seedOpLog(dir, {
        previousSha1: 'aaaa' + '00'.repeat(18),
        newSha1: 'ffff' + '00'.repeat(18), // doesn't match
        bundleId: 'dpe',
      });

      const r = await patchDetector.detect(dir);
      expect(r.modernizedBy).toBeUndefined();
      expect(r.overlaySafe).toBeUndefined();
    });

    it('leaves modernizedBy/overlaySafe absent when no op-log exists', async () => {
      const romPath = path.join(dir, 'random.gba');
      const buf = Buffer.alloc(0x800, 0);
      buf.write('POKEMON FIRE', 0xa0, 'ascii');
      buf.write('BPRE', 0xac, 'ascii');
      buf.write('01', 0xb0, 'ascii');
      buf[0xb2] = 0x96;
      buf[0xbc] = 1;
      buf[0x100] = 0x34;
      writeFileSync(romPath, buf);

      const r = await patchDetector.detect(dir);
      expect(r.modernizedBy).toBeUndefined();
      expect(r.overlaySafe).toBeUndefined();
    });
  });
});

describe('detectProject orchestrator', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies a clean decomp directory as kind="decomp"', async () => {
    buildDecompShape(dir, { baseGame: 'pokeemerald' });
    const id = await detectProject(dir);
    expect(id.kind).toBe('decomp');
    expect(id.confidence).toBeGreaterThanOrEqual(0.9);
    expect(id.baseGame).toBe('pokeemerald');
    expect(id.displayName).toBe('pokeemerald (decomp)');
  });

  it('classifies a patches+ROM workspace as kind="patch"', async () => {
    buildPatchShape(dir, { patches: 1, rom: true });
    const id = await detectProject(dir);
    expect(id.kind).toBe('patch');
    expect(id.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('classifies a decomp tree containing patch artifacts as kind="hybrid"', async () => {
    buildDecompShape(dir, { baseGame: 'pokeemerald' });
    buildPatchShape(dir, { patches: 1, rom: true });
    const id = await detectProject(dir);
    expect(id.kind).toBe('hybrid');
    expect(id.confidence).toBeGreaterThanOrEqual(0.5);
    expect(id.displayName).toMatch(/Hybrid/);
    expect(id.baseGame).toBe('pokeemerald');
    expect(id.evidence).toContain('pokeemerald.ld');
    expect(id.evidence.some((e) => e.endsWith('.ips'))).toBe(true);
  });

  it('returns kind="unknown" with a warning for an empty directory', async () => {
    const id = await detectProject(dir);
    expect(id.kind).toBe('unknown');
    expect(id.confidence).toBe(0);
    expect(id.warnings.length).toBeGreaterThan(0);
    expect(id.warnings[0]).toMatch(/No decomp or patch indicators/);
  });

  it('returns kind="unknown" for a sub-threshold decomp', async () => {
    buildDecompShape(dir, { minimal: true });
    const id = await detectProject(dir);
    expect(id.kind).toBe('unknown');
    expect(id.confidence).toBe(0);
  });

  it('surfaces concrete evidence for the classification (no mystery state)', async () => {
    buildDecompShape(dir, { baseGame: 'pokefirered' });
    const id = await detectProject(dir);
    expect(id.evidence.length).toBeGreaterThan(3);
    expect(id.evidence).toContain('Makefile');
    expect(id.evidence).toContain('pokefirered.ld');
  });
});
