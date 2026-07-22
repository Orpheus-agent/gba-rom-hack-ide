/**
 * Phase 4.2E - Rarity dot.
 *
 * Color-coded dot next to a percentage / label so the user can
 * scan an encounter table and instantly see which slots are common
 * vs vanishingly rare without reading the percentage. Mirrors the
 * standard MMO loot-rarity convention (common → green, uncommon →
 * yellow, rare → orange, very rare → red, ultra-rare → purple).
 */

import './RarityDot.css';

/** Convert a percentage (0..100) to a rarity bucket. The thresholds
 *  match the existing text-label thresholds in
 *  EncounterTableInspector so the dot + the label always agree. */
export type RarityBucket = 'very-common' | 'common' | 'uncommon' | 'rare' | 'very-rare';

export function rarityBucketForPct(pct: number): RarityBucket {
  if (pct >= 20) return 'very-common';
  if (pct >= 10) return 'common';
  if (pct >= 5) return 'uncommon';
  if (pct >= 1) return 'rare';
  return 'very-rare';
}

/** Human-readable label per bucket. */
export function rarityLabelForBucket(bucket: RarityBucket): string {
  switch (bucket) {
    case 'very-common':
      return 'very common';
    case 'common':
      return 'common';
    case 'uncommon':
      return 'uncommon';
    case 'rare':
      return 'rare';
    case 'very-rare':
      return 'very rare';
  }
}

export interface RarityDotProps {
  /** Bucket - caller can compute via rarityBucketForPct or pass directly. */
  readonly bucket: RarityBucket;
  /** Optional inline title for accessibility / hover. */
  readonly title?: string;
  readonly testIdPrefix?: string;
}

export function RarityDot({
  bucket,
  title,
  testIdPrefix,
}: RarityDotProps): JSX.Element {
  return (
    <span
      className={`rarity-dot rarity-dot--${bucket}`}
      title={title ?? rarityLabelForBucket(bucket)}
      data-testid={testIdPrefix ? `${testIdPrefix}-${bucket}` : `rarity-dot-${bucket}`}
      aria-label={`Rarity: ${rarityLabelForBucket(bucket)}`}
    />
  );
}
