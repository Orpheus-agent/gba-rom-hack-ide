/**
 * Smoke tests for propose_validate_map_traversal (Phase 8G-3).
 */

import { promises as fsp, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TileIntelClient } from '../../tile-intel/client.js';
import type { ValidateTraversalResponse } from '../../tile-intel/types.js';
import { proposeValidateMapTraversal } from './propose-validate-map-traversal.js';

function makeClient(
  response: ValidateTraversalResponse,
): { client: TileIntelClient; requests: unknown[] } {
  const requests: unknown[] = [];
  const fetchFn = async (
    _input: string,
    init?: { body?: string; method?: string },
  ) => {
    if (init?.body) {
      try {
        requests.push(JSON.parse(init.body));
      } catch {
        requests.push(init.body);
      }
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return response;
      },
      async text() {
        return JSON.stringify(response);
      },
    };
  };
  return { client: new TileIntelClient('http://stub', fetchFn), requests };
}

const fakeReport: ValidateTraversalResponse = {
  ok: true,
  summary: 'Traversal check passed: 12 of 12 cells walkable (100%).',
  width: 4,
  height: 3,
  issues: [],
  poi_reachability: [
    {
      poi_id: 'entrance',
      walkable: true,
      component_size: 12,
      reachable_pois: ['exit'],
    },
  ],
  walkable_summary: {
    walkable_cells: 12,
    component_count: 1,
    largest_component_size: 12,
    largest_component_share: 1.0,
  },
};

const failingReport: ValidateTraversalResponse = {
  ok: false,
  summary: 'Traversal check failed: entrance and exit are in different walkable components',
  width: 5,
  height: 3,
  issues: [
    {
      severity: 'error',
      code: 'entrance_exit_unreachable',
      message: 'entrance and exit are in different walkable components',
    },
  ],
  poi_reachability: [],
  walkable_summary: {
    walkable_cells: 8,
    component_count: 2,
    largest_component_size: 6,
    largest_component_share: 0.75,
  },
};

describe('propose_validate_map_traversal', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'traversal-test-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function seedResolved(slug: string): Promise<void> {
    const dir = path.join(projectRoot, '.editor', 'resolved-maps');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, `${slug}.resolved.json`),
      JSON.stringify({ width: 4, height: 3, pois: [] }, null, 2),
      'utf8',
    );
  }

  it('returns the validator report unchanged on happy path', async () => {
    await seedResolved('healthy');
    const { client, requests } = makeClient(fakeReport);
    const result = await proposeValidateMapTraversal(
      { projectRoot },
      { resolvedSlug: 'healthy' },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.traversalOk).toBe(true);
    expect(result.summary).toContain('Traversal check passed');
    expect(result.poiReachability.length).toBe(1);
    expect(requests.length).toBe(1);
    // The request body wraps the resolved file under "resolved".
    expect(requests[0]).toMatchObject({ resolved: { width: 4, height: 3 } });
  });

  it('surfaces traversal errors as traversalOk:false (tool still succeeds)', async () => {
    await seedResolved('broken');
    const { client } = makeClient(failingReport);
    const result = await proposeValidateMapTraversal(
      { projectRoot },
      { resolvedSlug: 'broken' },
      { clientForTests: client },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.traversalOk).toBe(false);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]!.code).toBe('entrance_exit_unreachable');
  });

  it('fails clearly when the resolved file is missing', async () => {
    const { client } = makeClient(fakeReport);
    const result = await proposeValidateMapTraversal(
      { projectRoot },
      { resolvedSlug: 'never-resolved' },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('resolved_not_found');
  });

  it('rejects unsafe characters in slug', async () => {
    const { client } = makeClient(fakeReport);
    const result = await proposeValidateMapTraversal(
      { projectRoot },
      { resolvedSlug: '???' },
      { clientForTests: client },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid_input');
  });

  it('surfaces sidecar exceptions cleanly', async () => {
    await seedResolved('error-test');
    const fetchFn = async () => {
      throw new Error('boom');
    };
    const result = await proposeValidateMapTraversal(
      { projectRoot },
      { resolvedSlug: 'error-test' },
      { clientForTests: new TileIntelClient('http://stub', fetchFn) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('sidecar_error');
    expect(result.message).toContain('boom');
  });
});
