/**
 * Phase-5 detector: audio system detection (P5-T7).
 *
 * Per §15 Phase 5, "music regions" is one of the verbatim sub-detections
 * the map system phase owns. The Gen-3 SAPPY engine references every
 * song via a flat in-ROM array (`gSongTable` in the pret decomps);
 * each map's `mapHeader.musicId` indexes into that table. P5-T7
 * detects the table structurally + emits coverage for table bytes +
 * song-header bytes, enabling the graph builder to surface
 * `music_track` typed nodes and `plays_music` edges (map →
 * music_track) using mapHeader.musicId as the resolver.
 *
 * PD 5: no baked offsets - `scanSongTable` finds the table by
 * validating the structural shape (8-byte entries each pointing to a
 * parseable SongHeader). Works uniformly on vanilla / decomp / hack /
 * fork.
 *
 * PD 8: every byte of the song table AND every detected song header
 * is registered in coverage as `audio` @ 0.85.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  SONG_HEADER_FIXED_PREFIX_BYTES,
  SONG_TABLE_ENTRY_SIZE_BYTES,
  scanSongTable,
  type SongTable,
} from '../audio/index.js';

export const AUDIO_SYSTEM_DETECTOR_ID = 'audio_system';

export interface AudioSystemReport {
  /** The detected gSongTable, or null if none was found. */
  readonly songTable: SongTable;
  /** Convenience mirror of songTable.entryCount. */
  readonly songCount: number;
}

export const audioSystemDetector: RomDetector<AudioSystemReport> = {
  id: AUDIO_SYSTEM_DETECTOR_ID,
  name: 'Audio System (Gen-3 SAPPY gSongTable scanner)',
  phase: 5,
  detect(rom: RomImage, coverage: CoverageMap): Detection<AudioSystemReport> {
    if (rom.byteLength < SONG_TABLE_ENTRY_SIZE_BYTES + SONG_HEADER_FIXED_PREFIX_BYTES) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to host a gSongTable entry + SongHeader`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 SAPPY song table',
      });
    }

    const songTable = scanSongTable(rom.bytes);
    if (songTable === null) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for a run of ≥3 song-table entries with parseable SongHeader targets - none found`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              songTableEntrySize: SONG_TABLE_ENTRY_SIZE_BYTES,
            },
          }),
        ],
        reason:
          'No Gen-3 SAPPY gSongTable found - either the ROM is non-Gen-3, the sound engine has been rewritten, or the table relocated to a position where its targets do not parse as standard SongHeader structs',
      });
    }

    // Register the song-table bytes as `audio` coverage.
    try {
      coverage.addClassified({
        start: songTable.tableStart,
        end: songTable.tableEndExclusive,
        probableClass: 'audio',
        score: 0.85,
        provenance: `${AUDIO_SYSTEM_DETECTOR_ID}#gSongTable`,
        note: `gSongTable (${String(songTable.entryCount)} songs${songTable.sentinelTerminated ? ' + sentinel' : ''})`,
      });
    } catch {
      // Overlap with an earlier detector - skip.
    }

    // Register each SongHeader struct as `audio` coverage.
    for (const entry of songTable.entries) {
      try {
        coverage.addClassified({
          start: entry.header.fileOffset,
          end: entry.header.fileOffset + entry.header.byteLength,
          probableClass: 'audio',
          score: 0.85,
          provenance: `${AUDIO_SYSTEM_DETECTOR_ID}#songHeader-index${String(entry.index)}`,
          note: `SongHeader (index=${String(entry.index)}, trackCount=${String(entry.header.trackCount)})`,
        });
      } catch {
        // Overlap - skip.
      }
    }

    const confidence = songTable.entryCount >= 100 ? 0.95 : songTable.entryCount >= 20 ? 0.9 : 0.8;

    return makeDetected({
      confidence,
      data: Object.freeze({ songTable, songCount: songTable.entryCount }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found gSongTable at offset 0x${songTable.tableStart.toString(16)} (${String(songTable.entryCount)} songs${songTable.sentinelTerminated ? ', sentinel-terminated' : ''})`,
          weight: 1.0,
          detail: {
            tableStart: songTable.tableStart,
            tableEndExclusive: songTable.tableEndExclusive,
            songCount: songTable.entryCount,
            sentinelTerminated: songTable.sentinelTerminated,
          },
        }),
      ],
    });
  },
};
