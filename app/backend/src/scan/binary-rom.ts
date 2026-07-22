/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  BINARY ROM SCANNER - runs the FULL engine ingest pipeline on    ║
 * ║  a `.gba` file and lifts every detector's structured output into ║
 * ║  the canonical ProjectManifest (iter 92 / UW-3-T11).             ║
 * ║                                                                  ║
 * ║  Replaces the NoOpScanner branch for patch (bare-ROM) projects.  ║
 * ║  Before iter 92 the editor showed "0 maps, 0 events, 0 dialogue, ║
 * ║  0 trainers, 0 assets" on every FireRed open - purely because    ║
 * ║  no scanner mapped engine detector output into manifest          ║
 * ║  collections. This module is that mapping.                       ║
 * ║                                                                  ║
 * ║  ARCHITECTURE - designed to grow with detection capability:      ║
 * ║                                                                  ║
 * ║    1. Scanner runs `runEngineOnRom()` (PD 13 single-source-of-   ║
 * ║       truth conduit) which executes the FULL                     ║
 * ║       `buildDefaultDetectorSet()` pipeline - currently 30        ║
 * ║       detectors and growing.                                     ║
 * ║                                                                  ║
 * ║    2. For each detector, looks up a lifter in                    ║
 * ║       `binary-rom-registry.ts`. Registered lifters translate     ║
 * ║       structured output into manifest collections (maps[],       ║
 * ║       trainers[], dialogue[], encounterTables[], assets[],      ║
 * ║       flags[], variables[]). Unregistered detectors still get   ║
 * ║       surfaced via the universal `binaryRom.subsystems[]`        ║
 * ║       channel (PD 12 - no dead zones).                           ║
 * ║                                                                  ║
 * ║    3. Coverage totals are lifted directly from the engine's      ║
 * ║       IngestReport.coverage so the editor's UnknownsPolicy       ║
 * ║       surface reflects the FULL ingest (not the lightweight      ║
 * ║       project-open scan).                                        ║
 * ║                                                                  ║
 * ║  PROMISE TO FUTURE-ME: when a new detector lands in              ║
 * ║  buildDefaultDetectorSet(), this scanner picks it up             ║
 * ║  automatically. The only optional work is registering a lifter   ║
 * ║  if the new detector's output should populate a standard         ║
 * ║  manifest collection. Otherwise the new detector flows through   ║
 * ║  binaryRom.subsystems[] without code changes here.               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AbilityEntry,
  Asset,
  BattleMoveEntry,
  BinaryRomScanReport,
  BinaryRomScanSubsystem,
  CoverageScoredUnknownRegion,
  CoverageSummary,
  DialogueNode,
  EncounterTable,
  ExperienceCurveEntry,
  Flag,
  ItemEntry,
  MapNode,
  MenuEntry,
  MoveNameEntry,
  ObjectEvent,
  ObjectEventPaletteEntry,
  OverworldSpriteEntry,
  TilesetEntry,
  PokedexEntryRecord,
  ProjectIdentity,
  ProjectManifest,
  RegionMapSectionEntry,
  MultichoiceListRecord,
  HealLocationEntry,
  SaveBlockEntry,
  ScriptStep,
  SpeciesEntry,
  SpeciesEvolutionEntry,
  SpeciesLearnsetEntry,
  SpeciesNameEntry,
  SpeciesTMHMEntry,
  Trainer,
  TrainerClassNameEntry,
  Trigger,
  TypeMatchupEntry,
  TypeNameEntry,
  Variable,
  Warp,
} from '@rom-editor/shared';
import { runEngineOnRom } from '../engine-client.js';
import {
  LIFTER_REGISTRY,
  crossReferenceLiftedEntries,
  decodeBinaryScriptsForLiftedEntities,
  getLifter,
  type LifterContext,
} from './binary-rom-registry.js';
import type { ProjectScanner, ScanResult } from './types.js';

