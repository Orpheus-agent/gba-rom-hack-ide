import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TemplatesView } from './TemplatesView';

describe('TemplatesView', () => {
  afterEach(() => cleanup());

  it('renders every template in the rail', () => {
    render(<TemplatesView />);
    expect(screen.getByTestId('templates-item-town_skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('templates-item-boss_battle_intro')).toBeInTheDocument();
    expect(screen.getByTestId('templates-item-gift_pokemon_event')).toBeInTheDocument();
    expect(screen.getByTestId('templates-item-randomizer_toggle')).toBeInTheDocument();
    expect(screen.getByTestId('templates-item-npc_with_dialogue')).toBeInTheDocument();
  });

  it('auto-selects the first template (town_skeleton) and shows its detail', () => {
    render(<TemplatesView />);
    const detail = screen.getByTestId('template-detail');
    expect(detail).toHaveTextContent('Town skeleton');
    expect(screen.getByTestId('template-param-mapName')).toBeInTheDocument();
  });

  it('switches detail pane when a different template is clicked and resets params', () => {
    render(<TemplatesView />);
    fireEvent.click(screen.getByTestId('templates-item-gift_pokemon_event'));
    const detail = screen.getByTestId('template-detail');
    expect(detail).toHaveTextContent('Gift Pokémon event');
    // gift_pokemon_event params should be present, town's mapName should not.
    expect(screen.getByTestId('template-param-speciesId')).toBeInTheDocument();
    expect(screen.getByTestId('template-param-flagId')).toBeInTheDocument();
    expect(screen.queryByTestId('template-param-mapName')).not.toBeInTheDocument();
  });

  it('updates the materialization preview when a required param is filled', () => {
    render(<TemplatesView />);
    const input = screen.getByTestId('template-param-mapName') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'CrystalCove' } });
    const preview = screen.getByTestId('template-detail-preview');
    expect(preview).toHaveTextContent('CrystalCove');
    // Error should be cleared once required param is non-empty.
    expect(screen.queryByTestId('template-detail-error')).not.toBeInTheDocument();
  });

  it('shows materializeError when a required param becomes empty after being filled', () => {
    render(<TemplatesView />);
    const input = screen.getByTestId('template-param-mapName') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'CrystalCove' } });
    expect(screen.queryByTestId('template-detail-error')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('template-detail-error')).toBeInTheDocument();
  });

  it('disables the Stage button when no project session is loaded', () => {
    render(<TemplatesView />);
    const btn = screen.getByTestId('template-detail-stage') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn).toHaveAttribute('title', 'No project session');
  });
});
