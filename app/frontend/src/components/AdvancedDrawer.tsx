import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { useAdvancedDrawerStore, useViewStore, type ViewKey } from '../state';
import './AdvancedDrawer.css';

// Phase P.2 + The Real Game Editor Push - Advanced drawer is now an
// OVERLAY (Ctrl+\ / Cmd+\) rather than the always-visible left rail.
// The Navigator tree owns the always-visible left rail; this drawer
// hosts the OLD flat tab list for power-user browse access to Build,
// Lint, Plugins, Mechanics, Timeline, Dependencies, Templates, and the
// demolished standalone views (Events, Dialogue, Flags, Species, etc.).
//
// Closed by default; opens with Ctrl+\; clicking the dim backdrop or
// pressing Escape closes it.

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function AdvancedDrawer() {
  const open = useAdvancedDrawerStore((s) => s.open);
  const toggle = useAdvancedDrawerStore((s) => s.toggle);
  const setOpen = useAdvancedDrawerStore((s) => s.setOpen);
  const activeView = useViewStore((s) => s.activeView);
  const setView = useViewStore((s) => s.setView);

  // Global Ctrl+\ / Cmd+\ shortcut to toggle the drawer + Escape closes.
  // Skipped when typing in inputs so writers don't lose focus mid-line.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.repeat) return;
      if (e.key === '\\' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, setOpen, open]);

  const onSelectView = (view: ViewKey) => {
    setView(view);
    // Drawer stays open across view switches so power-users can
    // navigate multiple views without re-toggling. Closed via the
    // close button, Escape, the backdrop, or Ctrl+\.
  };

  if (!open) {
    // Render nothing when closed - no grid space consumed.
    return null;
  }

  return (
    <>
      <div
        className="advanced-drawer__backdrop"
        onClick={() => setOpen(false)}
        data-testid="advanced-drawer-backdrop"
        aria-hidden="true"
      />
      <aside
        className="advanced-drawer advanced-drawer--open advanced-drawer--overlay"
        data-testid="advanced-drawer"
        data-open="true"
        role="dialog"
        aria-label="Advanced views"
      >
        <header className="advanced-drawer__header">
          <span className="advanced-drawer__title">All views</span>
          <button
            type="button"
            className="advanced-drawer__close"
            onClick={() => setOpen(false)}
            title="Close drawer (Esc / Ctrl+\\)"
            aria-label="Close advanced drawer"
            data-testid="advanced-drawer-close"
          >
            ✕
          </button>
        </header>
        <Sidebar active={activeView} onSelect={onSelectView} />
      </aside>
    </>
  );
}
