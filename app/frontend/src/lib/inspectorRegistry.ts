import type { ComponentType } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import type { EntityKind, EntityRef } from '../state';

// Phase P.3 - Inspector registry. The workspace's InspectorDock dispatches
// the currently-selected entity to a kind-specific panel registered here.
// Phase S progressively registers real per-entity editors (NPC, species,
// trainer, warp, encounter slot, etc.) without InspectorDock ever needing
// to know what kinds exist.
//
// The intentionally simple shape is one panel per kind. If we later need
// multiple stacked panels for a single kind (e.g., Identity / Properties /
// Relationships / Scripts / Advanced sections each contributed by separate
// packages), this module is the seam where that complexity lands.

export type InspectorSlot =
  | 'identity'
  | 'properties'
  | 'relationships'
  | 'scripts'
  | 'advanced';

export interface InspectorPanelProps {
  readonly selection: EntityRef;
  readonly manifest: ProjectManifest | null;
  readonly sessionId: string | null;
  /** Convenience: re-exposes selection.mapContext for panels that
   *  prefer not to drill into selection. */
  readonly mapContext?: string;
}

export type InspectorPanelComponent = ComponentType<InspectorPanelProps>;

export interface InspectorPanelRegistration {
  readonly kind: EntityKind;
  readonly slot: InspectorSlot;
  readonly component: InspectorPanelComponent;
  /** Optional weight inside the slot - lower renders first. Use to
   *  let later registrations override earlier ones for the same kind+slot. */
  readonly priority?: number;
  /** Free-text descriptor for diagnostics (e.g., "Phase S.21 FlagInspector"). */
  readonly description?: string;
}

const registry = new Map<EntityKind, InspectorPanelRegistration[]>();

export function registerInspectorPanel(reg: InspectorPanelRegistration): void {
  const existing = registry.get(reg.kind) ?? [];
  // Re-register-same-component is a no-op (dev HMR safety).
  const dup = existing.find(
    (e) => e.slot === reg.slot && e.component === reg.component,
  );
  if (dup) return;
  // Replace existing registration for same kind+slot when a new one comes
  // in (last-in wins on ties; priority can shape ordering across slots).
  const filtered = existing.filter((e) => e.slot !== reg.slot);
  filtered.push(reg);
  filtered.sort((a, b) => {
    const slotOrder: Record<InspectorSlot, number> = {
      identity: 0,
      properties: 1,
      relationships: 2,
      scripts: 3,
      advanced: 4,
    };
    const sa = slotOrder[a.slot];
    const sb = slotOrder[b.slot];
    if (sa !== sb) return sa - sb;
    return (a.priority ?? 0) - (b.priority ?? 0);
  });
  registry.set(reg.kind, filtered);
}

export function getInspectorPanels(kind: EntityKind): ReadonlyArray<InspectorPanelRegistration> {
  return registry.get(kind) ?? [];
}

export function hasInspectorPanel(kind: EntityKind): boolean {
  return (registry.get(kind)?.length ?? 0) > 0;
}

/** Test-only: wipe the registry between unit tests. Not exported via the
 *  public surface but reachable for vitest's `import` direct access. */
export function _resetInspectorRegistryForTests(): void {
  registry.clear();
}
