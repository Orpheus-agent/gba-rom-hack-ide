import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkspaceShell } from './WorkspaceShell';
import {
  useAdvancedDrawerStore,
  useProjectStore,
  useSelection,
  useViewStore,
} from '../state';
import { useAgentStore } from '../state/agent';

function resetAgentStore(): void {
  useAgentStore.getState().disconnect();
  useAgentStore.setState({
    stream: null,
    connection: { kind: 'idle' },
    projectId: null,
    messages: [],
    inFlight: false,
    eventCounter: 0,
  });
}

describe('WorkspaceShell (Phase AI-0.6 - Agent rail)', () => {
  beforeEach(() => {
    useAdvancedDrawerStore.setState({ open: true });
    useViewStore.setState({ activeView: 'project', editingMapId: null });
    useProjectStore.setState({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
    useSelection.setState({ current: null, history: [] });
    resetAgentStore();
  });

  afterEach(() => {
    cleanup();
    resetAgentStore();
  });

  it('mounts the workspace surface, the agent rail, and the advanced drawer by default', () => {
    render(<WorkspaceShell />);
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-surface')).toBeInTheDocument();
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(screen.getByTestId('advanced-drawer')).toBeInTheDocument();
  });

  it('does not mount an inspector dock slide-over by default', () => {
    render(<WorkspaceShell />);
    expect(screen.queryByTestId('inspector-dock')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-shell')).toHaveAttribute('data-inspector', 'closed');
  });

  it('does NOT auto-pop an inspector dock when an entity is selected', () => {
    // Per the user-driven UX simplification: selecting an entity should
    // not summon a slide-over inspector. Editing affordances live in
    // MainPanel (or AdvancedDrawer behind Ctrl+\). The inspector-dock
    // testid must remain absent so the MainPanel's selection-driven UI
    // isn't shadowed by an obscuring slide-over.
    useSelection.getState().select({ kind: 'species', id: 'BULBASAUR' });
    render(<WorkspaceShell />);
    expect(screen.queryByTestId('inspector-dock')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-shell')).toHaveAttribute('data-inspector', 'closed');
  });

  it('with drawer closed, the Sidebar is not in the DOM but the agent rail + surface remain', () => {
    useAdvancedDrawerStore.setState({ open: false });
    render(<WorkspaceShell />);
    expect(screen.queryByTestId('sidebar-nav-project')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-surface')).toBeInTheDocument();
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
  });

  it('with drawer open, the Sidebar inside the drawer reaches every ViewKey', () => {
    render(<WorkspaceShell />);
    expect(screen.getByTestId('sidebar-nav-project')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-nav-maps')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-nav-events')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-nav-build')).toBeInTheDocument();
  });
});
