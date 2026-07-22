import { useEffect, useMemo, useState } from 'react';
import {
  getDecompMovesList,
  getDecompMove,
  editDecompMove,
  type DecompMoveListItem,
  type DecompMoveDetail,
  type DecompMoveEnums,
  type DecompMoveEdit,
} from '../api';
import { useProjectStore } from '../state';

function pretty(constName: string, prefix: string): string {
  return constName
    .replace(new RegExp(`^${prefix}`), '')
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_a, _b, c: string) => (_b ? ' ' : '') + c.toUpperCase())
    .trim();
}

function Sel({
  value,
  options,
  prefix,
  onChange,
}: {
  value: string;
  options: string[];
  prefix: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const opts = options.includes(value) ? options : [value, ...options];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ padding: 4, minWidth: 130 }}>
      {opts.map((o) => (
        <option key={o} value={o}>
          {pretty(o, prefix)}
        </option>
      ))}
    </select>
  );
}

export function DecompMovesView(): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [list, setList] = useState<DecompMoveListItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DecompMoveDetail | null>(null);
  const [enums, setEnums] = useState<DecompMoveEnums | null>(null);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | { err: string }>('idle');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    getDecompMovesList(sessionId)
      .then((l) => {
        setList(l);
        if (l.length > 0) setSelectedId((c) => c ?? l[0]!.id);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !selectedId) return;
    setSave('idle');
    getDecompMove(sessionId, selectedId)
      .then(({ detail: d, enums: en }) => {
        setDetail(d);
        setEnums(en);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [sessionId, selectedId]);

  const filtered = useMemo(() => {
    const all = list ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : all;
  }, [list, filter]);

  if (!sessionId) return <div style={{ padding: 16 }}>Open a project first.</div>;
  if (err) return <div style={{ padding: 16, color: '#e25555' }}>Couldn't load moves: {err}</div>;
  if (!list) return <div style={{ padding: 16 }}>Loading moves…</div>;

  const set = <K extends keyof DecompMoveDetail>(k: K, v: DecompMoveDetail[K]): void =>
    setDetail((d) => (d ? { ...d, [k]: v } : d));

  const doSave = async (): Promise<void> => {
    if (!detail) return;
    setSave('saving');
    const edit: DecompMoveEdit = {
      name: detail.name,
      power: detail.power,
      type: detail.type,
      accuracy: detail.accuracy,
      pp: detail.pp,
      priority: detail.priority,
      category: detail.category,
      target: detail.target,
      effect: detail.effect,
      makesContact: detail.makesContact,
      description: detail.description,
    };
    try {
      await editDecompMove(sessionId, detail.id, edit);
      setSave('saved');
    } catch (e) {
      setSave({ err: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="decomp-moves-view">
      <aside style={{ width: 220, borderRight: '1px solid var(--border-subtle,#2a2a2a)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <input type="search" placeholder={`Filter ${list.length} moves…`} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ margin: 8, padding: 6 }} spellCheck={false} />
        <ul style={{ overflow: 'auto', listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
          {filtered.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => setSelectedId(m.id)} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', padding: '6px 10px', border: 'none', background: m.id === selectedId ? 'var(--surface-raised,#2d3138)' : 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                <span>{m.name}</span>
                <span style={{ opacity: 0.5, fontSize: 11 }}>{m.power || ' - '}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
        {!detail || !enums ? (
          <div>Select a move.</div>
        ) : (
          <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 style={{ margin: 0 }}>{detail.name}</h2>
            <fieldset style={FS}>
              <legend>Battle</legend>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label style={L}>Type<Sel value={detail.type} options={enums.types} prefix="TYPE_" onChange={(v) => set('type', v)} /></label>
                <label style={L}>Category<Sel value={detail.category} options={enums.categories} prefix="DAMAGE_CATEGORY_" onChange={(v) => set('category', v)} /></label>
                <label style={L}>Power<input type="number" value={detail.power} onChange={(e) => set('power', Number.parseInt(e.target.value, 10) || 0)} /></label>
                <label style={L}>Accuracy<input type="number" value={detail.accuracy} onChange={(e) => set('accuracy', Number.parseInt(e.target.value, 10) || 0)} /></label>
                <label style={L}>PP<input type="number" value={detail.pp} onChange={(e) => set('pp', Number.parseInt(e.target.value, 10) || 0)} /></label>
                <label style={L}>Priority<input type="number" value={detail.priority} onChange={(e) => set('priority', Number.parseInt(e.target.value, 10) || 0)} /></label>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' }}>
                <label style={L}>Target<Sel value={detail.target} options={enums.targets} prefix="MOVE_TARGET_" onChange={(v) => set('target', v)} /></label>
                <label style={L}>Effect<Sel value={detail.effect} options={enums.effects} prefix="EFFECT_" onChange={(v) => set('effect', v)} /></label>
                <label style={{ ...L, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={detail.makesContact} onChange={(e) => set('makesContact', e.target.checked)} />
                  Makes contact
                </label>
              </div>
            </fieldset>
            <fieldset style={FS}>
              <legend>Text</legend>
              <label style={{ ...L, width: '100%' }}>Name<input value={detail.name} spellCheck={false} onChange={(e) => set('name', e.target.value)} /></label>
              <label style={{ ...L, width: '100%', marginTop: 8 }}>Description<textarea value={detail.description} rows={3} spellCheck={false} onChange={(e) => set('description', e.target.value)} style={{ width: '100%', resize: 'vertical' }} /></label>
            </fieldset>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button type="button" onClick={() => void doSave()} disabled={save === 'saving'} style={BTN}>{save === 'saving' ? 'Saving…' : 'Save'}</button>
              {save === 'saved' && <span style={{ color: '#3fb950' }}>Saved. Build &amp; Play to see it.</span>}
              {typeof save === 'object' && <span style={{ color: '#e25555' }}>{save.err}</span>}
            </div>
            <div style={{ fontSize: 11, opacity: 0.55 }}>The move's effect *script* (what EFFECT_* does) is C logic - ask the agent to change behavior beyond these fields.</div>
          </div>
        )}
      </section>
    </div>
  );
}

const FS = { border: '1px solid var(--border-subtle,#2a2a2a)', borderRadius: 6, padding: 10 } as const;
const L = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 } as const;
const BTN = { padding: '6px 18px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' } as const;
