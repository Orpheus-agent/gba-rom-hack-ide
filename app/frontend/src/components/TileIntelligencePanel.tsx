/**
 * Phase 8I-1 - TileIntelligencePanel.
 *
 * Read-only browser for the tile-intel library. Three sub-views:
 *
 *   1. **Library** - filterable list of tilesets with attribution +
 *      license + metatile/palette counts.
 *   2. **Templates** - gallery of mined 3×3 patterns grouped by
 *      biome (clicking a biome filters the list).
 *   3. **Biome coverage** - honest summary of which biomes the
 *      library actually covers ("47 forest templates, only 2
 *      arctic").
 *
 * The panel renders the sidecar's `{ available: false, reason }`
 * states inline so the user always knows when tile intelligence
 * is offline (no silent "loading forever").
 *
 * Plain English everywhere: no `metatile_index` numbers leak to
 * primary copy; slugs render as the tileset's display_name when
 * present; tag slugs only appear inside expandable detail blocks.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  browseTilesetLibrary,
  fetchBiomeCoverage,
  fetchTileIntelHealth,
  listTemplatesByBiome,
} from '../lib/tileIntelApi';
import type { TileIntelClientResult } from '../lib/tileIntelApi';
import type {
  TileIntelUnavailable,
  TilesetLibraryEntry,
  TilesetLibraryResponse,
} from '../lib/tileIntelTypes';
import { TileNeighboursExplorer } from './TileNeighboursExplorer';
import { CurationDashboard } from './CurationDashboard';
import './TileIntelligencePanel.css';

type Tab = 'library' | 'templates' | 'coverage' | 'neighbours' | 'curation';

interface TileIntelligencePanelProps {
  /** Optional default-open tab. Used by Phase 8I-3's SkeletonEditor
   *  to deep-link into the templates view for a biome. */
  readonly initialTab?: Tab;
  readonly initialBiome?: string;
}

type LoadState<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: T }
  | { readonly kind: 'unavailable'; readonly status: TileIntelUnavailable };

function unwrapResult<T>(result: TileIntelClientResult<T>): LoadState<T> {
  if (result.available) {
    // Strip the discriminator so downstream code sees the raw body.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { available, ...body } = result as { available: true } & T;
    return { kind: 'loaded', data: body as T };
  }
  return { kind: 'unavailable', status: result };
}

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

// ---------------------------------------------------------------------------

interface LibraryFilters {
  family: string;
  isSecondary: boolean | null;
  search: string;
}

const DEFAULT_FILTERS: LibraryFilters = {
  family: '',
  isSecondary: null,
  search: '',
};

