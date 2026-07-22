import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HelpOverlay } from './HelpOverlay';
import { useViewStore } from '../state';

describe('HelpOverlay', () => {
  beforeEach(() => {
    useViewStore.setState({ activeView: 'project' });
  });

  afterEach(() => cleanup());

  it('renders nothing when open=false', () => {
    render(<HelpOverlay open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('help-overlay')).not.toBeInTheDocument();
  });

  it('renders the help entry for the current activeView when open', () => {
    useViewStore.setState({ activeView: 'templates' });
    render(<HelpOverlay open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('help-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('help-overlay-summary')).toBeInTheDocument();
    expect(screen.getByText('Templates')).toBeInTheDocument();
  });

  it('clicking the close button invokes onClose', () => {
    const onClose = vi.fn();
    render(<HelpOverlay open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('help-overlay-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop invokes onClose, clicking the panel itself does not', () => {
    const onClose = vi.fn();
    render(<HelpOverlay open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('help-overlay'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('help-overlay-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape key fires onClose when the overlay is open', () => {
    const onClose = vi.fn();
    render(<HelpOverlay open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('related-views buttons invoke onSelectView with the target view id', () => {
    useViewStore.setState({ activeView: 'maps' });
    const onSelectView = vi.fn();
    render(<HelpOverlay open={true} onClose={vi.fn()} onSelectView={onSelectView} />);
    const evtsBtn = screen.queryByTestId('help-overlay-related-events');
    expect(evtsBtn).toBeInTheDocument();
    fireEvent.click(evtsBtn!);
    expect(onSelectView).toHaveBeenCalledWith('events');
  });
});
