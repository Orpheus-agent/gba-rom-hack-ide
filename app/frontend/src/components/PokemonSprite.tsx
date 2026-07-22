/**
 * Phase 4.2C / Phase 9B - Pokémon sprite thumbnail with optional
 * frame animation.
 *
 * Renders a <img> pointed at the backend's per-project Pokémon-sprite
 * endpoint. Today the endpoint returns a 32×32 placeholder PNG keyed
 * by species id (distinct hue per species); the engine's
 * species-sprite lifter, when it lands, will swap in real ROM-decoded
 * sprites without any frontend change.
 *
 * Phase 9B added the `animated` prop. When `'walk'` or `'idle'` the
 * component cycles frames 0..3 via the backend's `?frame=N` query
 * param. IntersectionObserver pauses the cycle when the sprite scrolls
 * off-screen - important for SpawnGrid (1000+ sprites at once) so we
 * don't burn CPU on invisible rows.
 *
 * Renders nothing (returns null) when the species id is 0 (NONE) or
 * the sessionId isn't known yet.
 */

import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../state';
import './PokemonSprite.css';

export type PokemonSpriteAnimation = 'none' | 'idle' | 'walk';

export interface PokemonSpriteProps {
  /** Numeric species index (matches manifest.speciesNames.speciesIndex). */
  readonly speciesId: number;
  /** Optional CSS class for size variants. Defaults to a 32×32 chip. */
  readonly variant?: 'compact' | 'normal';
  /**
   * Phase 9B - optional walk/idle frame cycling.
   *   - `'none'` (default): static frame 0, no timer.
   *   - `'idle'`: cycles 4 frames at ~3 fps (calm breathing).
   *   - `'walk'`: cycles 4 frames at ~6 fps (locomotion pacing).
   *
   * IntersectionObserver pauses the cycle when off-screen so a
   * 1000-row SpawnGrid doesn't trigger 4000 timer ticks per second.
   */
  readonly animated?: PokemonSpriteAnimation;
  readonly testIdPrefix?: string;
}

const FRAME_INTERVAL_MS: Record<PokemonSpriteAnimation, number> = {
  none: 0,
  idle: 320,
  walk: 160,
};

export function PokemonSprite({
  speciesId,
  variant = 'normal',
  animated = 'none',
  testIdPrefix,
}: PokemonSpriteProps): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [frame, setFrame] = useState(0);
  const [visible, setVisible] = useState(true);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Phase 9B - IntersectionObserver pauses the cycle when the
  // sprite scrolls off-screen.
  useEffect(() => {
    if (animated === 'none') return;
    const el = imgRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setVisible(entry.isIntersecting);
        }
      },
      { root: null, threshold: 0 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [animated]);

  // Phase 9B - Frame-cycling timer; only runs while visible + animated.
  useEffect(() => {
    if (animated === 'none' || !visible) return;
    const interval = FRAME_INTERVAL_MS[animated];
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % 4);
    }, interval);
    return () => {
      clearInterval(id);
    };
  }, [animated, visible]);

  if (!sessionId || speciesId === 0) return null;

  const frameQuery = animated === 'none' ? '' : `?frame=${String(frame)}`;
  const src = `/api/projects/${encodeURIComponent(sessionId)}/pokemon-sprite/${encodeURIComponent(String(speciesId))}.png${frameQuery}`;
  const cls =
    variant === 'compact'
      ? 'pokemon-sprite pokemon-sprite--compact'
      : 'pokemon-sprite';

  return (
    <img
      ref={imgRef}
      src={src}
      alt={`Sprite for species ${String(speciesId)}`}
      className={cls}
      loading="lazy"
      decoding="async"
      data-testid={testIdPrefix ? `${testIdPrefix}-${String(speciesId)}` : `pokemon-sprite-${String(speciesId)}`}
      data-animated={animated}
      data-frame={frame}
    />
  );
}
