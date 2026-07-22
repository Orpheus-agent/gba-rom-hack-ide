import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AddEventPopover } from './AddEventPopover';

describe('AddEventPopover', () => {
  beforeEach(() => {
    cleanup();
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem('rom-editor.add-event.favorites');
        window.localStorage.removeItem('rom-editor.add-event.recent');
      } catch {
        // ignore
      }
    }
  });

  it('renders categorised command list', () => {
    render(<AddEventPopover onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('add-event-popover')).toBeInTheDocument();
    // Top categories: Text, Flow, Flags & Vars, etc.
    expect(screen.getByText(/Text & Dialogue/i)).toBeInTheDocument();
    expect(screen.getByText(/Flow/i)).toBeInTheDocument();
    expect(screen.getByText(/Flags & Variables/i)).toBeInTheDocument();
  });

  it('filtering narrows the list', () => {
    render(<AddEventPopover onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('add-event-popover-filter'), {
      target: { value: 'flag' },
    });
    // Should keep flag-related commands, hide unrelated ones
    expect(screen.getByTestId('add-event-popover-pick-set_flag')).toBeInTheDocument();
    expect(screen.getByTestId('add-event-popover-pick-clear_flag')).toBeInTheDocument();
    expect(screen.queryByTestId('add-event-popover-pick-dialogue')).not.toBeInTheDocument();
  });

  it('shows empty state when filter has no matches', () => {
    render(<AddEventPopover onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('add-event-popover-filter'), {
      target: { value: 'doesnotexist' },
    });
    expect(screen.getByTestId('add-event-popover-empty')).toBeInTheDocument();
  });

  it('clicking a command calls onPick with its kind', () => {
    const onPick = vi.fn();
    render(<AddEventPopover onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('add-event-popover-pick-set_flag'));
    expect(onPick).toHaveBeenCalledWith('set_flag');
  });

  it('Esc key calls onClose', () => {
    const onClose = vi.fn();
    render(<AddEventPopover onPick={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('toggling favorite persists the star icon', () => {
    render(<AddEventPopover onPick={() => {}} onClose={() => {}} />);
    const favBtn = screen.getByTestId('add-event-popover-fav-set_flag');
    expect(favBtn.textContent).toBe('☆');
    fireEvent.click(favBtn);
    expect(favBtn.textContent).toBe('★');
    // Toggle back
    fireEvent.click(favBtn);
    expect(favBtn.textContent).toBe('☆');
  });

  it('picking a command updates recent list (visible on next mount with no filter)', () => {
    render(<AddEventPopover onPick={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('add-event-popover-pick-give_item'));
    // After picking, recent list saved to localStorage. Cleanup + fresh mount.
    cleanup();
    render(<AddEventPopover onPick={() => {}} onClose={() => {}} />);
    // Recent group should appear at the top.
    expect(screen.getByText(/Recent/i)).toBeInTheDocument();
  });

  it('initialFilter pre-fills the search input', () => {
    render(<AddEventPopover onPick={() => {}} onClose={() => {}} initialFilter="flag" />);
    const input = screen.getByTestId('add-event-popover-filter') as HTMLInputElement;
    expect(input.value).toBe('flag');
  });
});
