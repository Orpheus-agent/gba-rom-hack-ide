import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { useEditFormKeyboard } from './useEditFormKeyboard';

function Harness(props: {
  canSave: boolean;
  save: () => void;
  cancel?: () => void;
  isSaving?: boolean;
  multiline?: boolean;
}) {
  const onKeyDown = useEditFormKeyboard({
    canSave: props.canSave,
    save: props.save,
    cancel: props.cancel,
    isSaving: props.isSaving,
  });
  return (
    <div onKeyDown={onKeyDown} data-testid="harness">
      <input data-testid="text-input" type="text" defaultValue="hi" />
      <input data-testid="number-input" type="number" defaultValue="42" />
      {props.multiline ? (
        <textarea data-testid="textarea" defaultValue="multi\nline" />
      ) : null}
      <select data-testid="select">
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
    </div>
  );
}

describe('useEditFormKeyboard', () => {
  afterEach(() => cleanup());

  it('Enter in a text input triggers save when canSave', () => {
    const save = vi.fn();
    const { getByTestId } = render(<Harness canSave={true} save={save} />);
    fireEvent.keyDown(getByTestId('text-input'), { key: 'Enter' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Enter in a number input also triggers save', () => {
    const save = vi.fn();
    const { getByTestId } = render(<Harness canSave={true} save={save} />);
    fireEvent.keyDown(getByTestId('number-input'), { key: 'Enter' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Enter does NOT save when canSave=false', () => {
    const save = vi.fn();
    const { getByTestId } = render(<Harness canSave={false} save={save} />);
    fireEvent.keyDown(getByTestId('text-input'), { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
  });

  it('Enter does NOT save when isSaving=true', () => {
    const save = vi.fn();
    const { getByTestId } = render(
      <Harness canSave={true} save={save} isSaving={true} />,
    );
    fireEvent.keyDown(getByTestId('text-input'), { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
  });

  it('Plain Enter in a textarea does NOT save (newline)', () => {
    const save = vi.fn();
    const { getByTestId } = render(
      <Harness canSave={true} save={save} multiline={true} />,
    );
    fireEvent.keyDown(getByTestId('textarea'), { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter in a textarea triggers save', () => {
    const save = vi.fn();
    const { getByTestId } = render(
      <Harness canSave={true} save={save} multiline={true} />,
    );
    fireEvent.keyDown(getByTestId('textarea'), { key: 'Enter', ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Enter (macOS) in a textarea triggers save', () => {
    const save = vi.fn();
    const { getByTestId } = render(
      <Harness canSave={true} save={save} multiline={true} />,
    );
    fireEvent.keyDown(getByTestId('textarea'), { key: 'Enter', metaKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Enter on a <select> is a no-op (native semantics preserved)', () => {
    const save = vi.fn();
    const { getByTestId } = render(<Harness canSave={true} save={save} />);
    fireEvent.keyDown(getByTestId('select'), { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
  });

  it('Shift+Enter in a text input does NOT save', () => {
    const save = vi.fn();
    const { getByTestId } = render(<Harness canSave={true} save={save} />);
    fireEvent.keyDown(getByTestId('text-input'), { key: 'Enter', shiftKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('Escape triggers cancel when provided', () => {
    const save = vi.fn();
    const cancel = vi.fn();
    const { getByTestId } = render(
      <Harness canSave={true} save={save} cancel={cancel} />,
    );
    fireEvent.keyDown(getByTestId('text-input'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('Escape with no cancel handler is a no-op (no crash)', () => {
    const save = vi.fn();
    const { getByTestId } = render(<Harness canSave={true} save={save} />);
    expect(() => {
      fireEvent.keyDown(getByTestId('text-input'), { key: 'Escape' });
    }).not.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('Escape cancels regardless of canSave', () => {
    const cancel = vi.fn();
    const { getByTestId } = render(
      <Harness canSave={false} save={() => undefined} cancel={cancel} />,
    );
    fireEvent.keyDown(getByTestId('text-input'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