const SCANNER_NAME = 'BinaryRomScanner';

/** Find the first `.gba` file in a project root (shallow search).
 *  Exported so per-tile / per-asset routes can resolve the same ROM. */
export async function findFirstGbaFile(projectRoot: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return path.join(projectRoot, e.name);
      }
    }
  } catch {
    // Directory unreadable - caller handles via empty manifest path.
  }
  return null;
}

/** Build the top-N scored-unknown region list from the engine's
 *  CoverageReport for surfacing in the editor's UnknownsPolicy view. */
function buildScoredUnknownRegions(
  regions: ReadonlyArray<{
    kind: string;
    start: number;
    end: number;
    score?: number | null;
    probableClass?: string;
    provenance?: string | null;
    note?: string | null;
  }>,
  topN: number,
): ReadonlyArray<CoverageScoredUnknownRegion> {
  const scored = regions.filter((r) => r.kind === 'unknown_scored');
  scored.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  return scored.slice(0, topN).map((r) => ({
    start: r.start,
    end: r.end,
    sizeBytes: r.end - r.start,
    score: typeof r.score === 'number' ? r.score : 0,
    provenance: r.provenance ?? r.probableClass ?? 'unknown',
    ...(r.note != null && r.note !== '' ? { note: r.note } : {}),
  }));
}

