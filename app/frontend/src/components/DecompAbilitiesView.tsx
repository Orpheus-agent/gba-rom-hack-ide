import { useEffect, useMemo, useState } from 'react';
import { getDecompAbilities, editDecompAbility, type DecompAbility } from '../api';
import { useProjectStore } from '../state';

export function DecompAbilitiesView(): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [list, setList] = useState<DecompAbility[] | null>(null);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<DecompAbility | null>(null);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | { err: string }>('idle');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    getDecompAbilities(sessionId)
      .then((l) => {
        setList(l);
        if (l.length > 0) setSel((c) => c ?? l[0]!.id);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  useEffect(() => {
    if (!list || !sel) return;
    const a = list.find((x) => x.id === sel) ?? null;
    setDraft(a ? { ...a } : null);
    setSave('idle');
  }, [list, sel]);

  const filtered = useMemo(() => {
    const all = list ?? [];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : all;
  }, [list, filter]);

  if (!sessionId) return <div style={{ padding: 16 }}>Open a project first.</div>;
  if (err) return <div style={{ padding: 16, color: '#e25555' }}>Couldn't load abilities: {err}</div>;
  if (!list) return <div style={{ padding: 16 }}>Loading abilities…</div>;

  const doSave = async (): Promise<void> => {
    if (!draft) return;
    setSave('saving');
    try {
      await editDecompAbility(sessionId, draft.id, {
        name: draft.name,
        description: draft.description,
        aiRating: draft.aiRating,
      });
      setList((l) => (l ? l.map((a) => (a.id === draft.id ? draft : a)) : l));
      setSave('saved');
    } catch (e) {
      setSave({ err: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="decomp-abilities-view">
      <aside style={{ width: 220, borderRight: '1px solid var(--border-subtle,#2a2a2a)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <input type="search" placeholder={`Filter ${list.length} abilities…`} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ margin: 8, padding: 6 }} spellCheck={false} />
        <ul style={{ overflow: 'auto', listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
          {filtered.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setSel(a.id)} style={{ display: 'block', width: '100%', padding: '6px 10px', border: 'none', background: a.id === sel ? 'var(--surface-raised,#2d3138)' : 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
        {!draft ? (
          <div>Select an ability.</div>
        ) : (
          <div style={{ maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 style={{ margin: 0 }}>{draft.name}</h2>
            <label style={LBL}>Name<input value={draft.name} spellCheck={false} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label style={LBL}>Description<textarea value={draft.description} rows={3} spellCheck={false} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={{ resize: 'vertical' }} /></label>
            <label style={{ ...LBL, maxWidth: 160 }}>AI rating<input type="number" value={draft.aiRating} onChange={(e) => setDraft({ ...draft, aiRating: Number.parseInt(e.target.value, 10) || 0 })} /></label>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button type="button" onClick={() => void doSave()} disabled={save === 'saving'} style={BTN}>{save === 'saving' ? 'Saving…' : 'Save'}</button>
              {save === 'saved' && <span style={{ color: '#3fb950' }}>Saved.</span>}
              {typeof save === 'object' && <span style={{ color: '#e25555' }}>{save.err}</span>}
            </div>
            <div style={{ fontSize: 11, opacity: 0.55 }}>The ability's *effect* is C battle-engine logic - ask the agent to change what it does.</div>
          </div>
        )}
      </section>
    </div>
  );
}

const LBL = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 } as const;
const BTN = { padding: '6px 18px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' } as const;
