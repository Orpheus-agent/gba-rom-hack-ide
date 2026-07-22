/**
 * Phase 4.3B - AI flag chip editor.
 *
 * Replaces the raw u32 numeric input in TrainerInspector's
 * TrainerStructEdit form with a chip toggle grid + preset buttons.
 * Each chip = one named AI flag from Phase 3.4's
 * decodeAiFlags/encodeAiFlags round-trip.
 *
 * The chip set covers every bit the engine recognises (vanilla
 * Gen-3 AI). Unknown bits (CFRU / hack extensions) are preserved
 * verbatim via the unknownBits field; clicking any chip does not
 * disturb them.
 */

import { useCallback, useMemo } from 'react';
import './AiFlagChips.css';

// Phase 5.9 hot-fix - inline the engine's ai-flags constants instead
// of importing from '@rom-introspection/engine'. The engine's index.js
// re-exports `rom/*` which transitively pulls `rom/loader.ts` (top-
// level `import { promises as fsp } from 'node:fs'`); the moment any
// frontend component imports the engine, Vite's bundler eagerly
// evaluates rom/loader and the page throws "Cannot access
// 'node:fs.promises' in client code." The proper fix is a subpath
// export for `@rom-introspection/engine/trainers/ai-flags`, but
// these 13 bit positions + 3 preset integers are tiny - inlining
// is cheaper and dodges the bundling pitfall entirely. Round-trip
// parity with engine/src/trainers/ai-flags.ts is verified by the
// existing AiFlagChips.test.tsx (presets land on the same u32s).

export interface AiFlagSet {
  readonly checkBadMove: boolean;
  readonly tryToFaint: boolean;
  readonly checkViability: boolean;
  readonly setupFirstTurn: boolean;
  readonly risky: boolean;
  readonly preferStrongestMove: boolean;
  readonly preferBatonPass: boolean;
  readonly tagBattle: boolean;
  readonly checkAbility: boolean;
  readonly checkHp: boolean;
  readonly firstBattle: boolean;
  readonly superEffective: boolean;
  readonly roaming: boolean;
  readonly unknownBits: number;
}

const BIT = {
  checkBadMove: 0,
  tryToFaint: 1,
  checkViability: 2,
  setupFirstTurn: 3,
  risky: 4,
  preferStrongestMove: 5,
  preferBatonPass: 6,
  tagBattle: 7,
  checkAbility: 8,
  checkHp: 9,
  firstBattle: 10,
  superEffective: 11,
  roaming: 31,
} as const;

const KNOWN_MASK = (() => {
  let m = 0;
  for (const bit of Object.values(BIT)) m |= 1 << bit;
  return m >>> 0;
})();

const SMART_TRAINER_AI_FLAGS = 0x07;
const GYM_LEADER_AI_FLAGS = 0x07 | (1 << BIT.setupFirstTurn) | (1 << BIT.checkHp);
const ELITE_FOUR_AI_FLAGS =
  GYM_LEADER_AI_FLAGS | (1 << BIT.superEffective) | (1 << BIT.checkAbility);

function decodeAiFlags(value: number): AiFlagSet {
  const v = value >>> 0;
  return Object.freeze({
    checkBadMove: ((v >>> BIT.checkBadMove) & 1) === 1,
    tryToFaint: ((v >>> BIT.tryToFaint) & 1) === 1,
    checkViability: ((v >>> BIT.checkViability) & 1) === 1,
    setupFirstTurn: ((v >>> BIT.setupFirstTurn) & 1) === 1,
    risky: ((v >>> BIT.risky) & 1) === 1,
    preferStrongestMove: ((v >>> BIT.preferStrongestMove) & 1) === 1,
    preferBatonPass: ((v >>> BIT.preferBatonPass) & 1) === 1,
    tagBattle: ((v >>> BIT.tagBattle) & 1) === 1,
    checkAbility: ((v >>> BIT.checkAbility) & 1) === 1,
    checkHp: ((v >>> BIT.checkHp) & 1) === 1,
    firstBattle: ((v >>> BIT.firstBattle) & 1) === 1,
    superEffective: ((v >>> BIT.superEffective) & 1) === 1,
    roaming: ((v >>> BIT.roaming) & 1) === 1,
    unknownBits: (v & ~KNOWN_MASK) >>> 0,
  });
}

function encodeAiFlags(set: AiFlagSet): number {
  let v = set.unknownBits >>> 0;
  if (set.checkBadMove) v |= 1 << BIT.checkBadMove;
  if (set.tryToFaint) v |= 1 << BIT.tryToFaint;
  if (set.checkViability) v |= 1 << BIT.checkViability;
  if (set.setupFirstTurn) v |= 1 << BIT.setupFirstTurn;
  if (set.risky) v |= 1 << BIT.risky;
  if (set.preferStrongestMove) v |= 1 << BIT.preferStrongestMove;
  if (set.preferBatonPass) v |= 1 << BIT.preferBatonPass;
  if (set.tagBattle) v |= 1 << BIT.tagBattle;
  if (set.checkAbility) v |= 1 << BIT.checkAbility;
  if (set.checkHp) v |= 1 << BIT.checkHp;
  if (set.firstBattle) v |= 1 << BIT.firstBattle;
  if (set.superEffective) v |= 1 << BIT.superEffective;
  if (set.roaming) v |= 1 << BIT.roaming;
  return v >>> 0;
}

/** Editable flags surfaced as chips. Order is "most-used first" so
 *  the common cases (smart-trainer trio) are leftmost. */
