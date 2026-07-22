import { useEffect, useMemo, useState } from 'react';
import {
  getDecompTrainer,
  editDecompTrainerParty,
  getDecompSpeciesList,
  getDecompMovesList,
  getDecompItems,
  type DecompPartyMon,
} from '../api';
import { useProjectStore } from '../state';

/** Trainers list + party editor (A7, decomp). Lists every trainer from the
 *  manifest, loads its party from src/data/trainers.party (friendly names), and
 *  edits species / level / held item / moves + add/remove mon. Reuses the
 *  existing /decomp-trainer routes (trainerId-driven) - the same editor reached
 *  by clicking a trainer NPC, now reachable from the full trainer list. IVs /
 *  EVs / ability / nature / unmodeled lines are preserved verbatim on save. */
export function DecompTrainersView(): JSX.Element {
  const scan = useProjectStore((s) => s.scan);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const manifest = scan.kind === 'loaded' ? scan.data.manifest : null;

  const [filter, setFilter] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [party, setParty] = useState<DecompPartyMon[] | null>(null);
  const [meta, setMeta] = useState<{ name: string | null; className: string | null } | null>(null);
  const [load, setLoad] = useState<'idle' | 'loading' | 'loaded' | 'none'>('idle');
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | { err: string }>('idle');
  const [species, setSpecies] = useState<string[]>([]);
  const [moves, setMoves] = useState<string[]>([]);
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    void Promise.allSettled([
      getDecompSpeciesList(sessionId).then((l) => setSpecies(l.map((x) => x.name))),
      getDecompMovesList(sessionId).then((l) => setMoves(l.map((x) => x.name))),
      getDecompItems(sessionId).then((r) => setItems(r.items.map((x) => x.name))),
    ]);
  }, [sessionId]);

  const trainers = useMemo(() => manifest?.trainers ?? [], [manifest]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? trainers.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || (t.className ?? '').toLowerCase().includes(q))
      : trainers;
  }, [trainers, filter]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !selId) {
      setParty(null);
      setMeta(null);
      return;
    }
    setLoad('loading');
    setDirty(false);
    setSave('idle');
    getDecompTrainer(sessionId, { trainerId: selId })
      .then((res) => {
        if (cancelled) return;
        if (res.resolved && res.trainer) {
          setMeta({ name: res.trainer.name, className: res.trainer.className });
          setParty(res.trainer.party.map((m) => ({ ...m, moves: [...m.moves], extraLines: [...m.extraLines] })));
          setLoad('loaded');
        } else {
          setParty(null);
          setMeta(null);
          setLoad('none');
        }
      })
      .catch(() => !cancelled && setLoad('none'));
    return () => { cancelled = true; };
  }, [sessionId, selId]);

  if (!sessionId || !manifest) return <div style={{ padding: 16 }}>Open + scan a project first.</div>;

  const patchMon = (i: number, p: Partial<DecompPartyMon>): void => {
    setParty((prev) => (prev ? prev.map((m, idx) => (idx === i ? { ...m, ...p } : m)) : prev));
    setDirty(true);
  };
  const patchMove = (i: number, mi: number, v: string): void => {
    setParty((prev) =>
      prev ? prev.map((m, idx) => {
        if (idx !== i) return m;
        const mv = [...m.moves];
        while (mv.length <= mi) mv.push('');
        mv[mi] = v;
        return { ...m, moves: mv };
      }) : prev,
    );
    setDirty(true);
  };
  const removeMon = (i: number): void => { setParty((p) => (p ? p.filter((_, idx) => idx !== i) : p)); setDirty(true); };
  const addMon = (): void => {
    setParty((p) => (p ? [...p, { species: 'Rattata', heldItem: null, level: 5, ivs: null, evs: null, ability: null, nature: null, moves: [], extraLines: [] }] : p));
    setDirty(true);
  };

  const doSave = async (): Promise<void> => {
    if (!sessionId || !selId || !party) return;
    setSave('saving');
    try {
      const cleaned = party.map((m) => ({
        ...m,
        species: m.species.trim(),
        heldItem: m.heldItem && m.heldItem.trim() ? m.heldItem.trim() : null,
        moves: m.moves.map((x) => x.trim()).filter((x) => x.length > 0),
      }));
      await editDecompTrainerParty(sessionId, selId, cleaned);
      setSave('saved');
      setDirty(false);
    } catch (e) {
      setSave({ err: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="decomp-trainers-view">
      <datalist id="dt-species">{species.map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="dt-moves">{moves.map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="dt-items">{items.map((s) => <option key={s} value={s} />)}</datalist>
      <aside style={{ width: 260, borderRight: '1px solid var(--border-subtle,#2a2a2a)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 8 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 15 }}>Trainers</h2>
          <input type="search" placeholder={`Filter ${trainers.length}…`} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', padding: 6, boxSizing: 'border-box' }} spellCheck={false} />
        </div>
        <ul style={{ overflow: 'auto', listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
          {filtered.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => setSelId(t.id)} style={{ display: 'block', width: '100%', padding: '5px 10px', border: 'none', background: t.id === selId ? 'var(--surface-raised,#2d3138)' : 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}>
                {t.name} <span style={{ opacity: 0.5 }}>· {t.className?.replace(/^TRAINER_CLASS_/, '').toLowerCase().replace(/_/g, ' ')}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
        {!selId ? (
          <div>Select a trainer.</div>
        ) : load === 'loading' ? (
          <div>Loading party…</div>
        ) : load === 'none' || !party ? (
          <div style={{ opacity: 0.7 }}>No editable party found for this trainer in trainers.party.</div>
        ) : (
          <div style={{ maxWidth: 640 }}>
            <h2 style={{ margin: '0 0 2px' }}>{meta?.name ?? selId}</h2>
            <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 12 }}>{meta?.className} · {party.length} Pokémon</div>
            {party.map((m, i) => (
              <div key={i} style={{ border: '1px solid var(--border-subtle,#2a2a2a)', borderRadius: 6, padding: 10, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={LBL}>Species<input list="dt-species" value={m.species} spellCheck={false} onChange={(e) => patchMon(i, { species: e.target.value })} style={{ width: 150 }} /></label>
                  <label style={LBL}>Level<input type="number" min={1} max={100} value={m.level ?? 0} onChange={(e) => patchMon(i, { level: Number.parseInt(e.target.value, 10) || 0 })} style={{ width: 60 }} /></label>
                  <label style={LBL}>Held item<input list="dt-items" value={m.heldItem ?? ''} spellCheck={false} placeholder="(none)" onChange={(e) => patchMon(i, { heldItem: e.target.value })} style={{ width: 150 }} /></label>
                  <button type="button" onClick={() => removeMon(i)} style={{ marginLeft: 'auto', padding: '4px 10px', background: '#5a2230', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Remove</button>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {[0, 1, 2, 3].map((mi) => (
                    <label key={mi} style={{ ...LBL, fontSize: 11 }}>Move {mi + 1}
                      <input list="dt-moves" value={m.moves[mi] ?? ''} spellCheck={false} placeholder=" - " onChange={(e) => patchMove(i, mi, e.target.value)} style={{ width: 130 }} />
                    </label>
                  ))}
                </div>
                {(m.ability || m.nature || m.ivs || m.evs) && (
                  <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
                    Preserved: {[m.ability && `ability ${m.ability}`, m.nature && `nature ${m.nature}`, m.ivs && 'IVs', m.evs && 'EVs'].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
              <button type="button" onClick={addMon} disabled={party.length >= 6} style={{ padding: '6px 14px', background: '#3a3a3a', color: '#fff', border: 'none', borderRadius: 4, cursor: party.length >= 6 ? 'default' : 'pointer' }}>＋ Add Pokémon ({party.length}/6)</button>
              <button type="button" onClick={() => void doSave()} disabled={!dirty || save === 'saving'} style={{ padding: '6px 18px', background: dirty ? '#2e7d32' : '#3a3a3a', color: '#fff', border: 'none', borderRadius: 4, cursor: dirty ? 'pointer' : 'default' }}>{save === 'saving' ? 'Saving…' : 'Save party'}</button>
              {save === 'saved' && !dirty && <span style={{ color: '#3fb950' }}>Saved.</span>}
              {typeof save === 'object' && <span style={{ color: '#e25555' }}>{save.err}</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const LBL = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 } as const;
