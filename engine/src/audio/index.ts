export {
  SONG_HEADER_FIXED_PREFIX_BYTES,
  SONG_HEADER_MAX_BLOCK_COUNT,
  SONG_HEADER_MAX_TRACK_COUNT,
  parseSongHeader,
  type SongHeader,
  type SongHeaderParseFailure,
  type SongHeaderParseResult,
} from './song-header.js';

export {
  SONG_TABLE_ENTRY_SIZE_BYTES,
  scanSongTable,
  type ScanSongTableOptions,
  type SongTable,
  type SongTableEntry,
} from './song-table-scanner.js';

export {
  CRY_ENTRY_SIZE_BYTES,
  CRY_TABLE_ANCHOR_CONFIRMATION_ENTRIES,
  CRY_TABLE_MAX_ENTRIES,
  CRY_TABLE_MIN_VALID_ENTRIES,
  findCryTable,
  type CryTableEntryView,
  type CryTableLocation,
} from './cry-table.js';

// Phase 3.6 + 5.1 - mid2agb / midi2agb bridge.
export {
  locateMid2agb,
  runMid2agb,
  type Mid2agbLocationResult,
  type Mid2agbVariant,
  type RunMid2agbArgs,
} from './mid2agb-bridge.js';

// Phase 3.37/3.38 - WAV decoder + resampler.
export {
  decodeWav,
  resamplePcm,
  WavDecodeError,
  type DecodedWav,
} from './wav-decoder.js';
