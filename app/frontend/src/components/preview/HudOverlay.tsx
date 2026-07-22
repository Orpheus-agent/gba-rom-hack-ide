/**
 * Phase 9C - Live-game HUD overlay.
 *
 * Layered on top of the emulator's canvas inside EmulatorHost. Reads
 * the active battle state (player + opponent BattleMon structs) from
 * EWRAM every ~500 ms and renders HP bars + level + species name
 * over the running emulator.
 *
 * **Default off.** The user toggles via the EmulatorHost toolbar so
 * the overlay never gets in the way of plain-vanilla emulator
 * usage. When on but no battle is detected, the overlay renders a
 * subtle "no battle detected" hint instead of garbage data.
 *
 * **Click semantics.** Clicking the player or opponent HP bar opens
 * the species inspector for that monster - fulfilling the
 * north-star "click anything to edit everything related to it"
 * affordance during play.
 *
 * **Poll cadence.** Every 500 ms while visible + emulator running.
 * The EmulatorMemory bridge uses a savestate-patch round-trip per
 * read (~100 ms), so 2 Hz is the sustainable ceiling. For HUD use
 * cases (HP bars during a 10-second battle turn) that's plenty.
 *
 * **Lifecycle.** Polling pauses on emulator pause / overlay toggle
 * off / component unmount. The savestate round-trip can briefly
 * blip audio (mGBA pauses emulation during save-state capture), so
 * we keep the poll interval generous to minimise the artifact.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readBattleState,
  type BattleMonSnapshot,
  type BattleStateSnapshot,
} from '../../lib/battleStateReader';
import type { EmulatorMemoryHost } from '../../lib/emulatorMemory';
import './HudOverlay.css';

const POLL_INTERVAL_MS = 500;

export interface HudOverlayProps {
  /** The active mGBA-WASM emulator module; pass the singleton from
   *  EmulatorHost (or null when no game is loaded). */
  readonly host: EmulatorMemoryHost | null;
  /** True when the emulator is running or paused; false on idle/
   *  error. The overlay suppresses itself outside of these. */
  readonly emulatorActive: boolean;
  /** Default off - the EmulatorHost toolbar provides the toggle. */
  readonly enabled: boolean;
  /** Callback fired when the user clicks a monster's HP bar. The
   *  parent (EmulatorHost) opens the species inspector. */
  readonly onMonsterClick?: (speciesId: number, side: 'player' | 'opponent') => void;
}

export function HudOverlay({
  host,
  emulatorActive,
  enabled,
  onMonsterClick,
}: HudOverlayProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<BattleStateSnapshot | null>(null);
  const [pollErrorCount, setPollErrorCount] = useState(0);
  const pollInProgressRef = useRef(false);
  const stillMountedRef = useRef(true);

  const poll = useCallback(async () => {
    if (!host || !emulatorActive || !enabled) return;
    if (pollInProgressRef.current) return; // skip overlapping polls
    pollInProgressRef.current = true;
    try {
      const snap = await readBattleState(host);
      if (stillMountedRef.current) {
        setSnapshot(snap);
        setPollErrorCount(0);
      }
    } catch {
      if (stillMountedRef.current) {
        setPollErrorCount((c) => c + 1);
      }
    } finally {
      pollInProgressRef.current = false;
    }
  }, [host, emulatorActive, enabled]);

  useEffect(() => {
    stillMountedRef.current = true;
    if (!enabled || !host || !emulatorActive) {
      setSnapshot(null);
      return () => {
        stillMountedRef.current = false;
      };
    }
    // Fire one immediate poll + then on an interval.
    void poll();
    const id = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      stillMountedRef.current = false;
      clearInterval(id);
    };
  }, [enabled, host, emulatorActive, poll]);

  if (!enabled || !emulatorActive) return null;

  // Persistent failure (e.g. emulator's WRAM bridge missing) →
  // surface a one-line warning instead of an empty overlay.
  if (pollErrorCount >= 3) {
    return (
      <div className="hud-overlay hud-overlay--error" role="status">
        Couldn&apos;t read battle state - your emulator may not expose the
        WRAM bridge.
      </div>
    );
  }

  if (!snapshot || !snapshot.looksLikeAnActiveBattle) {
    return (
      <div className="hud-overlay hud-overlay--empty" role="status">
        Battle HUD on - waiting for an active battle.
      </div>
    );
  }

  return (
    <div className="hud-overlay" role="region" aria-label="Live battle HUD">
      <MonsterCard
        side="opponent"
        mon={snapshot.opponent}
        onClick={onMonsterClick}
      />
      <MonsterCard
        side="player"
        mon={snapshot.player}
        onClick={onMonsterClick}
      />
    </div>
  );
}

function MonsterCard({
  side,
  mon,
  onClick,
}: {
  side: 'player' | 'opponent';
  mon: BattleMonSnapshot | null;
  onClick?: (speciesId: number, side: 'player' | 'opponent') => void;
}): JSX.Element | null {
  if (!mon) return null;
  const pct = Math.max(0, Math.min(100, Math.round((mon.hp / Math.max(1, mon.maxHp)) * 100)));
  const colorClass =
    pct > 50 ? 'hud-bar--green' : pct > 20 ? 'hud-bar--yellow' : 'hud-bar--red';
  return (
    <button
      type="button"
      className={`hud-overlay__card hud-overlay__card--${side}`}
      onClick={() => onClick?.(mon.speciesId, side)}
      data-testid={`hud-overlay-${side}`}
      title={`Click to open species inspector (species #${String(mon.speciesId)})`}
    >
      <div className="hud-overlay__title">
        <span className="hud-overlay__side-label">
          {side === 'player' ? 'You' : 'Foe'}
        </span>
        <span className="hud-overlay__level">Lv {mon.level}</span>
      </div>
      <div className="hud-overlay__bar">
        <div
          className={`hud-overlay__bar-fill ${colorClass}`}
          style={{ width: `${String(pct)}%` }}
          data-testid={`hud-overlay-${side}-bar`}
          data-percent={pct}
        />
      </div>
      <div className="hud-overlay__hp-text">
        {mon.hp}/{mon.maxHp}
      </div>
    </button>
  );
}
