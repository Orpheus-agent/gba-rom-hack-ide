export {
  findMapClusters,
  type FindMapClustersOptions,
  type MapCluster,
} from './clusters.js';

export {
  inferBuildings,
  type Building,
} from './buildings.js';

export {
  OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES,
  OVERWORLD_SPRITES_MAX_CLUSTER_SPAN,
  OVERWORLD_SPRITES_MAX_ENTRIES,
  OVERWORLD_SPRITES_MIN_ENTRIES,
  OVERWORLD_SPRITES_MIN_VALID_FRACTION,
  scanOverworldSpriteTable,
  type OverworldSpriteInfo,
  type OverworldSpriteTable,
  type ScanOverworldSpritesOptions,
} from './overworld-sprites.js';

export {
  REGION_MAP_SECTION_SIZE_BYTES,
  REGION_MAP_SECTION_SIZE_BYTES_8,
  REGION_MAP_SECTION_SIZE_BYTES_12,
  REGION_MAP_SECTIONS_MAX_ENTRIES,
  REGION_MAP_SECTIONS_MIN_DISTINCT_XY,
  REGION_MAP_SECTIONS_MIN_DISTINCT_Y,
  REGION_MAP_SECTIONS_MIN_ENTRIES,
  REGION_MAP_SECTIONS_MIN_NAMED,
  scanRegionMapSections,
  type RegionMapLayoutKind,
  type RegionMapSection,
  type RegionMapSectionsTable,
  type ScanRegionMapSectionsOptions,
} from './region-map-sections.js';

export {
  OBJECT_EVENT_GRAPHICS_IMAGES_PTR_OFFSET,
  SPRITE_FRAME_IMAGE_SIZE_BYTES,
  applyPaletteToOverworldSprite,
  decodeOverworldSpriteImage,
  type OverworldSpriteImage,
  type OverworldSpriteImageFailure,
  type OverworldSpriteImageResult,
} from './overworld-sprite-image.js';

export {
  OBJECT_EVENT_PAL_TAG_NONE,
  OBJECT_EVENT_PALETTES_MAX_ENTRIES,
  OBJECT_EVENT_PALETTES_MIN_ENTRIES,
  SPRITE_PALETTE_ENTRY_SIZE_BYTES,
  scanObjectEventPaletteTable,
  type ObjectEventPaletteEntry,
  type ObjectEventPaletteTable,
  type ScanObjectEventPalettesOptions,
} from './object-event-palettes.js';

// Phase 3.30 - heal-locations / fly-destinations.
export {
  HEAL_LOCATION_SIZE_BYTES,
  HEAL_LOCATIONS_MAX_ENTRIES,
  HEAL_LOCATIONS_MIN_ENTRIES,
  scanHealLocations,
  type HealLocation,
  type HealLocationsTable,
  type ScanHealLocationsOptions,
} from './heal-locations.js';
