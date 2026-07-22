export {
  LZ77_HEADER_FIRST_BYTE,
  LZ77_MAX_UNCOMPRESSED_BYTES,
  LZ77_TYPE_NIBBLE,
  encodeLz77Literal,
  readLz77,
  type Lz77ReadFailure,
  type Lz77ReadResult,
} from './lz77.js';

// Phase 3.3 - optimal-encoder side of the LZ77 codec.
export { encodeLz77 } from './lz77-encoder.js';

export {
  dedupeOverlappingBlocks,
  findLz77Candidates,
  type Lz77Block,
  type ScanLz77Options,
} from './scan.js';

export {
  findHighEntropyRegions,
  shannonEntropy,
  type EntropyOptions,
  type EntropyRegion,
} from './entropy.js';
