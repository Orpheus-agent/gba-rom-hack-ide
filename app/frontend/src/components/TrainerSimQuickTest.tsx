/**
 * Phase 4.3F - Inline damage-sim quick test.
 *
 * Small "Test this team" button inside the trainer inspector. Clicking
 * it POSTs to /api/projects/:id/sim-trainer-battle and renders the
 * win-rate as a colored bar + a one-line verdict.
 *
 * Helps the user answer "is my Gym Leader 3 team too hard / easy
 * for a level-22 player?" without booting the emulator.
 */

import { useState } from 'react';
import { ProjectApiError } from '../api';
import { useProjectStore } from '../state';
import './TrainerSimQuickTest.css';

interface SimResponse {
  readonly winRate: number;
  readonly trialsRun: number;
  readonly trainerName: string;
  readonly partySummary: ReadonlyArray<{
    readonly speciesId: number;
    readonly speciesName: string | null;
    readonly level: number;
  }>;
  readonly benchmark: ReadonlyArray<{
    readonly speciesId: number;
    readonly speciesName: string | null;
    readonly level: number;
  }>;
  readonly verdict: string;
}

export interface TrainerSimQuickTestProps {
  readonly trainerId: string;
  /** Override the default trial count (10..500). Higher = more
   *  precise but slower. Default 100. */
  readonly trials?: number;
}

export function TrainerSimQuickTest({
  trainerId,
  trials,
}: TrainerSimQuickTestProps): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [state, setState] = useState<
    | { kind: 'idle' }
    // Phase 9I - progressive: a partial result lands every chunk
    // (~10/50/100/200 trials) so the UI updates while the sim runs.
    | { kind: 'running'; partial: SimResponse | null }
    | { kind: 'done'; result: SimResponse }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function runSim(): Promise<void> {
    if (!sessionId) {
      setState({ kind: 'error', message: 'No project open.' });
      return;
    }
    setState({ kind: 'running', partial: null });
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(sessionId)}/sim-trainer-battle`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify({ trainerId, ...(trials !== undefined ? { trials } : {}) }),
        },
      );
      if (!response.ok) {
        let message = `HTTP ${String(response.status)}`;
        try {
          const body = (await response.json()) as { error?: { code: string; message: string } };
          if (body.error) message = `${body.error.code}: ${body.error.message}`;
        } catch {
          /* keep default */
        }
        setState({ kind: 'error', message });
        return;
      }
      // Phase 9I - read the SSE stream. Each event is a partial
      // result; the one with `isFinal: true` is the final answer.
      if (!response.body) {
        setState({ kind: 'error', message: 'No response body - streaming unsupported.' });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let last: (SimResponse & { isFinal?: boolean }) | null = null;
      // Stream loop: pull chunks, split on the SSE event delimiter
      // (double-newline), parse each `data:` line as JSON, and
      // update state.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          // Extract the data line(s).
          const dataLines = rawEvent
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6));
          if (dataLines.length === 0) continue;
          try {
            const parsed = JSON.parse(dataLines.join('\n')) as SimResponse & {
              isFinal?: boolean;
            };
            last = parsed;
            if (parsed.isFinal) {
              setState({ kind: 'done', result: parsed });
            } else {
              setState({ kind: 'running', partial: parsed });
            }
          } catch {
            /* skip malformed event */
          }
        }
      }
      // If the stream closed without an isFinal event but we got
      // at least one partial, treat the last one as final.
      if (last && (!last.isFinal)) {
        setState({ kind: 'done', result: last });
      }
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
    }
  }

  return (
    <div className="trainer-sim-quick-test" data-testid="trainer-sim-quick-test">
      <button
        type="button"
        className="trainer-sim-quick-test__btn"
        onClick={() => void runSim()}
        disabled={state.kind === 'running' || !sessionId}
        data-testid="trainer-sim-quick-test-btn"
        title="Approximate win rate vs a level-matched starter trio. ~1s to run."
      >
        {state.kind === 'running' ? 'Running…' : '⚔️ Test this team'}
      </button>
      {state.kind === 'error' && (
        <div className="trainer-sim-quick-test__error" data-testid="trainer-sim-quick-test-error">
          {state.message}
        </div>
      )}
      {/* Phase 9I - render the partial state with the same shape as
          'done' so the bar grows + the verdict refines as chunks
          arrive. The only visible difference is the label, which
          says "after N trials so far" while running. */}
      {(state.kind === 'running' && state.partial) || state.kind === 'done' ? (
        <SimResultPanel
          result={state.kind === 'done' ? state.result : state.partial!}
          isFinal={state.kind === 'done'}
        />
      ) : null}
    </div>
  );
}

function SimResultPanel({
  result,
  isFinal,
}: {
  readonly result: SimResponse;
  readonly isFinal: boolean;
}): JSX.Element {
  return (
    <div
      className="trainer-sim-quick-test__result"
      data-testid="trainer-sim-quick-test-result"
      data-final={isFinal ? 'true' : 'false'}
    >
      <div className="trainer-sim-quick-test__bar-row">
        <span className="trainer-sim-quick-test__pct">
          Player wins {(result.winRate * 100).toFixed(0)}%{' '}
          {isFinal
            ? `of ${String(result.trialsRun)} trials`
            : `(after ${String(result.trialsRun)} trials so far…)`}
        </span>
      </div>
      <div className="trainer-sim-quick-test__bar">
        <div
          className={
            'trainer-sim-quick-test__fill ' +
            (result.winRate >= 0.65
              ? 'trainer-sim-quick-test__fill--easy'
              : result.winRate >= 0.45
                ? 'trainer-sim-quick-test__fill--balanced'
                : result.winRate >= 0.25
                  ? 'trainer-sim-quick-test__fill--hard'
                  : 'trainer-sim-quick-test__fill--brutal')
          }
          style={{ width: `${(result.winRate * 100).toFixed(1)}%` }}
        />
      </div>
      <div className="trainer-sim-quick-test__verdict">{result.verdict}</div>
      <details className="trainer-sim-quick-test__details">
        <summary>vs benchmark</summary>
        <ul className="trainer-sim-quick-test__list">
          {result.benchmark.map((b) => (
            <li key={b.speciesId}>
              Lv {String(b.level)} {b.speciesName ?? `Species #${String(b.speciesId)}`}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
