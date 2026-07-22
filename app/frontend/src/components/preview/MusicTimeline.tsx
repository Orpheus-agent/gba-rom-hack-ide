/**
 * Phase 9E - Music timeline overlay.
 *
 * A compact strip that displays the currently-playing background
 * music + per-slot sound-effect playback. Polls the GBA audio engine
 * via the savestate-patch bridge (`audioStateReader.ts`) every 500 ms
 * while visible.
 *
 * Read-only by design (per Phase 9E plan): no track-warp + no
 * track-switching. Just visibility into what's playing right now.
 *
 * **What you see.**
 *   - Slot label (BGM / SE1 / SE2 / SE3) and a status dot.
 *   - songHeader pointer (hex) for the playing track. We surface
 *     the raw pointer so users debugging music can spot a track
 *     change immediately.
 *   - Track-name resolution: when the manifest's `songNames` carries
 *     an entry matching the pointer's offset into ROM, surface the
 *     friendly name. Otherwise we fall back to the hex pointer +
 *     "Unknown track".
 *   - "Clock" - ticks-elapsed since the song started. Resets on
 *     song change.
 *   - "Tempo" - raw tempoD / tempoU pair from the M4A struct.
 *
 * **Default off.** Toggle in the EmulatorHost toolbar.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readAudioState,
  type AudioStateSnapshot,
  type MusicPlayerSnapshot,
} from '../../lib/audioStateReader';
import type { EmulatorMemoryHost } from '../../lib/emulatorMemory';
import { useProjectStore } from '../../state';
import './MusicTimeline.css';

/** Subset of the manifest we read for song-name resolution.
 *  Intentionally tolerant of missing fields - the manifest's
 *  song table isn't guaranteed to carry pointer information,
 *  so we degrade to "Track @ 0xNNNNNNNN". */
type ManifestForMusic = {
  readonly songNames?: ReadonlyArray<{
    readonly songIndex: number;
    readonly name: string;
    readonly pointer?: number;
  }>;
} | null;

const POLL_INTERVAL_MS = 500;

export interface MusicTimelineProps {
  /** The active mGBA-WASM emulator module; pass the singleton from
   *  EmulatorHost (or null when no game is loaded). */
  readonly host: EmulatorMemoryHost | null;
  /** True when the emulator is running or paused. */
  readonly emulatorActive: boolean;
  /** Default off - the EmulatorHost toolbar provides the toggle. */
  readonly enabled: boolean;
}

export function MusicTimeline({
  host,
  emulatorActive,
  enabled,
}: MusicTimelineProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<AudioStateSnapshot | null>(null);
  const [pollErrorCount, setPollErrorCount] = useState(0);
  const pollInProgressRef = useRef(false);
  const stillMountedRef = useRef(true);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? (s.scan.data as ManifestForMusic) : null,
  );

  const poll = useCallback(async () => {
    if (!host || !emulatorActive || !enabled) return;
    if (pollInProgressRef.current) return;
    pollInProgressRef.current = true;
    try {
      const snap = await readAudioState(host);
      if (stillMountedRef.current) {
        setSnapshot(snap);
        setPollErrorCount(0);
      }
    } catch {
      if (stillMountedRef.current) setPollErrorCount((c) => c + 1);
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
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stillMountedRef.current = false;
      clearInterval(id);
    };
  }, [enabled, host, emulatorActive, poll]);

  if (!enabled || !emulatorActive) return null;

  if (pollErrorCount >= 3) {
    return (
      <div className="music-timeline music-timeline--error" role="status">
        Couldn&apos;t read music state - your emulator may not expose the
        WRAM bridge.
      </div>
    );
  }

  if (!snapshot || !snapshot.anySlotPlaying) {
    return (
      <div className="music-timeline music-timeline--empty" role="status">
        Music timeline on - no music currently playing.
      </div>
    );
  }

  return (
    <div
      className="music-timeline"
      role="region"
      aria-label="Live music timeline"
      data-testid="music-timeline"
    >
      <SlotRow label="BGM" slot={snapshot.bgm} manifest={manifest} />
      <SlotRow label="SE1" slot={snapshot.se1} manifest={manifest} />
      <SlotRow label="SE2" slot={snapshot.se2} manifest={manifest} />
      <SlotRow label="SE3" slot={snapshot.se3} manifest={manifest} />
    </div>
  );
}

function SlotRow({
  label,
  slot,
  manifest,
}: {
  label: string;
  slot: MusicPlayerSnapshot | null;
  manifest: ManifestForMusic;
}): JSX.Element {
  const isPlaying = slot?.looksLikePlaying ?? false;
  const trackName =
    slot && isPlaying ? resolveTrackName(slot.songHeaderPointer, manifest) : ' - ';
  return (
    <div
      className={`music-timeline__row ${isPlaying ? 'music-timeline__row--playing' : 'music-timeline__row--idle'}`}
      data-testid={`music-timeline-row-${label.toLowerCase()}`}
    >
      <span className="music-timeline__label">{label}</span>
      <span
        className={`music-timeline__dot ${isPlaying ? 'music-timeline__dot--on' : 'music-timeline__dot--off'}`}
        aria-hidden
      />
      <span className="music-timeline__track" title={trackName}>
        {trackName}
      </span>
      {isPlaying && slot ? (
        <>
          <span className="music-timeline__field" title="Ticks since song start (clock)">
            ⏱{slot.clock}
          </span>
          <span className="music-timeline__field" title="Tempo: tempoD / tempoU">
            ♩{slot.tempoD}/{slot.tempoU}
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Best-effort resolve of a `gMPlayInfo.songHeader` ROM pointer to a
 * friendly song name. Looks up against the manifest's song-name
 * entries (sourced from the firered-vanilla overlay + the symbol DB
 * Phase 5 scrape).
 *
 * Without a full `gSongTable` ROM-offset index this is approximate
 * - we display the pointer hex as a fallback so users debugging
 * audio aren't stranded.
 */
function resolveTrackName(pointer: number, manifest: ManifestForMusic): string {
  if (manifest?.songNames) {
    const hit = manifest.songNames.find(
      (s) => s.pointer !== undefined && s.pointer === pointer,
    );
    if (hit) {
      return hit.name;
    }
  }
  // Fallback - display the pointer with a hex prefix.
  return `Track @ 0x${pointer.toString(16).padStart(8, '0')}`;
}
