import { useEffect, useState } from 'react';
import { fetchModernizeAttribution, ProjectApiError } from '../api';
import type { ModernizeAttribution } from '@rom-editor/shared';
import './AttributionPanel.css';

interface AttributionPanelProps {
  readonly sessionId: string;
  /** Render style. `'inline'` collapses to a details/summary block
   *  under the IdentityCard; `'card'` shows everything expanded
   *  (used by the post-modernize success state). */
  readonly variant?: 'inline' | 'card';
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: ModernizeAttribution }
  | { readonly kind: 'error'; readonly message: string };

/** Modernize-and-Ship slice 7 - the surface that honors CFRU's
 *  no-monetization license clause. Pulls the bundled `cfru.json` +
 *  `ATTRIBUTION.md` via the backend's attribution route so the same
 *  source of truth is shared with the README the user ships in their
 *  hack package (slice 8). */
export function AttributionPanel({ sessionId, variant = 'inline' }: AttributionPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchModernizeAttribution(sessionId)
      .then((data) => {
        if (!cancelled) setState({ kind: 'loaded', data });
      })
      .catch((e) => {
        if (cancelled) return;
        const msg =
          e instanceof ProjectApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Could not load attribution.';
        setState({ kind: 'error', message: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (state.kind === 'loading') {
    if (variant === 'inline') {
      return (
        <details className="attribution-panel attribution-panel--inline" data-testid="attribution-panel">
          <summary>Who made this upgrade?</summary>
          <p className="attribution-panel__loading">Loading credits…</p>
        </details>
      );
    }
    return (
      <div className="attribution-panel attribution-panel--card" data-testid="attribution-panel">
        <p className="attribution-panel__loading">Loading credits…</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    if (variant === 'inline') {
      return (
        <details className="attribution-panel attribution-panel--inline" data-testid="attribution-panel">
          <summary>Who made this upgrade?</summary>
          <p className="attribution-panel__error">Couldn't load credits: {state.message}</p>
        </details>
      );
    }
    return (
      <div className="attribution-panel attribution-panel--card" data-testid="attribution-panel">
        <p className="attribution-panel__error">Couldn't load credits: {state.message}</p>
      </div>
    );
  }

  const inner = (
    <div className="attribution-panel__body" data-testid="attribution-panel-body">
      <div className="attribution-panel__version">
        Bundle: {state.data.cfruVersion}
        {state.data.built ? '' : ' (not yet built - run scripts/build-cfru-bundle.mjs)'}
      </div>
      <pre className="attribution-panel__attribution">{state.data.attribution}</pre>
    </div>
  );

  if (variant === 'inline') {
    return (
      <details className="attribution-panel attribution-panel--inline" data-testid="attribution-panel">
        <summary>Who made this upgrade?</summary>
        {inner}
      </details>
    );
  }
  return (
    <div className="attribution-panel attribution-panel--card" data-testid="attribution-panel">
      {inner}
    </div>
  );
}
