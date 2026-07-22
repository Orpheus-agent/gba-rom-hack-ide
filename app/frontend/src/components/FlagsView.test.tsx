import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { FlagsView } from './FlagsView';

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
  return {
    ...base,
    flags: [
      {
        id: 'FLAG_VISITED_LITTLEROOT',
        name: 'FLAG_VISITED_LITTLEROOT',
        scope: 'global',
        defaultValue: false,
        description: null,
        engineValue: '0x807',
      },
      {
        id: 'FLAG_INTRO_DONE',
        name: 'FLAG_INTRO_DONE',
        scope: 'global',
        defaultValue: false,
        description: 'Set after the intro cutscene finishes.',
        engineValue: '0x808',
      },
      {
        id: 'FLAG_UNUSED',
        name: 'FLAG_UNUSED',
        scope: 'global',
        defaultValue: false,
        description: null,
        engineValue: '0x900',
      },
    ],
    variables: [
      {
        id: 'VAR_INTRO_STATE',
        name: 'VAR_INTRO_STATE',
        scope: 'global',
        defaultValue: 0,
        description: null,
        engineValue: '0x4001',
      },
    ],
    objectEvents: [
      {
        id: 'objectEvent_LittlerootTown_0',
        name: 'objectEvent_LittlerootTown_0',
        mapId: 'LittlerootTown',
        coord: { x: 5, y: 4 },
        elevation: 3,
        kind: 'npc',
        graphicsId: 'OBJ_EVENT_GFX_MOM',
        movementType: 'WANDER_AROUND',
        scriptId: 'LittlerootTown_Mom',
        flagId: 'FLAG_VISITED_LITTLEROOT',
        trainerType: null,
        metadata: {},
      },
    ],
    triggers: [
      {
        id: 'trigger_Route101_0',
        name: 'trigger_Route101_0',
        kind: 'on_enter',
        mapId: 'Route101',
        coord: { x: 12, y: 7 },
        conditionExpression: 'FLAG_VISITED_LITTLEROOT',
        scriptStepIds: ['Route101_EventScript_Intro#0', 'Route101_EventScript_Intro#1'],
      },
    ],
    scriptSteps: [
      {
        id: 'Route101_EventScript_Intro#0',
        kind: 'branch',
        params: {
          macro: 'goto_if_set',
          args: ['FLAG_VISITED_LITTLEROOT', 'Route101_EventScript_Skip'],
          flag: 'FLAG_VISITED_LITTLEROOT',
          label: 'Route101_EventScript_Skip',
        },
      },
      {
        id: 'Route101_EventScript_Intro#1',
        kind: 'set_flag',
        params: {
          macro: 'setflag',
          args: ['FLAG_INTRO_DONE'],
          flag: 'FLAG_INTRO_DONE',
        },
      },
      {
        id: 'Route101_EventScript_Intro#2',
        kind: 'set_variable',
        params: {
          macro: 'setvar',
          args: ['VAR_INTRO_STATE', '1'],
          variable: 'VAR_INTRO_STATE',
          value: '1',
        },
      },
    ],
    dialogue: [
      {
        id: 'LittlerootTown_Mom_Text_Hi',
        name: 'LittlerootTown_Mom_Text_Hi',
        speakerName: 'Mom',
        portraitAssetId: null,
        text: 'Welcome home!',
        choices: [
          {
            label: 'Acknowledge',
            nextDialogueId: null,
            setsFlagIds: ['FLAG_INTRO_DONE'],
          },
        ],
      },
    ],
  };
}

describe('FlagsView', () => {
  afterEach(() => cleanup());

  it('renders the empty-state when no flags or variables are indexed', () => {
    const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
    render(<FlagsView manifest={base} />);
    expect(screen.getByTestId('flags-view-empty')).toBeInTheDocument();
  });

  it('renders flags and variables in separate groups with counts', () => {
    render(<FlagsView manifest={makeManifest()} />);
    expect(screen.getByTestId('flags-view-group-flag')).toBeInTheDocument();
    expect(screen.getByTestId('flags-view-group-variable')).toBeInTheDocument();
    expect(screen.getByTestId('flags-view-item-FLAG_VISITED_LITTLEROOT')).toBeInTheDocument();
    expect(screen.getByTestId('flags-view-item-FLAG_INTRO_DONE')).toBeInTheDocument();
    expect(screen.getByTestId('flags-view-item-VAR_INTRO_STATE')).toBeInTheDocument();
  });

  it('shows the placeholder before any entity is selected', () => {
    render(<FlagsView manifest={makeManifest()} />);
    expect(screen.getByTestId('flags-view-placeholder')).toBeInTheDocument();
  });

  it('filters the list across id, engineValue, and description', () => {
    render(<FlagsView manifest={makeManifest()} />);
    const filter = screen.getByTestId('flags-view-filter');
    fireEvent.change(filter, { target: { value: 'INTRO' } });
    expect(screen.getByTestId('flags-view-item-FLAG_INTRO_DONE')).toBeInTheDocument();
    expect(screen.getByTestId('flags-view-item-VAR_INTRO_STATE')).toBeInTheDocument();
    expect(screen.queryByTestId('flags-view-item-FLAG_VISITED_LITTLEROOT')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flags-view-item-FLAG_UNUSED')).not.toBeInTheDocument();
  });

  it('surfaces every cross-reference type for a richly-referenced flag', () => {
    render(<FlagsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('flags-view-item-FLAG_VISITED_LITTLEROOT'));
    const detail = screen.getByTestId('flags-detail');
    expect(within(detail).getByTestId('flags-detail-id')).toHaveTextContent('FLAG_VISITED_LITTLEROOT');
    expect(within(detail).getByTestId('flags-detail-engine')).toHaveTextContent('0x807');
    // ObjectEvent reference
    expect(within(detail).getByTestId('flags-detail-objects')).toHaveTextContent(
      'objectEvent_LittlerootTown_0',
    );
    // ScriptStep reference (goto_if_set on this flag)
    expect(within(detail).getByTestId('flags-detail-steps')).toHaveTextContent(
      'Route101_EventScript_Intro#0',
    );
    // Trigger reference (resolved via the script step's parent trigger)
    expect(within(detail).getByTestId('flags-detail-triggers')).toHaveTextContent(
      'trigger_Route101_0',
    );
  });

  it('surfaces dialogue-choice references for a flag set via a dialogue branch', () => {
    render(<FlagsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('flags-view-item-FLAG_INTRO_DONE'));
    const dialogueRefs = screen.getByTestId('flags-detail-dialogue');
    // Phase I.1 - dialogue refs now resolve to the speaker + text preview
    // via displayName.lookupDialogue, not the raw synthetic id.
    expect(dialogueRefs).toHaveTextContent('Mom');
    expect(dialogueRefs).toHaveTextContent('Welcome home!');
    expect(dialogueRefs).toHaveTextContent('Acknowledge');
  });

  it('reports the empty-references state for an unreferenced flag', () => {
    render(<FlagsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('flags-view-item-FLAG_UNUSED'));
    expect(screen.getByTestId('flags-detail-no-refs')).toBeInTheDocument();
  });

  it('surfaces script-step references for a variable referenced via setvar', () => {
    render(<FlagsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('flags-view-item-VAR_INTRO_STATE'));
    expect(screen.getByTestId('flags-detail-kind')).toHaveTextContent('variable');
    expect(screen.getByTestId('flags-detail-steps')).toHaveTextContent(
      'Route101_EventScript_Intro#2',
    );
  });
});
