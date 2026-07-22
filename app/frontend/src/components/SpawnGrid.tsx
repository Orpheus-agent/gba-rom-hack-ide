/**
 * Phase 4.2B - Cross-map wild encounter grid.
 *
 * Top-level view that lists EVERY encounter slot across the project:
 * one row per (map, method, slot index) triple. Each row carries the
 * sprite + species name + level range + rarity dot + a click-through
 * to the standalone EncounterTableInspector for that slot's table.
 *
 * Filters along the top:
 *   - Map name substring
 *   - Method (grass / water / fishing / cave / rock_smash / custom)
 *   - Species substring
 *   - Rarity bucket
 *
 * Surfaces the full spawn table of the whole game in a single
 * scannable view - useful for "where does Pidgey appear?",
 * "what's only in 1% slots?", or "rebalance every gym town to
 * include the regional bird".
 */

import { useMemo, useState } from 'react';
import type { EncounterSlot, EncounterTable, ProjectManifest } from '@rom-editor/shared';
import { displayName } from '../lib/displayName';
import { useProjectStore, useSelection, useUiPreferencesStore } from '../state';
import { PokemonSprite } from './PokemonSprite';
import { RarityDot, rarityBucketForPct, rarityLabelForBucket } from './RarityDot';
import type { RarityBucket } from './RarityDot';
import './SpawnGrid.css';

type MethodFilter = 'all' | EncounterTable['type'];

interface FlatSlot {
  readonly mapId: string | null;
  readonly mapName: string;
  readonly tableId: string;
  readonly tableType: EncounterTable['type'];
  readonly tableRate: number;
  readonly slotIndex: number;
  readonly slot: EncounterSlot;
  readonly pct: number;
  readonly bucket: RarityBucket;
}

const METHOD_OPTIONS: ReadonlyArray<{ value: MethodFilter; label: string }> = [
  { value: 'all', label: 'All methods' },
  { value: 'grass', label: 'Grass' },
  { value: 'water', label: 'Water' },
  { value: 'fishing', label: 'Fishing' },
  { value: 'cave', label: 'Cave' },
  { value: 'rock_smash', label: 'Rock smash' },
  { value: 'custom', label: 'Custom' },
];

const RARITY_OPTIONS: ReadonlyArray<{ value: 'all' | RarityBucket; label: string }> = [
  { value: 'all', label: 'All rarities' },
  { value: 'very-common', label: 'Very common (≥20%)' },
  { value: 'common', label: 'Common (10..20%)' },
  { value: 'uncommon', label: 'Uncommon (5..10%)' },
  { value: 'rare', label: 'Rare (1..5%)' },
  { value: 'very-rare', label: 'Very rare (<1%)' },
];

function methodLabel(t: EncounterTable['type']): string {
  switch (t) {
    case 'grass':
      return 'Grass';
    case 'water':
      return 'Surf';
    case 'fishing':
      return 'Fishing';
    case 'cave':
      return 'Cave';
    case 'rock_smash':
      return 'Rock smash';
    default:
      return 'Custom';
  }
}

