import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModernizeCard } from './ModernizeCard';

// Mock the api module so we don't hit a real network.
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    modernizeRom: vi.fn(),
    // AttributionPanel (rendered inside ModernizeCard) calls this on mount.
    fetchModernizeAttribution: vi.fn().mockResolvedValue({
      cfruVersion: '(test)',
      cfruCommitShortSha: 'test',
      built: false,
      attribution: '(test attribution)',
    }),
  };
});

import * as api from '../api';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('ModernizeCard', () => {
  it('renders the plain-English title, body, and primary button', () => {
    render(<ModernizeCard sessionId="s1" onSuccess={vi.fn()} />);
    expect(screen.getByText(/Modernize this Pokémon FireRed ROM/i)).toBeTruthy();
    expect(
      screen.getByText(/This is the original Pokémon FireRed/i),
    ).toBeTruthy();
    expect(screen.getByTestId('modernize-card-button')).toBeTruthy();
  });

  it('shows the confirmation dialog after clicking Modernize, with its own primary button', () => {
    render(<ModernizeCard sessionId="s1" onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByTestId('modernize-card-button'));
    expect(screen.getByTestId('modernize-card-confirm')).toBeTruthy();
    expect(screen.getByText(/Upgrade your FireRed ROM\?/i)).toBeTruthy();
    expect(screen.getByText(/backup of the original first/i)).toBeTruthy();
    expect(screen.getByTestId('modernize-card-confirm-button')).toBeTruthy();
    expect(screen.getByTestId('modernize-card-cancel-button')).toBeTruthy();
  });

  it('Cancel from the confirm dialog returns to idle', () => {
    render(<ModernizeCard sessionId="s1" onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByTestId('modernize-card-button'));
    fireEvent.click(screen.getByTestId('modernize-card-cancel-button'));
    expect(screen.queryByTestId('modernize-card-confirm')).toBeNull();
    expect(screen.getByTestId('modernize-card-button')).toBeTruthy();
  });

  it('calls api.modernizeRom on confirm and shows the success state', async () => {
    (api.modernizeRom as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: 's1',
      previousSha1: 'a'.repeat(40),
      newSha1: 'b'.repeat(40),
      cfruVersion: 'test-version',
      cfruCommitShortSha: 'abc1234',
      buildOffset: 0x900000,
      bytesWritten: 1024,
    });
    const onSuccess = vi.fn();
    render(<ModernizeCard sessionId="s1" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByTestId('modernize-card-button'));
    fireEvent.click(screen.getByTestId('modernize-card-confirm-button'));

    await waitFor(() => {
      expect(screen.getByTestId('modernize-card-success')).toBeTruthy();
    });
    expect(api.modernizeRom).toHaveBeenCalledWith('s1');
    expect(onSuccess).toHaveBeenCalled();
    expect(
      screen.getByText(/Your ROM is now upgraded/i),
    ).toBeTruthy();
  });

  it('renders the plain-English rom_hash_mismatch message on the failure path', async () => {
    const apiErr = new api.ProjectApiError('internal_error', 'rom_hash_mismatch: technical detail');
    (api.modernizeRom as ReturnType<typeof vi.fn>).mockRejectedValue(apiErr);
    render(<ModernizeCard sessionId="s1" onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByTestId('modernize-card-button'));
    fireEvent.click(screen.getByTestId('modernize-card-confirm-button'));

    await waitFor(() => {
      expect(screen.getByTestId('modernize-card-error')).toBeTruthy();
    });
    expect(
      screen.getByText(/Modernize only works on the original Pokémon FireRed/i),
    ).toBeTruthy();
    // Recovery path: a "Try again" button resets to idle.
    fireEvent.click(screen.getByText(/Try again/i));
    expect(screen.queryByTestId('modernize-card-error')).toBeNull();
    expect(screen.getByTestId('modernize-card-button')).toBeTruthy();
  });

  it('renders the already_modernized friendly message', async () => {
    const apiErr = new api.ProjectApiError('internal_error', 'already_modernized: details');
    (api.modernizeRom as ReturnType<typeof vi.fn>).mockRejectedValue(apiErr);
    render(<ModernizeCard sessionId="s1" onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByTestId('modernize-card-button'));
    fireEvent.click(screen.getByTestId('modernize-card-confirm-button'));

    await waitFor(() => {
      expect(
        screen.getByText(/This ROM has already been modernized/i),
      ).toBeTruthy();
    });
  });

  it('exposes a "What this adds" details panel listing CFRU\'s headline features', () => {
    render(<ModernizeCard sessionId="s1" onSuccess={vi.fn()} />);
    expect(screen.getByText(/What this adds/i)).toBeTruthy();
    expect(screen.getByText(/Battle engine through Generation 8/i)).toBeTruthy();
    // Multiple things mention 800+ Pokémon - the bullet text uses "800+ Pokémon"
    // exactly so this is unambiguous to getByText.
    expect(screen.getByText(/800\+ Pokémon available/i)).toBeTruthy();
    // "Mega Evolution, Z-Moves, and Primal Reversion" appears in the
    // feature bullet - narrowed to its full phrase so it doesn't
    // collide with the body paragraph that mentions both terms.
    expect(
      screen.getByText(/Mega Evolution, Z-Moves, and Primal Reversion/i),
    ).toBeTruthy();
  });

  it('does not surface "BPS" or "CFRU" in any user-facing copy outside the attribution surface', () => {
    render(<ModernizeCard sessionId="s1" onSuccess={vi.fn()} />);
    const body = screen.getByTestId('modernize-card').textContent ?? '';
    expect(body).not.toMatch(/\bBPS\b/);
    // CFRU appears nowhere in this primary card flow - attribution is
    // surfaced separately via AttributionPanel (slice 7).
    expect(body).not.toMatch(/\bCFRU\b/);
  });
});
