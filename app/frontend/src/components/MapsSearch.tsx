import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SearchHit } from '@rom-editor/shared';
import { searchProject } from '../api';
import './MapsSearch.css';

interface MapsSearchProps {
  readonly sessionId: string;
  readonly onMatchedMapsChange: (mapIds: ReadonlySet<string>) => void;
  readonly onPickMap: (mapId: string) => void;
}

type SearchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'results'; readonly hits: ReadonlyArray<SearchHit>; readonly query: string }
  | { readonly kind: 'error'; readonly message: string };

const DEBOUNCE_MS = 200;

export function MapsSearch({ sessionId, onMatchedMapsChange, onPickMap }: MapsSearchProps) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const reqIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setState({ kind: 'idle' });
      onMatchedMapsChange(new Set());
      return;
    }
    setState({ kind: 'searching' });
    const myId = ++reqIdRef.current;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await searchProject(sessionId, trimmed, 50);
          if (myId !== reqIdRef.current) return;
          const matchedMapIds = new Set(
            res.hits.filter((h) => h.entityKind === 'map').map((h) => h.entityId),
          );
          onMatchedMapsChange(matchedMapIds);
          setState({ kind: 'results', hits: res.hits, query: trimmed });
        } catch (e) {
          if (myId !== reqIdRef.current) return;
          setState({
            kind: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, sessionId, onMatchedMapsChange]);

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (state.kind !== 'results') return;
    const firstMap = state.hits.find((h) => h.entityKind === 'map');
    if (firstMap) onPickMap(firstMap.entityId);
  }

  return (
    <div className="maps-search">
      <form className="maps-search__form" onSubmit={onSubmit} role="search">
        <input
          type="search"
          className="maps-search__input"
          placeholder='Search maps and entities - "starter", "littleroot", "first-time"…'
          data-testid="maps-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {state.kind === 'searching' && (
          <span className="maps-search__status" aria-live="polite">searching…</span>
        )}
        {state.kind === 'error' && (
          <span className="maps-search__status maps-search__status--error" aria-live="polite">
            {state.message}
          </span>
        )}
        {state.kind === 'results' && (
          <span className="maps-search__status" aria-live="polite">
            {state.hits.length} {state.hits.length === 1 ? 'hit' : 'hits'} · press Enter for first map
          </span>
        )}
      </form>
      {state.kind === 'results' && state.hits.length > 0 && (
        <ul className="maps-search__results" data-testid="maps-search-results">
          {state.hits.slice(0, 15).map((h) => (
            <li key={`${h.entityKind}-${h.entityId}`}>
              <button
                type="button"
                className="maps-search__hit"
                data-testid={`maps-search-hit-${h.entityKind}-${h.entityId}`}
                onClick={() => {
                  if (h.entityKind === 'map') onPickMap(h.entityId);
                }}
                disabled={h.entityKind !== 'map'}
                title={h.entityKind !== 'map' ? `${h.entityKind} hit - open in its own view` : undefined}
              >
                <span className={`maps-search__kind maps-search__kind--${h.entityKind}`}>
                  {h.entityKind}
                </span>
                <span className="maps-search__name">{h.entityName}</span>
                {h.snippet && <span className="maps-search__snippet">{h.snippet}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