const CHIP_FIELDS: ReadonlyArray<{
  readonly key: keyof Omit<AiFlagSet, 'unknownBits'>;
  readonly label: string;
  readonly help: string;
}> = Object.freeze([
  { key: 'checkBadMove', label: 'Avoid bad moves', help: 'Skip moves with <50% chance of hitting.' },
  { key: 'tryToFaint', label: 'Try to KO', help: 'Prefer moves that would KO the opponent.' },
  { key: 'checkViability', label: 'Avoid self-harm', help: 'Skip self-damaging moves at low HP.' },
  { key: 'checkHp', label: 'Watch HP', help: 'Adjust move choice based on HP thresholds.' },
  { key: 'setupFirstTurn', label: 'Open w/ setup', help: 'Use stat-boost moves on turn 1.' },
  { key: 'superEffective', label: 'Pick super-eff', help: 'Always pick super-effective moves when available.' },
  { key: 'checkAbility', label: 'Read abilities', help: "Adjust for opponent's ability." },
  { key: 'risky', label: 'Risky', help: 'Favor low-accuracy high-damage moves.' },
  { key: 'preferStrongestMove', label: 'Pick strongest', help: 'Always pick highest-power move (ignores PP).' },
  { key: 'preferBatonPass', label: 'Baton-pass', help: 'Used by Baton Passer NPCs.' },
  { key: 'tagBattle', label: 'Tag-battle', help: 'Aware of double-battle context.' },
  { key: 'firstBattle', label: 'First-battle', help: 'Intro-battle AI override (e.g. rival starter battle).' },
  { key: 'roaming', label: 'Roaming', help: 'Legendary roaming Pokémon AI (bit 31).' },
]);

export interface AiFlagChipsProps {
  /** Current u32 aiFlags. Read by decodeAiFlags + mapped to chip state. */
  readonly value: number;
  /** Called with the new u32 after each toggle / preset click. */
  readonly onChange: (next: number) => void;
  /** Disable interaction (e.g. while a save is in flight). */
  readonly disabled?: boolean;
  /** Prefix for data-testid attributes. */
  readonly testIdPrefix?: string;
}

export function AiFlagChips({
  value,
  onChange,
  disabled = false,
  testIdPrefix,
}: AiFlagChipsProps): JSX.Element {
  const decoded = useMemo(() => decodeAiFlags(value), [value]);

  const toggle = useCallback(
    (key: keyof Omit<AiFlagSet, 'unknownBits'>) => {
      const next: AiFlagSet = { ...decoded, [key]: !decoded[key] };
      onChange(encodeAiFlags(next));
    },
    [decoded, onChange],
  );

  const applyPreset = useCallback(
    (preset: number) => {
      // Preserve unknownBits (CFRU/hack extensions) when applying a preset.
      const merged = (preset | decoded.unknownBits) >>> 0;
      onChange(merged);
    },
    [decoded.unknownBits, onChange],
  );

  return (
    <div className="ai-flag-chips" data-testid={testIdPrefix ?? 'ai-flag-chips'}>
      <div className="ai-flag-chips__presets" data-testid={testIdPrefix ? `${testIdPrefix}-presets` : undefined}>
        <span className="ai-flag-chips__presets-label">Presets:</span>
        <button
          type="button"
          className="ai-flag-chips__preset"
          onClick={() => applyPreset(SMART_TRAINER_AI_FLAGS)}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-preset-smart` : 'ai-flag-preset-smart'}
          title="Sets checkBadMove + tryToFaint + checkViability (vanilla 'smart trainer' default)."
        >
          Smart trainer
        </button>
        <button
          type="button"
          className="ai-flag-chips__preset"
          onClick={() => applyPreset(GYM_LEADER_AI_FLAGS)}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-preset-gym` : 'ai-flag-preset-gym'}
          title="Smart trainer + setupFirstTurn + checkHp."
        >
          Gym leader
        </button>
        <button
          type="button"
          className="ai-flag-chips__preset"
          onClick={() => applyPreset(ELITE_FOUR_AI_FLAGS)}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-preset-elite` : 'ai-flag-preset-elite'}
          title="Gym leader + superEffective + checkAbility."
        >
          Elite Four
        </button>
        <button
          type="button"
          className="ai-flag-chips__preset ai-flag-chips__preset--danger"
          onClick={() => applyPreset(0)}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-preset-clear` : 'ai-flag-preset-clear'}
          title="Clear every known bit (preserves unknown / CFRU-extension bits)."
        >
          Clear
        </button>
      </div>
      <div className="ai-flag-chips__grid">
        {CHIP_FIELDS.map((f) => {
          const on = decoded[f.key];
          return (
            <button
              type="button"
              key={f.key}
              className={`ai-flag-chips__chip${on ? ' ai-flag-chips__chip--on' : ''}`}
              onClick={() => toggle(f.key)}
              disabled={disabled}
              title={f.help}
              data-testid={testIdPrefix ? `${testIdPrefix}-chip-${f.key}` : `ai-flag-chip-${f.key}`}
            >
              {on ? '✓ ' : ''}{f.label}
            </button>
          );
        })}
      </div>
      {decoded.unknownBits !== 0 && (
        <div className="ai-flag-chips__unknown" data-testid={testIdPrefix ? `${testIdPrefix}-unknown` : 'ai-flag-unknown'}>
          + 0x{decoded.unknownBits.toString(16)} extra bits (preserved for CFRU/hack extensions)
        </div>
      )}
      <div className="ai-flag-chips__raw" data-testid={testIdPrefix ? `${testIdPrefix}-raw` : 'ai-flag-raw'}>
        Raw value: <code>0x{(value >>> 0).toString(16).padStart(8, '0')}</code>
      </div>
    </div>
  );
}
