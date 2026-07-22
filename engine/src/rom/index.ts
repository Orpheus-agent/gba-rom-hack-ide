export {
  GBA_HEADER_LENGTH,
  HEADER_FIELD,
  describeGbaHeader,
  parseGbaHeader,
  readGbaHeader,
  type GbaHeader,
  type GbaHeaderParseFailure,
  type GbaHeaderParseResult,
} from './header.js';

export {
  ROM_MAX_BYTES,
  ROM_MIN_BYTES,
  RomLoadError,
  loadRomFromBytes,
  loadRomFromPath,
  type RomImage,
  type RomLoadFailure,
} from './loader.js';

export {
  CANONICAL_GEN3_HEADERS,
  canonicalForGameCode,
  type CanonicalGen3Header,
} from './canonical-headers.js';

export {
  findFreeRomSpace,
  type FreeSpaceResult,
} from './free-space.js';

export {
  FreeSpaceRegistry,
  FreeSpaceExhaustedError,
  type FreeSpaceClaim,
  type FreeSpaceRegistrySnapshot,
} from './free-space-registry.js';
