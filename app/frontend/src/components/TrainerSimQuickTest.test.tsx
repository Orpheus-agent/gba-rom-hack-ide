import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TrainerSimQuickTest } from './TrainerSimQuickTest';
import { useProjectStore } from '../state';

describe('TrainerSimQuickTest (Phase 4.3F)', () => {
  // Typed loosely - vi.spyOn(global, 'fetch') returns a complex
  // generic that doesn't widen cleanly to MockInstance<unknown[], unknown>.
  // The test only needs .mockResolvedValue + .mockRestore, both of
  // which exist on the runtime mock.
  let fetchSpy: { mockResolvedValue: (v: unknown) => void; mockRestore: () => void };

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
    fetchSpy = vi.spyOn(global, 'fetch') as unknown as typeof fetchSpy;
  });

  afterEach(() => {
    cleanup();
    fetchSpy.mockRestore();
  });

  it('renders the test button', () => {
    render(<TrainerSimQuickTest trainerId="binary_trainer_1" />);
    expect(screen.getByTestId('trainer-sim-quick-test-btn')).toBeInTheDocument();
  });

  it('disables the button when no project is loaded', () => {
    useProjectStore.setState({ load: { kind: 'empty' } } as never);
    render(<TrainerSimQuickTest trainerId="binary_trainer_1" />);
    const btn = screen.getByTestId('trainer-sim-quick-test-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('clicking POSTs to the sim endpoint + renders the streamed win-rate (final event)', async () => {
    // Phase 9I - endpoint now returns SSE. Build a mock streaming
    // body that emits one progress event with isFinal: true.
    const partial = {
      winRate: 0.62,
      trialsRun: 200,
      trainerName: 'Brock',
      partySummary: [{ speciesId: 95, speciesName: 'ONIX', level: 14 }],
      benchmark: [{ speciesId: 7, speciesName: 'SQUIRTLE', level: 14 }],
      verdict: 'Easy fight.',
      isFinal: true,
    };
    const sseBody =
      'event: progress\ndata: ' + JSON.stringify(partial) + '\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    } as unknown as Response);

    render(<TrainerSimQuickTest trainerId="binary_trainer_1" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('trainer-sim-quick-test-btn'));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('trainer-sim-quick-test-result'),
      ).toBeInTheDocument();
    });
    const result = screen.getByTestId('trainer-sim-quick-test-result');
    expect(result.textContent).toContain('62%');
    expect(result.getAttribute('data-final')).toBe('true');
  });

  it('renders a progressive update for non-final chunks before the final one', async () => {
    const chunk1 = {
      winRate: 0.5,
      trialsRun: 50,
      trainerName: 'Brock',
      partySummary: [{ speciesId: 95, speciesName: 'ONIX', level: 14 }],
      benchmark: [{ speciesId: 7, speciesName: 'SQUIRTLE', level: 14 }],
      verdict: 'Coin flip.',
      isFinal: false,
    };
    const chunk2 = { ...chunk1, winRate: 0.62, trialsRun: 200, isFinal: true };
    const sseBody =
      'event: progress\ndata: ' +
      JSON.stringify(chunk1) +
      '\n\n' +
      'event: progress\ndata: ' +
      JSON.stringify(chunk2) +
      '\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    } as unknown as Response);
    render(<TrainerSimQuickTest trainerId="binary_trainer_1" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('trainer-sim-quick-test-btn'));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('trainer-sim-quick-test-result'),
      ).toBeInTheDocument();
    });
    // Final chunk's 62% wins.
    expect(screen.getByTestId('trainer-sim-quick-test-result').textContent).toContain('62%');
  });

  it('renders an error message when the endpoint fails', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'internal_error', message: 'no party' } }),
    } as Response);
    render(<TrainerSimQuickTest trainerId="binary_trainer_1" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('trainer-sim-quick-test-btn'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('trainer-sim-quick-test-error')).toBeInTheDocument();
    });
  });
});
