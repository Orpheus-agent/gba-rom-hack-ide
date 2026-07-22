import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';
import { ScriptStepInspector } from './ScriptStepInspector';
import { useSelection, type EntityRef } from '../state';

// Phase Q.6.1 - covers the inline dialogue editor and the parent-script
// edit-hint affordance added so users landing on a script step from
// VisualScriptEditor have a real place to change something.

vi.mock('../api', async () => {
  return {
    editBinaryRomDialogueString: vi.fn(async () => ({ ok: true })),
    ProjectApiError: class ProjectApiError extends Error {
      readonly code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    },
  };
});

function makeManifest(scriptSteps: ScriptStep[]): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-25T00:00:00.000Z',
    projectRoot: '/tmp/test',
    identity: {
      kind: 'patch',
      confidence: 0.5,
      displayName: 'Bare ROM',
      baseGame: null,
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
    scriptSteps,
    assets: [],
  } as ProjectManifest;
}

function selRef(id: string): EntityRef {
  return { kind: 'scriptStep', id };
}

describe('ScriptStepInspector', () => {
  beforeEach(() => {
    cleanup();
    useSelection.setState({ current: null, history: [] });
  });

  it('renders the inline dialogue editor for dialogue-kind steps', () => {
    const step: ScriptStep = {
      id: 'script_oak__3',
      kind: 'dialogue',
      params: { dialogueText: 'Hello!', textFileOffset: 0x1a8d0 },
    };
    const m = makeManifest([step]);
    render(
      <ScriptStepInspector
        selection={selRef('script_oak__3')}
        manifest={m}
        sessionId="sess-1"
      />,
    );
    const textarea = screen.getByTestId(
      'script-step-inspector-dialogue-text',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Hello!');
    const saveBtn = screen.getByTestId('script-step-inspector-dialogue-save');
    // Save disabled until dirty
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
    fireEvent.change(textarea, { target: { value: 'Goodbye!' } });
    expect(saveBtn.hasAttribute('disabled')).toBe(false);
  });

  it('does not render the dialogue editor for non-dialogue kinds', () => {
    const step: ScriptStep = {
      id: 'script_oak__4',
      kind: 'set_flag',
      params: { flag: 'FLAG_BADGE01_GET' },
    };
    const m = makeManifest([step]);
    render(
      <ScriptStepInspector
        selection={selRef('script_oak__4')}
        manifest={m}
        sessionId="sess-1"
      />,
    );
    expect(
      screen.queryByTestId('script-step-inspector-dialogue-editor'),
    ).not.toBeInTheDocument();
  });

  it('shows an edit-hint card for non-dialogue kinds so the user knows where to edit', () => {
    const step: ScriptStep = {
      id: 'script_oak__4',
      kind: 'set_flag',
      params: { flag: 'FLAG_BADGE01_GET' },
    };
    const m = makeManifest([step]);
    render(
      <ScriptStepInspector
        selection={selRef('script_oak__4')}
        manifest={m}
        sessionId="sess-1"
      />,
    );
    const hint = screen.getByTestId('script-step-inspector-edit-hint');
    expect(hint.textContent).toMatch(/map editor.*script panel/i);
  });

  it('renders a graceful empty state when the step id is unknown', () => {
    const m = makeManifest([]);
    render(
      <ScriptStepInspector
        selection={selRef('script_unknown__1')}
        manifest={m}
        sessionId="sess-1"
      />,
    );
    expect(screen.getByTestId('script-step-inspector').textContent).toMatch(
      /No script step/,
    );
  });

  it('disables Save when textFileOffset is null and explains why', () => {
    const step: ScriptStep = {
      id: 'script_oak__3',
      kind: 'dialogue',
      params: { dialogueText: 'Hi' /* no textFileOffset */ },
    };
    const m = makeManifest([step]);
    render(
      <ScriptStepInspector
        selection={selRef('script_oak__3')}
        manifest={m}
        sessionId="sess-1"
      />,
    );
    const textarea = screen.getByTestId(
      'script-step-inspector-dialogue-text',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'New text' } });
    expect(
      (screen.getByTestId('script-step-inspector-dialogue-save') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
