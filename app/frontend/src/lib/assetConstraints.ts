// Pure asset constraint engine for the AssetsView inspector. Surfaces
// GBA/decomp palette + tile-alignment expectations as typed severity-tagged
// hints - never blocking, never opaque. Directly serves Phase 6 acceptance
// criterion 3 ("palette/format constraints visible but not oppressive").
//
// Sources: GBA tile graphics are composed of 8×8 cells; 4bpp uses a 16-color
// palette and 8bpp uses a 256-color palette; sprites/tilesets in
// pokeemerald-class decomps are conventionally indexed PNGs.

import type { Asset, AssetKind } from '@rom-editor/shared';

export type ConstraintSeverity = 'ok' | 'info' | 'warn';

export type ConstraintRuleId =
  | 'dimensions_8_aligned'
  | 'palette_kind'
  | 'bit_depth_compact'
  | 'file_size';

export interface AssetConstraint {
  readonly rule: ConstraintRuleId;
  readonly severity: ConstraintSeverity;
  readonly message: string;
}

const SPRITE_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  'overworld_sprite',
  'trainer_sprite',
  'battle_sprite',
  'tileset',
  'portrait',
  'animation',
  'icon',
]);

const LARGE_SPRITE_BYTES = 500 * 1024;

function metaString(asset: Asset, key: string): string | null {
  const v = asset.metadata[key];
  return typeof v === 'string' ? v : null;
}

function metaNumber(asset: Asset, key: string): number | null {
  const v = asset.metadata[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function assessAssetConstraints(asset: Asset): ReadonlyArray<AssetConstraint> {
  const out: AssetConstraint[] = [];
  const isSpriteKind = SPRITE_KINDS.has(asset.kind);
  const width = metaNumber(asset, 'width');
  const height = metaNumber(asset, 'height');
  const bitDepth = metaNumber(asset, 'bitDepth');
  const colorType = metaString(asset, 'colorType');
  const sizeBytes = metaNumber(asset, 'sizeBytes');

  if (isSpriteKind && width !== null && height !== null) {
    const widthOk = width % 8 === 0;
    const heightOk = height % 8 === 0;
    if (widthOk && heightOk) {
      out.push({
        rule: 'dimensions_8_aligned',
        severity: 'ok',
        message: `Dimensions ${width}×${height} are 8-aligned (tiles fit cleanly).`,
      });
    } else {
      const which = !widthOk && !heightOk
        ? `width (${width}) and height (${height})`
        : !widthOk
          ? `width (${width})`
          : `height (${height})`;
      out.push({
        rule: 'dimensions_8_aligned',
        severity: 'warn',
        message: `GBA tiles are 8×8 - ${which} not a multiple of 8; the engine will pad or crop. Consider resizing to ${Math.ceil(width / 8) * 8}×${Math.ceil(height / 8) * 8}.`,
      });
    }
  }

  if (isSpriteKind && colorType !== null) {
    switch (colorType) {
      case 'indexed':
        out.push({
          rule: 'palette_kind',
          severity: 'ok',
          message: 'Indexed colorType (3) - natural fit for GBA palette tiles.',
        });
        break;
      case 'RGBA':
        out.push({
          rule: 'palette_kind',
          severity: 'info',
          message: 'RGBA colorType (6) - your build will need to quantize to an indexed palette.',
        });
        break;
      case 'RGB':
        out.push({
          rule: 'palette_kind',
          severity: 'warn',
          message: 'RGB colorType (2) without alpha - palette conversion may pick a wrong transparent color. Indexed PNG is preferred.',
        });
        break;
      case 'grayscale':
      case 'grayscale+alpha':
        out.push({
          rule: 'palette_kind',
          severity: 'info',
          message: `${colorType} colorType - grayscale-only; the build pipeline will fold this to a single palette ramp.`,
        });
        break;
    }
  }

  if (isSpriteKind && bitDepth !== null) {
    if (bitDepth === 4) {
      out.push({
        rule: 'bit_depth_compact',
        severity: 'info',
        message: '4bpp (16-color palette) - compact, matches GBA tile mode.',
      });
    } else if (bitDepth === 8) {
      out.push({
        rule: 'bit_depth_compact',
        severity: 'info',
        message: '8bpp (256-color palette) - twice the ROM of 4bpp; only needed for full-screen art.',
      });
    } else if (bitDepth === 1 || bitDepth === 2) {
      out.push({
        rule: 'bit_depth_compact',
        severity: 'info',
        message: `${bitDepth}bpp PNG - the build pipeline will expand to 4bpp.`,
      });
    } else {
      out.push({
        rule: 'bit_depth_compact',
        severity: 'warn',
        message: `Non-standard bit depth ${bitDepth} - most decomp art expects 4 or 8 bpp.`,
      });
    }
  }

  if (sizeBytes !== null) {
    if (isSpriteKind && sizeBytes > LARGE_SPRITE_BYTES) {
      out.push({
        rule: 'file_size',
        severity: 'warn',
        message: `${formatBytes(sizeBytes)} - unusually large for a sprite. Consider optimizing palette/dimensions.`,
      });
    } else {
      out.push({
        rule: 'file_size',
        severity: 'info',
        message: `${formatBytes(sizeBytes)}`,
      });
    }
  }

  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
