import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastContainer } from './Toast';
import { pushToast, useToastStore } from '../state';

describe('ToastContainer', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a success toast with message + icon', () => {
    render(<ToastContainer />);
    act(() => {
      pushToast('success', 'Saved');
    });
    expect(screen.getByTestId('toast-success')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('renders an error toast with the error icon', () => {
    render(<ToastContainer />);
    act(() => {
      pushToast('error', 'Something failed');
    });
    expect(screen.getByTestId('toast-error')).toBeInTheDocument();
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });

  it('clicking the close button dismisses the toast', () => {
    render(<ToastContainer />);
    act(() => {
      pushToast('info', 'Click me');
    });
    expect(screen.getByText('Click me')).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByLabelText('Dismiss notification'));
    });
    expect(screen.queryByText('Click me')).toBeNull();
  });

  it('stacks multiple toasts', () => {
    render(<ToastContainer />);
    act(() => {
      pushToast('info', 'One');
      pushToast('success', 'Two');
      pushToast('error', 'Three');
    });
    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
    expect(screen.getByText('Three')).toBeInTheDocument();
  });
});
