import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { emptyManifest } from '@rom-editor/shared';
import type { ProjectManifest } from '@rom-editor/shared';
import { EntityPicker, packMapId, unpackMapGroup, unpackMapNum } from './EntityPicker';

function manifestWith(opts: {
  species?: ReadonlyArray<{ id: number; name: string }>;
  moves?: ReadonlyArray<{ id: number; name: string }>;
}): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-18T00:00:00Z');
  return {
    ...base,
    speciesNames: opts.species
      ? opts.species.map((s) => ({
          id: `species_${String(s.id)}`,
          speciesIndex: s.id,
          name: s.name,
          sourceTableOffset: 0,
        }))
      : [],
    moveNames: opts.moves
      ? opts.moves.map((m) => ({
          id: `move_${String(m.id)}`,
          moveIndex: m.id,
          name: m.name,
          sourceTableOffset: 0,
        }))
      : [],
  };
}

describe('EntityPicker (Phase 7.2 typeahead)', () => {
  afterEach(() => cleanup());

  it('renders the current value as "NAME (id)" when the kind has a matching entry', () => {
    const m = manifestWith({
      species: [
        { id: 1, name: 'BULBASAUR' },
        { id: 4, name: 'CHARMANDER' },
      ],
    });
    render(
      <EntityPicker
        kind="species"
        manifest={m}
        value={4}
        onChange={() => undefined}
        testIdPrefix="t1"
      />,
    );
    const input = screen.getByTestId('t1-input') as HTMLInputElement;
    expect(input.value).toBe('CHARMANDER (4)');
  });

  it('falls back to the raw numeric value when no entry matches', () => {
    const m = manifestWith({ species: [{ id: 1, name: 'BULBASAUR' }] });
    render(
      <EntityPicker
        kind="species"
        manifest={m}
        value={42}
        onChange={() => undefined}
        testIdPrefix="t2"
      />,
    );
    const input = screen.getByTestId('t2-input') as HTMLInputElement;
    expect(input.value).toBe('42');
  });

  // Phase 7.2 - typing alone does NOT fire onChange. The old datalist
  // implementation parsed "42" on every keystroke and committed it,
  // making it impossible to type a 3-digit id (typing "734" committed
  // 7 first, which re-rendered the input as "Bulbasaur (7)").
  it('typing numeric digits does not fire onChange until commit', () => {
    const m = manifestWith({ moves: [{ id: 1, name: 'POUND' }] });
    const onChange = vi.fn();
    render(
      <EntityPicker
        kind="move"
        manifest={m}
        value={1}
        onChange={onChange}
        testIdPrefix="t3"
      />,
    );
    const input = screen.getByTestId('t3-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '7' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '73' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '734' } });
    expect(onChange).not.toHaveBeenCalled();
    // Commit via Enter - fires onChange with the full numeric value.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(734);
  });

  it('commits via blur (fires onChange with the parsed value)', () => {
    vi.useFakeTimers();
    const m = manifestWith({ moves: [{ id: 1, name: 'POUND' }] });
    const onChange = vi.fn();
    render(
      <EntityPicker
        kind="move"
        manifest={m}
        value={1}
        onChange={onChange}
        testIdPrefix="t4"
      />,
    );
    const input = screen.getByTestId('t4-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.blur(input);
    // Blur defers commit by 150ms so a dropdown mousedown can land.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onChange).toHaveBeenCalledWith(42);
    vi.useRealTimers();
  });

  it('clamps to minId / maxId bounds at commit time', () => {
    const m = manifestWith({ moves: [] });
    const onChange = vi.fn();
    render(
      <EntityPicker
        kind="move"
        manifest={m}
        value={50}
        onChange={onChange}
        minId={10}
        maxId={100}
        testIdPrefix="t5"
      />,
    );
    const input = screen.getByTestId('t5-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(10); // clamped to minId
    onChange.mockClear();
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(100); // clamped to maxId
  });

  it('renders filtered results in a custom dropdown when typing', () => {
    const m = manifestWith({
      species: [
        { id: 1, name: 'BULBASAUR' },
        { id: 2, name: 'IVYSAUR' },
        { id: 3, name: 'VENUSAUR' },
        { id: 16, name: 'PIDGEY' },
      ],
    });
    render(
      <EntityPicker
        kind="species"
        manifest={m}
        value={1}
        onChange={() => undefined}
        testIdPrefix="t6"
      />,
    );
    const input = screen.getByTestId('t6-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'saur' } });
    // 3 of the 4 species match "saur" (BULBASAUR, IVYSAUR, VENUSAUR);
    // PIDGEY does not.
    expect(screen.getByTestId('t6-result-1')).toBeInTheDocument();
    expect(screen.getByTestId('t6-result-2')).toBeInTheDocument();
    expect(screen.getByTestId('t6-result-3')).toBeInTheDocument();
    expect(screen.queryByTestId('t6-result-16')).not.toBeInTheDocument();
  });

  it('clicking a dropdown result fires onChange with that id', () => {
    const m = manifestWith({
      species: [
        { id: 1, name: 'BULBASAUR' },
        { id: 16, name: 'PIDGEY' },
        { id: 17, name: 'PIDGEOTTO' },
        { id: 18, name: 'PIDGEOT' },
      ],
    });
    const onChange = vi.fn();
    render(
      <EntityPicker
        kind="species"
        manifest={m}
        value={1}
        onChange={onChange}
        testIdPrefix="t7"
      />,
    );
    const input = screen.getByTestId('t7-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pidg' } });
    const pidgeot = screen.getByTestId('t7-result-18');
    fireEvent.mouseDown(pidgeot);
    expect(onChange).toHaveBeenCalledWith(18);
  });

  it('parses "NAME (id)" pattern back to numeric id on commit', () => {
    const m = manifestWith({
      moves: [
        { id: 1, name: 'POUND' },
        { id: 7, name: 'FIRE PUNCH' },
      ],
    });
    const onChange = vi.fn();
    render(
      <EntityPicker
        kind="move"
        manifest={m}
        value={1}
        onChange={onChange}
        testIdPrefix="t8"
      />,
    );
    const input = screen.getByTestId('t8-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'FIRE PUNCH (7)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it('Escape reverts the draft to the canonical value', () => {
    const m = manifestWith({ species: [{ id: 4, name: 'CHARMANDER' }] });
    const onChange = vi.fn();
    render(
      <EntityPicker
        kind="species"
        manifest={m}
        value={4}
        onChange={onChange}
        testIdPrefix="t9"
      />,
    );
    const input = screen.getByTestId('t9-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nonsense' } });
    expect(input.value).toBe('nonsense');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('CHARMANDER (4)');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Phase O.19 - packs / unpacks map (group, num) into a u16 id', () => {
    expect(packMapId(0, 0)).toBe(0);
    expect(packMapId(1, 4)).toBe(0x0104);
    expect(packMapId(255, 255)).toBe(0xffff);
    expect(unpackMapGroup(0x0104)).toBe(1);
    expect(unpackMapNum(0x0104)).toBe(4);
  });

  it('Phase O.19 - map kind shows binary-rom maps with packed ids', () => {
    const base = emptyManifest('/tmp/x', '2026-05-18T00:00:00Z');
    const m: ProjectManifest = {
      ...base,
      maps: [
        // Decomp map (skipped - id doesn't match binary_map_<g>_<n>)
        {
          id: 'MAP_PALLET_TOWN',
          name: 'PALLET TOWN',
          group: 'town',
          dimensions: { width: 20, height: 20 },
          tilesetIds: [],
          warpIds: [],
          scriptIds: [],
          objectEventIds: [],
          encounterTableIds: [],
          musicId: null,
          metadata: {},
        },
        // Binary map (group=1, num=4)
        {
          id: 'binary_map_1_4',
          name: 'PALLET TOWN (binary)',
          group: 'town',
          dimensions: { width: 20, height: 20 },
          tilesetIds: [],
          warpIds: [],
          scriptIds: [],
          objectEventIds: [],
          encounterTableIds: [],
          musicId: null,
          metadata: {},
        },
      ],
    };
    render(
      <EntityPicker
        kind="map"
        manifest={m}
        value={packMapId(1, 4)}
        onChange={() => undefined}
        testIdPrefix="t10"
      />,
    );
    const input = screen.getByTestId('t10-input') as HTMLInputElement;
    expect(input.value).toBe('PALLET TOWN (binary) (260)');
  });

  // ---------------------------------------------------------------------------
  // Phase 9J - option-cap regression guard
  //
  // The Phase 4 plan flagged Firefox lag on 2000+ species datalists.
  // Phase 7.2's rewrite to a typeahead added a MAX_RESULTS=100 cap
  // inside filterEntries. These tests pin that cap so a future
  // refactor can't silently regress to "render everything."
  // ---------------------------------------------------------------------------

  it('caps rendered options at 100 even when the manifest has thousands of species', () => {
    const m = manifestWith({
      species: Array.from({ length: 2000 }, (_unused, i) => ({
        id: i,
        name: `SPECIES_${String(i).padStart(4, '0')}`,
      })),
    });
    render(
      <EntityPicker
        kind="species"
        manifest={m}
        value={1}
        onChange={() => undefined}
        testIdPrefix="cap"
      />,
    );
    const input = screen.getByTestId('cap-input') as HTMLInputElement;
    act(() => {
      fireEvent.focus(input);
    });
    const results = screen.queryAllByTestId(/^cap-result-/);
    expect(results.length).toBeLessThanOrEqual(100);
    expect(results.length).toBeGreaterThan(0);
  });

  it('caps filtered results at 100 even when the query matches every entry', () => {
    const m = manifestWith({
      species: Array.from({ length: 2000 }, (_unused, i) => ({
        id: i,
        // Every entry contains "MON" so the query matches all 2000.
        name: `MON_${String(i).padStart(4, '0')}`,
      })),
    });
    render(
      <EntityPicker
        kind="species"
        manifest={m}
        value={1}
        onChange={() => undefined}
        testIdPrefix="cap2"
      />,
    );
    const input = screen.getByTestId('cap2-input') as HTMLInputElement;
    act(() => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'MON' } });
    });
    const results = screen.queryAllByTestId(/^cap2-result-/);
    expect(results.length).toBeLessThanOrEqual(100);
  });
});
