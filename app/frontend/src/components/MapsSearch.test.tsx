import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MapsSearch } from './MapsSearch';

const sampleResponse = {
  query: 'littleroot',
  tokenizedTerms: ['littleroot'],
  truncated: false,
  searchedAtUtc: '2026-05-16T08:00:00Z',
  hits: [
    {
      entityKind: 'map',
      entityId: 'MAP_LITTLEROOT_TOWN',
      entityName: 'LITTLEROOT_TOWN',
      score: 1,
      snippet: 'LITTLEROOT_TOWN town',
      matchedTerms: ['littleroot'],
    },
    {
      entityKind: 'dialogue',
      entityId: 'LittlerootTown_Mom_Text_WelcomeHome',
      entityName: 'LittlerootTown_Mom_Text_WelcomeHome',
      score: 0.6,
      snippet: 'Hi, honey! Welcome back!',
      matchedTerms: ['littleroot'],
    },
  ],
};

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.match(/\/api\/projects\/[^/]+\/search$/) && init?.method === 'POST') {
        return new Response(JSON.stringify(sampleResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

describe('MapsSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetchMock();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not search until query is non-empty; clears highlights on empty', () => {
    const onMatched = vi.fn();
    const onPick = vi.fn();
    render(<MapsSearch sessionId="sess-1" onMatchedMapsChange={onMatched} onPickMap={onPick} />);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onMatched).toHaveBeenLastCalledWith(new Set());
  });

  it('debounces input then issues a search and surfaces matched map ids', async () => {
    const onMatched = vi.fn();
    const onPick = vi.fn();
    render(<MapsSearch sessionId="sess-1" onMatchedMapsChange={onMatched} onPickMap={onPick} />);
    fireEvent.change(screen.getByTestId('maps-search-input'), {
      target: { value: 'littleroot' },
    });
    vi.advanceTimersByTime(300);
    await waitFor(() => {
      expect(screen.getByTestId('maps-search-results')).toBeInTheDocument();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(onMatched).toHaveBeenLastCalledWith(new Set(['MAP_LITTLEROOT_TOWN']));
    expect(screen.getByTestId('maps-search-hit-map-MAP_LITTLEROOT_TOWN')).toBeInTheDocument();
    expect(
      screen.getByTestId('maps-search-hit-dialogue-LittlerootTown_Mom_Text_WelcomeHome'),
    ).toBeInTheDocument();
  });

  it('calls onPickMap when a map hit is clicked', async () => {
    const onMatched = vi.fn();
    const onPick = vi.fn();
    render(<MapsSearch sessionId="sess-1" onMatchedMapsChange={onMatched} onPickMap={onPick} />);
    fireEvent.change(screen.getByTestId('maps-search-input'), { target: { value: 'littleroot' } });
    vi.advanceTimersByTime(300);
    await waitFor(() =>
      expect(screen.getByTestId('maps-search-hit-map-MAP_LITTLEROOT_TOWN')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('maps-search-hit-map-MAP_LITTLEROOT_TOWN'));
    expect(onPick).toHaveBeenCalledWith('MAP_LITTLEROOT_TOWN');
  });

  it('press Enter (form submit) picks the first map hit', async () => {
    const onMatched = vi.fn();
    const onPick = vi.fn();
    const { container } = render(
      <MapsSearch sessionId="sess-1" onMatchedMapsChange={onMatched} onPickMap={onPick} />,
    );
    fireEvent.change(screen.getByTestId('maps-search-input'), { target: { value: 'littleroot' } });
    vi.advanceTimersByTime(300);
    await waitFor(() =>
      expect(screen.getByTestId('maps-search-results')).toBeInTheDocument(),
    );
    const form = container.querySelector('form');
    if (!form) throw new Error('form missing');
    fireEvent.submit(form);
    expect(onPick).toHaveBeenCalledWith('MAP_LITTLEROOT_TOWN');
  });

  it('disables non-map hits (they live in their own views)', async () => {
    const onMatched = vi.fn();
    const onPick = vi.fn();
    render(<MapsSearch sessionId="sess-1" onMatchedMapsChange={onMatched} onPickMap={onPick} />);
    fireEvent.change(screen.getByTestId('maps-search-input'), { target: { value: 'littleroot' } });
    vi.advanceTimersByTime(300);
    await waitFor(() =>
      expect(
        screen.getByTestId('maps-search-hit-dialogue-LittlerootTown_Mom_Text_WelcomeHome'),
      ).toBeInTheDocument(),
    );
    const dialogueHit = screen.getByTestId('maps-search-hit-dialogue-LittlerootTown_Mom_Text_WelcomeHome');
    expect(dialogueHit).toBeDisabled();
  });
});
