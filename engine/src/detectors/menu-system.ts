/**
 * Gen-3 menu-system detector - Phase UW-2 / Category 11 substrate
 * (iter 77 / UW-2-T11).
 *
 * Detects the Gen-3 menu engine by scanning for canonical main-menu /
 * pause-menu / submenu prompt strings encoded in the Gen-3 charset
 * (CONTINUE, NEW GAME, OPTION, PLAYER, EXIT, etc.). Per
 * `engine/src/menus/menu-strings.ts` the scanner returns every matched
 * string with its first-occurrence offset and total occurrence count.
 *
 * Per PD 5: signature-driven; the prompt strings are universal across
 * every Gen-3 Pokémon ROM that retains pret's menu prompt text (every
 * known FRLG / Emerald / Ruby / Sapphire derivative including CFRU +
 * Unbound + Radical Red).
 *
 * Per PD 1: typed `not_detected` when ROM too small OR fewer than
 * MENU_PROMPT_MIN_MATCHES (3) distinct strings found.
 *
 * Per PD 12: returns ALL matched prompts via the `matches` array - no
 * silent absorption.
 *
 * Advances:
 *   - Category 11 (UI / menus / player-facing systems) - first
 *     concrete menu detector; flips engine status missing → partial.
 *     Cat 11 was at 5% (engine:missing) since the start of the
 *     universal-workspace master. After this iter, only Cat 8
 *     (graphics) remains engine:missing.
 */

import { makeDetected, makeEvidence, makeNotDetected } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import {
  MENU_PROMPT_MIN_MATCHES,
  MENU_PROMPT_STRINGS,
  scanMenuPromptStrings,
  type MenuPromptMatch,
} from '../menus/index.js';

export const MENU_SYSTEM_DETECTOR_ID = 'menu_system';

export interface MenuSystemReport {
  /** Total number of DISTINCT prompt strings matched. */
  readonly matchedPromptCount: number;
  /** Total occurrences summed across all matched prompts. */
  readonly totalOccurrenceCount: number;
  /** All matched prompts with their first-occurrence offset + count. */
  readonly matches: ReadonlyArray<MenuPromptMatch>;
  /** First matched prompt text for at-a-glance editor display. */
  readonly primaryPrompt: string;
  /** First matched prompt's offset for coverage anchoring. */
  readonly primaryOffset: number;
}

export const menuSystemDetector: RomDetector<MenuSystemReport> = {
  id: MENU_SYSTEM_DETECTOR_ID,
  name: 'Menu System (Gen-3 main/pause-menu prompt scan)',
  phase: 8,
  detect(rom: RomImage, coverage: CoverageMap): Detection<MenuSystemReport> {
    // The shortest prompt is "EXIT" = 4 chars. Need enough room past the
    // header to plausibly contain the string + multiple prompt strings.
    const minBytes = 0xc0 + 64;
    if (rom.byteLength < minBytes) {
      return makeNotDetected({
        confidence: 1.0,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `ROM is ${String(rom.byteLength)} bytes - too small to realistically host Gen-3 menu prompt strings`,
            weight: 1.0,
          }),
        ],
        reason: 'ROM too small to scan for Gen-3 menu prompt strings',
      });
    }

    const matches = scanMenuPromptStrings(rom.bytes);

    if (matches.length < MENU_PROMPT_MIN_MATCHES) {
      return makeNotDetected({
        confidence: 0.85,
        evidence: [
          makeEvidence({
            kind: 'heuristic',
            summary: `scanned ${String(rom.byteLength)} bytes for ${String(MENU_PROMPT_STRINGS.length)} canonical Gen-3 menu prompt strings - found only ${String(matches.length)} (need ≥${String(MENU_PROMPT_MIN_MATCHES)} for confident detection)`,
            weight: 1.0,
            detail: {
              romByteLength: rom.byteLength,
              candidateStrings: MENU_PROMPT_STRINGS,
              foundMatches: matches.map((m) => m.text),
            },
          }),
        ],
        reason:
          'Fewer than 3 canonical Gen-3 menu prompt strings found - ROM may be non-Pokémon, may have replaced the main-menu text wholesale, or may be a tiny test fixture',
      });
    }

    const primary = matches[0]!;

    // Register coverage at the primary match (the full menu engine
    // spans many KB scattered across .rodata; we only register the
    // anchor string here for traceability - the pointer-network
    // detector covers the bulk).
    try {
      coverage.addClassified({
        start: primary.firstOffset,
        end: primary.firstOffset + Buffer.from(primary.text).byteLength,
        probableClass: 'string',
        score: 0.92,
        provenance: `${MENU_SYSTEM_DETECTOR_ID}#${primary.text}`,
        note: `Gen-3 menu prompt "${primary.text}" - anchor for menu-system detection`,
      });
    } catch {
      // Overlap with another detector - skip but keep detecting.
    }

    const totalOccurrenceCount = matches.reduce(
      (sum, m) => sum + m.occurrenceCount,
      0,
    );

    // Confidence: more distinct prompt strings found = higher confidence.
    // ≥6 distinct prompts = vanilla-level coverage = 0.95.
    // ≥4 distinct prompts = strong match = 0.92.
    // ≥3 distinct prompts (threshold) = baseline detected = 0.88.
    const confidence =
      matches.length >= 6 ? 0.95 : matches.length >= 4 ? 0.92 : 0.88;

    return makeDetected({
      confidence,
      data: Object.freeze({
        matchedPromptCount: matches.length,
        totalOccurrenceCount,
        matches: Object.freeze(matches),
        primaryPrompt: primary.text,
        primaryOffset: primary.firstOffset,
      }),
      evidence: [
        makeEvidence({
          kind: 'heuristic',
          summary: `Found ${String(matches.length)} distinct Gen-3 menu prompt strings (${String(totalOccurrenceCount)} total occurrences); primary "${primary.text}" at offset 0x${primary.firstOffset.toString(16)}`,
          weight: 1.0,
          detail: {
            matchedPromptCount: matches.length,
            totalOccurrenceCount,
            matchedPromptTexts: matches.map((m) => m.text),
            primaryOffset: primary.firstOffset,
          },
        }),
      ],
    });
  },
};
