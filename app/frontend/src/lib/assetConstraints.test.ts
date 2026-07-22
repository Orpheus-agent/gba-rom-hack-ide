import { describe, expect, it } from 'vitest';
import type { Asset } from '@rom-editor/shared';
import { assessAssetConstraints } from './assetConstraints';

function asset(opts: {
  id?: string;
  kind?: Asset['kind'];
  metadata?: Record<string, string | number | boolean>;
}): Asset {
  return {
    id: opts.id ?? 'a',
    name: opts.id ?? 'a',
    kind: opts.kind ?? 'overworld_sprite',
    relativePath: opts.id ?? 'a',
    metadata: opts.metadata ?? {},
  };
}

describe('assessAssetConstraints', () => {
  it('returns no constraints when metadata is empty (nothing to check)', () => {
    const r = assessAssetConstraints(asset({}));
    expect(r).toEqual([]);
  });

  it('reports dimensions_8_aligned ok for a 32x32 sprite', () => {
    const r = assessAssetConstraints(
      asset({ metadata: { width: 32, height: 32 } }),
    );
    const dim = r.find((c) => c.rule === 'dimensions_8_aligned');
    expect(dim?.severity).toBe('ok');
    expect(dim?.message).toContain('32×32');
  });

  it('reports dimensions_8_aligned warn for an odd 24x20 sprite and suggests a rounded size', () => {
    const r = assessAssetConstraints(asset({ metadata: { width: 24, height: 20 } }));
    const dim = r.find((c) => c.rule === 'dimensions_8_aligned');
    expect(dim?.severity).toBe('warn');
    expect(dim?.message).toContain('height (20)');
    expect(dim?.message).toContain('24×24'); // 20 → 24 rounded up to next 8
  });

  it('does NOT emit alignment / palette rules for non-sprite kinds (music/palette)', () => {
    const r = assessAssetConstraints(
      asset({ kind: 'music', metadata: { sizeBytes: 1024 } }),
    );
    expect(r.find((c) => c.rule === 'dimensions_8_aligned')).toBeUndefined();
    expect(r.find((c) => c.rule === 'palette_kind')).toBeUndefined();
    // But file_size still applies even for non-sprite kinds.
    expect(r.find((c) => c.rule === 'file_size')?.severity).toBe('info');
  });

  it('grades palette colorTypes correctly: indexed=ok, RGBA=info, RGB=warn', () => {
    const indexed = assessAssetConstraints(asset({ metadata: { colorType: 'indexed' } }));
    expect(indexed.find((c) => c.rule === 'palette_kind')?.severity).toBe('ok');

    const rgba = assessAssetConstraints(asset({ metadata: { colorType: 'RGBA' } }));
    expect(rgba.find((c) => c.rule === 'palette_kind')?.severity).toBe('info');

    const rgb = assessAssetConstraints(asset({ metadata: { colorType: 'RGB' } }));
    expect(rgb.find((c) => c.rule === 'palette_kind')?.severity).toBe('warn');
  });

  it('grades bitDepth: 4 and 8 info; unusual values warn', () => {
    const four = assessAssetConstraints(asset({ metadata: { bitDepth: 4 } }));
    expect(four.find((c) => c.rule === 'bit_depth_compact')?.severity).toBe('info');
    expect(four.find((c) => c.rule === 'bit_depth_compact')?.message).toContain('4bpp');

    const eight = assessAssetConstraints(asset({ metadata: { bitDepth: 8 } }));
    expect(eight.find((c) => c.rule === 'bit_depth_compact')?.message).toContain('8bpp');

    const odd = assessAssetConstraints(asset({ metadata: { bitDepth: 16 } }));
    expect(odd.find((c) => c.rule === 'bit_depth_compact')?.severity).toBe('warn');
  });

  it('warns on unusually large sprite files', () => {
    const small = assessAssetConstraints(asset({ metadata: { sizeBytes: 5000 } }));
    expect(small.find((c) => c.rule === 'file_size')?.severity).toBe('info');

    const big = assessAssetConstraints(asset({ metadata: { sizeBytes: 800 * 1024 } }));
    expect(big.find((c) => c.rule === 'file_size')?.severity).toBe('warn');
    expect(big.find((c) => c.rule === 'file_size')?.message).toContain('KB');
  });

  it('emits every applicable rule for a fully-populated sprite asset', () => {
    const r = assessAssetConstraints(
      asset({
        metadata: {
          width: 64,
          height: 64,
          bitDepth: 4,
          colorType: 'indexed',
          sizeBytes: 2048,
        },
      }),
    );
    expect(r.map((c) => c.rule).sort()).toEqual([
      'bit_depth_compact',
      'dimensions_8_aligned',
      'file_size',
      'palette_kind',
    ]);
    // Every rule should be ok or info for a clean indexed 64x64 sprite.
    expect(r.every((c) => c.severity === 'ok' || c.severity === 'info')).toBe(true);
  });
});
