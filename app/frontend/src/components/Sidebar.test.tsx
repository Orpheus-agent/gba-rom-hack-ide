import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';

// Phase P.1 - roles system removed. The sidebar now renders one flat tab
// list with every ViewKey in declaration order. Roadmap Phase P.2 will
// supersede this whole component with a selection-driven WorkspaceShell;
// these tests pin down the flat-list contract in the interim.

describe('Sidebar (flat list, post-P.1)', () => {
  afterEach(() => cleanup());

  it('renders every tab across primary + advanced groups (P.5)', () => {
    render(<Sidebar active="project" onSelect={vi.fn()} />);

    // Both sections exist; advanced section has its label.
    expect(screen.getByTestId('sidebar-section-primary')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-section-advanced')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-advanced-heading')).toBeInTheDocument();

    // All 24 ViewKeys remain reachable from the default UX.
    for (const k of [
      'project',
      'maps',
      'events',
      'dialogue',
      'flags',
      'assets',
      'preview',
      'mechanics',
      'lint',
      'dependencies',
      'templates',
      'plugins',
      'timeline',
      'tilesets',
      'species',
      'moves',
      'items',
      'abilities',
      'trainerClasses',
      'types',
      'pokedex',
      'choices',
      'healLocations',
      'build',
    ]) {
      expect(screen.getByTestId(`sidebar-nav-${k}`)).toBeInTheDocument();
    }
  });

  it('engineer/operator + demolished standalone views land in Advanced', () => {
    render(<Sidebar active="project" onSelect={vi.fn()} />);
    const advanced = screen.getByTestId('sidebar-section-advanced');
    // The Real Game Editor Push - operator utilities + the views
    // demolished from the default UX (Events / Dialogue / Flags /
    // Species / Items / ...) all live here for power-user bulk-browse.
    for (const k of [
      'build',
      'lint',
      'plugins',
      'dependencies',
      'mechanics',
      'timeline',
      'templates',
      'events',
      'dialogue',
      'flags',
      'choices',
      'healLocations',
      'species',
      'moves',
      'items',
      'abilities',
      'trainerClasses',
      'types',
      'pokedex',
      'tilesets',
      'assets',
    ]) {
      expect(advanced).toContainElement(screen.getByTestId(`sidebar-nav-${k}`));
    }
  });

  it('Primary section is trimmed to bare-minimum navigation (Project / World / Preview)', () => {
    render(<Sidebar active="project" onSelect={vi.fn()} />);
    const primary = screen.getByTestId('sidebar-section-primary');
    for (const k of ['project', 'maps', 'preview']) {
      expect(primary).toContainElement(screen.getByTestId(`sidebar-nav-${k}`));
    }
  });

  it('does not render a RoleSwitcher (roles system removed in Phase P.1)', () => {
    render(<Sidebar active="project" onSelect={vi.fn()} />);
    expect(screen.queryByTestId('role-switcher')).not.toBeInTheDocument();
    expect(screen.queryByTestId('role-switcher-select')).not.toBeInTheDocument();
  });

  it('marks the active tab with aria-selected=true', () => {
    render(<Sidebar active="maps" onSelect={vi.fn()} />);
    const mapsTab = screen.getByTestId('sidebar-nav-maps');
    expect(mapsTab).toHaveAttribute('aria-selected', 'true');
    const projectTab = screen.getByTestId('sidebar-nav-project');
    expect(projectTab).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking a tab calls onSelect with the tab key', () => {
    const onSelect = vi.fn();
    render(<Sidebar active="project" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('sidebar-nav-events'));
    expect(onSelect).toHaveBeenCalledWith('events');
  });
});