function LibraryTab(): JSX.Element {
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS);
  const [state, setState] = useState<LoadState<TilesetLibraryResponse>>({
    kind: 'idle',
  });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    browseTilesetLibrary({
      family: filters.family || undefined,
      isSecondary: filters.isSecondary ?? undefined,
      limit: 200,
    }).then((result) => {
      if (cancelled) return;
      setState(unwrapResult(result));
    });
    return () => {
      cancelled = true;
    };
  }, [filters.family, filters.isSecondary]);

  const filtered = useMemo(() => {
    if (state.kind !== 'loaded') return [] as ReadonlyArray<TilesetLibraryEntry>;
    if (!filters.search.trim()) return state.data.entries;
    const needle = filters.search.toLowerCase();
    return state.data.entries.filter(
      (e) =>
        e.slug.toLowerCase().includes(needle) ||
        e.display_name.toLowerCase().includes(needle) ||
        (e.source ?? '').toLowerCase().includes(needle),
    );
  }, [state, filters.search]);

  return (
    <div className="tile-intel-panel__tab">
      <div className="tile-intel-panel__filters">
        <label>
          Family:&nbsp;
          <select
            value={filters.family}
            onChange={(e) => setFilters({ ...filters, family: e.target.value })}
          >
            <option value="">All</option>
            <option value="frlg">FireRed / LeafGreen</option>
            <option value="rse">Ruby / Sapphire / Emerald</option>
          </select>
        </label>
        <label>
          Secondary only:&nbsp;
          <input
            type="checkbox"
            checked={filters.isSecondary === true}
            onChange={(e) =>
              setFilters({
                ...filters,
                isSecondary: e.target.checked ? true : null,
              })
            }
          />
        </label>
        <input
          type="search"
          placeholder="Search by name or slug…"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          className="tile-intel-panel__search"
        />
      </div>

      {state.kind === 'loading' && (
        <p className="tile-intel-panel__hint">Loading tilesets…</p>
      )}

      {state.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(state.status)}
        </p>
      )}

      {state.kind === 'loaded' && (
        <>
          <p className="tile-intel-panel__hint">
            Showing {filtered.length} of {state.data.total_tilesets} tilesets.
          </p>
          <ul className="tile-intel-panel__list">
            {filtered.map((entry) => (
              <li key={entry.slug} className="tile-intel-panel__row">
                <div className="tile-intel-panel__row-title">
                  <strong>{entry.display_name}</strong>
                  <span className="tile-intel-panel__row-badge">
                    {entry.family.toUpperCase()}
                  </span>
                  {entry.is_secondary && (
                    <span className="tile-intel-panel__row-badge tile-intel-panel__row-badge--secondary">
                      Secondary
                    </span>
                  )}
                </div>
                <div className="tile-intel-panel__row-meta">
                  {entry.metatile_count} metatiles · {entry.palette_count}{' '}
                  palettes · {entry.attribution ?? 'No attribution recorded'}
                  {entry.license_spdx ? ` · ${entry.license_spdx}` : ''}
                </div>
                <code className="tile-intel-panel__row-slug">{entry.slug}</code>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="tile-intel-panel__row tile-intel-panel__row--empty">
                No tilesets match the current filter.
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TemplatesTab({
  initialBiome,
}: {
  initialBiome?: string;
}): JSX.Element {
  const [biome, setBiome] = useState<string>(initialBiome ?? 'biome.route');
  const [state, setState] = useState<
    LoadState<{
      readonly biome: string;
      readonly templates: ReadonlyArray<{
        readonly template_slug: string;
        readonly role: string;
        readonly required_tags: ReadonlyArray<string>;
        readonly biomes: ReadonlyArray<string>;
        readonly total_usage: number;
      }>;
    }>
  >({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    listTemplatesByBiome(biome).then((r) => {
      if (cancelled) return;
      setState(unwrapResult(r));
    });
    return () => {
      cancelled = true;
    };
  }, [biome]);

  return (
    <div className="tile-intel-panel__tab">
      <label>
        Biome:&nbsp;
        <input
          type="text"
          value={biome}
          onChange={(e) => setBiome(e.target.value)}
          placeholder="biome.route / biome.forest / biome.cave / …"
          className="tile-intel-panel__biome-input"
        />
      </label>
      {state.kind === 'loading' && (
        <p className="tile-intel-panel__hint">Loading templates…</p>
      )}
      {state.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(state.status)}
        </p>
      )}
      {state.kind === 'loaded' && (
        <>
          <p className="tile-intel-panel__hint">
            {state.data.templates.length} template
            {state.data.templates.length === 1 ? '' : 's'} for {biome}.
          </p>
          <ul className="tile-intel-panel__list">
            {state.data.templates.map((t) => (
              <li key={t.template_slug} className="tile-intel-panel__row">
                <div className="tile-intel-panel__row-title">
                  <strong>{t.role.replace(/_/g, ' ')}</strong>
                  <span className="tile-intel-panel__row-badge">
                    {t.total_usage} use{t.total_usage === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="tile-intel-panel__row-meta">
                  Tags: {t.required_tags.join(', ') || '(none)'}
                </div>
                <code className="tile-intel-panel__row-slug">
                  {t.template_slug}
                </code>
              </li>
            ))}
            {state.data.templates.length === 0 && (
              <li className="tile-intel-panel__row tile-intel-panel__row--empty">
                No templates yet for this biome. Try{' '}
                <code>biome.route</code>, <code>biome.forest</code>, or run the
                template-build pipeline.
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CoverageTab(): JSX.Element {
  const [state, setState] = useState<
    LoadState<{ readonly biomes: Record<string, number> }>
  >({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchBiomeCoverage().then((r) => {
      if (cancelled) return;
      setState(unwrapResult(r));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedBiomes = useMemo(() => {
    if (state.kind !== 'loaded') return [] as Array<[string, number]>;
    return Object.entries(state.data.biomes).sort(
      ([, a], [, b]) => b - a,
    );
  }, [state]);

  return (
    <div className="tile-intel-panel__tab">
      <p className="tile-intel-panel__hint">
        Honest summary of which biomes the template library currently covers.
        Lower counts mean the generator will lean on filler templates instead
        of biome-specific patterns.
      </p>
      {state.kind === 'loading' && (
        <p className="tile-intel-panel__hint">Loading coverage…</p>
      )}
      {state.kind === 'unavailable' && (
        <p className="tile-intel-panel__warning">
          {describeUnavailable(state.status)}
        </p>
      )}
      {state.kind === 'loaded' && (
        <table className="tile-intel-panel__coverage-table">
          <thead>
            <tr>
              <th>Biome</th>
              <th>Templates</th>
            </tr>
          </thead>
          <tbody>
            {sortedBiomes.map(([biome, count]) => (
              <tr key={biome}>
                <td>{biome}</td>
                <td>{count}</td>
              </tr>
            ))}
            {sortedBiomes.length === 0 && (
              <tr>
                <td colSpan={2}>
                  No templates indexed yet. Run the template-build pipeline
                  against your mined corpus.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function TileIntelligencePanel({
  initialTab = 'library',
  initialBiome,
}: TileIntelligencePanelProps = {}): JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [healthStatus, setHealthStatus] = useState<TileIntelUnavailable | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    fetchTileIntelHealth().then((r) => {
      if (cancelled) return;
      if (r.available) {
        setHealthOk(true);
      } else {
        setHealthOk(false);
        setHealthStatus(r);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="tile-intel-panel">
      <header className="tile-intel-panel__header">
        <h2>Tile Intelligence</h2>
        <p className="tile-intel-panel__subtitle">
          Browse what the editor knows about Pokémon-style tilesets, mined
          patterns, and biome coverage. Used by the map generator and the
          paint-tile autocomplete.
        </p>
        {healthOk === false && healthStatus && (
          <p className="tile-intel-panel__warning">
            {describeUnavailable(healthStatus)}
          </p>
        )}
      </header>
      <nav className="tile-intel-panel__tabs">
        <button
          type="button"
          className={tab === 'library' ? 'is-active' : ''}
          onClick={() => setTab('library')}
        >
          Library
        </button>
        <button
          type="button"
          className={tab === 'templates' ? 'is-active' : ''}
          onClick={() => setTab('templates')}
        >
          Templates
        </button>
        <button
          type="button"
          className={tab === 'coverage' ? 'is-active' : ''}
          onClick={() => setTab('coverage')}
        >
          Biome coverage
        </button>
        <button
          type="button"
          className={tab === 'neighbours' ? 'is-active' : ''}
          onClick={() => setTab('neighbours')}
        >
          Neighbours
        </button>
        <button
          type="button"
          className={tab === 'curation' ? 'is-active' : ''}
          onClick={() => setTab('curation')}
        >
          Curation
        </button>
      </nav>
      {tab === 'library' && <LibraryTab />}
      {tab === 'templates' && <TemplatesTab initialBiome={initialBiome} />}
      {tab === 'coverage' && <CoverageTab />}
      {tab === 'neighbours' && <TileNeighboursExplorer />}
      {tab === 'curation' && <CurationDashboard />}
    </section>
  );
}
