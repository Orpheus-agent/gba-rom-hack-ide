import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  CoverageSummary,
  DetectedSubsystem,
  RomBinaryStats,
  RomCartridgeHeader,
  RomStructure,
} from '@rom-editor/shared';
import type { ProjectDetector, DetectorResult } from './types.js';
// PD 13 migration (UW-0-T2 + UW-0-T7): rom-header parsing AND species-name
// reading now route through the canonical engine modules
// (`@rom-introspection/engine` → `rom` + `species` namespaces). The editor's
// legacy `lib/rom-header.ts` and `rom-binary/*` modules are
// `legacy-pending-removal`. Engine species_names detector (UW-0-T6 / iter 59)
// replaces the editor's signature scanner with universal heuristic detection;
// engine text codec (UW-0-T4 / iter 57) replaces the editor's text-codec.
import {
  detection as engineDetection,
  identity as engineIdentity,
  rom as engineRom,
  species as engineSpecies,
} from '@rom-introspection/engine';
import { scanRomStructure } from '../engine-client.js';
import { readOpLogTail } from '../events/op-log.js';

const PATCH_EXTS = new Set(['.ips', '.ups', '.bps']);
const ROM_EXTS = new Set(['.gba']);
const HEADER_PEEK_BYTES = 0xc0;

/** Modernize-and-Ship slice 5 - the canonical vanilla FireRed USA
 *  rev-0 SHA-1. Set on ProjectIdentity.upgradeOffer when the ROM
 *  matches, so the frontend can render the "Modernize" card. */
const VANILLA_FRLG_USA_REV0_SHA1 = '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc';

/** Phase 6.2 - walks the project's op-log looking for a `modernize_rom`
 *  entry whose post-apply SHA-1 matches the currently-loaded ROM.
 *  Strongest possible evidence that the editor's own modernize flow
 *  produced this ROM, which lets the vanilla-truth overlay assert
 *  real labels with confidence (every offset unchanged by the patch
 *  is still vanilla FRLG).
 *
 *  Returns the `bundleId` from the matched entry (`'cfru'` or `'dpe'`)
 *  or `null` if no matching entry exists. Errors reading the op-log
 *  are swallowed - the overlay simply won't activate, which is the
 *  same outcome as not finding a match. */
async function findModernizeTrustSignal(
  projectRoot: string,
  romSha1: string,
): Promise<'cfru' | 'dpe' | null> {
  try {
    // readOpLogTail returns entries newest-first; we want the most
    // recent modernize_rom matching this SHA-1.
    const { entries } = await readOpLogTail(projectRoot, 500);
    for (const entry of entries) {
      if (entry.op !== 'modernize_rom') continue;
      const payload = entry.payload as { newSha1?: unknown; bundleId?: unknown };
      if (payload.newSha1 !== romSha1) continue;
      // Pre-Phase-6.2 entries don't have bundleId. Fall back to 'cfru'
      // so legacy modernised ROMs still light up the overlay (CFRU is
      // the conservative default - overlay-safe either way).
      if (payload.bundleId === 'dpe' || payload.bundleId === 'cfru') {
        return payload.bundleId;
      }
      return 'cfru';
    }
  } catch {
    /* op-log missing or corrupt - no trust signal */
  }
  return null;
}

