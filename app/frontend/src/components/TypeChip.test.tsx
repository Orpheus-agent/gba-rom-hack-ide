import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TypeChip, TypeChipPair } from './TypeChip';

describe('TypeChip (Phase 4.2D)', () => {
  afterEach(() => cleanup());

  it('renders the canonical type name', () => {
    render(<TypeChip typeId={10} />);
    expect(screen.getByTestId('type-chip-10').textContent).toBe('Fire');
  });

  it('uses manifest-supplied display name when provided', () => {
    render(<TypeChip typeId={10} displayName="FUEGO" />);
    expect(screen.getByTestId('type-chip-10').textContent).toBe('FUEGO');
  });

  it('applies the canonical color per type', () => {
    render(<TypeChip typeId={11} />);
    const chip = screen.getByTestId('type-chip-11');
    expect(chip.style.backgroundColor).toBe('rgb(104, 144, 240)'); // #6890F0
  });

  it('renders Fairy (id 18) with the CFRU palette', () => {
    render(<TypeChip typeId={18} />);
    expect(screen.getByTestId('type-chip-18').textContent).toBe('Fairy');
  });

  it('renders an unknown type id with the placeholder chip', () => {
    render(<TypeChip typeId={250} />);
    expect(screen.getByTestId('type-chip-250').textContent).toBe('Type?');
  });

  it('compact mode adds the compact class', () => {
    render(<TypeChip typeId={10} compact />);
    expect(screen.getByTestId('type-chip-10').className).toMatch(/compact/);
  });
});

describe('TypeChipPair (Phase 4.2D)', () => {
  afterEach(() => cleanup());

  it('renders two chips for a dual-type Pokémon', () => {
    render(<TypeChipPair type1={6} type2={3} testIdPrefix="pair" />);
    expect(screen.getByTestId('pair-1-6')).toBeInTheDocument(); // Bug
    expect(screen.getByTestId('pair-2-3')).toBeInTheDocument(); // Poison
  });

  it('renders one chip for a single-type Pokémon (type1 === type2)', () => {
    render(<TypeChipPair type1={0} type2={0} testIdPrefix="single" />);
    expect(screen.getByTestId('single-1-0')).toBeInTheDocument();
    expect(screen.queryByTestId('single-2-0')).toBeNull();
  });
});
