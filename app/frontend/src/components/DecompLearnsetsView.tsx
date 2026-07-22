import { useEffect, useMemo, useState } from 'react';
import {
  getDecompLearnsets,
  getDecompMovesList,
  editDecompLearnsetMove,
  type DecompLearnset,
  type DecompMoveListItem,
} from '../api';
import { useProjectStore } from '../state';

/** Level-up Learnsets editor (A3, decomp). Reads the active gen file's
 *  s<Mon>LevelUpLearnset[] arrays; edits an entry's level + move in place.
 *  Adding/removing moves goes through the agent for now. */
interface Row {
  level: number;
  move: string; // friendly name (or raw MOVE_ id if unknown)
  origLevel: number;
  origMove: string; // MOVE_ id
}

export function DecompLearnsetsView(): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [list, setList] = useState<DecompLearnset[] | null>(null);
  const [moves, setMoves] = useState<DecompMoveListItem[]>([]);
  const [filter, setFilter] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    Promise.all([getDecompLearnsets(sessionId), getDecompMovesList(sessionId)])
      .then(([ls, mv]) => {
        setList(ls);
        setMoves(mv);
        if (ls.length > 0) setSelId((c) => c ?? ls[0]!.id);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  const { idToName, nameToId } = useMemo(() => {
    const i2n = new Map<string, string>();
    const n2i = new Map<string, string>();
    for (const m of moves) {
      i2n.set(m.id, m.name);
      n2i.set(m.name.toLowerCase(), m.id);
    }
    return { idToName: i2n, nameToId: n2i };
  }, [moves]);

  const filtered = useMemo(() => {
    const all = list ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((l) => l.name.toLowerCase().includes(q) || l.id.toLowerCase().includes(q)) : all;
  }, [list, filter]);

  const selected = useMemo(() => (list ?? []).find((l) => l.id === selId) ?? null, [list, selId]);

  useEffect(() => {
    if (!selected) {
      setRows([]);
      return;
    }
    setRows(
      selected.moves.map((m) => ({
        level: m.level,
        move: idToName.get(m.move) ?? m.move,
        origLevel: m.level,
        origMove: m.move,
      })),
    );
    setNote(null);
  }, [selected, idToName]);

  if (!sessionId) return <div style={{ padding: 16 }}>Open a project first.</div>;
  if (err) return <div style={{ padding: 16, color: '#e25555' }}>Couldn't load learnsets: {err}</div>;
  if (!list) return <div style={{ padding: 16 }}>Loading learnsets…</div>;

  const resolveMove = (text: string): string | null => {
    const byName = nameToId.get(text.trim().toLowerCase());
    if (byName) return byName;
    const t = text.trim();
    return /^MOVE_[A-Z0-9_]+$/i.test(t) ? t.toUpperCase() : null;
  };
  const rowChanged = (r: Row): boolean =>
    r.level !== r.origLevel || (resolveMove(r.move) ?? r.origMove) !== r.origMove;

  const saveRow = async (i: number): Promise<void> => {
    if (!selected) return;
    const r = rows[i]!;
    const mv = resolveMove(r.move);
    if (r.move.trim() && !mv) {
      setNote(`"${r.move}" isn't a known move - type a name (e.g. Thunderbolt) or a MOVE_ id.`);
      return;
    }
    const edit: { level?: number; move?: string } = {};
    if (r.level !== r.origLevel) edit.level = r.level;
    if (mv && mv !== r.origMove) edit.move = mv;
    if (Object.keys(edit).length === 0) return;
    setSavingIdx(i);
    setNote(null);
    try {
      await editDecompLearnsetMove(sessionId, selected.id, i, edit);
      setRows((prev) =>
        prev.map((x, idx) =>
          idx === i ? { ...x, origLevel: x.level, origMove: mv ?? x.origMove, move: idToName.get(mv ?? x.origMove) ?? x.move } : x,
        ),
      );
      setNote(`Move ${i + 1} saved.`);
    } catch (e) {
      setNote(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingIdx(null);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="decomp-learnsets-view">
      <aside style={{ width: 240, borderRight: '1px solid var(--border-subtle,#2a2a2a)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 8 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 15 }}>Learnsets</h2>
          <input type="search" placeholder={`Filter ${list.length}…`} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', padding: 6, boxSizing: 'border-box' }} spellCheck={false} />
        </div>
        <ul style={{ overflow: 'auto', listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
          {filtered.map((l) => (
            <li key={l.id}>
              <button type="button" onClick={() => setSelId(l.id)} style={{ display: 'block', width: '100%', padding: '6px 10px', border: 'none', background: l.id === selId ? 'var(--surface-raised,#2d3138)' : 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}>
                {l.name} <span style={{ opacity: 0.5 }}>({l.moves.length})</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
        {!selected ? (
          <div>Select a Pokémon's learnset.</div>
        ) : (
          <div style={{ maxWidth: 560 }}>
            <h2 style={{ margin: '0 0 2px' }}>{selected.name}</h2>
            <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 12 }}>{selected.moves.length} level-up moves</div>
            {note && <div style={{ marginBottom: 10, fontSize: 12, color: note.includes('failed') || note.includes("isn't") ? '#e25555' : '#3fb950' }}>{note}</div>}
            <datalist id="decomp-learnset-moves">
              {moves.map((m) => <option key={m.id} value={m.name} />)}
            </datalist>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                  <th style={{ padding: '4px 6px', width: 80 }}>Level</th>
                  <th style={{ padding: '4px 6px' }}>Move</th>
                  <th style={{ padding: '4px 6px', width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-subtle,#2a2a2a)' }}>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="number" min={0} max={100} value={r.level} style={{ width: 64 }}
                        onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, level: Number.parseInt(e.target.value, 10) || 0 } : x)))} />
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input list="decomp-learnset-moves" value={r.move} spellCheck={false} style={{ width: '100%', boxSizing: 'border-box' }}
                        onChange={(e) => setRows((p) => p.map((x, idx) => (idx === i ? { ...x, move: e.target.value } : x)))} />
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
              Editing the active learnset gen file. Type a move name (autocompletes) or a MOVE_ id. Adding/removing moves goes through the agent.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
