import { useEffect, useState } from 'react';
import { getDecompTypeChart, editDecompTypeChartCell, type DecompTypeChart } from '../api';
import { useProjectStore } from '../state';

/** Type-chart editor (A8, decomp). N×N effectiveness grid; click a cell to
 *  cycle the attacker→defender multiplier (1× → 2× → ½× → 0× → 1×). Edits
 *  gTypeEffectivenessTable in src/data/types_info.h in place. */
function prettyType(t: string): string {
  return t
    .replace(/^TYPE_/, '')
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_a, _b, c: string) => (_b ? ' ' : '') + c.toUpperCase());
}
function abbr(t: string): string {
  return prettyType(t).slice(0, 3);
}
function cellBg(m: number | null): string {
  if (m === null) return '#222';
  if (m === 0) return '#1b1b1b';
  if (m < 1) return '#5a2230';
  if (m > 1) return '#1f5130';
  return 'transparent';
}
function cellText(m: number | null): string {
  if (m === null) return '?';
  if (m === 0) return '0';
  if (m === 0.5) return '½';
  if (m === 1) return '';
  if (m === 2) return '2';
  return String(m);
}
function nextMult(m: number | null): number {
  // 1 → 2 → ½ → 0 → 1
  if (m === 1 || m === null) return 2;
  if (m === 2) return 0.5;
  if (m === 0.5) return 0;
  return 1;
}

export function DecompTypeChartView(): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [chart, setChart] = useState<DecompTypeChart | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    getDecompTypeChart(sessionId)
      .then(setChart)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [sessionId]);

  if (!sessionId) return <div style={{ padding: 16 }}>Open a project first.</div>;
  if (err) return <div style={{ padding: 16, color: '#e25555' }}>Couldn't load type chart: {err}</div>;
  if (!chart) return <div style={{ padding: 16 }}>Loading type chart…</div>;

  const { types, matrix } = chart;

  const onCell = async (ai: number, di: number): Promise<void> => {
    if (!sessionId || busy) return;
    const cur = matrix[ai]![di]!;
    const next = nextMult(cur);
    setBusy(true);
    setNote(null);
    try {
      await editDecompTypeChartCell(sessionId, types[ai]!, di, next);
      setChart((c) => {
        if (!c) return c;
        const m = c.matrix.map((row) => row.slice());
        m[ai]![di] = next;
        return { ...c, matrix: m };
      });
    } catch (e) {
      setNote(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const CELL = 26;
  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%', minHeight: 0 }} data-testid="decomp-typechart-view">
      <h2 style={{ margin: '0 0 4px' }}>Type chart</h2>
      <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 10 }}>
        Rows attack, columns defend. Click a cell to cycle 1× → 2× → ½× → 0×.
        <span style={{ marginLeft: 8 }}>
          <Swatch bg="#1f5130" label="2× (super)" /> <Swatch bg="#5a2230" label="½× (resist)" /> <Swatch bg="#1b1b1b" label="0× (immune)" />
        </span>
      </div>
      {note && <div style={{ marginBottom: 8, fontSize: 12, color: '#e25555' }}>{note}</div>}
      <table style={{ borderCollapse: 'collapse', fontSize: 11, userSelect: 'none' }}>
        <thead>
          <tr>
            <th style={{ position: 'sticky', left: 0, background: 'var(--surface,#1e1e1e)', zIndex: 2 }} />
            {types.map((t) => (
              <th key={t} title={prettyType(t)} style={{ width: CELL, minWidth: CELL, padding: 0, fontWeight: 500, opacity: 0.7, transform: 'rotate(-35deg)', height: 44, fontSize: 10 }}>
                {abbr(t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {types.map((atk, ai) => (
            <tr key={atk}>
              <th style={{ position: 'sticky', left: 0, background: 'var(--surface,#1e1e1e)', textAlign: 'right', padding: '0 6px', fontWeight: 500, whiteSpace: 'nowrap', fontSize: 11 }} title={prettyType(atk)}>
                {prettyType(atk)}
              </th>
              {types.map((def, di) => {
                const m = matrix[ai]![di]!;
                return (
                  <td key={def} style={{ padding: 0, border: '1px solid #2a2a2a' }}>
                    <button
                      type="button"
                      onClick={() => void onCell(ai, di)}
                      disabled={busy}
                      title={`${prettyType(atk)} → ${prettyType(def)}: ${m === null ? '?' : m}×`}
                      style={{ width: CELL, height: CELL, margin: 0, padding: 0, border: 'none', background: cellBg(m), color: m !== null && m > 1 ? '#9fe6b0' : m !== null && m < 1 ? '#e6a0ad' : 'inherit', cursor: busy ? 'default' : 'pointer', fontSize: 12, fontWeight: 700 }}
                      data-testid={`typechart-cell-${ai}-${di}`}
                    >
                      {cellText(m)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Swatch({ bg, label }: { bg: string; label: string }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 8 }}>
      <span style={{ display: 'inline-block', width: 12, height: 12, background: bg, border: '1px solid #2a2a2a', verticalAlign: 'middle' }} />
      <span style={{ opacity: 0.7 }}>{label}</span>
    </span>
  );
}
