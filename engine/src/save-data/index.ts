/**
 * `engine/src/save-data/` - Gen-3 save-format layout substrate.
 *
 * Phase UW-2 / Category 10. Iter 76 (UW-2-T10) ships the sector-magic
 * scanner that detects pret's save-validation infrastructure. Future
 * iters can add per-section structure decoders (gSaveBlock1Ptr layout,
 * box storage layout, etc.).
 *
 * Engine root namespace surfaces this as
 * `import { saveData } from '@rom-introspection/engine'` per the same
 * convention as `moves`, `items`, `abilities`, `battle`, `species`.
 */

export {
  SAVE_SECTOR_SIZE_BYTES,
  SAVE_SECTOR_DATA_SIZE_BYTES,
  SAVE_SECTOR_FOOTER_SIZE_BYTES,
  SAVE_SECTOR_COUNT,
  SAVE_DATA_TOTAL_SIZE_BYTES,
  SAVE_SECTOR_FOOTER_MAGIC,
  findSaveSectorFooterMagic,
  findAllSaveSectorFooterMagic,
} from './save-data.js';
