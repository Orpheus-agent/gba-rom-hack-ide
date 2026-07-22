/**
 * Phase-0 detector: GBA cartridge header fingerprint.
 *
 * This is the simplest detector in the engine - it parses the 192-byte
 * cartridge header that EVERY GBA cart has by hardware spec (no Pokémon
 * assumption - PD 5). It exists at Phase 0 because:
 *   (a) it proves the universal Detection contract end-to-end with real
 *       byte-level evidence (Phase 0 Exit Gate criterion);
 *   (b) every later phase needs to know the cart's game code + version, so
 *       this is the first read-once shared signal Phase 1+ detectors will
 *       consume; and
 *   (c) it demonstrates how `detected` / `partial` / `not_detected` all
 *       reach the orchestrator with concrete evidence rather than bare nulls.
 */

import { makeDetected, makeEvidence, makeNotDetected, makePartial } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import {
  GBA_HEADER_LENGTH,
  HEADER_FIELD,
  describeGbaHeader,
  parseGbaHeader,
  type GbaHeader,
} from '../rom/header.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';

export const HEADER_FINGERPRINT_DETECTOR_ID = 'gba_header_fingerprint';

/**
 * Successful header detection payload. Carries the parsed header + an
 * already-formatted display string so consumers don't need to re-derive it.
 */
export interface HeaderFingerprintPayload {
  readonly header: GbaHeader;
  readonly display: string;
  readonly romSha1: string;
}

/**
 * Partial header payload - the header parsed BUT something looks off (e.g.
 * the fixed marker was wrong but the game code still read as printable
 * ASCII). The partial result still surfaces what WAS readable.
 */
export interface HeaderPartialPayload {
  readonly observedMarkerByte: number;
  readonly expectedMarkerByte: number;
  readonly probableGameCode: string | null;
}

