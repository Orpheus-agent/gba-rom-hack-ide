import { useEffect, useState } from 'react';
import { fetchOpLog, type BackendStatus, type OpKind, type OpLogEntry } from '../api';
import { useProjectStore } from '../state';
import './StatusBar.css';

interface StatusBarProps {
  readonly backendStatus: BackendStatus;
}

function backendCell(s: BackendStatus): { text: string; cls: string; full: string } {
  switch (s.state) {
    case 'connecting':
      return {
        text: 'Backend: connecting…',
        cls: 'status-bar__dot--connecting',
        full: 'Connecting to local backend…',
      };
    case 'connected':
      return {
        text: `Backend: ${s.service} v${s.version}`,
        cls: 'status-bar__dot--connected',
        full: `Backend ${s.service} v${s.version} - connected`,
      };
    case 'disconnected':
      return {
        text: 'Backend: unreachable',
        cls: 'status-bar__dot--disconnected',
        full: `Backend unreachable: ${s.error}`,
      };
  }
}

const OP_LABEL: Record<OpKind, string> = {
  move_event: 'Move event',
  patch_event_fields: 'Edit event fields',
  edit_dialogue: 'Edit dialogue',
  replace_asset: 'Replace asset',
  import_asset: 'Import asset',
  stage_template: 'Stage template',
  patch_mechanic_config: 'Update mechanic',
};

function relativeTime(fromUtc: string, nowMs: number): string {
  const ms = nowMs - Date.parse(fromUtc);
  if (Number.isNaN(ms)) return fromUtc;
  if (ms < 0) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

export function StatusBar({ backendStatus }: StatusBarProps) {
  const load = useProjectStore((s) => s.load);
  const scan = useProjectStore((s) => s.scan);
  const sessionId = load.kind === 'loaded' ? load.data.session.id : null;
  const [lastOp, setLastOp] = useState<OpLogEntry | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Refresh the relative-time display every 15s so "just now" eventually
  // becomes "1 min ago" without requiring a re-fetch.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Lazy + polled fetch of the op-log tail (limit=1) so the status bar can
  // show the most recent edit without holding the whole log in memory.
  useEffect(() => {
    if (!sessionId) {
      setLastOp(null);
      return;
    }
    let cancelled = false;
    async function refresh() {
      if (!sessionId) return;
      try {
        const r = await fetchOpLog(sessionId, 1);
        if (cancelled) return;
        setLastOp(r.entries[0] ?? null);
      } catch {
        // Swallow - status bar is best-effort, an unreachable backend
        // already shows in the backend cell.
      }
    }
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, scan]);

  const backend = backendCell(backendStatus);

  // Project + scan cell
  let projectText = 'No project open';
  let projectCls = 'status-bar__dot--neutral';
  let projectFull = projectText;
  if (load.kind === 'loaded') {
    const ident = load.data.identity;
    if (scan.kind === 'scanning') {
      projectText = `Project: ${ident.displayName} - scanning…`;
      projectCls = 'status-bar__dot--connecting';
      projectFull = projectText;
    } else if (scan.kind === 'loaded') {
      const m = scan.data.manifest;
      const total =
        m.maps.length +
        m.warps.length +
        m.triggers.length +
        m.objectEvents.length +
        m.flags.length +
        m.variables.length +
        m.encounterTables.length +
        m.trainers.length +
        m.dialogue.length +
        m.assets.length +
        m.scriptSteps.length;
      // WP-C1/C3 cascade - stale-while-revalidate ScanState. When
      // scan.revalidating is true the user sees the prior-scan
      // counts (so the UI doesn't flicker) but the status bar
      // surfaces a "syncing" pip so they know a rescan is in
      // flight. Identical visual treatment as the initial-scan path.
      const syncing = scan.revalidating === true;
      projectText = syncing
        ? `Project: ${ident.displayName} - syncing… (${total} entities)`
        : `Project: ${ident.displayName} - ${total} entities`;
      projectCls = syncing ? 'status-bar__dot--connecting' : 'status-bar__dot--connected';
      const durMs = scan.data.scanDurationMs;
      const durStr = durMs >= 0 ? ` - scan took ${durMs}ms (budget 5000ms)` : '';
      projectFull = `${ident.displayName} (${ident.kind}, confidence ${Math.round(ident.confidence * 100)}%) - ${total} indexed entities${durStr}${syncing ? ' - refreshing after edit' : ''}`;
    } else if (scan.kind === 'error') {
      projectText = `Project: ${ident.displayName} - scan failed`;
      projectCls = 'status-bar__dot--disconnected';
      projectFull = `Scan failed: ${scan.message} (${scan.code})`;
    } else {
      projectText = `Project: ${ident.displayName} - not scanned`;
      projectCls = 'status-bar__dot--warn';
      projectFull = `${ident.displayName} (${ident.kind}) - open Project view and click Scan to index`;
    }
  } else if (load.kind === 'loading') {
    projectText = 'Project: opening…';
    projectCls = 'status-bar__dot--connecting';
  } else if (load.kind === 'error') {
    projectText = `Project: open failed`;
    projectCls = 'status-bar__dot--disconnected';
    projectFull = `Failed to open: ${load.message} (${load.code})`;
  }

  // Last edit cell
  let lastOpText = 'No edits yet';
  let lastOpFull = 'No edits recorded in this project yet';
  if (lastOp) {
    const label = OP_LABEL[lastOp.op] ?? lastOp.op;
    lastOpText = `Last edit: ${label} - ${relativeTime(lastOp.atUtc, nowMs)}`;
    lastOpFull = `${label} at ${lastOp.atUtc} by session ${lastOp.sessionId.slice(0, 8)}`;
  }

  return (
    <footer className="status-bar" data-testid="status-bar">
      <div className="status-bar__cell" data-testid="status-cell-backend" title={backend.full}>
        <span className={`status-bar__dot ${backend.cls}`} aria-hidden="true" />
        <span className="status-bar__text" data-testid="backend-status">
          {backend.text}
        </span>
      </div>
      <div className="status-bar__sep" aria-hidden="true" />
      <div className="status-bar__cell" data-testid="status-cell-project" title={projectFull}>
        <span className={`status-bar__dot ${projectCls}`} aria-hidden="true" />
        <span className="status-bar__text">{projectText}</span>
      </div>
      <div className="status-bar__sep" aria-hidden="true" />
      <div className="status-bar__cell" data-testid="status-cell-last-op" title={lastOpFull}>
        <span className="status-bar__dot status-bar__dot--neutral" aria-hidden="true" />
        <span className="status-bar__text">{lastOpText}</span>
      </div>
    </footer>
  );
}
