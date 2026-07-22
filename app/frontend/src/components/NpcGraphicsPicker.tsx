import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import {
  listNpcGraphicsForIdentity,
  resolveNpcGraphicsForIdentity,
  type NpcGraphicsCategory,
  type NpcGraphicsEntry,
} from '../lib/symbols';
import { fetchBinaryRomOwSprite } from '../api';
import './NpcGraphicsPicker.css';

/**
 * Phase Q.6.2 - NPC graphics picker.
 *
 * Replaces the raw `<input type="number" min=0 max=255>` for graphicsId
 * on ObjectEventInspector. The user used to have to memorise that 0x21
 * means "Bug Catcher" or 0x2E means "Brock". Now they pick by name from
 * a categorised, searchable list and optionally see a thumbnail of the
 * actual OW sprite.
 *
 * Thumbnails are LAZY - only fetched for the currently-selected sprite
 * and any sprite the user hovers in the grid, to keep load cost
 * proportional to engagement (the registry has 100+ entries; fetching
 * all of them eagerly would be wasteful).
 *
 * Hack-added graphics IDs beyond the bundled registry render with a
 * generic "NPC sprite #N" label so the user can still select them.
 *
 * Categories from the registry: player, generic, story, gym_leader,
 * elite_four, frontier_brain, team, legendary, decoration, object, misc.
 * Player + story + gym_leader are grouped at the top so iconic sprites
 * are easy to find without scrolling through 50+ NPCs.
 */

const CATEGORY_LABELS: Record<NpcGraphicsCategory, string> = {
  player: 'Player & rivals',
  story: 'Story characters',
  gym_leader: 'Gym Leaders',
  elite_four: 'Elite Four',
  frontier_brain: 'Frontier Brains',
  team: 'Villain teams',
  legendary: 'Legendary Pokémon',
  generic: 'Generic NPCs',
  object: 'Interactive objects',
  decoration: 'Decorations & dolls',
  misc: 'Other',
};

const CATEGORY_ORDER: ReadonlyArray<NpcGraphicsCategory> = [
  'player',
  'story',
  'gym_leader',
  'elite_four',
  'frontier_brain',
  'team',
  'legendary',
  'generic',
  'object',
  'decoration',
  'misc',
];

interface NpcGraphicsPickerProps {
  readonly manifest: ProjectManifest;
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly sessionId: string | null;
  readonly disabled?: boolean;
  readonly testIdPrefix?: string;
}

