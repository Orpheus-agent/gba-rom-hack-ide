import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { NpcGraphicsPicker } from './NpcGraphicsPicker';
import { isSymbolDatabaseAvailable } from '../lib/symbols';

vi.mock('../api', async () => {
  return {
    fetchBinaryRomOwSprite: vi.fn(async () => {
      // Tiny placeholder 16x16 transparent RGBA so the canvas doesn't error.
      const bytes = new Uint8ClampedArray(16 * 16 * 4);
      const b64 = Buffer.from(bytes).toString('base64');
      return { width: 16, height: 16, rgbaBase64: b64, grayscaleFallback: false };
    }),
  };
});

function makeManifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-25T00:00:00.000Z',
    projectRoot: '/tmp/test',
    identity: {
      kind: 'decomp',
      confidence: 1,
      displayName: 'pokefirered',
      baseGame: 'pokefirered',
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
    scriptSteps: [],
    assets: [],
    ...over,
  } as ProjectManifest;
}

describe('NpcGraphicsPicker', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders the resolved sprite name + index for the current value', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x2e}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    expect(screen.getByTestId('npc-graphics-picker-current').textContent).toMatch(
      /Brock/,
    );
    expect(screen.getByTestId('npc-graphics-picker-current').textContent).toMatch(
      /#46/,
    );
  });

  // The scraped OBJ_EVENT_GFX_* fallback lives in the generated per-family
  // symbol database, which is not distributed with this repository. Without
  // it the picker correctly falls back to the "NPC sprite #N" placeholder,
  // so this assertion only applies once the user has run build-symbols.mjs.
  it.runIf(isSymbolDatabaseAvailable())('shows a sensible name even for hack-added IDs beyond the hand-curated map (WP-D fallback)', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={250}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    // WP-D - 0xFA on vanilla FRLG isn't in the hand-curated pretty-name
    // map, but build-symbols.mjs scraped it from pret/pokefirered as
    // OBJ_EVENT_GFX_VAR_A. The picker shows that prettified ("VAR A")
    // instead of the legacy "NPC sprite #250" placeholder.
    const text = screen.getByTestId('npc-graphics-picker-current').textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/NPC sprite #/);
  });

  it('uses the Emerald roster when identity.baseGame is pokeemerald', () => {
    const m = makeManifest({
      identity: {
        kind: 'decomp',
        confidence: 1,
        displayName: 'pokeemerald',
        baseGame: 'pokeemerald',
        fork: null,
        featureFlags: [],
        warnings: [],
        evidence: [],
      },
    });
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    expect(screen.getByTestId('npc-graphics-picker-current').textContent).toMatch(
      /Brendan/,
    );
  });

  it('clicking the current swatch opens the picker panel', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    expect(screen.queryByTestId('npc-graphics-picker-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('npc-graphics-picker-current'));
    expect(screen.getByTestId('npc-graphics-picker-panel')).toBeInTheDocument();
  });

  it('filtering by name narrows the list', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    fireEvent.click(screen.getByTestId('npc-graphics-picker-current'));
    fireEvent.change(screen.getByTestId('npc-graphics-picker-filter'), {
      target: { value: 'brock' },
    });
    // FireRed Brock is at 0x2E (46).
    expect(screen.getByTestId('npc-graphics-picker-tile-46')).toBeInTheDocument();
    // Red (default) at 0x00 should not be visible.
    expect(screen.queryByTestId('npc-graphics-picker-tile-0')).not.toBeInTheDocument();
  });

  it('filtering by sprite # narrows the list', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    fireEvent.click(screen.getByTestId('npc-graphics-picker-current'));
    fireEvent.change(screen.getByTestId('npc-graphics-picker-filter'), {
      target: { value: '46' },
    });
    expect(screen.getByTestId('npc-graphics-picker-tile-46')).toBeInTheDocument();
  });

  it('shows empty-state message when no sprites match the filter', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    fireEvent.click(screen.getByTestId('npc-graphics-picker-current'));
    fireEvent.change(screen.getByTestId('npc-graphics-picker-filter'), {
      target: { value: 'doesnotexist' },
    });
    expect(screen.getByTestId('npc-graphics-picker-empty')).toBeInTheDocument();
  });

  it('clicking a tile calls onChange and closes the panel', () => {
    const m = makeManifest();
    const onChange = vi.fn();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={onChange}
        sessionId={null}
      />,
    );
    fireEvent.click(screen.getByTestId('npc-graphics-picker-current'));
    fireEvent.click(screen.getByTestId('npc-graphics-picker-tile-46'));
    expect(onChange).toHaveBeenCalledWith(46);
    expect(screen.queryByTestId('npc-graphics-picker-panel')).not.toBeInTheDocument();
  });

  it('numeric-override input lets the user type a hack-added id', () => {
    const m = makeManifest();
    const onChange = vi.fn();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={onChange}
        sessionId={null}
      />,
    );
    fireEvent.click(screen.getByTestId('npc-graphics-picker-current'));
    fireEvent.change(screen.getByTestId('npc-graphics-picker-numeric'), {
      target: { value: '200' },
    });
    expect(onChange).toHaveBeenCalledWith(200);
  });

  it('disabled picker does not open on click', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={() => {}}
        sessionId={null}
        disabled
      />,
    );
    fireEvent.click(screen.getByTestId('npc-graphics-picker-current'));
    expect(screen.queryByTestId('npc-graphics-picker-panel')).not.toBeInTheDocument();
  });

  it('renders a fallback swatch when no overworld-sprite metadata exists for this index', () => {
    const m = makeManifest();
    render(
      <NpcGraphicsPicker
        manifest={m}
        value={0x00}
        onChange={() => {}}
        sessionId={null}
      />,
    );
    // sessionId is null so the thumbnail can't fetch - fallback swatch.
    expect(screen.getByTestId('sprite-thumbnail-fallback-0')).toBeInTheDocument();
  });
});
