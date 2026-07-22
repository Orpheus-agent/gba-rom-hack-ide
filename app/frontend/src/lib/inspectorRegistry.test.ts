import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetInspectorRegistryForTests,
  getInspectorPanels,
  hasInspectorPanel,
  registerInspectorPanel,
  type InspectorPanelComponent,
} from './inspectorRegistry';

const StubPanel: InspectorPanelComponent = () => null;
const StubPanel2: InspectorPanelComponent = () => null;

describe('inspectorRegistry (Phase P.3)', () => {
  beforeEach(() => {
    _resetInspectorRegistryForTests();
  });

  it('starts empty - no panels registered', () => {
    expect(getInspectorPanels('species')).toEqual([]);
    expect(hasInspectorPanel('species')).toBe(false);
  });

  it('registers and retrieves a panel by kind', () => {
    registerInspectorPanel({
      kind: 'species',
      slot: 'identity',
      component: StubPanel,
      description: 'test',
    });
    const panels = getInspectorPanels('species');
    expect(panels).toHaveLength(1);
    expect(panels[0]?.kind).toBe('species');
    expect(panels[0]?.slot).toBe('identity');
    expect(panels[0]?.component).toBe(StubPanel);
    expect(hasInspectorPanel('species')).toBe(true);
  });

  it('orders panels by slot (identity → properties → relationships → scripts → advanced)', () => {
    registerInspectorPanel({ kind: 'flag', slot: 'advanced', component: StubPanel });
    registerInspectorPanel({ kind: 'flag', slot: 'identity', component: StubPanel2 });
    registerInspectorPanel({ kind: 'flag', slot: 'relationships', component: StubPanel });
    registerInspectorPanel({ kind: 'flag', slot: 'properties', component: StubPanel });
    const panels = getInspectorPanels('flag');
    expect(panels.map((p) => p.slot)).toEqual([
      'identity',
      'properties',
      'relationships',
      'advanced',
    ]);
  });

  it('replaces an existing registration for the same kind+slot (last-in wins)', () => {
    registerInspectorPanel({ kind: 'trainer', slot: 'identity', component: StubPanel });
    registerInspectorPanel({ kind: 'trainer', slot: 'identity', component: StubPanel2 });
    const panels = getInspectorPanels('trainer');
    expect(panels).toHaveLength(1);
    expect(panels[0]?.component).toBe(StubPanel2);
  });

  it('re-registering the same component for the same kind+slot is a no-op (HMR safety)', () => {
    registerInspectorPanel({ kind: 'item', slot: 'identity', component: StubPanel });
    registerInspectorPanel({ kind: 'item', slot: 'identity', component: StubPanel });
    expect(getInspectorPanels('item')).toHaveLength(1);
  });

  it('isolates registrations across kinds', () => {
    registerInspectorPanel({ kind: 'species', slot: 'identity', component: StubPanel });
    registerInspectorPanel({ kind: 'trainer', slot: 'identity', component: StubPanel2 });
    expect(getInspectorPanels('species')).toHaveLength(1);
    expect(getInspectorPanels('trainer')).toHaveLength(1);
    expect(getInspectorPanels('flag')).toHaveLength(0);
  });

  it('priority sorts panels within the same slot (lower first)', () => {
    registerInspectorPanel({
      kind: 'map',
      slot: 'properties',
      component: StubPanel,
      priority: 10,
    });
    // Different slot - won't conflict.
    registerInspectorPanel({
      kind: 'map',
      slot: 'identity',
      component: StubPanel2,
      priority: 0,
    });
    const panels = getInspectorPanels('map');
    expect(panels[0]?.slot).toBe('identity');
    expect(panels[1]?.slot).toBe('properties');
  });
});