async function listFilesShallow(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function peekGbaHeader(filePath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(HEADER_PEEK_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_PEEK_BYTES, 0);
    // Files shorter than a full header aren't real ROMs - they're stub
    // fixtures or scratch files. Skip header parsing entirely so we don't
    // warn about every test-only .gba placeholder.
    if (bytesRead < HEADER_PEEK_BYTES) return null;
    return buf;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export const patchDetector: ProjectDetector = {
  kind: 'patch',
  name: 'PatchDetector',
  async detect(projectRoot: string): Promise<DetectorResult> {
    const evidence: string[] = [];
    const warnings: string[] = [];
    let patchCount = 0;
    let romCount = 0;
    let firstRomName: string | null = null;
    let baseGame: string | null = null;

    const rootFiles = await listFilesShallow(projectRoot);
    for (const name of rootFiles) {
      const ext = path.extname(name).toLowerCase();
      if (PATCH_EXTS.has(ext)) {
        patchCount++;
        evidence.push(name);
      }
      if (ROM_EXTS.has(ext)) {
        romCount++;
        evidence.push(name);
        if (!firstRomName) firstRomName = name;
      }
    }

    for (const sub of ['patches', 'patch']) {
      const subFiles = await listFilesShallow(path.join(projectRoot, sub));
      for (const name of subFiles) {
        const ext = path.extname(name).toLowerCase();
        if (PATCH_EXTS.has(ext)) {
          patchCount++;
          evidence.push(`${sub}/${name}`);
        }
      }
    }

    // Read the GBA cartridge header from the first ROM (if any) and surface
    // it in the evidence list. For known game codes (BPRE / AXVE / etc) the
    // baseGame is set so the IdentityCard surfaces e.g. "Pokémon FireRed".
    let romBinary: RomBinaryStats | undefined = undefined;
    let romHeader: RomCartridgeHeader | undefined = undefined;
    let romStructure: RomStructure | undefined = undefined;
    let detectedSubsystems: ReadonlyArray<DetectedSubsystem> | undefined = undefined;
    let coverageSummary: CoverageSummary | undefined = undefined;
    // RT-1.3: per-hack identity lookup. When non-null, overrides the
    // generic "Bare ROM workspace" / GBA-header-only fallback name.
    let hackFingerprint: engineIdentity.HackFingerprint | null = null;
    let romSha1: string | null = null;
    if (firstRomName) {
      const bytes = await peekGbaHeader(path.join(projectRoot, firstRomName));
      if (bytes) {
        const header = engineRom.readGbaHeader(bytes);
        if (header) {
          const displayString = engineRom.describeGbaHeader(header);
          evidence.push(`ROM header: ${displayString}`);
          if (header.knownGame) baseGame = header.knownGame;
          // UW-1-T3: surface the parsed engine header as a structured
          // ProjectIdentity.romHeader field so the IdentityCard can
          // render game code / title / maker / version / known-game
          // visually instead of as a raw evidence string.
          romHeader = {
            internalTitle: header.internalTitle,
            gameCode: header.gameCode,
            makerCode: header.makerCode,
            softwareVersion: header.softwareVersion,
            knownGame: header.knownGame,
            displayString,
          };

          // Read the full ROM + locate well-known data tables via the
          // engine's universal heuristic detectors (PD 5 / PD 13). The
          // engine's `findSpeciesNamesTable` signature-scans for the
          // canonical BULBASAUR/IVYSAUR pair at 11-byte stride and
          // works on hacks that have relocated the table (vanilla
          // offsets aren't baked). Loading the whole ROM is fine:
          // GBA carts cap at 32 MB and the buffer drops after this
          // block returns.
          try {
            const fullBytes = await fsp.readFile(path.join(projectRoot, firstRomName));
            // RT-1.3 - compute SHA-1 of the full ROM. Vanilla FRLG +
            // FRLG-based hacks (Unbound, Radical Red, etc.) all carry
            // the same GBA header bytes, so SHA-1 is the only universal
            // discriminator. The lookup table maps known hashes to
            // {displayName, baseGame, family} for the editor + agent.
            romSha1 = createHash('sha1').update(fullBytes).digest('hex');
            hackFingerprint = engineIdentity.lookupHackFingerprint(romSha1);
            if (hackFingerprint) {
              evidence.push(
                `Identity fingerprint matched: ${hackFingerprint.displayName} [SHA-1 ${romSha1.slice(0, 12)}…]`,
              );
            } else {
              evidence.push(
                `Unknown ROM SHA-1: ${romSha1} (no hack fingerprint matched; trying heuristic detection)`,
              );
              // Modernize-and-Ship slice 5 - if the SHA-1 is unknown
              // but the ROM has CFRU-shaped code inserted, synthesize
              // a fingerprint so the editor still recognizes it as a
              // modernized FRLG. False positives are conservative
              // (header + size + probe-window match all required).
              const heuristic = engineDetection.detectCfruHeuristic(fullBytes);
              if (heuristic.matched) {
                hackFingerprint = {
                  displayName: 'FireRed (Modernized) - custom build',
                  baseGame: 'Pokémon FireRed',
                  family: 'frlg-hack',
                  notes: `Detected via heuristic at offset 0x${heuristic.buildOffset!.toString(16)} - SHA-1 ${romSha1.slice(0, 12)}… not in fingerprint table.`,
                };
                for (const item of heuristic.evidence) {
                  evidence.push(`CFRU heuristic: ${item}`);
                }
              }
            }
            // UW-1-T4: lightweight structural scan via the engine's
            // pointer-network + compression-format detectors. Adds
            // ~500ms-1s on a 16 MiB ROM; one-time per project-open.
            try {
              const struct = await scanRomStructure({
                romBytes: fullBytes,
                sourcePath: path.join(projectRoot, firstRomName),
              });
              romStructure = {
                memoryLayout: struct.memoryLayout,
                pointerTables: struct.pointerTables,
                compressionRegions: struct.compressionRegions,
              };
              // UW-2-T6 iter 72: surface the 5 subsystem detector
              // summaries (save / moves / type-chart / items /
              // abilities) so the IdentityCard can render them as
              // first-class cards instead of hiding them behind the
              // full scanProject pass. PD 13: derived from engine
              // WorkspaceFeatureDetection - no editor-side detection.
              detectedSubsystems = struct.detectedSubsystems;
              // UW-2-T14 iter 80: lift coverage summary into the
              // ProjectIdentity for the IdentityCard's UnknownsPolicySection.
              coverageSummary = struct.coverageSummary;
            } catch (structErr) {
              warnings.push(
                `ROM structure scan failed: ${
                  structErr instanceof Error ? structErr.message : String(structErr)
                }`,
              );
            }
            const tableOffset = engineSpecies.findSpeciesNamesTable(fullBytes);
            if (tableOffset !== null) {
              // `measureSpeciesNamesTable` walks slot-by-slot with the
              // byte-level validator and returns the table's true
              // length in slots - (max species ID + 1), matching
              // CFRU's `NUM_SPECIES` macro. Vanilla FRLG = 412 slots;
              // CFRU stock = 1294; Radical Red 4.10 = 1376. The
              // previous "filter trimmed non-empty from 1024 slots"
              // approach over-counted vanilla to ~744 and
              // under-counted CFRU to ~412 (it stopped at the vanilla
              // dex slot range because CFRU keeps the BULBASAUR
              // signature at the original offset and re-uses the same
              // pointer-at-0x144 slot to point at the extended table).
              const shape = engineSpecies.measureSpeciesNamesTable(fullBytes, tableOffset);
              const totalSlots = shape.totalSlotCount;
              const sampleNames = engineSpecies.readSpeciesNamesAt(
                fullBytes,
                tableOffset,
                totalSlots,
              );
              if (engineSpecies.validateSpeciesNames(sampleNames)) {
                // `speciesCount` for display: exclude slot 0
                // placeholder so "1267 species" lines up with CFRU's
                // human-facing `SPECIES_URSHIFU_RAPID_GIGA = 0x50D`
                // ("max species ID is 1293, table length is 1294,
                // species count is 1293"). Vanilla → 411; CFRU
                // stock → 1293; Radical Red → 1375.
                const speciesCount = Math.max(0, totalSlots - 1);
                // Preview drops the slot-0 placeholder and any
                // embedded placeholder rows for a cleaner UI sample.
                const preview = sampleNames
                  .slice(1)
                  .filter((n) => n.length > 0 && n.trim().length > 0 && !/^\?+$/.test(n))
                  .slice(0, 24);
                romBinary = {
                  // The engine doesn't expose a per-version variant
                  // identifier (BPRE_1.0 vs 1.1) - the universal path
                  // intentionally avoids baked version-offset tables
                  // per PD 4/PD 5. The familyVerdict (set during full
                  // ingest) provides the equivalent "Pokémon FireRed"
                  // label.
                  variant: null,
                  variantDisplayName: null,
                  speciesSource: 'signature_scan',
                  speciesCount,
                  speciesPreview: preview,
                };
                evidence.push(
                  `ROM binary: ${speciesCount} Pokémon species (${shape.nameSlotCount} named, ${shape.placeholderSlotCount} placeholders) decoded via engine signature scan @ 0x${tableOffset.toString(16)}`,
                );
              } else {
                // Signature found but validation rejected - likely a
                // false positive (incidental BULBASAUR-shaped bytes).
                romBinary = {
                  variant: null,
                  variantDisplayName: null,
                  speciesSource: 'none',
                  speciesCount: 0,
                  speciesPreview: [],
                };
              }
            } else {
              // No species table located - vanilla offsets not present
              // OR a ROM that has fundamentally rewritten the species
              // engine (rare).
              romBinary = {
                variant: null,
                variantDisplayName: null,
                speciesSource: 'none',
                speciesCount: 0,
                speciesPreview: [],
              };
            }
          } catch (e) {
            warnings.push(
              `Could not read ${firstRomName} for binary inspection: ${(e as Error).message}`,
            );
          }
        } else {
          warnings.push(
            `Found ${firstRomName} but its first ${HEADER_PEEK_BYTES} bytes don't parse as a GBA cartridge header - the file may be corrupted or not a real .gba ROM.`,
          );
        }
      }
    }

    // Scoring. A single .gba alone is intentionally classified as a patch
    // project (kind=patch, confidence ≥ 0.4) because that IS the canonical
    // shape of a fresh patch workspace - base ROM ready, patches to follow.
    // Threshold for kind selection is 0.4 in detect/index.ts.
    let score = 0;
    if (patchCount > 0) score += 0.5;
    if (romCount > 0) score += 0.4;
    if (patchCount > 0 && romCount > 0) score += 0.2;
    const confidence = Math.min(1, score);

    if (patchCount > 0 && romCount === 0) {
      warnings.push(
        'Patch file(s) detected but no .gba base ROM is present in the workspace. You will need to supply a base ROM to build the patched output.',
      );
    }
    if (romCount > 0 && patchCount === 0) {
      warnings.push(
        'A .gba file is present but no patch files (.ips/.ups/.bps) were found - this is a bare-ROM workspace. You can apply patches to it or use it as a base ROM for new patches.',
      );
    }

    // RT-1.3: derive displayName by precedence:
    //   1. Hack fingerprint match (SHA-1 → known hack/version name)
    //   2. Patch-project shape ("Patch project (3 patches + base ROM)")
    //   3. GBA-header knownGame (e.g. "Pokémon FireRed")
    //   4. "Bare ROM workspace" generic fallback
    //   5. "Not a patch project" (no ROM, no patches)
    let displayName: string;
    if (hackFingerprint) {
      displayName =
        patchCount > 0
          ? `${hackFingerprint.displayName} (+ ${patchCount} patch file${patchCount === 1 ? '' : 's'})`
          : hackFingerprint.displayName;
      // The fingerprint overrides any generic baseGame the header
      // detector inferred - Unbound/RR's header says "FireRed" but
      // the fingerprint's `baseGame` carries the same canonical name.
      baseGame = hackFingerprint.baseGame;
    } else if (patchCount > 0) {
      displayName = `Patch project (${patchCount} patch file${patchCount === 1 ? '' : 's'}${romCount > 0 ? ' + base ROM' : ''})`;
    } else if (romCount > 0 && romHeader?.knownGame) {
      displayName = romHeader.knownGame;
    } else if (romCount > 0) {
      displayName = 'Bare ROM workspace';
    } else {
      displayName = 'Not a patch project';
    }

    // Modernize-and-Ship slice 5 + Phase 5.4 - derive the fork tag
    // and upgradeOffer signal from the detection state. `fork` lights
    // up the per-fork symbol DB (firered-cfru / firered-cfru-dpe) so
    // the agent + inspectors get plain-English names. `upgradeOffer`
    // tells the frontend's ModernizeCard whether to surface the
    // one-click upgrade.
    //
    // DPE check first since DPE bundles always carry "Gen 9 species"
    // in their displayName (set by build-cfru-bundle-with-dpe.mjs).
    let fork: string | null = null;
    if (
      hackFingerprint &&
      /Gen 9|Gen-9|DPE|Dynamic Pokemon Expansion/i.test(hackFingerprint.displayName)
    ) {
      fork = 'CFRU+DPE';
    } else if (
      hackFingerprint &&
      /FireRed \(Modernized\)|CFRU/i.test(hackFingerprint.displayName)
    ) {
      fork = 'CFRU';
    }
    const upgradeOffer: 'vanilla-frlg-rev0' | null =
      romSha1 === VANILLA_FRLG_USA_REV0_SHA1 ? 'vanilla-frlg-rev0' : null;

    // Phase 6.2 - overlaySafe + modernizedBy. Two sources of trust,
    // either of which is sufficient:
    //   1. Op-log proof: a `modernize_rom` entry whose newSha1 matches
    //      the currently-loaded ROM. This is the strongest signal - 
    //      we ran the modernise flow ourselves and recorded what
    //      bundle was applied.
    //   2. Fingerprint match: the hackFingerprint table has an entry
    //      for this exact SHA-1 that we recognise as one of OUR
    //      bundle outputs (the displayName starts with "FireRed
    //      (Modernized)" - set by the bundle script).
    // If neither matches, modernizedBy stays null and overlaySafe
    // stays false; the displayName overlay layer (Phase 6.5) refuses
    // to assert vanilla labels.
    let modernizedBy: 'CFRU' | 'CFRU+DPE' | null = null;
    if (romSha1) {
      const opLogBundle = await findModernizeTrustSignal(projectRoot, romSha1);
      if (opLogBundle === 'dpe') {
        modernizedBy = 'CFRU+DPE';
      } else if (opLogBundle === 'cfru') {
        modernizedBy = 'CFRU';
      }
    }
    if (!modernizedBy && fork === 'CFRU+DPE') {
      modernizedBy = 'CFRU+DPE';
    } else if (!modernizedBy && fork === 'CFRU') {
      modernizedBy = 'CFRU';
    }
    const overlaySafe = modernizedBy !== null;

    return {
      confidence,
      displayName,
      baseGame,
      fork,
      featureFlags: [],
      warnings,
      evidence,
      ...(upgradeOffer ? { upgradeOffer } : {}),
      ...(modernizedBy ? { modernizedBy } : {}),
      ...(overlaySafe ? { overlaySafe } : {}),
      ...(romBinary ? { romBinary } : {}),
      ...(romHeader ? { romHeader } : {}),
      ...(romStructure ? { romStructure } : {}),
      ...(detectedSubsystems ? { detectedSubsystems } : {}),
      ...(coverageSummary ? { coverageSummary } : {}),
    };
  },
};
