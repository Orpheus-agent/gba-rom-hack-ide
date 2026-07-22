import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ObjectEvent, Warp } from '@rom-editor/shared';
import {
  ObjectEventFieldsEditor,
  WarpFieldsEditor,
} from './MapEntityFieldsEditor';

function decompObjectEvent(over: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 'MAP_LITTLEROOT_TOWN_obj_0',
    name: 'LittlerootTown_EventScript_Boy',
    mapId: 'MAP_LITTLEROOT_TOWN',
    coord: { x: 11, y: 6 },
    elevation: 3,
    kind: 'npc',
    graphicsId: 'OBJ_EVENT_GFX_LITTLE_BOY_1',
    movementType: 'MOVEMENT_TYPE_FACE_DOWN',
    scriptId: 'LittlerootTown_EventScript_Boy',
    flagId: null,
    trainerType: 'TRAINER_TYPE_NONE',
    metadata: {},
    ...over,
  };
}

function decompWarp(over: Partial<Warp> = {}): Warp {
  return {
    id: 'MAP_LITTLEROOT_TOWN_warp_0',
    name: 'MAP_LITTLEROOT_TOWN → MAP_ROUTE101',
    fromMapId: 'MAP_LITTLEROOT_TOWN',
    fromCoord: { x: 10, y: 12 },
    toMapId: 'MAP_ROUTE101',
    toCoord: { x: 4, y: 5 },
    ...over,
  };
}

describe('ObjectEventFieldsEditor', () => {
  afterEach(() => cleanup());

  it('renders editable inputs for a decomp object event', () => {
    render(<ObjectEventFieldsEditor objectEvent={decompObjectEvent()} sessionId={null} />);
    expect(screen.getByTestId('object-event-fields-editor')).toBeInTheDocument();
    expect((screen.getByTestId('obj-graphics-id') as HTMLInputElement).value).toBe(
      'OBJ_EVENT_GFX_LITTLE_BOY_1',
    );
    expect((screen.getByTestId('obj-movement-type-text') as HTMLInputElement).value).toBe(
      'MOVEMENT_TYPE_FACE_DOWN',
    );
    expect((screen.getByTestId('obj-script') as HTMLInputElement).value).toBe(
      'LittlerootTown_EventScript_Boy',
    );
  });

  it('save button starts disabled (no edits) and enables after a field change', () => {
    render(
      <ObjectEventFieldsEditor objectEvent={decompObjectEvent()} sessionId="test-session" />,
    );
    const save = screen.getByTestId('object-event-fields-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const graphicsInput = screen.getByTestId('obj-graphics-id') as HTMLInputElement;
    fireEvent.change(graphicsInput, { target: { value: 'OBJ_EVENT_GFX_NPC_FRIEND' } });
    expect(save.disabled).toBe(false);
  });

  it('save button stays disabled when sessionId is null even after edits', () => {
    render(<ObjectEventFieldsEditor objectEvent={decompObjectEvent()} sessionId={null} />);
    const save = screen.getByTestId('object-event-fields-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const flagInput = screen.getByTestId('obj-flag') as HTMLInputElement;
    fireEvent.change(flagInput, { target: { value: 'FLAG_HIDE_BOY' } });
    // Dirty, but no session - backend can't accept patches.
    expect(save.disabled).toBe(true);
  });

  // Phase G-RC5 - binary-ROM ids now render a numeric byte-level
  // editor that posts to /binary-rom-edit/object-event-fields instead
  // of the "not supported" note.
  it('renders the binary-rom byte editor for `binary_obj_*` ids when struct offset present', () => {
    render(
      <ObjectEventFieldsEditor
        objectEvent={decompObjectEvent({
          id: 'binary_obj_0_1_5',
          graphicsId: 'gfx_18',
          movementType: 'move_9',
          flagId: 'flag_0x800',
          metadata: { binaryFileOffset: 0x123456 },
        })}
        sessionId="test-session"
      />,
    );
    expect(
      screen.queryByTestId('object-event-fields-editor'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('binary-rom-object-event-fields-editor'),
    ).toBeInTheDocument();
    // Current values parsed out of the synthetic ids.
    expect((screen.getByTestId('bin-obj-graphics-id') as HTMLInputElement).value).toBe('18');
    expect((screen.getByTestId('bin-obj-movement-type') as HTMLInputElement).value).toBe('9');
    expect((screen.getByTestId('bin-obj-flag') as HTMLInputElement).value).toBe('0x800');
  });

  it('renders a re-scan note for binary-rom events missing binaryFileOffset metadata', () => {
    render(
      <ObjectEventFieldsEditor
        objectEvent={decompObjectEvent({ id: 'binary_obj_0_1_5' })}
        sessionId="test-session"
      />,
    );
    expect(
      screen.queryByTestId('binary-rom-object-event-fields-editor'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Re-scan the project/i)).toBeInTheDocument();
  });
});

describe('WarpFieldsEditor', () => {
  afterEach(() => cleanup());

  it('renders a destination map input for decomp warps', () => {
    render(<WarpFieldsEditor warp={decompWarp()} sessionId={null} />);
    expect((screen.getByTestId('warp-dest-map') as HTMLInputElement).value).toBe('MAP_ROUTE101');
  });

  it('save button enables after editing the destination', () => {
    render(<WarpFieldsEditor warp={decompWarp()} sessionId="test-session" />);
    const save = screen.getByTestId('warp-fields-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('warp-dest-map') as HTMLInputElement, {
      target: { value: 'MAP_OLDALE_TOWN' },
    });
    expect(save.disabled).toBe(false);
  });

  it('Phase O.22 - renders the binary-rom warp editor for `binary_warp_*` ids', () => {
    render(
      <WarpFieldsEditor
        warp={decompWarp({ id: 'binary_warp_0_1_2' })}
        sessionId="test-session"
      />,
    );
    // The decomp WarpFieldsEditor is replaced by the binary-rom
    // variant which has its own test id. Without metadata.structFileOffset
    // the editor falls back to a re-scan note.
    expect(screen.queryByTestId('warp-fields-editor')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('binary-rom-warp-fields-editor'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/has no struct file offset on its metadata/i),
    ).toBeInTheDocument();
  });
});
