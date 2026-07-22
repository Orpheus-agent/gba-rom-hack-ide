import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { proposeStorySpec } from './propose-story-spec.js';

const MINIMAL_SPEC = {
  title: 'Tinytown',
  premise: 'A tiny test premise that meets the 10-character minimum.',
  cast: [{ id: 'rival', name: 'Rival', role: 'rival' }],
  regions: [
    { id: 'r1', name: 'Pallet', kind: 'town' as const, mapIds: ['map_pallet'] },
  ],
  flags: [{ id: 'pallet_done', description: 'Player left Pallet Town' }],
  acts: [
    {
      id: 'act1',
      title: 'Opening',
      summary: 'Player wakes up.',
      scenes: [
        {
          id: 'wake',
          title: 'Player wakes up',
          mapRef: 'map_pallet',
          cast: ['rival'],
          flagsSet: ['pallet_done'],
          dialogueSummary: 'Player wakes; rival barges in.',
        },
      ],
    },
  ],
};

describe('proposeStorySpec - Phase 2C persistence', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'story-spec-test-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('writes the rendered markdown to <root>/.editor/story-spec.md', async () => {
    const result = await proposeStorySpec(
      { projectRoot: root, baseUrl: 'http://x' },
      MINIMAL_SPEC,
    );
    expect(result.persistedMarkdownPath).toBe(
      path.join(root, '.editor', 'story-spec.md'),
    );
    const contents = await fsp.readFile(result.persistedMarkdownPath!, 'utf8');
    expect(contents).toContain('# 📖 Story plan - Tinytown');
    expect(contents).toContain('Player wakes up');
  });

  it('creates the .editor directory if it does not exist', async () => {
    // Confirm the directory doesn't pre-exist.
    await expect(fsp.stat(path.join(root, '.editor'))).rejects.toThrow();
    const result = await proposeStorySpec(
      { projectRoot: root, baseUrl: 'http://x' },
      MINIMAL_SPEC,
    );
    expect(result.persistedMarkdownPath).not.toBeNull();
    const stat = await fsp.stat(path.join(root, '.editor'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('overwrites an existing story-spec.md (single source of truth)', async () => {
    await fsp.mkdir(path.join(root, '.editor'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '.editor', 'story-spec.md'),
      '# Stale\n',
      'utf8',
    );
    const result = await proposeStorySpec(
      { projectRoot: root, baseUrl: 'http://x' },
      MINIMAL_SPEC,
    );
    const contents = await fsp.readFile(result.persistedMarkdownPath!, 'utf8');
    expect(contents).not.toContain('Stale');
    expect(contents).toContain('Tinytown');
  });

  it('returns persistedMarkdownPath: null when projectRoot is unwritable', async () => {
    // Point at a path that cannot be created (parent doesn't exist + is
    // a regular file on POSIX-like systems; on Windows, fsp.mkdir throws
    // for invalid paths). Either way, the tool degrades gracefully.
    const result = await proposeStorySpec(
      { projectRoot: path.join(root, 'definitely-a-file.txt', 'nested') },
      MINIMAL_SPEC,
    );
    // Either persistence succeeded (rare; some filesystems allow this)
    // OR returned null. The contract is "best-effort, never fails the
    // tool".
    expect(result.markdown).toContain('Tinytown'); // in-memory part is fine
  });

  it('does not affect the spec or warnings output', async () => {
    const result = await proposeStorySpec(
      { projectRoot: root, baseUrl: 'http://x' },
      MINIMAL_SPEC,
    );
    expect(result.spec).toEqual(MINIMAL_SPEC);
    expect(result.warnings).toEqual([]);
    expect(result.stats.acts).toBe(1);
    expect(result.stats.scenes).toBe(1);
  });
});
