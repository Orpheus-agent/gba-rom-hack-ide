export type { RomDetector } from './types.js';

export {
  HEADER_FINGERPRINT_DETECTOR_ID,
  headerFingerprintDetector,
  type HeaderFingerprintPayload,
  type HeaderPartialPayload,
} from './header-fingerprint.js';

export {
  BINARY_FINGERPRINT_DETECTOR_ID,
  KNOWN_SIZE_CLASSES,
  makeBinaryFingerprintDetector,
  type RomFingerprint,
  type RomSizeClass,
} from './binary-fingerprint.js';

export {
  FORK_HEURISTIC_DETECTOR_ID,
  forkHeuristicDetector,
  type DivergenceKind,
  type DivergenceSignal,
  type ForkHeuristicEvidence,
} from './fork-heuristic.js';

export {
  POINTER_NETWORK_DETECTOR_ID,
  pointerNetworkDetector,
  type PointerNetworkSummary,
} from './pointer-network.js';

export {
  COMPRESSION_FORMAT_DETECTOR_ID,
  compressionFormatDetector,
  type CompressionInventory,
} from './compression-format.js';

export {
  REGION_FINALIZER_DETECTOR_ID,
  regionFinalizerDetector,
  type FinalizedRegion,
  type RegionFinalizationReport,
} from './region-finalizer.js';

export {
  MAP_SYSTEM_DETECTOR_ID,
  mapSystemDetector,
  type MapSystemReport,
} from './map-system.js';

export {
  AUDIO_SYSTEM_DETECTOR_ID,
  audioSystemDetector,
  type AudioSystemReport,
} from './audio-system.js';

export {
  SCRIPT_ENGINE_DETECTOR_ID,
  scriptEngineDetector,
  type ScriptEngineReport,
} from './script-engine.js';

export {
  SPECIES_SYSTEM_DETECTOR_ID,
  speciesSystemDetector,
  type SpeciesSystemReport,
} from './species-system.js';

export {
  TRAINER_SYSTEM_DETECTOR_ID,
  trainerSystemDetector,
  type TrainerSystemReport,
} from './trainer-system.js';

export {
  ENCOUNTER_SYSTEM_DETECTOR_ID,
  encounterSystemDetector,
  type EncounterSystemReport,
  type EncounterTableEntryReport,
} from './encounter-system.js';

export {
  SPECIES_EVOLUTIONS_DETECTOR_ID,
  speciesEvolutionsDetector,
  type SpeciesEvolutionsReport,
} from './species-evolutions.js';

export {
  SPECIES_LEARNSETS_DETECTOR_ID,
  speciesLearnsetsDetector,
  type SpeciesLearnsetsReport,
} from './species-learnsets.js';

export {
  SPECIES_TMHM_DETECTOR_ID,
  speciesTMHMDetector,
  type SpeciesTMHMReport,
} from './species-tmhm.js';

export {
  SPECIES_NAMES_DETECTOR_ID,
  speciesNamesDetector,
  type SpeciesNamesReport,
} from './species-names.js';

export {
  SAVE_STRING_DESCRIPTORS,
  SAVE_SYSTEM_DETECTOR_ID,
  saveSystemDetector,
  type SaveBackendFamily,
  type SaveSystemReport,
} from './save-system.js';

export {
  MOVES_SYSTEM_DETECTOR_ID,
  movesSystemDetector,
  type MovesSystemReport,
} from './moves-system.js';

export {
  TYPE_CHART_SYSTEM_DETECTOR_ID,
  typeChartSystemDetector,
  type TypeChartSystemReport,
} from './type-chart-system.js';

export {
  ITEMS_SYSTEM_DETECTOR_ID,
  itemsSystemDetector,
  type ItemsSystemReport,
} from './items-system.js';

export {
  ABILITIES_SYSTEM_DETECTOR_ID,
  abilitiesSystemDetector,
  type AbilitiesSystemReport,
} from './abilities-system.js';

export {
  MOVE_NAMES_DETECTOR_ID,
  moveNamesDetector,
  type MoveNamesReport,
} from './move-names-system.js';

export {
  SAVE_DATA_SYSTEM_DETECTOR_ID,
  saveDataSystemDetector,
  type SaveDataSystemReport,
} from './save-data-system.js';

export {
  MENU_SYSTEM_DETECTOR_ID,
  menuSystemDetector,
  type MenuSystemReport,
} from './menu-system.js';

export {
  PALETTE_DETECT_MIN_REGIONS,
  PALETTE_SYSTEM_DETECTOR_ID,
  paletteSystemDetector,
  type PaletteSystemReport,
} from './palette-system.js';

export {
  POKEDEX_SYSTEM_DETECTOR_ID,
  pokedexSystemDetector,
  type PokedexSystemReport,
} from './pokedex-system.js';

export {
  TYPE_NAMES_DETECTOR_ID,
  typeNamesDetector,
  type TypeNamesReport,
} from './type-names-system.js';

export {
  TRAINER_CLASS_NAMES_DETECTOR_ID,
  trainerClassNamesDetector,
  type TrainerClassNamesReport,
} from './trainer-class-names-system.js';

export {
  CRY_TABLE_DETECTOR_ID,
  cryTableDetector,
  type CryTableSystemReport,
} from './cry-table-system.js';

export {
  TEXT_POINTER_TABLES_DETECTOR_ID,
  textPointerTablesDetector,
  type TextPointerTablesReport,
} from './text-pointer-tables-system.js';

export {
  LZ77_POINTER_TABLES_DETECTOR_ID,
  lz77PointerTablesDetector,
  type Lz77PointerTablesReport,
} from './lz77-pointer-tables-system.js';

export {
  EXPERIENCE_CURVES_SYSTEM_DETECTOR_ID,
  experienceCurvesSystemDetector,
  type ExperienceCurvesSystemReport,
} from './experience-curves-system.js';

export {
  OVERWORLD_SPRITES_SYSTEM_DETECTOR_ID,
  overworldSpritesSystemDetector,
  type OverworldSpritesSystemReport,
} from './overworld-sprites-system.js';

export {
  OBJECT_EVENT_PALETTES_SYSTEM_DETECTOR_ID,
  objectEventPalettesSystemDetector,
  type ObjectEventPalettesSystemReport,
} from './object-event-palettes-system.js';

export {
  TRAINER_PARTIES_SYSTEM_DETECTOR_ID,
  trainerPartiesSystemDetector,
  type TrainerPartiesSystemReport,
  type TrainerPartyParsed,
} from './trainer-parties-system.js';

export {
  REGION_MAP_SECTIONS_SYSTEM_DETECTOR_ID,
  regionMapSectionsSystemDetector,
  type RegionMapSectionsSystemReport,
} from './region-map-sections-system.js';

export {
  MULTICHOICE_LISTS_SYSTEM_DETECTOR_ID,
  multichoiceListsSystemDetector,
  type MultichoiceChoiceReport,
  type MultichoiceListReport,
  type MultichoiceListsSystemReport,
} from './multichoice-lists-system.js';

export {
  HEAL_LOCATIONS_SYSTEM_DETECTOR_ID,
  healLocationsSystemDetector,
  type HealLocationsSystemReport,
} from './heal-locations-system.js';

export {
  RUNTIME_VALIDATOR_DETECTOR_ID,
  makeRuntimeValidatorDetector,
  type MakeRuntimeValidatorDetectorArgs,
  type RuntimeScriptTrace,
  type RuntimeValidationFinding,
  type RuntimeValidatorReport,
} from './runtime-validator.js';
