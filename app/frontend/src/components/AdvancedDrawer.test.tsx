import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AdvancedDrawer } from './AdvancedDrawer';
import { useAdvancedDrawerStore, useProjectStore, useViewStore } from '../state';

describe('AdvancedDrawer (Phase P.2)', () => {
  beforeEach(() => {
    useAdvancedDrawerStore.setState({ open: true });
    useViewStore.setState({ activeView: 'project', editingMapId: null });
    useProjectStore.setState({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
  });

  afterEach(() => cleanup());

  it('renders the Sidebar inside when open', () => {
    render(<AdvancedDrawer />);
    expect(screen.getByTestId('advanced-drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('sidebar-nav-project')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-nav-maps')).toBeInTheDocument();
  });

  it('renders nothing when closed (overlay drawer pattern)', () => {
    // The Real Game Editor Push - drawer became a Ctrl+\ overlay
    // rather than a fixed left rail. When closed it consumes no space,
    // renders no DOM at all (and crucially no backdrop, no Sidebar).
    useAdvancedDrawerStore.setState({ open: false });
    render(<AdvancedDrawer />);
    expect(screen.queryByTestId('advanced-drawer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('advanced-drawer-backdrop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-nav-project')).not.toBeInTheDocument();
  });

  it('close button toggles the drawer shut', () => {
    render(<AdvancedDrawer />);
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
    fireEvent.click(screen.getByTestId('advanced-drawer-close'));
    expect(useAdvancedDrawerStore.getState().open).toBe(false);
  });

  it('Ctrl+\\ toggles the drawer', () => {
    render(<AdvancedDrawer />);
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(useAdvancedDrawerStore.getState().open).toBe(false);
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
  });

  it('Cmd+\\ also toggles the drawer (for macOS users)', () => {
    render(<AdvancedDrawer />);
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    expect(useAdvancedDrawerStore.getState().open).toBe(false);
  });

  it('Ctrl+\\ in a text input is ignored (writers should not lose focus)', () => {
    render(
      <>
        <input data-testid="some-input" />
        <AdvancedDrawer />
      </>,
    );
    const input = screen.getByTestId('some-input');
    input.focus();
    fireEvent.keyDown(input, { key: '\\', ctrlKey: true });
    // Drawer state should still be open (not toggled).
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
  });

  it('clicking a sidebar nav item inside the drawer switches the active view', () => {
    render(<AdvancedDrawer />);
    fireEvent.click(screen.getByTestId('sidebar-nav-events'));
    expect(useViewStore.getState().activeView).toBe('events');
    // P.2 keeps the drawer open after selection.
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
  });
});
