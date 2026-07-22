import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AiFlagChips } from './AiFlagChips';

// Phase 5.9 hot-fix - these constants are now duplicated inline in
// AiFlagChips.tsx (see the comment in that file for the rationale).
// The values must stay byte-equivalent to engine/src/trainers/ai-flags.ts;
// the constants below mirror the engine's exports for the test's
// preset-assertion code.
const trainers = {
  SMART_TRAINER_AI_FLAGS: 0x07,
  GYM_LEADER_AI_FLAGS: 0x07 | (1 << 3) | (1 << 9),  // + setupFirstTurn + checkHp
  ELITE_FOUR_AI_FLAGS:
    (0x07 | (1 << 3) | (1 << 9)) | (1 << 11) | (1 << 8), // + superEffective + checkAbility
};

describe('AiFlagChips (Phase 4.3B)', () => {
  afterEach(() => cleanup());

  it('renders one chip per known flag', () => {
    render(<AiFlagChips value={0} onChange={() => {}} />);
    expect(screen.getByTestId('ai-flag-chips')).toBeInTheDocument();
    expect(screen.getByTestId('ai-flag-chip-checkBadMove')).toBeInTheDocument();
    expect(screen.getByTestId('ai-flag-chip-tryToFaint')).toBeInTheDocument();
    expect(screen.getByTestId('ai-flag-chip-checkViability')).toBeInTheDocument();
    expect(screen.getByTestId('ai-flag-chip-superEffective')).toBeInTheDocument();
    expect(screen.getByTestId('ai-flag-chip-roaming')).toBeInTheDocument();
  });

  it('value=0x07 lights up the smart-trainer trio', () => {
    render(<AiFlagChips value={trainers.SMART_TRAINER_AI_FLAGS} onChange={() => {}} />);
    const checkBad = screen.getByTestId('ai-flag-chip-checkBadMove');
    expect(checkBad.className).toMatch(/on/);
    const tryFaint = screen.getByTestId('ai-flag-chip-tryToFaint');
    expect(tryFaint.className).toMatch(/on/);
    const viability = screen.getByTestId('ai-flag-chip-checkViability');
    expect(viability.className).toMatch(/on/);
    // setupFirstTurn should NOT be on.
    const setup = screen.getByTestId('ai-flag-chip-setupFirstTurn');
    expect(setup.className).not.toMatch(/on/);
  });

  it('clicking a chip toggles + emits onChange with the new u32', () => {
    const onChange = vi.fn();
    render(<AiFlagChips value={0} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('ai-flag-chip-checkBadMove'));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('Smart trainer preset emits 0x07', () => {
    const onChange = vi.fn();
    render(<AiFlagChips value={0} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('ai-flag-preset-smart'));
    expect(onChange).toHaveBeenCalledWith(0x07);
  });

  it('Gym leader preset emits the right bits', () => {
    const onChange = vi.fn();
    render(<AiFlagChips value={0} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('ai-flag-preset-gym'));
    expect(onChange).toHaveBeenCalledWith(trainers.GYM_LEADER_AI_FLAGS);
  });

  it('Elite Four preset emits the strongest preset', () => {
    const onChange = vi.fn();
    render(<AiFlagChips value={0} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('ai-flag-preset-elite'));
    expect(onChange).toHaveBeenCalledWith(trainers.ELITE_FOUR_AI_FLAGS);
  });

  it('Clear preset returns 0 (but preserves unknown bits)', () => {
    const onChange = vi.fn();
    // Set a known bit + an unknown bit (e.g. bit 16).
    const value = (1 << 0) | (1 << 16);
    render(<AiFlagChips value={value} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('ai-flag-preset-clear'));
    // Clear should keep the unknown bit only.
    expect(onChange).toHaveBeenCalledWith(1 << 16);
  });

  it('surfaces unknown bits when present', () => {
    render(<AiFlagChips value={1 << 20} onChange={() => {}} />);
    expect(screen.getByTestId('ai-flag-unknown')).toBeInTheDocument();
  });

  it('disabled prop disables every chip + preset', () => {
    render(<AiFlagChips value={0} onChange={() => {}} disabled />);
    const chip = screen.getByTestId('ai-flag-chip-checkBadMove') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    const preset = screen.getByTestId('ai-flag-preset-smart') as HTMLButtonElement;
    expect(preset.disabled).toBe(true);
  });
});