export const headerFingerprintDetector: RomDetector<HeaderFingerprintPayload | HeaderPartialPayload> = {
  id: HEADER_FINGERPRINT_DETECTOR_ID,
  name: 'GBA Cartridge Header Fingerprint',
  phase: 0,
  detect(
    rom: RomImage,
    coverage: CoverageMap,
  ): Detection<HeaderFingerprintPayload | HeaderPartialPayload> {
    const parsed = parseGbaHeader(rom.bytes);

    if (parsed.ok) {
      // Register the header bytes as classified coverage - they're the
      // hardware-spec-defined header region. Confidence is 1.0 because the
      // 0x96 marker validated; this isn't a guess.
      coverage.addClassified({
        start: 0x00,
        end: GBA_HEADER_LENGTH,
        probableClass: 'header',
        score: 1.0,
        provenance: `${HEADER_FINGERPRINT_DETECTOR_ID}#detected`,
        note: `GBA cartridge header (game code ${parsed.header.gameCode})`,
      });

      return makeDetected<HeaderFingerprintPayload>({
        // Confidence is high - the 0x96 marker is Nintendo's own sanity
        // check, and the game code parsed as 4 ASCII chars. We hold a
        // little back from 1.0 because a forged header can still trick the
        // marker - only runtime/BIOS validation makes it provably 1.0,
        // and that's a Phase 10 concern.
        confidence: 0.95,
        evidence: [
          makeEvidence({
            kind: 'signature',
            summary: `0x96 fixed-marker byte present at offset 0x${HEADER_FIELD.fixedMarkerOffset.toString(16).toUpperCase()}`,
            weight: 0.6,
            detail: { offset: HEADER_FIELD.fixedMarkerOffset, expectedByte: 0x96 },
          }),
          makeEvidence({
            kind: 'heuristic',
            summary: `game code ${parsed.header.gameCode} is 4 printable ASCII chars at offset 0x${HEADER_FIELD.gameCodeOffset.toString(16).toUpperCase()}`,
            weight: 0.3,
            detail: {
              gameCode: parsed.header.gameCode,
              offset: HEADER_FIELD.gameCodeOffset,
            },
          }),
          makeEvidence({
            kind: 'heuristic',
            summary: `internal title "${parsed.header.internalTitle}" decoded at offset 0x${HEADER_FIELD.titleOffset.toString(16).toUpperCase()}`,
            weight: 0.1,
            detail: { title: parsed.header.internalTitle, offset: HEADER_FIELD.titleOffset },
          }),
        ],
        data: {
          header: parsed.header,
          display: describeGbaHeader(parsed.header),
          romSha1: rom.sha1,
        },
      });
    }

    // Failure path - return a typed result with a concrete reason.
    const f = parsed.failure;
    if (f.kind === 'too_short') {
      return makeNotDetected({
        confidence: 0.95,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM has ${String(f.bytesAvailable)} bytes - need at least ${String(f.bytesRequired)} for a GBA cartridge header`,
            weight: 1.0,
            detail: { bytesAvailable: f.bytesAvailable, bytesRequired: f.bytesRequired },
          }),
        ],
        reason: `Input is too short to contain a GBA cartridge header (${String(f.bytesAvailable)} < ${String(f.bytesRequired)} bytes)`,
      });
    }

    if (f.kind === 'fixed_marker_invalid') {
      // The fixed marker is wrong but enough bytes were present to attempt
      // the rest of the parse. Try to read the game code anyway for the
      // partial payload - useful evidence for "corrupted but salvageable".
      let probableGameCode: string | null = null;
      if (rom.bytes.length >= HEADER_FIELD.gameCodeOffset + HEADER_FIELD.gameCodeLength) {
        const slice = rom.bytes.subarray(
          HEADER_FIELD.gameCodeOffset,
          HEADER_FIELD.gameCodeOffset + HEADER_FIELD.gameCodeLength,
        );
        const allPrintable = slice.every((c) => c >= 0x20 && c <= 0x7e);
        if (allPrintable) {
          let code = '';
          for (let i = 0; i < slice.length; i++) {
            code += String.fromCharCode(slice[i] ?? 0);
          }
          probableGameCode = code;
        }
      }

      // Still register the header REGION as classified - the BYTES are
      // there, the marker is just wrong. Lowering score reflects uncertainty.
      coverage.addClassified({
        start: 0x00,
        end: GBA_HEADER_LENGTH,
        probableClass: 'header',
        score: 0.5,
        provenance: `${HEADER_FINGERPRINT_DETECTOR_ID}#partial`,
        note: `header region present but fixed marker 0x96 missing (got 0x${f.observedByte.toString(16).padStart(2, '0').toUpperCase()})`,
      });

      return makePartial<HeaderPartialPayload>({
        confidence: 0.4,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `fixed-marker byte at offset 0x${HEADER_FIELD.fixedMarkerOffset.toString(16).toUpperCase()} was 0x${f.observedByte.toString(16).padStart(2, '0').toUpperCase()} (expected 0x96)`,
            weight: 1.0,
            detail: { observed: f.observedByte, expected: 0x96 },
          }),
        ],
        data: {
          observedMarkerByte: f.observedByte,
          expectedMarkerByte: f.expectedByte,
          probableGameCode,
        },
        partialReason:
          'GBA cartridge header is present but the Nintendo 0x96 sanity-check marker is wrong - the cart bytes are likely corrupted or this is not a real GBA ROM',
      });
    }

    // game_code_unreadable
    return makeNotDetected({
      confidence: 0.7,
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `game-code field at offset 0x${HEADER_FIELD.gameCodeOffset.toString(16).toUpperCase()} contains non-printable bytes [${f.bytesAtOffset.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`,
          weight: 1.0,
          detail: { bytesAtOffset: f.bytesAtOffset, offset: HEADER_FIELD.gameCodeOffset },
        }),
      ],
      reason:
        'GBA cartridge header is present but the game-code field is not printable ASCII - header is malformed',
    });
  },
};
