import { useEffect, useMemo, useState } from 'react';
import type { EncounterTable } from '@rom-editor/shared';
import {
  editDecompEncounterSlot,
  getDecompSpeciesList,
  type DecompSpeciesListItem,
} from '../api';
import { useProjectStore } from '../state';
import { displayName } from '../lib/displayName';

/** Wild Encounters editor (A4, decomp). Read side comes from
 *  manifest.encounterTables (scan/encounters.ts parses wild_encounters.json);
 *  edits a slot's species + level range in that JSON in place. The encounter
 *  RATE and slot ORDER (which fixes each slot's %) stay as-is here - those edit
 *  cleanly on the binary path; for decomp, reordering = swapping species,
 *  which the per-slot species field already does. */
const METHOD_LABEL: Record<string, string> = {
  grass: 'Grass', water: 'Surf', fishing: 'Fishing', cave: 'Cave', rock_smash: 'Rock smash', custom: 'Custom',
};

interface Row {
  sp: string; // friendly name (or raw SPECIES_ id if unknown)
  min: number;
  max: number;
  origSp: string; // original SPECIES_ id
  origMin: number;
  origMax: number;
}

export function DecompEncountersView(): JSX.Element {
  const scan = useProjectStore((s) => s.scan);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const manifest = scan.kind === 'loaded' ? scan.data.manifest : null;

  const [species, setSpecies] = useState<DecompSpeciesListItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    getDecompSpeciesList(sessionId)
      .then(setSpecies)
      .catch(() => setSpecies([]));
  }, [sessionId]);

  // id ↔ friendly-name maps for the species picker.
  const { idToName, nameToId } = useMemo(() => {
    const i2n = new Map<string, string>();
    const n2i = new Map<string, string>();
    for (const s of species ?? []) {
      i2n.set(s.id, s.name);
      n2i.set(s.name.toLowerCase(), s.id);
    }
    return { idToName: i2n, nameToId: n2i };
  }, [species]);

  const tables = useMemo<ReadonlyArray<EncounterTable>>(
    () => manifest?.encounterTables ?? [],
    [manifest],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const withLabel = tables.map((t) => ({
      t,
      label: `${t.mapId && manifest ? displayName(manifest, t.mapId, false) : t.id} · ${METHOD_LABEL[t.type] ?? t.type}`,
    }));
    return q ? withLabel.filter((x) => x.label.toLowerCase().includes(q)) : withLabel;
  }, [tables, filter, manifest]);

  const selected = useMemo(() => tables.find((t) => t.id === selId) ?? null, [tables, selId]);

  // Reset the editable rows whenever the selected table (or species map) changes.
  useEffect(() => {
    if (!selected) {
      setRows([]);
      return;
    }
    setRows(
      selected.slots.map((s) => ({
        sp: idToName.get(s.speciesId) ?? s.speciesId,
        min: s.minLevel,
        max: s.maxLevel,
        origSp: s.speciesId,
        origMin: s.minLevel,
        origMax: s.maxLevel,
      })),
    );
    setNote(null);
  }, [selected, idToName]);

  if (!sessionId || !manifest) return <div style={{ padding: 16 }}>Open + scan a project first.</div>;

  const resolveSpecies = (text: string): string | null => {
    const byName = nameToId.get(text.trim().toLowerCase());
    if (byName) return byName;
    const t = text.trim();
    return /^SPECIES_[A-Z0-9_]+$/i.test(t) ? t.toUpperCase() : null;
  };

  const rowChanged = (r: Row): boolean =>
    r.min !== r.origMin || r.max !== r.origMax || (resolveSpecies(r.sp) ?? r.origSp) !== r.origSp;

  const saveRow = async (i: number): Promise<void> => {
    if (!selected) return;
    const r = rows[i]!;
    const spId = resolveSpecies(r.sp);
    if (r.sp.trim() && !spId) {
      setNote(`"${r.sp}" isn't a known species - type a name (e.g. Pikachu) or a SPECIES_ id.`);
      return;
    }
    const edit: { speciesId?: string; minLevel?: number; maxLevel?: number } = {};
    if (spId && spId !== r.origSp) edit.speciesId = spId;
    if (r.min !== r.origMin) edit.minLevel = r.min;
    if (r.max !== r.origMax) edit.maxLevel = r.max;
    if (Object.keys(edit).length === 0) return;
    setSavingIdx(i);
    setNote(null);
    try {
      await editDecompEncounterSlot(sessionId, selected.id, i, edit);
      // Optimistic: bake the new values into this row's "original" baseline.
      setRows((prev) =>
        prev.map((x, idx) =>
          idx === i
            ? { ...x, origSp: spId ?? x.origSp, origMin: x.min, origMax: x.max, sp: idToName.get(spId ?? x.origSp) ?? x.sp }
            : x,
        ),
      );
      setNote(`Slot ${i + 1} saved.`);
    } catch (e) {
      setNote(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingIdx(null);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="decomp-encounters-view">
      <aside style={{ width: 300, borderRight: '1px solid var(--border-subtle,#2a2a2a)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 8 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 15 }}>Wild Encounters</h2>
          <input type="search" placeholder={`Filter ${tables.length} tables…`} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', padding: 6, boxSizing: 'border-box' }} spellCheck={false} />
        </div>
        <ul style={{ overflow: 'auto', listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
          {filtered.map(({ t, label }) => (
            <li key={t.id}>
              <button type="button" onClick={() => setSelId(t.id)} style={{ display: 'block', width: '100%', padding: '6px 10px', border: 'none', background: t.id === selId ? 'var(--surface-raised,#2d3138)' : 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}>
                {label} <span style={{ opacity: 0.5 }}>({t.slots.length})</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
        {!selected ? (
          <div>Select an encounter table.</div>
        ) : (
          <div style={{ maxWidth: 620 }}>
            <h2 style={{ margin: '0 0 2px' }}>
              {selected.mapId ? displayName(manifest, selected.mapId, false) : selected.id}
            </h2>
            <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 12 }}>
              {METHOD_LABEL[selected.type] ?? selected.type} · {selected.encounterRate}% encounter rate · {selected.slots.length} slots ·
              <span style={{ marginLeft: 4 }}>slot order fixes each %, so #1 is the most common.</span>
            </div>
            {note && <div style={{ marginBottom: 10, fontSize: 12, color: note.includes('failed') || note.includes("isn't") ? '#e25555' : '#3fb950' }}>{note}</div>}
            <datalist id="decomp-enc-species">
              {(species ?? []).map((s) => <option key={s.id} value={s.name} />)}
            </datalist>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                  <th style={{ padding: '4px 6px', width: 36 }}>#</th>
                  <th style={{ padding: '4px 6px' }}>Pokémon</th>
                  <th style={{ padding: '4px 6px', width: 90 }}>Min Lv</th>
                  <th style={{ padding: '4px 6px', width: 90 }}>Max Lv</th>
                  <th style={{ padding: '4px 6px', width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-subtle,#2a2a2a)' }}>
                    <td style={{ padding: '4px 6px', opacity: 0.5 }}>{i + 1}</td>
                    <td style={{ padding: '4px 6px' }}>
                      <input list="decomp-enc-species" value={r.sp} spellCheck={false} style={{ width: '100%', boxSizing: 'border-box' }}
                        onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, sp: e.target.value } : x)))} />
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="number" min={1} max={100} value={r.min} style={{ width: 70 }}
                        onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, min: Number.parseInt(e.target.value, 10) || 0 } : x)))} />
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="number" min={1} max={100} value={r.max} style={{ width: 70 }}
                        onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, max: Number.parseInt(e.target.value, 10) || 0 } : x)))} />
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <button type="button" disabled={savingIdx !== null || !rowChanged(r)} onClick={() => void saveRow(i)}
                        style={{ padding: '3px 10px', background: rowChanged(r) ? '#2e7d32' : '#3a3a3a', color: '#fff', border: 'none', borderRadius: 4, cursor: rowChanged(r) ? 'pointer' : 'default' }}>
                        {savingIdx === i ? '…' : 'Save'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 12 }}>
              Encounter rate + adding/removing slots edit the JSON via the agent for now. Type a Pokémon name (autocompletes) or a SPECIES_ id.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
