import { useCallback, useState } from 'react';
import type { BuildProfile, BuildRunResponse } from '@rom-editor/shared';
import { ProjectApiError, runBuild } from '../api';
import { useProjectStore } from '../state';
import './BuildLauncher.css';

interface BuildLauncherProps {
  readonly buildProfile: BuildProfile | null;
}

type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAt: number }
  | { readonly kind: 'done'; readonly response: BuildRunResponse }
  | { readonly kind: 'error'; readonly message: string };

export function BuildLauncher({ buildProfile }: BuildLauncherProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const [expanded, setExpanded] = useState(false);

  const command = buildProfile?.buildCommand ?? null;
  const canRun = sessionId !== null && command !== null && state.kind !== 'running';

  const onRun = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    setState({ kind: 'running', startedAt: Date.now() });
    setExpanded(true);
    try {
      const response = await runBuild(sessionId);
      setState({ kind: 'done', response });
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
    }
  }, [sessionId]);

  if (!buildProfile) {
    return (
      <div className="build-launcher build-launcher--no-profile" data-testid="build-launcher">
        <span className="build-launcher__no-profile-msg">
          No build profile detected - run a scan, or configure a custom command via the build
          endpoint.
        </span>
      </div>
    );
  }

  return (
    <div className="build-launcher" data-testid="build-launcher">
      <button
        type="button"
        className="build-launcher__run-btn"
        data-testid="build-launcher-run"
        onClick={() => void onRun()}
        disabled={!canRun}
        title={`Run: ${command}`}
      >
        {state.kind === 'running' ? 'Building…' : `▶ Run \`${command}\``}
      </button>
      <StatusBadge state={state} />
      {state.kind !== 'idle' && (
        <button
          type="button"
          className="build-launcher__toggle-output"
          data-testid="build-launcher-toggle-output"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? '▼ Hide output' : '▶ Show output'}
        </button>
      )}
      {expanded && state.kind === 'done' && (
        <BuildOutputPanel response={state.response} />
      )}
      {expanded && state.kind === 'error' && (
        <div className="build-launcher__error" data-testid="build-launcher-error">
          {state.message}
        </div>
      )}
      {expanded && state.kind === 'running' && (
        <div className="build-launcher__running" data-testid="build-launcher-running">
          Running…
        </div>
      )}
    </div>
  );
}

function StatusBadge({ state }: { state: RunState }) {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'running':
      return (
        <span className="build-launcher__badge build-launcher__badge--running" data-testid="build-launcher-status">
          running
        </span>
      );
    case 'done': {
      const ok = state.response.exitCode === 0;
      return (
        <span
          className={`build-launcher__badge build-launcher__badge--${ok ? 'ok' : 'err'}`}
          data-testid="build-launcher-status"
        >
          exit {state.response.exitCode ?? 'null'} · {state.response.durationMs}ms
        </span>
      );
    }
    case 'error':
      return (
        <span className="build-launcher__badge build-launcher__badge--err" data-testid="build-launcher-status">
          error
        </span>
      );
  }
}

function BuildOutputPanel({ response }: { response: BuildRunResponse }) {
  return (
    <div className="build-launcher__output" data-testid="build-launcher-output">
      <div className="build-launcher__output-meta">
        <code className="build-launcher__output-cmd">{response.command}</code>
        <span>
          exit {response.exitCode ?? 'null'}
          {response.signal ? ` · signal ${response.signal}` : ''}
          {response.timedOut ? ' · timed out' : ''} · {response.durationMs}ms
        </span>
      </div>
      {response.spawnError && (
        <div className="build-launcher__output-err">spawn error: {response.spawnError}</div>
      )}
      {response.stdout && (
        <section data-testid="build-launcher-stdout">
          <h5 className="build-launcher__output-heading">stdout</h5>
          <pre className="build-launcher__output-body">{response.stdout}</pre>
        </section>
      )}
      {response.stderr && (
        <section data-testid="build-launcher-stderr">
          <h5 className="build-launcher__output-heading">stderr</h5>
          <pre className="build-launcher__output-body build-launcher__output-body--err">
            {response.stderr}
          </pre>
        </section>
      )}
    </div>
  );
}
