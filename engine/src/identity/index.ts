/**
 * Identity surface - RT-1.3.
 *
 * Per-ROM hack identity fingerprints (SHA-1 → display name + family).
 * Used by the editor's patch detector to surface real hack names
 * ("Pokémon Unbound v2.1.1.1") instead of the generic
 * "Bare ROM workspace" fallback.
 */
export {
  FINGERPRINTS_BY_SHA1,
  lookupHackFingerprint,
  type HackFingerprint,
} from './hack-fingerprints.js';