function speciesIndexOf(slot: EncounterSlot): number | null {
  const m = /^species_(\d+)$/.exec(slot.speciesId);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

export interface SpawnGridProps {
  readonly manifest: ProjectManifest;
}

export function SpawnGrid({ manifest }: SpawnGridProps): JSX.Element {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);

  const [mapFilter, setMapFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('all');
  const [speciesFilter, setSpeciesFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState<'all' | RarityBucket>('all');

  // Flatten all tables into a single row list.
  const allSlots = useMemo<FlatSlot[]>(() => {
    const out: FlatSlot[] = [];
    for (const table of manifest.encounterTables) {
      const totalWeight = table.slots.reduce((s, x) => s + x.weight, 0);
      const map = table.mapId
        ? manifest.maps.find((m) => m.id === table.mapId)
        : undefined;
      const mapName = map?.name ?? table.mapId ?? '(orphan table)';
      table.slots.forEach((slot, slotIndex) => {
        const pct = totalWeight > 0 ? Math.round((slot.weight / totalWeight) * 1000) / 10 : 0;
        out.push({
          mapId: table.mapId ?? null,
          mapName,
          tableId: table.id,
          tableType: table.type,
          tableRate: table.encounterRate,
          slotIndex,
          slot,
          pct,
          bucket: rarityBucketForPct(pct),
        });
      });
    }
    return out;
  }, [manifest.encounterTables, manifest.maps]);

  const filtered = useMemo(() => {
    const mapNeedle = mapFilter.trim().toLowerCase();
    const speciesNeedle = speciesFilter.trim().toLowerCase();
    return allSlots.filter((row) => {
      if (methodFilter !== 'all' && row.tableType !== methodFilter) return false;
      if (rarityFilter !== 'all' && row.bucket !== rarityFilter) return false;
      if (mapNeedle.length > 0 && !row.mapName.toLowerCase().includes(mapNeedle)) return false;
      if (speciesNeedle.length > 0) {
        const speciesLabel = displayName(manifest, row.slot.speciesId, showInternalIds).toLowerCase();
        if (!speciesLabel.includes(speciesNeedle)) return false;
      }
      return true;
    });
  }, [allSlots, mapFilter, methodFilter, speciesFilter, rarityFilter, manifest, showInternalIds]);

  return (
    <div className="spawn-grid" data-testid="spawn-grid">
      <header className="spawn-grid__header">
        <h2 className="spawn-grid__title">Wild encounters</h2>
        <div className="spawn-grid__filters">
          <input
            type="search"
            placeholder="Filter by map…"
            value={mapFilter}
            onChange={(e) => setMapFilter(e.target.value)}
            data-testid="spawn-grid-filter-map"
            className="spawn-grid__filter"
          />
          <input
            type="search"
            placeholder="Filter by Pokémon…"
            value={speciesFilter}
            onChange={(e) => setSpeciesFilter(e.target.value)}
            data-testid="spawn-grid-filter-species"
            className="spawn-grid__filter"
          />
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value as MethodFilter)}
            data-testid="spawn-grid-filter-method"
            className="spawn-grid__filter"
          >
            {METHOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            value={rarityFilter}
            onChange={(e) => setRarityFilter(e.target.value as 'all' | RarityBucket)}
            data-testid="spawn-grid-filter-rarity"
            className="spawn-grid__filter"
          >
            {RARITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="spawn-grid__count">
          Showing {String(filtered.length)} of {String(allSlots.length)} slots
        </div>
      </header>
      {filtered.length === 0 ? (
        <div className="spawn-grid__empty" data-testid="spawn-grid-empty">
          No encounter slots match the filters.
        </div>
      ) : (
        <table className="spawn-grid__table">
          <thead>
            <tr>
              <th>Map</th>
              <th>Method</th>
              <th>Slot</th>
              <th>Pokémon</th>
              <th>Level</th>
              <th>Rarity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const speciesIdx = speciesIndexOf(row.slot);
              const speciesLabel = displayName(manifest, row.slot.speciesId, showInternalIds);
              const levelRange =
                row.slot.minLevel === row.slot.maxLevel
                  ? `Lv ${String(row.slot.minLevel)}`
                  : `Lv ${String(row.slot.minLevel)}–${String(row.slot.maxLevel)}`;
              return (
                <tr
                  key={`${row.tableId}-${row.slotIndex}`}
                  data-testid={`spawn-grid-row-${row.tableId}-${row.slotIndex}`}
                  className="spawn-grid__row"
                  onClick={() => select({ kind: 'encounterTable', id: row.tableId })}
                >
                  <td className="spawn-grid__cell-map">{row.mapName}</td>
                  <td className="spawn-grid__cell-method">{methodLabel(row.tableType)}</td>
                  <td className="spawn-grid__cell-slot">#{String(row.slotIndex + 1)}</td>
                  <td className="spawn-grid__cell-species">
                    {speciesIdx !== null && (
                      <PokemonSprite
                        speciesId={speciesIdx}
                        variant="compact"
                        testIdPrefix={`spawn-grid-sprite-${row.tableId}-${row.slotIndex}`}
                      />
                    )}
                    <span className="spawn-grid__species-name">{speciesLabel}</span>
                  </td>
                  <td className="spawn-grid__cell-level">{levelRange}</td>
                  <td className="spawn-grid__cell-rarity">
                    <RarityDot
                      bucket={row.bucket}
                      testIdPrefix={`spawn-grid-rarity-${row.tableId}-${row.slotIndex}`}
                    />
                    {row.pct}% ({rarityLabelForBucket(row.bucket)})
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Top-level view wrapper for MainPanel - gates on the manifest
 *  being loaded + renders a helpful empty state otherwise. */
export function SpawnGridView(): JSX.Element {
  const scan = useProjectStore((s) => s.scan);
  if (scan.kind !== 'loaded') {
    return (
      <div className="spawn-grid spawn-grid--empty" data-testid="spawn-grid-view-empty">
        <p>Open + scan a project to see its wild encounter tables.</p>
      </div>
    );
  }
  return <SpawnGrid manifest={scan.data.manifest} />;
}
