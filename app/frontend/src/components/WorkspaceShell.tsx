import { useProjectStore, useViewStore } from '../state';
import { AdvancedDrawer } from './AdvancedDrawer';
import { AgentPanel } from './AgentPanel';
import { MainPanel } from './MainPanel';
import { NavigatorTree } from './NavigatorTree';
import './WorkspaceShell.css';

// Workspace shell. Three mounting points:
//
//   1. NavigatorTree (left rail, always visible).
//   2. MainPanel (center, flex) - renders the active view + handles its
//      own selection-bound editing UI inline. Per user request, we no
//      longer auto-pop an InspectorDock slide-over on selection - the
//      MainPanel renders editing affordances in place where appropriate,
//      and the AdvancedDrawer (Ctrl+\) still provides the full
//      InspectorDock view for power users.
//   3. AgentPanel (right rail, always mounted) - the AI agent chat
//      surface; the default right-rail surface per the AI-native pivot.
//
// CSS grid template-columns: `auto minmax(0, 1fr) 380px`.
export function WorkspaceShell() {
  const activeView = useViewStore((s) => s.activeView);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );

  return (
    <div
      className="workspace-shell"
      data-testid="workspace-shell"
      data-inspector="closed"
    >
      <NavigatorTree manifest={manifest} />
      <main className="workspace-shell__surface" data-testid="workspace-surface">
        <MainPanel view={activeView} />
      </main>
      <AgentPanel />
      <AdvancedDrawer />
    </div>
  );
}