export function NpcGraphicsPicker({
  manifest,
  value,
  onChange,
  sessionId,
  disabled,
  testIdPrefix,
}: NpcGraphicsPickerProps): JSX.Element {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const all = useMemo(
    () => listNpcGraphicsForIdentity(manifest.identity),
    [manifest.identity],
  );

  // Lookup the OverworldSpriteEntry corresponding to the current
  // graphicsId so the thumbnail loader has structFileOffset + palette
  // info.
  const overworldByIndex = useMemo(() => {
    const m = new Map<number, NonNullable<typeof manifest.overworldSprites>[number]>();
    for (const s of manifest.overworldSprites ?? []) m.set(s.spriteIndex, s);
    return m;
  }, [manifest.overworldSprites]);

  const currentEntry: NpcGraphicsEntry | null = useMemo(
    () => resolveNpcGraphicsForIdentity(manifest.identity, value),
    [manifest.identity, value],
  );
  const currentDisplayName = currentEntry
    ? currentEntry.name
    : `NPC sprite #${String(value)}`;

  const grouped = useMemo(() => {
    // Mutable bucket type - the `all` array is readonly so we can't reuse
    // its element type directly.
    type Entry = { graphicsId: number; name: string; category: NpcGraphicsCategory };
    const buckets = new Map<NpcGraphicsCategory, Entry[]>();
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            String(e.graphicsId).includes(q) ||
            `0x${e.graphicsId.toString(16)}`.toLowerCase().includes(q),
        )
      : all;
    for (const entry of filtered) {
      const arr = buckets.get(entry.category) ?? [];
      arr.push({ graphicsId: entry.graphicsId, name: entry.name, category: entry.category });
      buckets.set(entry.category, arr);
    }
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      entries: buckets.get(cat) ?? [],
    })).filter((g) => g.entries.length > 0);
  }, [all, filter]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (ev: MouseEvent) => {
      if (!containerRef.current?.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div
      className="npc-graphics-picker"
      ref={containerRef}
      data-testid={testIdPrefix ?? 'npc-graphics-picker'}
    >
      <button
        type="button"
        className="npc-graphics-picker__current"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        data-testid={`${testIdPrefix ?? 'npc-graphics-picker'}-current`}
        title={`Current sprite #${String(value)} - click to change`}
      >
        <SpriteThumbnail
          spriteIndex={value}
          sessionId={sessionId}
          overworldSprites={manifest.overworldSprites ?? null}
          objectEventPalettes={manifest.objectEventPalettes ?? null}
          size={36}
        />
        <span className="npc-graphics-picker__current-text">
          <span className="npc-graphics-picker__current-name">{currentDisplayName}</span>
          <span className="npc-graphics-picker__current-meta">
            #{value}
            {overworldByIndex.get(value)?.width && overworldByIndex.get(value)?.height
              ? ` · ${String(overworldByIndex.get(value)!.width)}×${String(overworldByIndex.get(value)!.height)}px`
              : ''}
          </span>
        </span>
        <span className="npc-graphics-picker__chevron" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div
          className="npc-graphics-picker__panel"
          data-testid={`${testIdPrefix ?? 'npc-graphics-picker'}-panel`}
        >
          <input
            type="search"
            className="npc-graphics-picker__filter"
            placeholder="Search by name or sprite #…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            autoFocus
            data-testid={`${testIdPrefix ?? 'npc-graphics-picker'}-filter`}
          />
          <div className="npc-graphics-picker__list">
            {grouped.length === 0 ? (
              <p
                className="npc-graphics-picker__empty"
                data-testid={`${testIdPrefix ?? 'npc-graphics-picker'}-empty`}
              >
                No sprites match "{filter}". Clear the filter to see everything.
              </p>
            ) : (
              grouped.map((group) => (
                <div key={group.category} className="npc-graphics-picker__group">
                  <h4 className="npc-graphics-picker__group-heading">
                    {group.label}
                    <span className="npc-graphics-picker__group-count">
                      ({group.entries.length})
                    </span>
                  </h4>
                  <div className="npc-graphics-picker__grid">
                    {group.entries.map((entry) => {
                      const isSelected = entry.graphicsId === value;
                      return (
                        <button
                          key={entry.graphicsId}
                          type="button"
                          className={`npc-graphics-picker__tile${isSelected ? ' npc-graphics-picker__tile--selected' : ''}`}
                          onClick={() => {
                            onChange(entry.graphicsId);
                            setOpen(false);
                          }}
                          title={`${entry.name} (#${String(entry.graphicsId)})`}
                          data-testid={`${testIdPrefix ?? 'npc-graphics-picker'}-tile-${entry.graphicsId}`}
                        >
                          <SpriteThumbnail
                            spriteIndex={entry.graphicsId}
                            sessionId={sessionId}
                            overworldSprites={manifest.overworldSprites ?? null}
                            objectEventPalettes={manifest.objectEventPalettes ?? null}
                            size={32}
                          />
                          <span className="npc-graphics-picker__tile-name">
                            {entry.name}
                          </span>
                          <span className="npc-graphics-picker__tile-id">
                            #{entry.graphicsId}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
            {/* Always allow numeric override for hack-added sprites
                beyond the bundled registry. */}
            <div className="npc-graphics-picker__numeric-override">
              <label>
                <span className="npc-graphics-picker__numeric-label">
                  Or enter a sprite # directly (for hack-added sprites)
                </span>
                <input
                  type="number"
                  min={0}
                  max={1023}
                  value={value}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n) && n >= 0 && n <= 1023) onChange(n);
                  }}
                  data-testid={`${testIdPrefix ?? 'npc-graphics-picker'}-numeric`}
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SpriteThumbnailProps {
  readonly spriteIndex: number;
  readonly sessionId: string | null;
  readonly overworldSprites: NonNullable<ProjectManifest['overworldSprites']> | null;
  readonly objectEventPalettes: NonNullable<ProjectManifest['objectEventPalettes']> | null;
  readonly size: number;
}

/** Lazy sprite-thumbnail loader. Fetches the decoded RGBA bytes on
 *  first mount and renders them onto a canvas. Falls back to a
 *  placeholder swatch with the index number when no overworld-sprite
 *  metadata is available (decomp project / hack-added id) or the fetch
 *  fails. The fetch is cached in module-level memory so re-renders of
 *  the same sprite reuse the same RGBA payload. */
const SPRITE_THUMB_CACHE = new Map<number, { width: number; height: number; rgba: Uint8ClampedArray } | 'failed'>();

function SpriteThumbnail({
  spriteIndex,
  sessionId,
  overworldSprites,
  objectEventPalettes,
  size,
}: SpriteThumbnailProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'fallback'>(() =>
    SPRITE_THUMB_CACHE.get(spriteIndex) === 'failed' ? 'fallback' : 'loading',
  );

  // Find the matching OverworldSpriteEntry + its palette.
  const spriteMeta = useMemo(
    () => overworldSprites?.find((s) => s.spriteIndex === spriteIndex) ?? null,
    [overworldSprites, spriteIndex],
  );
  const paletteEntry = useMemo(() => {
    if (!spriteMeta || !objectEventPalettes) return null;
    return objectEventPalettes.find((p) => p.tag === spriteMeta.paletteTag) ?? null;
  }, [spriteMeta, objectEventPalettes]);

  useEffect(() => {
    let cancelled = false;

    const cached = SPRITE_THUMB_CACHE.get(spriteIndex);
    if (cached && cached !== 'failed') {
      paint(cached.width, cached.height, cached.rgba);
      setStatus('loaded');
      return;
    }
    if (cached === 'failed' || !sessionId || !spriteMeta) {
      setStatus('fallback');
      return;
    }

    setStatus('loading');
    void (async () => {
      try {
        const res = await fetchBinaryRomOwSprite(sessionId, {
          structFileOffset: spriteMeta.structFileOffset,
          frameIndex: 0,
          palette: paletteEntry?.paletteRgba ?? undefined,
        });
        if (cancelled) return;
        const bytes = base64ToBytes(res.rgbaBase64);
        SPRITE_THUMB_CACHE.set(spriteIndex, {
          width: res.width,
          height: res.height,
          rgba: bytes,
        });
        paint(res.width, res.height, bytes);
        setStatus('loaded');
      } catch {
        if (cancelled) return;
        SPRITE_THUMB_CACHE.set(spriteIndex, 'failed');
        setStatus('fallback');
      }
    })();

    return () => {
      cancelled = true;
    };

    function paint(w: number, h: number, rgba: Uint8ClampedArray): void {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const img = new ImageData(rgba, w, h);
      ctx.putImageData(img, 0, 0);
    }
  }, [spriteIndex, sessionId, spriteMeta, paletteEntry]);

  if (status === 'fallback') {
    return (
      <div
        className="npc-graphics-picker__thumb-fallback"
        style={{ width: size, height: size }}
        title={`Sprite #${String(spriteIndex)} (preview unavailable)`}
        data-testid={`sprite-thumbnail-fallback-${spriteIndex}`}
      >
        #{spriteIndex}
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="npc-graphics-picker__thumb"
      style={{ width: size, height: size }}
      data-testid={`sprite-thumbnail-${spriteIndex}`}
    />
  );
}

/** Decode base64 → Uint8ClampedArray for ImageData. */
function base64ToBytes(b64: string): Uint8ClampedArray {
  if (typeof atob !== 'function') {
    // jsdom / node - fall through to Buffer.
    return new Uint8ClampedArray(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const arr = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
