export {
  GBA_ROM_BASE_ADDRESS,
  GBA_ROM_END_ADDRESS_EXCLUSIVE,
  discoverPointers,
  isProbableRomPointer,
  type DiscoveryOptions,
  type RomPointer,
} from './discovery.js';

export {
  findPointerTables,
  type FindPointerTablesOptions,
  type PointerTable,
} from './tables.js';

export {
  clusterCrossReferences,
  toSortedHotspots,
  type CrossReferenceCluster,
} from './clusters.js';
