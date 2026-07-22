/**
 * Pokédex entry encoder (Phase 3.42).
 *
 * Inverse of `parsePokedexEntry`. Produces the 32-byte struct from a
 * spec; the caller allocates the description string separately (the
 * struct only holds the ROM pointer to it).
 *
 * Description text is encoded via the engine's Gen-3 text codec
 * (the same one msgbox uses).
 */

import { encodeString } from '../text/codec.js';
import {
  POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
  POKEDEX_CATEGORY_NAME_LENGTH_BYTES,
  POKEDEX_HEIGHT_MAX,
  POKEDEX_OFFSET_CATEGORY_NAME,
  POKEDEX_OFFSET_DESCRIPTION_PTR,
  POKEDEX_OFFSET_HEIGHT,
  POKEDEX_OFFSET_POKEMON_OFFSET,
  POKEDEX_OFFSET_POKEMON_SCALE,
  POKEDEX_OFFSET_TRAINER_OFFSET,
  POKEDEX_OFFSET_TRAINER_SCALE,
  POKEDEX_OFFSET_UNUSED_DESCRIPTION_PTR,
  POKEDEX_OFFSET_WEIGHT,
  POKEDEX_WEIGHT_MAX,
} from './pokedex-entry.js';

const GBA_ROM_BASE = 0x08000000;

export interface PokedexEntrySpec {
  /** 1..12 ASCII chars; encoded as ALL-CAPS Gen-3 text + 0xFF terminator. */
  readonly categoryName: string;
  /** Decimeters (1..999 = 0.1m..99.9m). */
  readonly height: number;
  /** Hectograms (1..9999 = 0.1kg..999.9kg). */
  readonly weight: number;
  /** File offset of the encoded description text. */
  readonly descriptionOffset: number | null;
  /** Optional unused description ptr (vanilla = NULL). */
  readonly unusedDescriptionOffset?: number | null;
  /** Sprite scale (typically 256..1024). */
  readonly pokemonScale: number;
  /** Sprite y-offset. */
  readonly pokemonOffset: number;
  /** Trainer-side scale. */
  readonly trainerScale: number;
  /** Trainer-side y-offset. */
  readonly trainerOffset: number;
}

export class PokedexEntryEncodeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`PokedexEntryEncodeError: ${field}: ${message}`);
    this.name = 'PokedexEntryEncodeError';
    this.field = field;
  }
}

/** Encode a single PokedexEntry struct (32 bytes). */
export function encodePokedexEntry(spec: PokedexEntrySpec): Uint8Array {
  if (
    !Number.isInteger(spec.height) ||
    spec.height < 0 ||
    spec.height > POKEDEX_HEIGHT_MAX
  ) {
    throw new PokedexEntryEncodeError('height', `must be 0..${String(POKEDEX_HEIGHT_MAX)}; got ${String(spec.height)}`);
  }
  if (!Number.isInteger(spec.weight) || spec.weight < 0 || spec.weight > POKEDEX_WEIGHT_MAX) {
    throw new PokedexEntryEncodeError('weight', `must be 0..${String(POKEDEX_WEIGHT_MAX)}; got ${String(spec.weight)}`);
  }
  if (spec.categoryName.length === 0 || spec.categoryName.length > POKEDEX_CATEGORY_NAME_LENGTH_BYTES - 1) {
    throw new PokedexEntryEncodeError(
      'categoryName',
      `must be 1..${String(POKEDEX_CATEGORY_NAME_LENGTH_BYTES - 1)} chars; got ${String(spec.categoryName.length)}`,
    );
  }

  const out = new Uint8Array(POKEDEX_ENTRY_STRUCT_SIZE_BYTES);
  // categoryName: encode + pad with 0xFF terminator.
  const nameEncoded = encodeString(spec.categoryName.toUpperCase());
  if (nameEncoded.length > POKEDEX_CATEGORY_NAME_LENGTH_BYTES) {
    throw new PokedexEntryEncodeError(
      'categoryName',
      `encoded length ${String(nameEncoded.length)} > ${String(POKEDEX_CATEGORY_NAME_LENGTH_BYTES)} byte slot`,
    );
  }
  for (let i = 0; i < POKEDEX_CATEGORY_NAME_LENGTH_BYTES; i++) {
    out[POKEDEX_OFFSET_CATEGORY_NAME + i] = i < nameEncoded.length ? nameEncoded[i]! : 0xff;
  }
  writeU16Le(out, POKEDEX_OFFSET_HEIGHT, spec.height);
  writeU16Le(out, POKEDEX_OFFSET_WEIGHT, spec.weight);
  writePointer(out, POKEDEX_OFFSET_DESCRIPTION_PTR, spec.descriptionOffset, 'descriptionOffset');
  writePointer(out, POKEDEX_OFFSET_UNUSED_DESCRIPTION_PTR, spec.unusedDescriptionOffset ?? null, 'unusedDescriptionOffset');
  writeU16Le(out, POKEDEX_OFFSET_POKEMON_SCALE, spec.pokemonScale);
  writeU16Le(out, POKEDEX_OFFSET_POKEMON_OFFSET, spec.pokemonOffset);
  writeU16Le(out, POKEDEX_OFFSET_TRAINER_SCALE, spec.trainerScale);
  writeU16Le(out, POKEDEX_OFFSET_TRAINER_OFFSET, spec.trainerOffset);
  return out;
}

function writeU16Le(out: Uint8Array, offset: number, value: number): void {
  out[offset + 0] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function writePointer(out: Uint8Array, offset: number, fileOffset: number | null, field: string): void {
  if (fileOffset === null) {
    out[offset + 0] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  if (!Number.isInteger(fileOffset) || fileOffset < 0 || fileOffset > 0x01ffffff) {
    throw new PokedexEntryEncodeError(field, `must fit in 25 bits; got ${String(fileOffset)}`);
  }
  const ptr = (fileOffset + GBA_ROM_BASE) >>> 0;
  out[offset + 0] = ptr & 0xff;
  out[offset + 1] = (ptr >>> 8) & 0xff;
  out[offset + 2] = (ptr >>> 16) & 0xff;
  out[offset + 3] = (ptr >>> 24) & 0xff;
}
