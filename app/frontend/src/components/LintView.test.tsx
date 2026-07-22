import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { LintView } from './LintView';

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    flags: [
      { id: 'FLAG_UNUSED', name: 'FLAG_UNUSED', scope: 'global', defaultValue: false, description: null, engineValue: '0x800' },
    ],
    dialogue: [
      { id: 'Text_Orphan', name: 'Text_Orphan', speakerName: null, portraitAssetId: null, text: 'nobody calls me', choices: [] },
    ],
    triggers: [
      { id: 'trig_empty', name: 'trig_empty', kind: 'on_enter', mapId: null, coord: null, conditionExpression: null, scriptStepIds: [] },
    ],
    objectEvents: [
      { id: 'obj_decorative', name: 'obj_decorative', mapId: 'Town', coord: { x: 0, y: 0 }, elevation: 0, kind: 'npc', graphicsId: null, movementType: null, scriptId: null, flagId: null, trainerType: null, metadata: {} },
    ],
  };
}

describe('LintView', () => {
  afterEach(() => cleanup());

  it('renders the clean state when manifest has zero findings', () => {
    render(<LintView manifest={emptyManifest('/tmp/x', '2026-05-16T00:00:00Z')} />);
    expect(screen.getByTestId('lint-view-clean')).toBeInTheDocument();
    expect(screen.queryByTestId('lint-view')).not.toBeInTheDocument();
  });

  it('renders the lint shell when there are findings', () => {
    render(<LintView manifest={makeManifest()} />);
    expect(screen.getByTestId('lint-view')).toBeInTheDocument();
    expect(screen.queryByTestId('lint-view-clean')).not.toBeInTheDocument();
  });

  it('groups findings by rule with severity attributes', () => {
    render(<LintView manifest={makeManifest()} />);
    expect(screen.getByTestId('lint-rule-orphan_dialogue')).toHaveAttribute('data-severity', 'warn');
    expect(screen.getByTestId('lint-rule-unused_flag')).toHaveAttribute('data-severity', 'warn');
    expect(screen.getByTestId('lint-rule-empty_trigger')).toHaveAttribute('data-severity', 'warn');
    expect(screen.getByTestId('lint-rule-decorative_object')).toHaveAttribute('data-severity', 'info');
  });

  it('surfaces the specific entity id in the finding row', () => {
    render(<LintView manifest={makeManifest()} />);
    expect(screen.getByTestId('lint-finding-orphan_dialogue-Text_Orphan')).toBeInTheDocument();
    expect(screen.getByTestId('lint-finding-unused_flag-FLAG_UNUSED')).toBeInTheDocument();
  });

  it('reports correct warn + info counts in the header', () => {
    render(<LintView manifest={makeManifest()} />);
    const counts = screen.getByTestId('lint-view-counts');
    expect(counts).toHaveTextContent('3 warn');
    expect(counts).toHaveTextContent('1 info');
    expect(counts).toHaveTextContent('4 total');
  });
});
