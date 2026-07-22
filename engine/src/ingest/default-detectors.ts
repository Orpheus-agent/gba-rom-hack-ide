/**
 * Default detector set - the canonical detector list every consumer
 * (smoke harness, editor backend EngineClient, future CLI) runs.
 *
 * Per `MASTER_PROMPT_UNIVERSAL_WORKSPACE.md` PD 13: the editor MAY NOT
 * re-implement detection / classification. It consumes the engine's
 * output via the same detector pipeline the smoke harness uses. This
 * module is the single source of truth for "the detectors a universal
 * ingest pass runs" - change it here and every consumer picks up the
 * new detector automatically.
 *
 * Ordering matters:
 *   - `headerFingerprintDetector` first (provides RomHeader to later
 *     detectors).
 *   - `regionFinalizerDetector` MUST run last - it walks the gaps
 *     every earlier detector left and registers them so PD 8 ROM-wide
 *     accounting closes with zero unaccounted bytes.
 *
 * Plugin detectors are included (currently `testMarkerPluginDetector`)
 * to prove the universal extensibility path (per introspection master
 * Phase 13 P13-T2). Future plugins drop into this list.
 *
 * The runtime validator detector is NOT in the default set - it's
 * costly (executes script bytecode) and is run as a separate
 * `ingestRom({ detectors: [runtimeValidator] })` pass when the
 * orchestrator wants runtime ground truth (Phase 10 pattern).
 */

import type { RomDetector } from '../detectors/types.js';
import type { SignatureDb } from '../signatures/index.js';

import { headerFingerprintDetector } from '../detectors/header-fingerprint.js';
import { makeBinaryFingerprintDetector } from '../detectors/binary-fingerprint.js';
import { forkHeuristicDetector } from '../detectors/fork-heuristic.js';
import { pointerNetworkDetector } from '../detectors/pointer-network.js';
import { compressionFormatDetector } from '../detectors/compression-format.js';
import { regionFinalizerDetector } from '../detectors/region-finalizer.js';
import { mapSystemDetector } from '../detectors/map-system.js';
import { audioSystemDetector } from '../detectors/audio-system.js';
import { scriptEngineDetector } from '../detectors/script-engine.js';
import { speciesSystemDetector } from '../detectors/species-system.js';
import { trainerSystemDetector } from '../detectors/trainer-system.js';
import { encounterSystemDetector } from '../detectors/encounter-system.js';
import { speciesEvolutionsDetector } from '../detectors/species-evolutions.js';
import { speciesLearnsetsDetector } from '../detectors/species-learnsets.js';
import { speciesTMHMDetector } from '../detectors/species-tmhm.js';
import { speciesNamesDetector } from '../detectors/species-names.js';
import { saveSystemDetector } from '../detectors/save-system.js';
import { movesSystemDetector } from '../detectors/moves-system.js';
import { typeChartSystemDetector } from '../detectors/type-chart-system.js';
import { itemsSystemDetector } from '../detectors/items-system.js';
import { abilitiesSystemDetector } from '../detectors/abilities-system.js';
import { moveNamesDetector } from '../detectors/move-names-system.js';
import { saveDataSystemDetector } from '../detectors/save-data-system.js';
import { menuSystemDetector } from '../detectors/menu-system.js';
import { paletteSystemDetector } from '../detectors/palette-system.js';
import { pokedexSystemDetector } from '../detectors/pokedex-system.js';
import { typeNamesDetector } from '../detectors/type-names-system.js';
import { trainerClassNamesDetector } from '../detectors/trainer-class-names-system.js';
import { cryTableDetector } from '../detectors/cry-table-system.js';
import { textPointerTablesDetector } from '../detectors/text-pointer-tables-system.js';
import { lz77PointerTablesDetector } from '../detectors/lz77-pointer-tables-system.js';
import { experienceCurvesSystemDetector } from '../detectors/experience-curves-system.js';
import { overworldSpritesSystemDetector } from '../detectors/overworld-sprites-system.js';
import { objectEventPalettesSystemDetector } from '../detectors/object-event-palettes-system.js';
import { trainerPartiesSystemDetector } from '../detectors/trainer-parties-system.js';
import { regionMapSectionsSystemDetector } from '../detectors/region-map-sections-system.js';
import { multichoiceListsSystemDetector } from '../detectors/multichoice-lists-system.js';
import { healLocationsSystemDetector } from '../detectors/heal-locations-system.js';
import { testMarkerPluginDetector } from '../plugins/test-marker-detector.js';

export interface BuildDefaultDetectorSetArgs {
  /** Signature DB to inject into the binary-fingerprint detector. */
  readonly signatureDb: SignatureDb;
}

/**
 * Canonical detector set for a default ingest pass.
 *
 * Returns a frozen array of `RomDetector<unknown>` ordered per the
 * ingest contract (header first, region finalizer last).
 */
export function buildDefaultDetectorSet(
  args: BuildDefaultDetectorSetArgs,
): ReadonlyArray<RomDetector<unknown>> {
  const detectors: ReadonlyArray<RomDetector<unknown>> = [
    headerFingerprintDetector,
    makeBinaryFingerprintDetector({ db: args.signatureDb }),
    forkHeuristicDetector,
    pointerNetworkDetector,
    compressionFormatDetector,
    mapSystemDetector,
    audioSystemDetector,
    scriptEngineDetector,
    speciesSystemDetector,
    trainerSystemDetector,
    encounterSystemDetector,
    speciesEvolutionsDetector,
    speciesLearnsetsDetector,
    speciesTMHMDetector,
    speciesNamesDetector,
    saveSystemDetector,
    movesSystemDetector,
    typeChartSystemDetector,
    itemsSystemDetector,
    abilitiesSystemDetector,
    moveNamesDetector,
    saveDataSystemDetector,
    menuSystemDetector,
    paletteSystemDetector,
    pokedexSystemDetector,
    typeNamesDetector,
    trainerClassNamesDetector,
    cryTableDetector,
    textPointerTablesDetector,
    lz77PointerTablesDetector,
    experienceCurvesSystemDetector,
    overworldSpritesSystemDetector,
    objectEventPalettesSystemDetector,
    trainerPartiesSystemDetector,
    regionMapSectionsSystemDetector,
    multichoiceListsSystemDetector,
    healLocationsSystemDetector,
    testMarkerPluginDetector,
    regionFinalizerDetector,
  ];
  return Object.freeze(detectors);
}