export const binaryRomScanner: ProjectScanner = {
  name: SCANNER_NAME,
  supports(identity: ProjectIdentity): boolean {
    // Patch projects (bare ROMs) get the binary scanner. Hybrid projects
    // (decomp + ROM) prefer the decomp scanner; pure decomp uses
    // decompScanner. Unknown projects are left to NoOpScanner since we
    // can't be sure a .gba is present.
    return identity.kind === 'patch';
  },
  async scan(projectRoot: string, identity: ProjectIdentity): Promise<ScanResult> {
    const warnings: string[] = [];
    const romPath = await findFirstGbaFile(projectRoot);
    if (romPath === null) {
      warnings.push(
        'BinaryRomScanner: no .gba file found in the project root. ' +
          'The manifest is empty; drop a .gba into the project to scan.',
      );
      return {
        manifest: makeEmptyManifest(projectRoot, identity),
        scannerName: SCANNER_NAME,
        warnings,
      };
    }

    const romBytes = await fsp.readFile(romPath);
    const startedAt = Date.now();
    const { ingestReport: report } = await runEngineOnRom({
      romBytes,
      sourcePath: romPath,
      synthetic: false,
    });
    const ingestDurationMs = Date.now() - startedAt;

    // Initialize lift accumulator + run every registered lifter.
    const ctx: LifterContext = {
      maps: [],
      warps: [],
      objectEvents: [],
      triggers: [],
      scriptSteps: [],
      dialogue: [],
      flags: [],
      variables: [],
      encounterTables: [],
      trainers: [],
      assets: [],
      speciesNames: [],
      moveNames: [],
      items: [],
      abilities: [],
      pokedexEntries: [],
      trainerClassNames: [],
      typeNames: [],
      typeMatchups: [],
      saveBlocks: [],
      menus: [],
      battleMoves: [],
      experienceCurves: [],
      overworldSprites: [],
      objectEventPalettes: [],
      tilesets: [],
      species: [],
      speciesEvolutions: [],
      speciesLearnsets: [],
      speciesTMHM: [],
      regionMapSections: [],
      multichoiceLists: [],
      healLocations: [],
    };

    let liftedCount = 0;
    const subsystems: BinaryRomScanSubsystem[] = [];
    for (const row of report.detections) {
      const lifter = getLifter(row.detectorId);
      let liftedCollection: string | null = null;
      if (lifter !== null) {
        try {
          liftedCollection = lifter(row, ctx);
        } catch (e) {
          warnings.push(
            `BinaryRomScanner: lifter for detector '${row.detectorId}' threw - ${
              e instanceof Error ? e.message : String(e)
            }. Lift skipped; subsystem still surfaced.`,
          );
        }
        if (liftedCollection !== null) liftedCount++;
      }

      // Lift summary string + sampleNames from the detector's
      // detection result (mirrors the engine-client.ts conduit per
      // PD 13). Use detection-result narrowing so we only read
      // .data.sampleNames on the 'detected' variant.
      let summary: string | null = null;
      let sampleNames: ReadonlyArray<string> | undefined = undefined;
      if (row.detection.status === 'detected') {
        const firstEvidence = row.detection.evidence?.[0];
        if (firstEvidence && typeof firstEvidence.summary === 'string') {
          summary = firstEvidence.summary;
        }
        const data = row.detection.data as unknown;
        if (data && typeof data === 'object') {
          const candidate = (data as { sampleNames?: unknown }).sampleNames;
          if (
            Array.isArray(candidate) &&
            candidate.every((v): v is string => typeof v === 'string')
          ) {
            sampleNames = candidate;
          }
        }
      } else if (
        row.detection.status === 'partial' ||
        row.detection.status === 'not_detected'
      ) {
        const firstEvidence = row.detection.evidence?.[0];
        if (firstEvidence && typeof firstEvidence.summary === 'string') {
          summary = firstEvidence.summary;
        }
      }

      subsystems.push({
        id: row.detectorId,
        name: row.detectorName,
        phase: row.phase,
        status: row.detection.status,
        confidence: Number(row.detection.confidence),
        runtimeMs: row.runtimeMs,
        summary,
        ...(sampleNames !== undefined ? { sampleNames } : {}),
        liftedToManifest: liftedCollection !== null,
        liftedCollection,
      });
    }

    // Sort subsystems for stable surface order.
    subsystems.sort((a, b) => {
      if (a.phase !== b.phase) return a.phase - b.phase;
      return a.id.localeCompare(b.id);
    });

    // Iter 96 (UW-3-T15) - cross-reference pass: resolve synthetic
    // `class_N` / `species_N` ids in trainers/encounters/pokedex
    // entries into real decoded strings from speciesNames +
    // trainerClassNames lifters. Runs AFTER per-detector lifters so
    // it can read fully-populated ctx.speciesNames + ctx.trainerClassNames.
    const xrefStats = crossReferenceLiftedEntries(ctx);

    // Phase H-RC1 (semantic-world plan §H.1): decode binary script
    // bytecode for each ObjectEvent that has a scriptOffset. Runs
    // after cross-ref so the steps replace any stub raw scripts.
    // Reads romBytes directly (the cross-ref pass + lifters don't
    // have ROM access).
    const scriptDecodeStats = decodeBinaryScriptsForLiftedEntities(
      ctx,
      new Uint8Array(romBytes),
    );
    if (scriptDecodeStats.scriptsDecoded > 0) {
      warnings.push(
        `BinaryRomScanner script decode: decoded ${String(scriptDecodeStats.scriptsDecoded)} unique scripts → ${String(scriptDecodeStats.stepsEmitted)} ScriptSteps; ${String(scriptDecodeStats.objectEventsWithDecodedScript)} object events now have plain-English step lists.`,
      );
    }
    if (
      xrefStats.trainerClassResolved +
        xrefStats.encounterSpeciesResolved +
        xrefStats.pokedexSpeciesNamed +
        xrefStats.typeMatchupsNamed +
        xrefStats.battleMovesNamed +
        xrefStats.battleMovesTyped +
        xrefStats.objectEventSpritesResolved +
        xrefStats.objectEventSpritesPaletteResolved +
        xrefStats.speciesNamed +
        xrefStats.speciesType1Named +
        xrefStats.speciesType2Named +
        xrefStats.speciesGrowthRateResolved +
        xrefStats.speciesEvolutionTargetsNamed +
        xrefStats.speciesLearnsetMovesNamed +
        xrefStats.speciesAbility1Named +
        xrefStats.speciesAbility2Named +
        xrefStats.trainerPartySpeciesNamed +
        xrefStats.trainerPartyMovesNamed +
        xrefStats.trainerPartyHeldItemsNamed +
        xrefStats.mapsRegionNamed +
        xrefStats.speciesItem1Named +
        xrefStats.speciesItem2Named >
      0
    ) {
      warnings.push(
        `BinaryRomScanner cross-ref: resolved ${String(xrefStats.trainerClassResolved)} trainer classes, ${String(xrefStats.encounterSpeciesResolved)} encounter species, ${String(xrefStats.pokedexSpeciesNamed)} pokedex species names, ${String(xrefStats.typeMatchupsNamed)} type matchup names, ${String(xrefStats.battleMovesNamed)} battle-move names, ${String(xrefStats.battleMovesTyped)} battle-move types, ${String(xrefStats.objectEventSpritesResolved)} object-event sprites (${String(xrefStats.objectEventSpritesPaletteResolved)} colored), ${String(xrefStats.speciesNamed)} species names, ${String(xrefStats.speciesType1Named)} species type1 names, ${String(xrefStats.speciesType2Named)} species type2 names, ${String(xrefStats.speciesGrowthRateResolved)} species growth rates, ${String(xrefStats.speciesEvolutionTargetsNamed)} evolution target names, ${String(xrefStats.speciesLearnsetMovesNamed)} learnset move names, ${String(xrefStats.speciesAbility1Named)} species ability1 names, ${String(xrefStats.speciesAbility2Named)} species ability2 names, ${String(xrefStats.trainerPartySpeciesNamed)} trainer-party species, ${String(xrefStats.trainerPartyMovesNamed)} trainer-party moves, ${String(xrefStats.trainerPartyHeldItemsNamed)} trainer-party held items, ${String(xrefStats.mapsRegionNamed)} maps named from regions, ${String(xrefStats.speciesItem1Named)} species item1 names, ${String(xrefStats.speciesItem2Named)} species item2 names from cross-detector lookup tables.`,
      );
    }

    const coverageSummary: CoverageSummary = {
      romSize: report.rom.byteLength,
      classifiedBytes: report.coverage.classifiedBytes,
      unknownScoredBytes: report.coverage.unknownScoredBytes,
      unaccountedBytes: report.coverage.unaccountedBytes,
      classifiedPct:
        report.rom.byteLength > 0
          ? (report.coverage.classifiedBytes / report.rom.byteLength) * 100
          : 0,
      unknownScoredPct:
        report.rom.byteLength > 0
          ? (report.coverage.unknownScoredBytes / report.rom.byteLength) * 100
          : 0,
      unaccountedPct:
        report.rom.byteLength > 0
          ? (report.coverage.unaccountedBytes / report.rom.byteLength) * 100
          : 0,
      regionCount: report.coverage.regions.length,
      topScoredUnknownRegions: buildScoredUnknownRegions(report.coverage.regions, 5),
    };

    const binaryRom: BinaryRomScanReport = {
      romSha1: report.rom.sha1,
      romByteLength: report.rom.byteLength,
      sourcePath: report.rom.sourcePath ?? romPath,
      detectorCount: report.detections.length,
      detectedCount: report.summary.detectedCount,
      partialCount: report.summary.partialCount,
      notDetectedCount: report.summary.notDetectedCount,
      liftedCount,
      coverageSummary,
      subsystems: Object.freeze(subsystems),
      ingestDurationMs,
    };

    const manifest: ProjectManifest = {
      schemaVersion: 1,
      generatedAtUtc: new Date().toISOString(),
      projectRoot,
      identity,
      buildProfile: null,
      maps: Object.freeze(ctx.maps) as ReadonlyArray<MapNode>,
      warps: Object.freeze(ctx.warps) as ReadonlyArray<Warp>,
      triggers: Object.freeze(ctx.triggers) as ReadonlyArray<Trigger>,
      objectEvents: Object.freeze(ctx.objectEvents) as ReadonlyArray<ObjectEvent>,
      dialogue: Object.freeze(ctx.dialogue) as ReadonlyArray<DialogueNode>,
      flags: Object.freeze(ctx.flags) as ReadonlyArray<Flag>,
      variables: Object.freeze(ctx.variables) as ReadonlyArray<Variable>,
      encounterTables: Object.freeze(ctx.encounterTables) as ReadonlyArray<EncounterTable>,
      trainers: Object.freeze(ctx.trainers) as ReadonlyArray<Trainer>,
      scriptSteps: Object.freeze(ctx.scriptSteps) as ReadonlyArray<ScriptStep>,
      assets: Object.freeze(ctx.assets) as ReadonlyArray<Asset>,
      binaryRom,
      // Iter 94 (UW-3-T13) - new manifest collections from extended
      // lifters. Spread as optional fields so the decompScanner path
      // continues to omit them (kept manifest backward-compat).
      ...(ctx.speciesNames.length > 0
        ? { speciesNames: Object.freeze(ctx.speciesNames) as ReadonlyArray<SpeciesNameEntry> }
        : {}),
      ...(ctx.moveNames.length > 0
        ? { moveNames: Object.freeze(ctx.moveNames) as ReadonlyArray<MoveNameEntry> }
        : {}),
      ...(ctx.items.length > 0
        ? { items: Object.freeze(ctx.items) as ReadonlyArray<ItemEntry> }
        : {}),
      ...(ctx.abilities.length > 0
        ? { abilities: Object.freeze(ctx.abilities) as ReadonlyArray<AbilityEntry> }
        : {}),
      ...(ctx.pokedexEntries.length > 0
        ? {
            pokedexEntries: Object.freeze(
              ctx.pokedexEntries,
            ) as ReadonlyArray<PokedexEntryRecord>,
          }
        : {}),
      ...(ctx.trainerClassNames.length > 0
        ? {
            trainerClassNames: Object.freeze(
              ctx.trainerClassNames,
            ) as ReadonlyArray<TrainerClassNameEntry>,
          }
        : {}),
      ...(ctx.typeNames.length > 0
        ? { typeNames: Object.freeze(ctx.typeNames) as ReadonlyArray<TypeNameEntry> }
        : {}),
      ...(ctx.typeMatchups.length > 0
        ? {
            typeMatchups: Object.freeze(
              ctx.typeMatchups,
            ) as ReadonlyArray<TypeMatchupEntry>,
          }
        : {}),
      ...(ctx.saveBlocks.length > 0
        ? { saveBlocks: Object.freeze(ctx.saveBlocks) as ReadonlyArray<SaveBlockEntry> }
        : {}),
      ...(ctx.menus.length > 0
        ? { menus: Object.freeze(ctx.menus) as ReadonlyArray<MenuEntry> }
        : {}),
      ...(ctx.battleMoves.length > 0
        ? {
            battleMoves: Object.freeze(
              ctx.battleMoves,
            ) as ReadonlyArray<BattleMoveEntry>,
          }
        : {}),
      ...(ctx.experienceCurves.length > 0
        ? {
            experienceCurves: Object.freeze(
              ctx.experienceCurves,
            ) as ReadonlyArray<ExperienceCurveEntry>,
          }
        : {}),
      ...(ctx.overworldSprites.length > 0
        ? {
            overworldSprites: Object.freeze(
              ctx.overworldSprites,
            ) as ReadonlyArray<OverworldSpriteEntry>,
          }
        : {}),
      ...(ctx.objectEventPalettes.length > 0
        ? {
            objectEventPalettes: Object.freeze(
              ctx.objectEventPalettes,
            ) as ReadonlyArray<ObjectEventPaletteEntry>,
          }
        : {}),
      ...(ctx.tilesets.length > 0
        ? {
            tilesets: Object.freeze(ctx.tilesets) as ReadonlyArray<TilesetEntry>,
          }
        : {}),
      ...(ctx.species.length > 0
        ? { species: Object.freeze(ctx.species) as ReadonlyArray<SpeciesEntry> }
        : {}),
      ...(ctx.speciesEvolutions.length > 0
        ? {
            speciesEvolutions: Object.freeze(
              ctx.speciesEvolutions,
            ) as ReadonlyArray<SpeciesEvolutionEntry>,
          }
        : {}),
      ...(ctx.speciesLearnsets.length > 0
        ? {
            speciesLearnsets: Object.freeze(
              ctx.speciesLearnsets,
            ) as ReadonlyArray<SpeciesLearnsetEntry>,
          }
        : {}),
      ...(ctx.speciesTMHM.length > 0
        ? {
            speciesTMHM: Object.freeze(
              ctx.speciesTMHM,
            ) as ReadonlyArray<SpeciesTMHMEntry>,
          }
        : {}),
      ...(ctx.regionMapSections.length > 0
        ? {
            regionMapSections: Object.freeze(
              ctx.regionMapSections,
            ) as ReadonlyArray<RegionMapSectionEntry>,
          }
        : {}),
      ...(ctx.multichoiceLists.length > 0
        ? {
            multichoiceLists: Object.freeze(
              ctx.multichoiceLists,
            ) as ReadonlyArray<MultichoiceListRecord>,
          }
        : {}),
      ...(ctx.healLocations.length > 0
        ? {
            healLocations: Object.freeze(
              ctx.healLocations,
            ) as ReadonlyArray<HealLocationEntry>,
          }
        : {}),
    };

    // Warning surfacing - total entities lifted gives the operator
    // visibility into "how much of the ROM did we lift into the
    // editable manifest vs. how much is detector-only".
    const totalEntities =
      ctx.maps.length +
      ctx.warps.length +
      ctx.objectEvents.length +
      ctx.triggers.length +
      ctx.scriptSteps.length +
      ctx.trainers.length +
      ctx.encounterTables.length +
      ctx.dialogue.length +
      ctx.flags.length +
      ctx.variables.length +
      ctx.assets.length +
      ctx.speciesNames.length +
      ctx.moveNames.length +
      ctx.items.length +
      ctx.abilities.length +
      ctx.pokedexEntries.length +
      ctx.trainerClassNames.length +
      ctx.typeNames.length +
      ctx.typeMatchups.length +
      ctx.saveBlocks.length +
      ctx.menus.length +
      ctx.battleMoves.length +
      ctx.experienceCurves.length +
      ctx.overworldSprites.length +
      ctx.objectEventPalettes.length +
      ctx.tilesets.length +
      ctx.species.length +
      ctx.speciesEvolutions.length +
      ctx.speciesLearnsets.length +
      ctx.speciesTMHM.length +
      ctx.regionMapSections.length +
      ctx.multichoiceLists.length +
      ctx.healLocations.length;
    if (totalEntities === 0) {
      warnings.push(
        `BinaryRomScanner: ran ${String(report.detections.length)} detectors ` +
          `(${String(report.summary.detectedCount)} detected) but no detector produced ` +
          'structured data that the lifter registry could map into standard manifest ' +
          'collections. Every detection is surfaced via binaryRom.subsystems[]. ' +
          'Register more lifters in binary-rom-registry.ts to lift detector output ' +
          'into editable manifest entries.',
      );
    }

    return { manifest, scannerName: SCANNER_NAME, warnings };
  },
};

function makeEmptyManifest(
  projectRoot: string,
  identity: ProjectIdentity,
): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    projectRoot,
    identity,
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  };
}

/** Re-exported so smoke tests + the runtime can introspect the
 *  registry contents (e.g. "how many lifters are registered?"). */
export { LIFTER_REGISTRY } from './binary-rom-registry.js';
