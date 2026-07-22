import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { AbilityChip } from './AbilityChip';

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-27T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
    abilities: [
      { id: 'ability_9', abilityIndex: 9, name: 'STATIC', sourceTableOffset: 0 },
      { id: 'ability_31', abilityIndex: 31, name: 'LIGHTNING ROD', sourceTableOffset: 0 },
    ],
    ...over,
  };
}

describe('AbilityChip (Phase 4.3E)', () => {
  afterEach(() => cleanup());

  it('resolves a known ability id to its manifest name', () => {
    render(<AbilityChip abilityId={9} manifest={manifest()} />);
    expect(screen.getByTestId('ability-chip-9').textContent).toBe('STATIC');
  });

  it('falls back to "Ability #N" when manifest is missing the entry', () => {
    render(<AbilityChip abilityId={50} manifest={manifest()} />);
    expect(screen.getByTestId('ability-chip-50').textContent).toBe('Ability #50');
  });

  it('renders nothing for ability id 0', () => {
    const { container } = render(<AbilityChip abilityId={0} manifest={manifest()} />);
    expect(container.firstChild).toBeNull();
  });

  it('hidden flag adds the hidden modifier + sparkle prefix', () => {
    render(<AbilityChip abilityId={31} manifest={manifest()} hidden />);
    const chip = screen.getByTestId('ability-chip-31');
    expect(chip.className).toMatch(/hidden/);
    expect(chip.textContent).toMatch(/✨/);
  });
});
