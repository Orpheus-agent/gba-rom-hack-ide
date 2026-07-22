import { describe, it, expect, vi } from 'vitest';
import { proposePatch, ProposePatchError } from './propose-patch.js';

describe('proposePatch tool', () => {
  it('POSTs to <baseUrl>/api/agent/internal/patches and returns the proposal', async () => {
    const fakeProposal = {
      id: 'patch_abc',
      projectId: 'p1',
      description: 'rename Route 1',
      edits: [{ kind: 'replace_in_file' as const, filePath: 'a', before: 'x', after: 'y' }],
      status: 'pending' as const,
      createdAtUtc: '2026-05-22T00:00:00.000Z',
    };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeProposal,
      text: async () => '',
    });
    const result = await proposePatch(
      { projectRoot: '/x', baseUrl: 'http://127.0.0.1:8717' },
      { description: 'rename Route 1', edits: fakeProposal.edits },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(result).toEqual(fakeProposal);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:8717/api/agent/internal/patches',
      expect.objectContaining({ method: 'POST' }),
    );
    const callArgs = fetchFn.mock.calls[0]!;
    const body = JSON.parse((callArgs[1] as { body: string }).body);
    expect(body.projectRoot).toBe('/x');
    expect(body.description).toBe('rename Route 1');
  });

  it('throws ProposePatchError(no_baseurl) when baseUrl is missing', async () => {
    await expect(
      proposePatch(
        { projectRoot: '/x' },
        { description: 'd', edits: [{ kind: 'replace_in_file', filePath: 'a', before: 'x', after: 'y' }] },
      ),
    ).rejects.toBeInstanceOf(ProposePatchError);
  });

  it('throws backend_rejected when fetch returns non-2xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad_request"}',
    });
    let err: unknown;
    try {
      await proposePatch(
        { projectRoot: '/x', baseUrl: 'http://127.0.0.1:8717' },
        { description: 'd', edits: [{ kind: 'replace_in_file', filePath: 'a', before: 'x', after: 'y' }] },
        { fetchFn: fetchFn as unknown as typeof fetch },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProposePatchError);
    expect((err as ProposePatchError).code).toBe('backend_rejected');
  });

  it('throws backend_unreachable on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    let err: unknown;
    try {
      await proposePatch(
        { projectRoot: '/x', baseUrl: 'http://127.0.0.1:8717' },
        { description: 'd', edits: [{ kind: 'replace_in_file', filePath: 'a', before: 'x', after: 'y' }] },
        { fetchFn: fetchFn as unknown as typeof fetch },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProposePatchError);
    expect((err as ProposePatchError).code).toBe('backend_unreachable');
  });
});
