/**
 * Phase 4.2D - Pokémon type chip.
 *
 * Renders a small colored chip per Gen-3 type id using the canonical
 * Gen-6+ Pokémon-type color palette. Supports the vanilla 18 types
 * (0-17) plus Fairy (id 18) which CFRU adds.
 *
 * Two render shapes:
 *   <TypeChip typeId={10} />                  → single chip
 *   <TypeChipPair type1={10} type2={2} />     → 1 or 2 chips
 *                                                  (no second chip when type1 === type2)
 *
 * The chip resolves the type's display name via the manifest's
 * SpeciesEntry.type1Name / type2Name when available (project-scoped
 * lifter ran) and falls back to a hardcoded canonical name otherwise.
 */

import './TypeChip.css';

/** Gen-3 type ids per pret/pokefirered. Fairy (18) is the CFRU
 *  extension; we render it the same way the rest do. */
export type Gen3TypeId = number;

interface TypeMeta {
  readonly name: string;
  readonly color: string;
  readonly textColor: string;
}

/** Canonical Gen-6+ type palette. Hardcoded so a type chip looks
 *  right even before a manifest is loaded (e.g. in fixtures /
 *  Storybook-equivalent test rigs). Manifest-supplied names override
 *  the `name` field when available, but the color is always sourced
 *  here. */
const TYPE_META: Readonly<Record<number, TypeMeta>> = Object.freeze({
  0: { name: 'Normal', color: '#A8A878', textColor: '#000' },
  1: { name: 'Fighting', color: '#C03028', textColor: '#fff' },
  2: { name: 'Flying', color: '#A890F0', textColor: '#000' },
  3: { name: 'Poison', color: '#A040A0', textColor: '#fff' },
  4: { name: 'Ground', color: '#E0C068', textColor: '#000' },
  5: { name: 'Rock', color: '#B8A038', textColor: '#000' },
  6: { name: 'Bug', color: '#A8B820', textColor: '#000' },
  7: { name: 'Ghost', color: '#705898', textColor: '#fff' },
  8: { name: 'Steel', color: '#B8B8D0', textColor: '#000' },
  9: { name: '???', color: '#68A090', textColor: '#fff' }, // Mystery / Curse type
  10: { name: 'Fire', color: '#F08030', textColor: '#000' },
  11: { name: 'Water', color: '#6890F0', textColor: '#fff' },
  12: { name: 'Grass', color: '#78C850', textColor: '#000' },
  13: { name: 'Electric', color: '#F8D030', textColor: '#000' },
  14: { name: 'Psychic', color: '#F85888', textColor: '#fff' },
  15: { name: 'Ice', color: '#98D8D8', textColor: '#000' },
  16: { name: 'Dragon', color: '#7038F8', textColor: '#fff' },
  17: { name: 'Dark', color: '#705848', textColor: '#fff' },
  18: { name: 'Fairy', color: '#EE99AC', textColor: '#000' },
});

const UNKNOWN_TYPE: TypeMeta = Object.freeze({
  name: 'Type?',
  color: '#444',
  textColor: '#aaa',
});

export interface TypeChipProps {
  /** Numeric type id. */
  readonly typeId: number;
  /** Optional display-name override (from manifest's
   *  species.type1Name / type2Name when available). */
  readonly displayName?: string;
  /** Compact mode - narrower padding, tinier font. */
  readonly compact?: boolean;
  /** Data-testid prefix for component tests. */
  readonly testIdPrefix?: string;
}

export function TypeChip({
  typeId,
  displayName,
  compact = false,
  testIdPrefix,
}: TypeChipProps): JSX.Element {
  const meta = TYPE_META[typeId] ?? UNKNOWN_TYPE;
  const label = displayName ?? meta.name;
  return (
    <span
      className={`type-chip${compact ? ' type-chip--compact' : ''}`}
      style={{ backgroundColor: meta.color, color: meta.textColor }}
      title={`Type ${String(typeId)} - ${label}`}
      data-testid={testIdPrefix ? `${testIdPrefix}-${String(typeId)}` : `type-chip-${String(typeId)}`}
    >
      {label}
    </span>
  );
}

export interface TypeChipPairProps {
  readonly type1: number;
  readonly type2: number;
  readonly type1Name?: string;
  readonly type2Name?: string;
  readonly compact?: boolean;
  readonly testIdPrefix?: string;
}

/** Render 1 or 2 chips for a Pokémon's primary + secondary type. When
 *  the two types are equal (single-type Pokémon), only one chip
 *  renders. */
export function TypeChipPair({
  type1,
  type2,
  type1Name,
  type2Name,
  compact = false,
  testIdPrefix,
}: TypeChipPairProps): JSX.Element {
  const single = type1 === type2;
  return (
    <span className="type-chip-pair" data-testid={testIdPrefix ?? 'type-chip-pair'}>
      <TypeChip
        typeId={type1}
        {...(type1Name !== undefined ? { displayName: type1Name } : {})}
        {...(compact ? { compact: true } : {})}
        {...(testIdPrefix !== undefined ? { testIdPrefix: `${testIdPrefix}-1` } : {})}
      />
      {!single && (
        <TypeChip
          typeId={type2}
          {...(type2Name !== undefined ? { displayName: type2Name } : {})}
          {...(compact ? { compact: true } : {})}
          {...(testIdPrefix !== undefined ? { testIdPrefix: `${testIdPrefix}-2` } : {})}
        />
      )}
    </span>
  );
}
