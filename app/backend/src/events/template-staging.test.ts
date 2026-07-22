import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageTemplate, TemplateStagingError } from './template-staging.js';

describe('stageTemplate', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'rom-editor-tmpl-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('atomically writes the staged payload to .editor/staged-templates/', async () => {
    const r = await stageTemplate({
      projectRoot,
      templateId: 'town_skeleton',
      params: { mapName: 'NewTown' },
      materialization: { summary: 'creates one map', entities: { maps: [{ id: 'NewTown' }] } },
    });
    expect(r.stagedPath).toMatch(/^\.editor\/staged-templates\/.+town_skeleton\.json$/);
    expect(r.templateId).toBe('town_skeleton');
    expect(r.stagedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const onDisk = readFileSync(path.join(projectRoot, r.stagedPath), 'utf8');
    const parsed = JSON.parse(onDisk) as { templateId: string; params: Record<string, string>; materialization: Record<string, unknown> };
    expect(parsed.templateId).toBe('town_skeleton');
    expect(parsed.params).toEqual({ mapName: 'NewTown' });
    expect((parsed.materialization as { entities: { maps: Array<{ id: string }> } }).entities.maps[0]?.id).toBe('NewTown');
  });

  it('rejects empty / oversized templateId', async () => {
    await expect(
      stageTemplate({
        projectRoot,
        templateId: '',
        params: {},
        materialization: {},
      }),
    ).rejects.toMatchObject({ name: 'TemplateStagingError', code: 'invalid_template_id' });

    await expect(
      stageTemplate({
        projectRoot,
        templateId: 'x'.repeat(200),
        params: {},
        materialization: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid_template_id' });
  });

  it('rejects non-object materialization or params', async () => {
    await expect(
      stageTemplate({
        projectRoot,
        templateId: 'town_skeleton',
        params: {} as Record<string, string>,
        // @ts-expect-error testing runtime guard
        materialization: 'not an object',
      }),
    ).rejects.toBeInstanceOf(TemplateStagingError);
  });

  it('sanitizes templateId characters in the filename (no path injection)', async () => {
    const r = await stageTemplate({
      projectRoot,
      templateId: 'evil/../injection',
      params: {},
      materialization: {},
    });
    // The dangerous chars get replaced with underscores; the staged file lives
    // strictly under .editor/staged-templates/.
    expect(r.stagedPath).toMatch(/^\.editor\/staged-templates\/.+\.json$/);
    expect(r.stagedPath).not.toContain('..');
    expect(existsSync(path.join(projectRoot, r.stagedPath))).toBe(true);
  });

  it('produces distinct filenames for two stages of the same template (timestamp differs)', async () => {
    await stageTemplate({
      projectRoot,
      templateId: 't',
      params: {},
      materialization: {},
    });
    // Sleep 5ms to make sure the timestamp at ms-resolution moves.
    await new Promise((r) => setTimeout(r, 5));
    await stageTemplate({
      projectRoot,
      templateId: 't',
      params: {},
      materialization: {},
    });
    const files = readdirSync(path.join(projectRoot, '.editor/staged-templates'));
    expect(files.length).toBe(2);
  });
});
