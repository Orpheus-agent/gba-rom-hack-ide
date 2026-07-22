import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PokemonSprite } from './PokemonSprite';
import { useProjectStore } from '../state';

describe('PokemonSprite (Phase 4.2C)', () => {
  beforeEach(() => {
    useProjectStore.setState({
      load: {
        kind: 'loaded',
        data: {
          session: {
            id: 'sess-1',
            projectRoot: '/tmp',
            name: 'test',
            createdAtUtc: '2026-05-27T00:00:00Z',
            updatedAtUtc: '2026-05-27T00:00:00Z',
          },
          rootListing: { entries: [] },
        } as never,
      },
      scan: { kind: 'idle' },
    } as never);
  });
  afterEach(() => cleanup());

  it('renders an <img> pointing at the per-project sprite endpoint', () => {
    render(<PokemonSprite speciesId={25} />);
    const img = screen.getByTestId('pokemon-sprite-25') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toContain('/api/projects/sess-1/pokemon-sprite/25.png');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('returns null when speciesId is 0', () => {
    const { container } = render(<PokemonSprite speciesId={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when no project session is loaded', () => {
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    const { container } = render(<PokemonSprite speciesId={25} />);
    expect(container.firstChild).toBeNull();
  });

  it('compact variant adds the modifier class', () => {
    render(<PokemonSprite speciesId={25} variant="compact" />);
    const img = screen.getByTestId('pokemon-sprite-25');
    expect(img.className).toMatch(/compact/);
  });

  // ---------------------------------------------------------------------------
  // Phase 9B - animation
  // ---------------------------------------------------------------------------

  it('animated="none" omits the ?frame query param (default behaviour)', () => {
    render(<PokemonSprite speciesId={25} />);
    const img = screen.getByTestId('pokemon-sprite-25') as HTMLImageElement;
    expect(img.src).not.toContain('frame=');
    expect(img.getAttribute('data-animated')).toBe('none');
  });

  it('animated="walk" cycles frames via the ?frame query param', () => {
    vi.useFakeTimers();
    try {
      render(<PokemonSprite speciesId={25} animated="walk" />);
      const img = screen.getByTestId('pokemon-sprite-25') as HTMLImageElement;
      expect(img.getAttribute('data-frame')).toBe('0');
      expect(img.src).toContain('frame=0');
      // Walk = 160 ms per frame.
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(img.getAttribute('data-frame')).toBe('1');
      act(() => {
        vi.advanceTimersByTime(160 * 3);
      });
      // Wrapped back to frame 0 after 4 ticks.
      expect(img.getAttribute('data-frame')).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('animated="idle" runs at slower cadence (~320ms per frame)', () => {
    vi.useFakeTimers();
    try {
      render(<PokemonSprite speciesId={25} animated="idle" />);
      const img = screen.getByTestId('pokemon-sprite-25') as HTMLImageElement;
      // At 160 ms (walk-pace) idle should NOT have advanced.
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(img.getAttribute('data-frame')).toBe('0');
      // At 320 ms it should be on frame 1.
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(img.getAttribute('data-frame')).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('IntersectionObserver pauses the cycle when off-screen', () => {
    vi.useFakeTimers();

    // Hand-roll a tiny IntersectionObserver mock so we can fire the
    // "not intersecting" callback at will. jsdom doesn't provide one.
    const observers: Array<{
      callback: IntersectionObserverCallback;
      observe: () => void;
      disconnect: () => void;
    }> = [];
    const realObserver = (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver =
      class {
        callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          observers.push({
            callback,
            observe: () => undefined,
            disconnect: () => undefined,
          });
        }
        observe(): void {}
        disconnect(): void {}
        unobserve(): void {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
        root = null;
        rootMargin = '';
        thresholds = [];
      } as unknown as typeof IntersectionObserver;

    try {
      render(<PokemonSprite speciesId={25} animated="walk" />);
      const img = screen.getByTestId('pokemon-sprite-25');
      // Frame timer ticks normally while visible.
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(img.getAttribute('data-frame')).toBe('1');
      // Fire "not intersecting" → visible flips off → timer cleared.
      act(() => {
        observers[0]!.callback(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          observers[0] as unknown as IntersectionObserver,
        );
      });
      const frameBefore = img.getAttribute('data-frame');
      act(() => {
        vi.advanceTimersByTime(160 * 4);
      });
      // Frame should NOT have advanced while off-screen.
      expect(img.getAttribute('data-frame')).toBe(frameBefore);
      // Re-intersect → resumes.
      act(() => {
        observers[0]!.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          observers[0] as unknown as IntersectionObserver,
        );
      });
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(img.getAttribute('data-frame')).not.toBe(frameBefore);
    } finally {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
        realObserver;
      vi.useRealTimers();
    }
  });
});
