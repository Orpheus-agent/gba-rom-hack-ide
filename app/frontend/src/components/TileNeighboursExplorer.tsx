/**
 * Phase 8I-2 - TileNeighboursExplorer.
 *
 * Interactive surface for exploring the tile-intel sidecar's
 * adjacency_rules table. The user picks a seed metatile (by tileset
 * slug + index) and a direction, and the panel renders the top-N
 * legal neighbours ranked by observed-adjacency probability.
 *
 * Currently mounts inside TileIntelligencePanel as a 4th tab. A
 * future polish pass will also expose this through a right-click
 * context menu on the map editor canvas - once that lands, the
 * panel's "open this seed" deep-link will take a (slug, index)
 * pair from the map-editor selection state.
 *
 * Plain English: direction is exposed as `"north"` / `"east"` /
 * etc.; numeric direction codes never leave this component.
 */

import { useState, type FormEvent } from 'react';
import { suggestNeighbors } from '../lib/tileIntelApi';
import type { TileIntelClientResult } from '../lib/tileIntelApi';
import type {
  NeighborSuggestion,
  SuggestNeighborsResponse,
  TileIntelUnavailable,
} from '../lib/tileIntelTypes';

type Direction = 'north' | 'east' | 'south' | 'west';

const DIRECTION_TO_CODE: Record<Direction, number> = {
  north: 0,
  east: 2,
  south: 4,
  west: 6,
};

type ExplorerState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded';
      readonly response: SuggestNeighborsResponse;
    }
  | {
      readonly kind: 'unavailable';
      readonly status: TileIntelUnavailable;
    }
  | { readonly kind: 'error'; readonly message: string };

function describeUnavailable(status: TileIntelUnavailable): string {
  switch (status.reason) {
    case 'sidecar_offline':
      return `The tile intelligence service is offline. ${status.details}`;
    case 'sidecar_crashed':
      return `The tile intelligence service crashed. ${status.details}`;
    case 'storage_unhealthy':
      return `Tile intelligence storage isn't reachable. ${status.details}`;
    case 'version_mismatch':
      return `Version mismatch - the editor expects v${status.expected} but the service reports v${status.observed}. Reinstall the editor or restart the service.`;
    case 'warming_up':
      return `The service is starting up - try again in ${status.etaSeconds}s.`;
    case 'embedding_unavailable':
      return `The visual-similarity model isn't installed. ${status.details}`;
  }
}

function unwrapResult(
  result: TileIntelClientResult<SuggestNeighborsResponse>,
): ExplorerState {
  if (result.available) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { available, ...body } = result;
    return { kind: 'loaded', response: body as SuggestNeighborsResponse };
  }
  return { kind: 'unavailable', status: result };
}

interface TileNeighboursExplorerProps {
  /** Optional seed inputs so callers (e.g. the future map-editor
   *  right-click menu) can deep-link into the explorer. */
  readonly initialTilesetSlug?: string;
  readonly initialMetatileIndex?: number;
  readonly initialDirection?: Direction;
}

export function TileNeighboursExplorer({
  initialTilesetSlug = '',
  initialMetatileIndex,
  initialDirection = 'east',
}: TileNeighboursExplorerProps = {}): JSX.Element {
  const [tilesetSlug, setTilesetSlug] = useState<string>(initialTilesetSlug);
  const [metatileIndex, setMetatileIndex] = useState<string>(
    initialMetatileIndex !== undefined ? String(initialMetatileIndex) : '',
  );
  const [direction, setDirection] = useState<Direction>(initialDirection);
  const [state, setState] = useState<ExplorerState>({ kind: 'idle' });

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const idx = Number.parseInt(metatileIndex, 10);
    if (!tilesetSlug.trim() || Number.isNaN(idx)) {
      setState({
        kind: 'error',
        message: 'Tileset slug and metatile index are required.',
      });
      return;
    }
    setState({ kind: 'loading' });
    const result = await suggestNeighbors({
      tilesetSlug: tilesetSlug.trim(),
      metatileIndex: idx,
      direction: DIRECTION_TO_CODE[direction],
    });
    setState(unwrapResult(result));
  }

  return (
    <div className="tile-intel-panel__tab">
      <form
        className="tile-intel-panel__filters tile-intel-explorer-form"
        onSubmit={handleSubmit}
      >
        <label>
          Tileset slug:&nbsp;
          <input
            type="text"
            value={tilesetSlug}
            onChange={(e) => setTilesetSlug(e.target.value)}
            placeholder="pret-frlg-route1"
            className="tile-intel-panel__biome-input"
          />
        </label>
        <label>
          Metatile #:&nbsp;
          <input
            type="number"
            min={0}
            max={0x3ff}
            value={metatileIndex}
            onChange={(e) => setMetatileIndex(e.target.value)}
            style={{ width: 80 }}
          />
        </label>
        <label>
          Direction:&nbsp;
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as Direction)}
          >
            <option value="north">North</option>
            <option value="east">East</option>
            <option value="south">South</option>
            <option value="west">West</option>
          </select>
        </label>
        <button type="submit">Suggest neighbours</button>
      </form>

      {state.kind === 'loading' && (
        <p className="tile-intel-panel__hint">Looking up suggestions…</p>
      )}
      {state.kind === 'error' && (
        <p className="tile-intel-panel__warning">{state.message}</p>
      )}
      {state.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(state.status)}
        </p>
      )}
      {state.kind === 'loaded' && (
        <NeighbourResults response={state.response} direction={direction} />
      )}
    </div>
  );
}

function NeighbourResults({
  response,
  direction,
}: {
  response: SuggestNeighborsResponse;
  direction: Direction;
}): JSX.Element {
  if (response.suggestions.length === 0) {
    return (
      <p className="tile-intel-panel__hint">
        No observed neighbours to the {direction} of{' '}
        <code>{response.seed_tileset_slug}</code> / metatile{' '}
        {response.seed_metatile_index}. The seed might be too rare in
        observed maps, or the rules haven't been rebuilt yet.
      </p>
    );
  }
  return (
    <>
      <p className="tile-intel-panel__hint">
        Top {response.suggestions.length} neighbours to the {direction} of{' '}
        <code>{response.seed_tileset_slug}</code> / metatile{' '}
        {response.seed_metatile_index} ({response.total_observations} total
        observations).
      </p>
      <ul className="tile-intel-panel__list">
        {response.suggestions.map((s, i) => (
          <NeighbourRow key={`${s.tileset_slug}:${s.metatile_index}:${i}`} suggestion={s} />
        ))}
      </ul>
    </>
  );
}

function NeighbourRow({
  suggestion,
}: {
  suggestion: NeighborSuggestion;
}): JSX.Element {
  const pct = Math.round(suggestion.probability * 100);
  return (
    <li className="tile-intel-panel__row">
      <div className="tile-intel-panel__row-title">
        <strong>{suggestion.tileset_slug}</strong>
        <span className="tile-intel-panel__row-badge">
          metatile {suggestion.metatile_index}
        </span>
        <span
          className={
            'tile-intel-panel__row-badge ' +
            (suggestion.is_walkable
              ? 'tile-intel-panel__row-badge--secondary'
              : '')
          }
        >
          {suggestion.is_walkable ? 'Walkable' : 'Blocked'}
        </span>
      </div>
      <div className="tile-intel-explorer-bar">
        <div
          className="tile-intel-explorer-bar__fill"
          style={{ width: `${pct}%` }}
          title={`${pct}% probability`}
        />
        <span className="tile-intel-explorer-bar__label">
          {pct}% · {suggestion.support_count} map
          {suggestion.support_count === 1 ? '' : 's'}
        </span>
      </div>
    </li>
  );
}
